/**
 * CHECK THE FIGURES AGAINST THE PAGE — the review step for a scanned EOB.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SCREEN EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The first real scanned EOB was a category-subtotal layout: it printed payment
 * only at benefit-type subtotals and never per line. The read promoted each
 * line's COVERED amount into PAID, and one line showed a fabricated $1,229.00
 * paid — a figure nowhere on the page, which understated what the patient owed.
 * The arithmetic warnings fired and approve was blocked, so no money moved.
 *
 * But a biller was reading numbers that were not on the document, and a refusal
 * she cannot check against the paper asks her to trust a reader she cannot see.
 * So: the page beside the figures, and one decision per figure.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CHECK IS THE ANCHOR (owner ruling)
 * ─────────────────────────────────────────────────────────────────────────────
 * The cheque total is the screen's first line and the absolute the whole read
 * reconciles to. It is the one figure in the document a biller can verify
 * against something OUTSIDE the document — she is holding the paper. So it is
 * confirmable and correctable like any other field, with the same trail, and the
 * check cannot leave this step while the claim figures do not add up to it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO INVENTED CONFIDENCE
 * ─────────────────────────────────────────────────────────────────────────────
 * There is no per-field confidence to show, and none is manufactured. The reader
 * reports ONE mean word confidence for the whole document; the extraction model
 * reports a per-LINE confidence, which already reaches the biller as an
 * `uncertain_line:N` review reason on the check page. Neither is a per-field
 * score, and printing "92%" beside an amount would be a number this product
 * made up about a number a payer printed.
 *
 * So the framing is the honest one: these came from the scan, check them. A
 * field is `not stated`, `from the scan` (nobody has looked yet), `checked`, or
 * `corrected`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TYPING A FIGURE HERE IS TRANSCRIPTION, NOT A DECISION (owner ruling)
 * ─────────────────────────────────────────────────────────────────────────────
 * The module's no-amount-fields rule governs DECISIONS — writing an amount off,
 * billing a patient — where a typed number creates money movement out of
 * somebody's judgement. It is untouched, and this is the opposite act: the
 * figure already exists, printed on paper, and she is copying it across.
 *
 * The ruling is scoped to THIS screen. Nothing else may read it as precedent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMAGES ARE EVIDENCE, NOT CONTROLS
 * ─────────────────────────────────────────────────────────────────────────────
 * The document panel is a viewer. Nothing is clicked on it to change a figure,
 * and no colour is drawn over it — red and amber are reserved for disagreement,
 * and a crop tinted by our own opinion of a number would be this screen telling
 * her what to see on her own document.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useRoute } from "wouter";
import { AlertCircle, Check, FileText, Loader2, Pencil } from "lucide-react";

import {
  confirmFields,
  documentUrl,
  getFieldConfirm,
  isRcmOfficeId,
  type ConfirmClaim,
  type ConfirmField,
  type ConfirmInstruction,
  type ConfirmLine,
  type ConfirmableField,
  type FieldConfirmState,
  type RcmOfficeId,
} from "@/features/rcm/api";
import { money } from "@/features/rcm/format";
import {
  CONFIRM_FIELD_LABELS,
  CONFIRM_HEADLINE,
  CONFIRM_NOT_STATED,
  CONFIRM_SCAN_CAVEAT,
  confirmedByLine,
} from "@/features/rcm/labels";
import { remittanceHref } from "@/features/rcm/flow";
import { useOffice } from "@/contexts/OfficeContext";
import DisabledReason from "@/components/rcm/DisabledReason";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; office: RcmOfficeId; data: FieldConfirmState };

/** A field's address, which is also its identity on this screen. */
function addressOf(field: ConfirmableField, claimId: string | null, lineId: string | null): string {
  return `${claimId ?? ""}|${lineId ?? ""}|${field}`;
}

/**
 * Cents from what a person typed, or `undefined` for something that is not a
 * figure.
 *
 * Dollars in, cents out, and parsed rather than multiplied by 100 on a float:
 * `1229.00 * 100` is 122899.99999999999 in JavaScript, and a cent lost here is a
 * cent the anchor then refuses to reconcile.
 */
export function centsFromTyped(raw: string): number | undefined {
  const text = raw.trim().replace(/[$,\s]/g, "");
  if (!text) return undefined;
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return undefined;
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : undefined;
}

/** What this field's state is called, in a biller's words. */
function stateLabel(f: ConfirmField): string {
  if (f.source === "corrected") return "Corrected";
  if (f.confirmed) return f.stated ? "Checked" : "Not on the page";
  return f.stated ? "From the scan" : CONFIRM_NOT_STATED;
}

