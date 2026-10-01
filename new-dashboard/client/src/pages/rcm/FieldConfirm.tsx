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
import { AlertCircle, ArrowLeft, Check, Loader2, Pencil } from "lucide-react";

import {
  confirmFields,
  documentUrl,
  getFieldConfirm,
  getRemittance,
  isRcmOfficeId,
  type ConfirmClaim,
  type ConfirmField,
  type ConfirmInstruction,
  type ConfirmLine,
  type ConfirmableField,
  type FieldConfirmState,
  type RcmOfficeId,
  type RemittanceDetail,
} from "@/features/rcm/api";
import { money } from "@/features/rcm/format";
import {
  CONFIRM_FIELD_LABELS,
  CONFIRM_HEADLINE,
  CONFIRM_NOT_STATED,
  CONFIRM_SCAN_CAVEAT,
  confirmedByLine,
} from "@/features/rcm/labels";
import { remittanceFlow, remittanceHref } from "@/features/rcm/flow";
import { useOffice } from "@/contexts/OfficeContext";
import DisabledReason from "@/components/rcm/DisabledReason";
import EobViewer from "@/components/rcm/EobViewer";
import RcmStepper from "@/components/rcm/RcmStepper";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "loaded";
      office: RcmOfficeId;
      data: FieldConfirmState;
      /**
       * The CHECK this step belongs to, for the rail.
       *
       * Null when it could not be read — the confirm work does not depend on it,
       * so a failure here costs the breadcrumb and the rail, never the screen.
       * An island with no rail is the defect being fixed; a blank page would be
       * a worse one.
       */
      check: RemittanceDetail | null;
    };

/**
 * A save that did not take, and where it was made.
 *
 * `address` is a field's address, or a line's `line:<id>` label for the button
 * that confirms five figures at once — so the message renders at the control
 * that was pressed and nowhere else.
 */
