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
import { AlertCircle, ArrowLeft, Check, Loader2, Pencil, Plus } from "lucide-react";

import {
  addConfirmLine,
  confirmFields,
  documentUrl,
  getFieldConfirm,
  getRemittance,
  isRcmOfficeId,
  strikeConfirmLine,
  type AddLineInstruction,
  type ConfirmClaim,
  type ConfirmField,
  type ConfirmInstruction,
  type ConfirmLine,
  type ConfirmLineSum,
  type ConfirmableField,
  type FieldConfirmState,
  type RcmOfficeId,
  type RemittanceDetail,
} from "@/features/rcm/api";
import { money } from "@/features/rcm/format";
import {
  ADDED_BY_HAND_MARK,
  ADD_LINE_CONTROL,
  ADD_LINE_HINT,
  CONFIRM_FIELD_LABELS,
  CONFIRM_HEADLINE,
  CONFIRM_NOT_STATED,
  CONFIRM_SCAN_CAVEAT,
  STRIKE_LINE_CONTROL,
  STRIKE_LINE_HINT,
  UNSTRIKE_LINE_CONTROL,
  confirmedByLine,
  struckByLine,
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

/**
 * THE FIVE MONEY FIELDS A LINE CARRIES, in vocabulary order.
 *
 * The same five the extraction stores and the confirm step confirms, so a line a
 * person types in is the same shape as one the reader found. A sixth box here
 * would be a figure the rest of the screen has no row for.
 */
const LINE_FIGURE_FIELDS: ConfirmableField[] = [
  "line_paid",
  "line_billed",
  "line_allowed",
  "line_deductible",
  "line_copay",
];

/** An empty add-a-line form. Every box blank means every figure "not stated". */
const BLANK_FIGURES = Object.freeze(
  Object.fromEntries(LINE_FIGURE_FIELDS.map((f) => [f, ""])),
) as Record<ConfirmableField, string>;

/** What the strike endpoint is told: which line, and whether it is being struck. */
type StrikeBody = {
  claimId: string;
  lineId?: string;
  addedLineId?: string;
  reason?: string;
  struck?: boolean;
};

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
  const mutate = useCallback(
    async (
      label: string,
      run: (office: RcmOfficeId) => Promise<FieldConfirmState>,
      after?: (next: FieldConfirmState) => void,
    ): Promise<boolean> => {
      /*
       * IT SAYS WHETHER IT TOOK.
       *
       * A form that clears itself on a failed save has thrown away what she typed
       * and told her to do it again, which is the same class of defect as a page
       * that loses her scroll position. So the forms close on `true` only.
       */
      if (!office) return false;
      setSaving(label);
      setFieldError(null);
      try {
        const next = await run(office);

        // The server's own recomputation, swapped in under a tree that stays
        // mounted. Every child is keyed by claim, line or field, so React
        // reconciles what changed and leaves the rest — and the viewer — alone.
        setState((prev) => (prev.kind === "loaded" ? { ...prev, data: next } : prev));
        if (after) after(next);
        return true;
      } catch (err) {
        /*
         * NOTHING MOVES. No state swap, no focus change, and whatever she typed
         * stays in its box so she can press Save again rather than retype it.
         */
        setFieldError({
          address: label,
          message: err instanceof Error ? err.message : "That could not be saved.",
        });
        return false;
      } finally {
        setSaving(null);
      }
    },
    [office],
  );

  const send = useCallback(
    (label: string, fields: ConfirmInstruction[]) =>
      mutate(
        label,
        (o) => confirmFields(o, batchId, fields).then((r) => r.state),
        (next) => {
        setTyping((prev) => {
          const copy = { ...prev };
          for (const f of fields) delete copy[addressOf(f.field, f.claimId ?? null, f.lineId ?? null)];
          return copy;
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
          const at = next.outstanding.first;
          setFocus(at ? addressOf(at.field, at.claimId, at.lineId) : null);
          // The document follows the work. It only moves the page when the stored
          // read carries geometry for that line; until then this is the selection,
          // and the panel stays where she left it.
          if (at && at.lineId) setActiveLineId(at.lineId);
        },
      ),
    [batchId, mutate],
  );

  /**
   * ADD A LINE THE SCAN MISSED.
   *
   * Same in-place save as a confirm, and the same reason: the server returns the
   * whole recomputed state — including the claim's new line sum, which is the
   * figure that goes from "does not add up" to "adds up" — so nothing here works
   * anything out and nothing unmounts.
   *
   * No advance afterwards. An added line asks for no confirmation of its own
   * (she typed every figure on it off the page), so there is no next figure that
   * this act created, and jumping her somewhere else would lose the place she
   * chose to be.
   */
  const addLine = useCallback(
    (claimId: string, line: AddLineInstruction) =>
      mutate(`add:${claimId}`, (o) =>
        addConfirmLine(o, batchId, claimId, line).then((r) => r.state),
      ),
    [batchId, mutate],
  );

  /** Strike a line as not on the page, or take that back. */
  const strikeLine = useCallback(
    (label: string, body: Parameters<typeof strikeConfirmLine>[2]) =>
      mutate(label, (o) => strikeConfirmLine(o, batchId, body).then((r) => r.state)),
    [batchId, mutate],
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
              addLine={addLine}
              strikeLine={strikeLine}
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
          /*
            "Start at the top" is gone: since the in-place fix the screen takes
            her to the next unconfirmed figure itself, so an instruction about
            where to begin is a sentence the software now performs.
          */
          <>Nothing can be added up yet — the check total, or one claim total, is not a figure.</>
        )}
      </span>
    </div>
  );
}