/** The figure, or the words for its absence. Never a zero standing in for one. */
function figureText(f: ConfirmField): string {
  return f.stated && f.cents !== null ? money(f.cents) : CONFIRM_NOT_STATED;
}

export default function FieldConfirm() {
  const [, params] = useRoute("/rcm/remittances/:id/confirm");
  const batchId = params?.id ?? "";
  const { office: selected } = useOffice();

  const [state, setState] = useState<State>({ kind: "loading" });
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which line the document panel is showing, so the two stay in step. */
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  /** Open transcription inputs, by field address. */
  const [typing, setTyping] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    /*
     * Same office resolution as the check and approve screens: the global picker
     * may be on "All Offices", which `/api/rcm` has no query for, so each
     * concrete office is tried in roster order and a 404 under one is how the
     * other is discovered.
     */
    const offices = isRcmOfficeId(selected) ? [selected] : (["roland", "valley"] as const);

    (async () => {
      let lastError: unknown = null;
      for (const office of offices) {
        try {
          const data = await getFieldConfirm(office, batchId);
          if (!cancelled) setState({ kind: "loaded", office, data });
          return;
        } catch (err) {
          lastError = err;
        }
      }
      if (!cancelled) {
        setState({
          kind: "error",
          message:
            lastError instanceof Error ? lastError.message : "This check could not be opened.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [batchId, selected]);

  useEffect(() => load(), [load]);

  const data = state.kind === "loaded" ? state.data : null;
  const office = state.kind === "loaded" ? state.office : null;

  /** The page the document panel should show. */
  const activePage = useMemo(() => {
    if (!data) return 1;
    for (const claim of data.claims) {
      for (const line of claim.lines) {
        if (line.lineId === activeLineId && line.region) return line.region.page;
      }
    }
    return 1;
  }, [data, activeLineId]);

  /** Send one or more figures, then re-read so the screen shows the server's answer. */
  const send = useCallback(
    async (label: string, fields: ConfirmInstruction[]) => {
      if (!office) return;
      setSaving(label);
      setError(null);
      try {
        await confirmFields(office, batchId, fields);
        /*
         * RE-READ rather than patching local state. The server derives whether a
         * figure was confirmed or corrected, recomputes the outstanding count and
         * re-runs the sum against the anchor — and a screen that guessed any of
         * those would be a second opinion about which number is real, which is
         * the whole thing this slice exists to prevent.
         */
        load();
        setTyping((prev) => {
          const next = { ...prev };
          for (const f of fields) delete next[addressOf(f.field, f.claimId ?? null, f.lineId ?? null)];
          return next;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "That could not be saved.");
      } finally {
        setSaving(null);
      }
    },
    [batchId, load, office],
  );

  if (state.kind === "loading") {
    return (
      <div className="p-6" data-testid="rcm-confirm-loading">
        <Loader2 className="animate-spin text-muted-foreground" size={20} />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="p-6" data-testid="rcm-confirm-error">
        <p className="text-sm text-destructive">{state.message}</p>
        <button type="button" className="mt-3 text-sm underline" onClick={() => load()}>
          Try again
        </button>
      </div>
    );
  }

  const loaded = state.data;

  /*
   * THE TEACHING EMPTY STATE. An 835 and a PDF with its own text layer have
   * nothing to check against a page: their figures are data, not a picture of a
   * table. Rendering an empty confirm list would look broken, so the screen says
   * which kind of document this is and sends her back.
   */
  if (!loaded.required) {
    return (
      <div className="p-6" data-testid="rcm-confirm-not-needed">
        <h1 className="text-lg font-semibold">Nothing to check by hand</h1>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          This check came in as a file the computer could read directly, so its figures were not
          read off a picture. There is nothing here to compare against a page.
        </p>
        <Link
          href={remittanceHref(loaded.batchId)}
          className="mt-4 inline-block text-sm underline"
          data-testid="rcm-confirm-back"
        >
          Back to the check
        </Link>
      </div>
    );
  }

  const { outstanding, sums } = loaded;
  const done = outstanding.ok && sums.ok;

  return (
    <div className="p-4 md:p-6" data-testid="rcm-confirm-page">
      <div className="mb-4">
        <h1 className="text-lg font-semibold">{CONFIRM_HEADLINE}</h1>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">{CONFIRM_SCAN_CAVEAT}</p>
      </div>

      {/* ── THE ANCHOR, and the snapshot slot beside it ───────────────────── */}
      <div
        className="mb-4 flex flex-wrap items-start gap-4 rounded-xl border border-border bg-muted/30 p-4"
        data-testid="rcm-confirm-anchor"
      >
        <div className="min-w-[14rem] flex-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">This check is for</p>
          <p className="mt-1 text-2xl font-semibold" data-testid="rcm-confirm-check-total">
            {figureText(loaded.checkTotal)}
          </p>
          <p className="text-xs text-muted-foreground">
            {loaded.payer ?? "Payer not stated"}
            {loaded.checkNumber ? ` · ${loaded.checkNumber}` : ""}
          </p>
          <FieldRow
            field={loaded.checkTotal}
            claimId={null}
            lineId={null}
            saving={saving}
            typing={typing}
            setTyping={setTyping}
            send={send}
            hideLabel
          />
        </div>

        {/*
          THE CHECK SNAPSHOT SLOT (addendum item 2).
          Reserved beside the anchor and rendered only when an image exists on the
          record. Nothing in this slice uploads or captures one, so today it
          renders nothing at all — not a placeholder, not a prompt, because an
          empty frame inviting an upload that does not exist is a dead end.
        */}
        {loaded.checkImage ? (
          <img
            src={loaded.checkImage.url}
            alt="The check"
            className="h-28 w-auto rounded-lg border border-border"
            data-testid="rcm-confirm-check-image"
          />
        ) : null}
      </div>

      {/* ── Does it add up? ──────────────────────────────────────────────── */}
      <SumLine sums={sums} outstanding={outstanding.outstanding} />

      {error ? (
        <div
          className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          data-testid="rcm-confirm-save-error"
        >
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── The document. Evidence, not a control. ───────────────────── */}
        <div className="order-2 lg:order-1">
          <div className="sticky top-4 rounded-xl border border-border bg-card p-2">
            <p className="px-1 pb-2 text-xs text-muted-foreground">
              <FileText size={12} className="mr-1 inline" />
              The document
              {loaded.provenance?.ocrPageCount
                ? ` · ${loaded.provenance.ocrPageCount} page${loaded.provenance.ocrPageCount === 1 ? "" : "s"}`
                : ""}
            </p>
            {office && loaded.provenance ? (
              <iframe
                title="The scanned document"
                /*
                 * `key` on the page number so a change to it REMOUNTS the frame.
                 * A PDF viewer does not re-navigate on a `#page=` fragment change
                 * alone, so without this the panel would silently stay on page 1
                 * while the screen claimed to be showing the selected line.
                 */
                key={activePage}
                src={documentUrl(office, loaded.provenance.uploadId, { page: activePage })}
                className="h-[60vh] w-full rounded-lg border border-border bg-background"
                data-testid="rcm-confirm-document"
              />
            ) : (
              <p className="p-3 text-sm text-muted-foreground" data-testid="rcm-confirm-no-document">
                The original file is not attached to this check, so there is nothing to compare
                against. Check the figures against your own copy before approving.
              </p>
            )}
          </div>
        </div>

        {/* ── The figures ─────────────────────────────────────────────────── */}
        <div className="order-1 space-y-4 lg:order-2">
          {loaded.claims.map((claim) => (
            <ClaimPanel
              key={claim.claimId}
              claim={claim}
              activeLineId={activeLineId}
              setActiveLineId={setActiveLineId}
              saving={saving}
              typing={typing}
              setTyping={setTyping}
              send={send}
            />
          ))}
        </div>
      </div>

      {/* ── The one primary ─────────────────────────────────────────────── */}
      <div className="mt-6 border-t border-border pt-4">
        {done ? (
          <Link
            href={remittanceHref(loaded.batchId)}
            className="inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background"
            data-testid="rcm-confirm-done"
          >
            <Check size={16} />
            Everything checked — back to the check
          </Link>
        ) : (
          /*
           * NO REASON-LESS GREYED BUTTON. There is no disabled control here at
           * all: the row says what is left, and the way out is to do it. A dead
           * button with a tooltip would be one more thing to click at.
           */
          <DisabledReason tone="muted" testId="rcm-confirm-not-done">
            {outstanding.outstanding > 0
              ? `${outstanding.outstanding} figure${outstanding.outstanding === 1 ? "" : "s"} still to check. Work down the list — each one is either right, or you type what the page says.`
              : "The figures are all checked, but they do not add up to the check yet. Fix the one that disagrees with the page."}
          </DisabledReason>
        )}
      </div>
    </div>
  );
}

/** Does the read add up to the cheque? The line the owner ruling asks for. */
function SumLine({
  sums,
  outstanding,
}: {
  sums: FieldConfirmState["sums"];
  outstanding: number;
}) {
  if (sums.ok) {
    return (
      <p
        className="mb-4 text-sm text-muted-foreground"
        data-testid="rcm-confirm-sum-ok"
      >
        <Check size={14} className="mr-1 inline" />
        The claim totals add up to the check.
        {outstanding > 0 ? " Still worth checking each figure against the page." : ""}
      </p>
    );
  }

  /*
   * AMBER, and only here. Red and amber are reserved for disagreement, and this
   * IS the disagreement: money the read cannot account for against the one
   * figure she can verify outside the document.
   */
  return (
    <div
      className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
      data-testid="rcm-confirm-sum-off"
    >
      <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
      <span>
        {sums.comparable && sums.differenceCents !== null ? (
          <>
            The claim totals come to {money(sums.claimsTotalCents ?? 0)} and this check is for{" "}
            {money(sums.checkTotalCents ?? 0)} —{" "}
            <strong>{money(Math.abs(sums.differenceCents))} apart</strong>. Find the figure that
            disagrees with the page.
          </>
        ) : (
          <>
            Nothing can be added up yet — the check total, or one claim total, is not a figure yet.
            Start at the top.
          </>
        )}
      </span>
    </div>
  );
}

function ClaimPanel({
  claim,
  activeLineId,
  setActiveLineId,
  saving,
  typing,
  setTyping,
  send,
}: {
  claim: ConfirmClaim;
  activeLineId: string | null;
  setActiveLineId: (id: string) => void;
  saving: string | null;
  typing: Record<string, string>;
  setTyping: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  send: (label: string, fields: ConfirmInstruction[]) => Promise<void>;
}) {
  return (
    <section
      className="rounded-xl border border-border bg-card p-4"
      data-testid={`rcm-confirm-claim-${claim.claimId}`}
    >
      <header className="mb-3">
        <h2 className="text-sm font-semibold">{claim.patientName ?? "Patient not stated"}</h2>
        <p className="text-xs text-muted-foreground">
          {claim.claimNumber ?? "No claim number"}
          {claim.serviceDate ? ` · ${claim.serviceDate}` : ""}
        </p>
      </header>

      <FieldRow
        field={claim.totalPaid}
        claimId={claim.claimId}
        lineId={null}
        saving={saving}
        typing={typing}
        setTyping={setTyping}
        send={send}
      />

      <div className="mt-3 space-y-3">
        {claim.lines.map((line) => (
          <LinePanel
            key={line.lineId}
            claimId={claim.claimId}
            line={line}
            active={line.lineId === activeLineId}
            onSelect={() => setActiveLineId(line.lineId)}
            saving={saving}
            typing={typing}
            setTyping={setTyping}
            send={send}
          />
        ))}
      </div>
    </section>
  );
}

function LinePanel({
  claimId,
  line,
  active,
  onSelect,
  saving,
  typing,
  setTyping,
  send,
}: {
  claimId: string;
  line: ConfirmLine;
  active: boolean;
  onSelect: () => void;
  saving: string | null;
  typing: Record<string, string>;
  setTyping: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  send: (label: string, fields: ConfirmInstruction[]) => Promise<void>;
}) {
  const label = `line:${line.lineId}`;
  const unchecked = line.fields.filter((f) => !f.confirmed);

  return (
    <div
      className={`rounded-lg border p-3 ${active ? "border-foreground/40 bg-muted/40" : "border-border"}`}
      data-testid={`rcm-confirm-line-${line.lineId}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <button
          type="button"
          onClick={onSelect}
          className="text-left text-sm font-medium underline-offset-2 hover:underline"
          data-testid={`rcm-confirm-line-select-${line.lineId}`}
        >
          {line.code} {line.description}
        </button>
        {/*
          THE PER-LINE VISUAL CHECK (addendum item 1).

          A cropped strip of the page would render here when the stored read
          carries the geometry to cut one. It does not: the reader keeps text,
          page count, word count and mean confidence and discards Azure's
          polygons, and re-running OCR to recover a box is ruled out. So the
          fallback is the whole page, and selecting this line scrolls the document
          panel to it — which is why the row's name is the control.
        */}
        {line.region ? (
          <span className="text-xs text-muted-foreground" data-testid={`rcm-confirm-crop-${line.lineId}`}>
            Strip of the page
          </span>
        ) : null}
      </div>

      <dl className="mt-2 space-y-1">
        {line.fields.map((field) => (
          <FieldRow
            key={field.field}
            field={field}
            claimId={claimId}
            lineId={line.lineId}
            saving={saving}
            typing={typing}
            setTyping={setTyping}
            send={send}
          />
        ))}
      </dl>

      {unchecked.length > 0 ? (
        <button
          type="button"
          disabled={saving === label}
          onClick={() =>
            send(
              label,
              unchecked.map((f) => ({
                claimId,
                lineId: line.lineId,
                field: f.field,
                // Confirming AS READ, including "not stated" as a real answer.
                confirmedCents: f.stated ? f.cents : null,
              })),
            )
          }
          className="mt-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
          data-testid={`rcm-confirm-line-all-${line.lineId}`}
        >
          {saving === label ? "Saving…" : `These ${unchecked.length} are right`}
        </button>
      ) : null}
    </div>
  );
}

/** One figure: what it says, what state it is in, and the two ways to answer. */
function FieldRow({
  field,
  claimId,
  lineId,
  saving,
  typing,
  setTyping,
  send,
  hideLabel = false,
}: {
  field: ConfirmField;
  claimId: string | null;
  lineId: string | null;
  saving: string | null;
  typing: Record<string, string>;
  setTyping: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  send: (label: string, fields: ConfirmInstruction[]) => Promise<void>;
  hideLabel?: boolean;
}) {
  const address = addressOf(field.field, claimId, lineId);
  const open = Object.prototype.hasOwnProperty.call(typing, address);
  const raw = typing[address] ?? "";
  const parsed = centsFromTyped(raw);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  return (
    <div
      className="flex flex-wrap items-center gap-2 text-sm"
      data-testid={`rcm-confirm-field-${address}`}
    >
      {hideLabel ? null : (
        <dt className="min-w-[7rem] text-muted-foreground">{CONFIRM_FIELD_LABELS[field.field]}</dt>
      )}
      <dd className="font-medium">{figureText(field)}</dd>
      <span
        className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
        data-testid={`rcm-confirm-state-${address}`}
      >
        {stateLabel(field)}
      </span>

      {field.confirmed ? (
        /*
         * THE TRAIL, in a sentence. It stays under the figure for as long as the
         * figure exists — which is what makes a typed amount safe: anybody
         * reading this number later can see it was typed, by whom, and what the
         * machine had said instead.
         */
        <span className="text-xs text-muted-foreground" data-testid={`rcm-confirm-by-${address}`}>
          {confirmedByLine(field)}
        </span>
      ) : (
        <>
          <button
            type="button"
            disabled={saving === address}
            onClick={() =>
              send(address, [
                { claimId, lineId, field: field.field, confirmedCents: field.stated ? field.cents : null },
              ])
            }
            className="rounded-lg border border-border px-2 py-0.5 text-xs font-medium hover:bg-muted"
            data-testid={`rcm-confirm-yes-${address}`}
          >
            {saving === address ? "Saving…" : "That is right"}
          </button>
          {open ? null : (
            <button
              type="button"
              onClick={() => setTyping((prev) => ({ ...prev, [address]: "" }))}
              className="inline-flex items-center gap-1 text-xs underline"
              data-testid={`rcm-confirm-edit-${address}`}
            >
              <Pencil size={11} />
              Type what the page says
            </button>
          )}
        </>
      )}

      {open ? (
        <span className="flex items-center gap-1">
          <input
            ref={inputRef}
            value={raw}
            onChange={(e) => setTyping((prev) => ({ ...prev, [address]: e.target.value }))}
            inputMode="decimal"
            placeholder="0.00"
            aria-label={`What the page says for ${CONFIRM_FIELD_LABELS[field.field]}`}
            className="w-24 rounded-lg border border-border bg-background px-2 py-0.5 text-xs"
            data-testid={`rcm-confirm-input-${address}`}
          />
          <button
            type="button"
            disabled={parsed === undefined || saving === address}
            onClick={() =>
              parsed !== undefined &&
              send(address, [{ claimId, lineId, field: field.field, confirmedCents: parsed }])
            }
            className="rounded-lg border border-border px-2 py-0.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            data-testid={`rcm-confirm-save-${address}`}
          >
            Save
          </button>
          <button
            type="button"
            onClick={() =>
              setTyping((prev) => {
                const next = { ...prev };
                delete next[address];
                return next;
              })
            }
            className="text-xs underline"
            data-testid={`rcm-confirm-cancel-${address}`}
          >
            Cancel
          </button>
        </span>
      ) : null}
    </div>
  );
}