type SaveFailure = { address: string; message: string } | null;

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
  /**
   * A FAILED SAVE SAYS SO WHERE IT HAPPENED, AND NOTHING MOVES.
   *
   * Keyed by the address the save was made under — a field's own address, or a
   * line's `line:<id>` label for the "these N are right" button. A banner at the
   * top of a long list is a message about a figure she cannot see from where the
   * banner is, and she has no way to tell which of fifteen rows it is about.
   */
  const [fieldError, setFieldError] = useState<{ address: string; message: string } | null>(null);
  /** Which line the document panel is showing, so the two stay in step. */
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  /**
   * WHICH FIGURE THE WORK IS AT, by address.
   *
   * Set from the server's own `outstanding.first` after every save, so the
   * screen walks the list in the same order the count counts it — not in an
   * order the browser worked out for itself.
   */
  const [focus, setFocus] = useState<string | null>(null);
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
          /*
            The rail's data, and it must not be able to fail the screen.
            `allSettled` on purpose: the confirm work is the point, the rail is
            orientation, and a biller who can see the figures but not the
            breadcrumb is far better off than one who can see neither.
          */
          const [check] = await Promise.allSettled([getRemittance(office, batchId)]);
          if (!cancelled) {
            setState({
              kind: "loaded",
              office,
              data,
              check: check.status === "fulfilled" ? check.value : null,
            });
          }
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

  /**
   * Save one or more figures, IN PLACE.
   *
   * ─────────────────────────────────────────────────────────────────────────────
   * WHY THIS DOES NOT RE-FETCH THE PAGE
   * ─────────────────────────────────────────────────────────────────────────────
   * It used to call `load()`, which sets `kind: "loading"` — so the whole tree
   * came down and went back up on every single confirm. Both panes were thrown
   * to the top: the document viewer remounted and lost its scroll position and
   * its page, and the figure list reset, so a biller working down a long EOB had
   * to find her place again after each of thirty figures. That is the defect.
   *
   * The old comment here was right about WHY it re-fetched — the server decides
   * whether a figure was confirmed or corrected, recounts what is outstanding and
   * re-runs the sum against the anchor, and a screen that guessed any of those
   * would be a second opinion about which number is real. It was wrong only
   * about what that requires. The server now returns its whole recomputed state
   * in the POST response, so the screen can take the server's answer verbatim
   * WITHOUT going back for the page. Nothing is guessed here, and nothing
   * unmounts.
   */
  const send = useCallback(
    async (label: string, fields: ConfirmInstruction[]) => {
      if (!office) return;
      setSaving(label);
      setFieldError(null);
      try {
        const result = await confirmFields(office, batchId, fields);

        // The server's own recomputation, swapped in under a tree that stays
        // mounted. Every child is keyed by claim, line or field, so React
        // reconciles the figures that changed and leaves the rest — and the
        // viewer — alone.
        setState((prev) => (prev.kind === "loaded" ? { ...prev, data: result.state } : prev));

        setTyping((prev) => {
          const next = { ...prev };
          for (const f of fields) delete next[addressOf(f.field, f.claimId ?? null, f.lineId ?? null)];
          return next;
        });

        /*
         * ON TO THE NEXT ONE — the server's `first`, not ours.
         *
         * `outstanding.first` is computed by the same accessor that produces the
         * count beside it, walking the check in the order the remittance prints
         * it. Picking the next row in the DOM instead would be a second ordering,
         * and the two would disagree the first time a claim was added by a
         * re-extraction.
         */
        const next = result.state.outstanding.first;
        setFocus(next ? addressOf(next.field, next.claimId, next.lineId) : null);
        // The document follows the work. It only moves the page when the stored
        // read carries geometry for that line; until then this is the selection,
        // and the panel stays where she left it.
        if (next && next.lineId) setActiveLineId(next.lineId);
      } catch (err) {
        /*
         * NOTHING MOVES. No state swap, no focus change, and the typed figure
         * stays in its box so she can press Save again rather than retype it.
         */
        setFieldError({
          address: label,
          message: err instanceof Error ? err.message : "That could not be saved.",
        });
      } finally {
        setSaving(null);
      }
    },
    [batchId, office],
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

  /*
    THE SAME RAIL THE OTHER FLOW SCREENS DRAW, so this reads as a STEP and not an
    island. Confirming a scanned read is the tail end of BRING IN — the rail
    below shows that step as the current one, which is the same computation the
    check page runs, from the same payload.

    `hideCta`: the way on from this screen is its own primary at the bottom,
    which knows what is still outstanding. Two CTAs saying different things about
    the same work is the thing W-11 settled on the check page.
  */
  const rail =
    state.check && state.check.remittance
      ? remittanceFlow(state.check.remittance, state.check.claims, {
          fieldConfirm: state.check.remittance.fieldConfirm ?? null,
        })
      : null;

  return (
    <div className="p-4 md:p-6" data-testid="rcm-confirm-page">
      <Link
        href={remittanceHref(loaded.batchId)}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        data-testid="rcm-confirm-breadcrumb"
      >
        <ArrowLeft size={14} /> Back to the check
      </Link>

      {rail ? <RcmStepper flow={rail} here="upload" hideCta variant="board" /> : null}

      <div className="mb-4 mt-4">
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
            focus={focus}
            fieldError={fieldError}
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

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── The document. Evidence, not a control. ───────────────────── */}
        <div className="order-2 lg:order-1">
          {/*
            STICKY, NOT A SECOND SCROLLBAR.

            The panel travels with the page as the figures column scrolls, and
            the ONE internal scroll on this screen is the document frame itself —
            which is the exception the rule allows, because a page image has to
            be scrollable to be usable. No `overflow-y-auto` wrapper here: a
            second full-height scrollbar beside the main one is the thing being
            removed, and it is the reason this is `sticky` and not `h-screen`.
          */}
          <div className="sticky top-4 rounded-xl border border-border bg-card p-2">
            <EobViewer
              href={office && loaded.provenance ? documentUrl(office, loaded.provenance.uploadId) : null}
              page={activePage}
              caption={
                loaded.provenance?.ocrPageCount
                  ? `The document · ${loaded.provenance.ocrPageCount} page${
                      loaded.provenance.ocrPageCount === 1 ? "" : "s"
                    }`
                  : "The document"
              }
              testId="rcm-confirm-document"
            />
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
              focus={focus}
              fieldError={fieldError}
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
            {/*
              WHAT IS LEFT, AND NOTHING ELSE.

              This used to add "work down the list — each one is either right, or
              you type what the page says", which is the instruction the two
              buttons on every row already give, in those words. The rail above
              now says where the figures came from as well, so the sentence was
              the third telling. Cut, and the screen's budget paid for the rail
              with it.
            */}
            {outstanding.outstanding > 0
              ? `${outstanding.outstanding} figure${outstanding.outstanding === 1 ? "" : "s"} still to check.`
              : "All checked, but they do not add up to the check yet."}
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
        {/*
          The "still worth checking each figure" half is gone: the row at the
          foot already counts what is outstanding, and this line is about the
          arithmetic, not about the work left.
        */}
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
  focus,
  fieldError,
  typing,
  setTyping,
  send,
}: {
  claim: ConfirmClaim;
  activeLineId: string | null;
  setActiveLineId: (id: string) => void;
  saving: string | null;
  focus: string | null;
  fieldError: SaveFailure;
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
        focus={focus}
        fieldError={fieldError}
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
            focus={focus}
            fieldError={fieldError}
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
  focus,
  fieldError,
  typing,
  setTyping,
  send,
}: {
  claimId: string;
  line: ConfirmLine;
  active: boolean;
  onSelect: () => void;
  saving: string | null;
  focus: string | null;
  fieldError: SaveFailure;
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
            focus={focus}
            fieldError={fieldError}
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

      {fieldError && fieldError.address === label ? (
        <InlineFailure message={fieldError.message} testId={`rcm-confirm-line-error-${line.lineId}`} />
      ) : null}
    </div>
  );
}