/**
 * DOES THIS CLAIM ADD UP TO WHAT IT WAS PAID?
 *
 * The same `claimLineSum` the approval gate refuses on, rendered as a line a
 * biller can read — so the thing she is working towards is on screen while she
 * works. This is the line that goes from "does not add up" to "adds up" when she
 * types in the line the scan missed, which is why adding one is not a bypass.
 */
function ClaimLineSum({ sum }: { sum: ConfirmLineSum }) {
  if (sum.ok) {
    return (
      <p className="mt-3 text-xs text-muted-foreground" data-testid="rcm-confirm-linesum-ok">
        <Check size={12} className="mr-1 inline" />
        {/*
          SHORT, BECAUSE THE CHECK-LEVEL LINE ABOVE ALREADY SAYS THE LONG VERSION.
          This row is about one claim's lines; the sentence above it is about the
          whole cheque, and saying the same thing twice in different words is the
          third telling the budget is there to stop.
        */}
        {sum.comparable ? "The lines add up." : "Paid by category, not per line."}
      </p>
    );
  }

  /*
   * AMBER, and only for disagreement. A difference the screen invented from a
   * missing figure is one she would go looking for on the page, so an
   * incomparable sum names no number at all.
   */
  return (
    <p
      className="mt-3 text-xs text-amber-700 dark:text-amber-400"
      data-testid="rcm-confirm-linesum-off"
    >
      <AlertCircle size={12} className="mr-1 inline" />
      {sum.comparable && sum.differenceCents !== null ? (
        <>
          Lines {money(sum.lineSumCents ?? 0)}, claim {money(sum.claimTotalCents ?? 0)} —{" "}
          <strong>{money(Math.abs(sum.differenceCents))} apart</strong>.
          {/*
            THE DIRECTION IS THE INSTRUCTION. Lines short of the claim total means
            the read missed something, and the control for that is right below.
            Lines over it means a figure is wrong, or a line is not on the page.
          */}
          {sum.differenceCents < 0 ? " A line may be missing." : " A figure may be wrong."}
        </>
      ) : sum.lineCount === 0 ? (
        "Every line struck — nothing to add up."
      ) : (
        "No sum yet — a line payment is not a figure."
      )}
    </p>
  );
}

/**
 * ADD A LINE FROM THE PAGE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A TEXT BOX FOR A MONEY FIGURE IS ALLOWED HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * The module's no-amount-fields rule governs DECISIONS — writing an amount off,
 * billing a patient — where a typed number creates money movement out of
 * somebody's judgement. This is the opposite act: the line is printed on the
 * paper in her hand and she is copying it across. Same owner ruling, same scope
 * as a correction, and nothing outside this screen may read it as precedent.
 *
 * EVERY FIGURE IS SENT, including the ones left blank — blank means "the page
 * does not state this for this line", which is the ordinary case on a
 * category-subtotal EOB. An omitted key would be the server recording "the page
 * says nothing" about a figure nobody looked at.
 */
function AddLineForm({
  claimId,
  saving,
  fieldError,
  onAdd,
}: {
  claimId: string;
  saving: string | null;
  fieldError: SaveFailure;
  onAdd: (claimId: string, line: AddLineInstruction) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [figures, setFigures] = useState<Record<ConfirmableField, string>>(BLANK_FIGURES);

  const label = `add:${claimId}`;
  const failed = fieldError && fieldError.address === label ? fieldError.message : null;

  /*
   * A BLANK BOX IS "NOT STATED", AND A BAD ONE IS NOT A FIGURE.
   *
   * `centsFromTyped` returns undefined for both, so the two are told apart here:
   * an empty string is a deliberate null, anything else that will not parse keeps
   * the button disabled rather than being sent as a null. Treating "1,84o" as
   * "the page does not say" would record an answer she did not give.
   */
  const parsed = new Map(
    LINE_FIGURE_FIELDS.map((field) => {
      const raw = figures[field].trim();
      if (!raw) return [field, { cents: null as number | null, bad: false }];
      const cents = centsFromTyped(raw);
      return [field, { cents: cents ?? null, bad: cents === undefined }];
    }),
  );
  /** By NAME, never by position: a reordered vocabulary must not move a figure. */
  const centsFor = (field: ConfirmableField) => parsed.get(field)?.cents ?? null;
  const unparseable = LINE_FIGURE_FIELDS.some((f) => parsed.get(f)?.bad === true);
  const ready = code.trim().length > 0 && !unparseable;

  const reset = () => {
    setOpen(false);
    setCode("");
    setDescription("");
    setFigures(BLANK_FIGURES);
  };

  if (!open) {
    return (
      <div className="mt-3 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 text-xs font-medium underline"
          data-testid={`rcm-confirm-add-open-${claimId}`}
        >
          <Plus size={12} />
          {ADD_LINE_CONTROL}
        </button>
      </div>
    );
  }

  return (
    <div
      className="mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-3"
      data-testid={`rcm-confirm-add-form-${claimId}`}
    >
      <p className="text-xs text-muted-foreground">{ADD_LINE_HINT}</p>

      <div className="flex flex-wrap gap-2">
        <label className="text-xs">
          <span className="mr-1 text-muted-foreground">Code</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="D0220"
            aria-label="The procedure code as the page prints it"
            className="w-24 rounded-lg border border-border bg-background px-2 py-0.5 text-xs"
            data-testid={`rcm-confirm-add-code-${claimId}`}
          />
        </label>
        <label className="flex-1 text-xs">
          <span className="mr-1 text-muted-foreground">What it is</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-label="What the page calls this procedure"
            className="w-full min-w-[10rem] rounded-lg border border-border bg-background px-2 py-0.5 text-xs"
            data-testid={`rcm-confirm-add-description-${claimId}`}
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        {LINE_FIGURE_FIELDS.map((field) => (
          <label key={field} className="text-xs">
            <span className="mr-1 text-muted-foreground">{CONFIRM_FIELD_LABELS[field]}</span>
            <input
              value={figures[field]}
              onChange={(e) => setFigures((prev) => ({ ...prev, [field]: e.target.value }))}
              inputMode="decimal"
              placeholder={CONFIRM_NOT_STATED}
              aria-label={`What the page says for ${CONFIRM_FIELD_LABELS[field]}`}
              className="w-24 rounded-lg border border-border bg-background px-2 py-0.5 text-xs"
              data-testid={`rcm-confirm-add-${field}-${claimId}`}
            />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!ready || saving === label}
          onClick={async () => {
            const saved = await onAdd(claimId, {
              code: code.trim(),
              description: description.trim() || null,
              billedCents: centsFor("line_billed"),
              allowedCents: centsFor("line_allowed"),
              deductibleCents: centsFor("line_deductible"),
              copayCents: centsFor("line_copay"),
              paidCents: centsFor("line_paid"),
            });
            // Only on success. A refusal leaves the form exactly as she left it,
            // with the message beside the button, so she can fix one box.
            if (saved) reset();
          }}
          className="rounded-lg bg-foreground px-3 py-1 text-xs font-medium text-background disabled:opacity-50"
          data-testid={`rcm-confirm-add-save-${claimId}`}
        >
          {saving === label ? "Saving…" : "Add this line"}
        </button>
        <button
          type="button"
          onClick={reset}
          className="text-xs underline"
          data-testid={`rcm-confirm-add-cancel-${claimId}`}
        >
          Cancel
        </button>
        {/*
          A REASON, NEVER A BARE GREYED BUTTON. `DisabledReason` is the module's
          rule: a control somebody cannot press has to say why, in words about
          what is missing rather than about the control.
        */}
        {!ready ? (
          <DisabledReason tone="muted" testId={`rcm-confirm-add-blocked-${claimId}`}>
            {code.trim().length === 0
              ? "Type the procedure code printed beside the line."
              : "One of those figures is not an amount. Leave a box empty if the page does not state it."}
          </DisabledReason>
        ) : null}
        {failed ? (
          <InlineFailure message={failed} testId={`rcm-confirm-add-error-${claimId}`} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * NOT A LINE ON THE PAGE.
 *
 * A scanned read can invent a line as easily as it can miss one — a benefit
 * subtotal row read as a procedure, a carried-forward balance read as a payment.
 * No correction to its figures makes it true, so she says it is not there, with a
 * reason.
 *
 * NOTHING IS DELETED. The extraction row stays exactly as the read produced it;
 * this records that a person looked at the page and the line is not on it. And it
 * can be taken back: striking a real line takes its money out of the sum, so a
 * mis-strike would otherwise leave a check that can never reconcile.
 */
function StrikeControl({
  claimId,
  line,
  saving,
  fieldError,
  onStrike,
}: {
  claimId: string;
  line: ConfirmLine;
  saving: string | null;
  fieldError: SaveFailure;
  onStrike: (label: string, body: StrikeBody) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const label = `strike:${line.lineId}`;
  const failed = fieldError && fieldError.address === label ? fieldError.message : null;
  /** Which id the server is told about: a read line, or one she added. */
  const target: StrikeBody =
    line.kind === "added" ? { claimId, addedLineId: line.lineId } : { claimId, lineId: line.lineId };

  if (line.struck) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground" data-testid={`rcm-confirm-struck-by-${line.lineId}`}>
          {struckByLine(line.struck)}
        </span>
        <button
          type="button"
          disabled={saving === label}
          onClick={() => void onStrike(label, { ...target, struck: false })}
          className="text-xs underline"
          data-testid={`rcm-confirm-unstrike-${line.lineId}`}
        >
          {saving === label ? "Saving…" : UNSTRIKE_LINE_CONTROL}
        </button>
        {failed ? (
          <InlineFailure message={failed} testId={`rcm-confirm-strike-error-${line.lineId}`} />
        ) : null}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 text-xs underline"
        data-testid={`rcm-confirm-strike-open-${line.lineId}`}
      >
        {STRIKE_LINE_CONTROL}
      </button>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="What is it, then?"
        aria-label="Why this is not a line on the page"
        className="w-56 rounded-lg border border-border bg-background px-2 py-0.5 text-xs"
        data-testid={`rcm-confirm-strike-reason-${line.lineId}`}
      />
      <button
        type="button"
        disabled={reason.trim().length === 0 || saving === label}
        onClick={async () => {
          const saved = await onStrike(label, { ...target, reason: reason.trim() });
          if (!saved) return;
          setOpen(false);
          setReason("");
        }}
        className="rounded-lg border border-border px-2 py-0.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
        data-testid={`rcm-confirm-strike-save-${line.lineId}`}
      >
        {saving === label ? "Saving…" : "Strike it"}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setReason("");
        }}
        className="text-xs underline"
        data-testid={`rcm-confirm-strike-cancel-${line.lineId}`}
      >
        Cancel
      </button>
      {reason.trim().length === 0 ? (
        <DisabledReason tone="muted" testId={`rcm-confirm-strike-blocked-${line.lineId}`}>
          {STRIKE_LINE_HINT}
        </DisabledReason>
      ) : null}
      {failed ? (
        <InlineFailure message={failed} testId={`rcm-confirm-strike-error-${line.lineId}`} />
      ) : null}
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
  addLine,
  strikeLine,
}: {
  claim: ConfirmClaim;
  activeLineId: string | null;
  setActiveLineId: (id: string) => void;
  saving: string | null;
  focus: string | null;
  fieldError: SaveFailure;
  typing: Record<string, string>;
  setTyping: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  send: (label: string, fields: ConfirmInstruction[]) => Promise<boolean>;
  addLine: (claimId: string, line: AddLineInstruction) => Promise<boolean>;
  strikeLine: (label: string, body: StrikeBody) => Promise<boolean>;
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
            strikeLine={strikeLine}
          />
        ))}
      </div>

      <ClaimLineSum sum={claim.lineSum} />
      <AddLineForm
        claimId={claim.claimId}
        saving={saving}
        fieldError={fieldError}
        onAdd={addLine}
      />
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
  strikeLine,
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
  send: (label: string, fields: ConfirmInstruction[]) => Promise<boolean>;
  strikeLine: (label: string, body: StrikeBody) => Promise<boolean>;
}) {
  const label = `line:${line.lineId}`;
  /*
   * A STRUCK LINE ASKS FOR NOTHING. A person has said it is not on the page, so
   * its five figures are moot — offering to confirm them against a page they are
   * not on would be asking her to answer a question she has just withdrawn.
   */
  const unchecked = line.struck ? [] : line.fields.filter((f) => !f.confirmed);

  return (
    <div
      className={`rounded-lg border p-3 ${
        line.struck
          ? "border-border opacity-60"
          : active
            ? "border-foreground/40 bg-muted/40"
            : "border-border"
      }`}
      data-testid={`rcm-confirm-line-${line.lineId}`}
      data-kind={line.kind}
      data-struck={line.struck ? "true" : undefined}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <button
          type="button"
          onClick={onSelect}
          className={`text-left text-sm font-medium underline-offset-2 hover:underline ${
            line.struck ? "line-through" : ""
          }`}
          data-testid={`rcm-confirm-line-select-${line.lineId}`}
        >
          {line.code} {line.description}
        </button>
        {/*
          THE HUMAN-ADDED MARK, wherever an added line appears.

          Not a colour: red and amber are reserved for disagreement on this
          screen, and a line somebody typed in correctly is not a disagreement.
          It is a plain label saying where the figures came from, which is the
          same thing the trail sentence under each figure says.
        */}
        {line.kind === "added" ? (
          <span
            className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
            data-testid={`rcm-confirm-added-mark-${line.lineId}`}
          >
            {ADDED_BY_HAND_MARK}
          </span>
        ) : null}
        {/*
          NO CHIP FOR A STRUCK LINE. The strikethrough on its name and the
          "struck by <name> — <reason>" sentence under it already say it twice;
          a third label would be the kind of repetition the word budget exists
          to catch. The ADDED mark stays, because nothing else on the row says
          where those figures came from.
        */}
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

      <StrikeControl
        claimId={claimId}
        line={line}
        saving={saving}
        fieldError={fieldError}
        onStrike={strikeLine}
      />
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
  send: (label: string, fields: ConfirmInstruction[]) => Promise<boolean>;
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