/**
 * A save that did not take, said where it was made.
 *
 * Inline rather than at the top of the page: a biller fifteen rows down a long
 * EOB cannot see a banner above the fold, and a banner cannot tell her which of
 * fifteen figures it is about.
 */
function InlineFailure({ message, testId }: { message: string; testId: string }) {
  return (
    <span
      className="inline-flex items-start gap-1 text-xs text-destructive"
      role="alert"
      data-testid={testId}
    >
      <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
      {message}
    </span>
  );
}

/** One figure: what it says, what state it is in, and the two ways to answer. */
function FieldRow({
  field,
  claimId,
  lineId,
  saving,
  focus,
  fieldError,
  typing,
  setTyping,
  send,
  hideLabel = false,
}: {
  field: ConfirmField;
  claimId: string | null;
  lineId: string | null;
  saving: string | null;
  focus: string | null;
  fieldError: SaveFailure;
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
  const rowRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  /** This row is where the work is. Set by the server's count, not by the DOM. */
  const focused = focus === address;
  const failed = fieldError && fieldError.address === address ? fieldError.message : null;

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /*
   * THE WORK ARRIVES HERE.
   *
   * Scrolled into view and then focused, so the next figure is both visible and
   * ready to answer — Enter confirms it without reaching for the mouse.
   *
   * `block: "nearest"` on purpose: it moves the list the smallest amount that
   * brings the row into view, so a row already on screen does not jump. Centring
   * would scroll on every single confirm, which is a milder version of the
   * defect this fixes.
   *
   * `?.()` on `scrollIntoView` because jsdom does not implement it. A guard
   * rather than a test-only stub: this is a convenience, and a browser without it
   * should still get a working screen.
   */
  useEffect(() => {
    if (!focused) return;
    rowRef.current?.scrollIntoView?.({ block: "nearest" });
    confirmRef.current?.focus();
  }, [focused]);

  /** Confirm the figure AS READ — including "not stated" as a real answer. */
  const confirmAsRead = () =>
    send(address, [
      { claimId, lineId, field: field.field, confirmedCents: field.stated ? field.cents : null },
    ]);

  const saveTyped = () => {
    if (parsed === undefined) return;
    return send(address, [{ claimId, lineId, field: field.field, confirmedCents: parsed }]);
  };

  return (
    <div
      ref={rowRef}
      /*
       * ENTER ANSWERS THE ROW.
       *
       * On the container rather than on the button, so it works wherever focus
       * sits inside the row — the confirm button when the work arrives here, or
       * the text box when she is partway through typing a figure. An explicit
       * handler rather than relying on a focused button's native Enter, because
       * "Enter saves what I typed" has to hold in the input too, where the native
       * behaviour would be nothing at all.
       */
      onKeyDown={(e) => {
        if (e.key !== "Enter" || field.confirmed) return;
        e.preventDefault();
        if (open) void saveTyped();
        else void confirmAsRead();
      }}
      className={`flex flex-wrap items-center gap-2 rounded-md text-sm ${
        focused ? "bg-muted/60 ring-1 ring-foreground/30 px-1.5 py-1" : ""
      }`}
      data-testid={`rcm-confirm-field-${address}`}
      data-focused={focused ? "true" : undefined}
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
            ref={confirmRef}
            type="button"
            disabled={saving === address}
            onClick={() => void confirmAsRead()}
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
            onClick={() => void saveTyped()}
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

      {failed ? <InlineFailure message={failed} testId={`rcm-confirm-error-${address}`} /> : null}
    </div>
  );
}
