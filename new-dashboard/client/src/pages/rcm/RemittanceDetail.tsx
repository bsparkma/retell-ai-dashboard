/**
 * /rcm/remittances/:id — one carrier payment, in full (Slice 6a).
 *
 * The header, the balance check, a link back to the source document, and the
 * claims table: per claim, what the carrier said, every flag as a chip, the
 * CARC/RARC codes with their plain-English meanings, and the match state.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE FLAGS FINALLY GET SEEN
 * ─────────────────────────────────────────────────────────────────────────────
 * Slice 4's low-confidence flags and Slice 5's malformed-CAS, downcode and
 * reversal flags have been written to `needs_review_reasons` and rendered
 * nowhere. They are first-class here. A reversal is shown clearly and linked to
 * the manual SOP — detect-and-flag means exactly that, and inventing an action
 * for one would be worse than admitting there is none.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE APPROVE BUTTON IS LIVE (Slice 6b) — AND STILL WRITES NO CHART
 * ─────────────────────────────────────────────────────────────────────────────
 * `ApprovalPanel` below carries the gate: the pre-flight checklist BEFORE
 * anything is pressed, the button, and what a press did. Approving creates a
 * posting PLAN in CareIN's own database. Nothing on this screen reaches Open
 * Dental — `rcmNoOdWrites.test.js` drives the approve path to success against a
 * client whose every verb throws and asserts not one was called.
 *
 * The Confirm button on a claim with a red blocker stays ENABLED, deliberately.
 * Linking a proposal to a chart claim is not posting, and a biller who can see
 * the right claim should be able to say so. What changed in 6b is that the
 * consequence is now PREDICTED where the confirmation happens — the claim card
 * says the confirmation cannot be approved, and the checklist says why — rather
 * than being discovered at drain time.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  CircleSlash,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  ScanLine,
} from "lucide-react";
import {
  getRemittance,
  matchRemittance,
  RcmApiError,
  unparkRemittance,
  RCM_OFFICE_LABELS,
  type BatchMatchResponse,
  type RemittanceClaim,
  type RemittanceDetail as RemittanceDetailPayload,
} from "@/features/rcm/api";
import { isRcmOfficeId } from "@/features/rcm/api";
import {
  batchStatusLabel,
  batchStatusTone,
  day,
  isBlockingReason,
  lineFlagLabel,
  lineFlagTone,
  matchStatusLabel,
  MATCH_STATUS_TONE,
  money,
  NO_ACTION_REASONS,
  reasonTone,
  reviewReasonLabel,
  SOURCE_LABELS,
  SOURCE_TITLES,
  stamp,
} from "@/features/rcm/format";
import { FLAG_LABELS, label, provenanceLabel, provenanceNote } from "@/features/rcm/labels";
import { claimHref, remittanceFlow } from "@/features/rcm/flow";
import { describePlbAdjustment } from "@/features/rcm/plb";
import ApprovalPanel from "@/pages/rcm/ApprovalPanel";
import { RecoupmentPanel } from "@/pages/rcm/RecoupmentPanel";
import RcmStepper from "@/components/rcm/RcmStepper";
import PostThisCheck from "@/components/rcm/PostThisCheck";
import CheckWorklistActions from "@/components/rcm/CheckWorklistActions";
import DisabledReason from "@/components/rcm/DisabledReason";
import { useOffice } from "@/contexts/OfficeContext";

export default function RemittanceDetailPage() {
  const [, params] = useRoute("/rcm/remittances/:id");
  const batchId = params?.id ?? "";
  const { office: selected } = useOffice();

  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "loaded"; data: RemittanceDetailPayload }
    | { kind: "failed"; message: string }
  >({ kind: "loading" });
  const [matching, setMatching] = useState(false);
  const [matchResult, setMatchResult] = useState<BatchMatchResponse | null>(null);
  /**
   * A failed MATCH must not replace the loaded remittance.
   *
   * It used to set `state = "failed"`, so a batch match that timed out wiped
   * the screen to "Could not open this remittance" while the server was still
   * matching. The operator's only move was to reload and press Match again —
   * launching a SECOND Open Dental-heavy run against a rate-limited credential.
   * An inline notice keeps the data on screen and the mistake un-invited, the
   * way ClaimMatch.tsx already handles its own failures.
   */
  const [matchError, setMatchError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  /**
   * Which office's remittance this is.
   *
   * The global picker may be on "All Offices", which /api/rcm has no query for.
   * Rather than guess, the page tries the selected office and — since a batch id
   * is only ever found under its own office — a 404 there means "not this one".
   * Both concrete offices are tried in roster order, which is why the id alone
   * is enough for a shareable link.
   */
  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    const offices = isRcmOfficeId(selected) ? [selected] : (["roland", "valley"] as const);

    (async () => {
      let lastError: unknown = null;
      for (const office of offices) {
        try {
          const data = await getRemittance(office, batchId);
          if (!cancelled) setState({ kind: "loaded", data });
          return;
        } catch (err) {
          // A 404 under one office is the normal way to discover it belongs to
          // the other; anything else is a real failure worth reporting.
          if (err instanceof RcmApiError && err.status === 404) continue;
          lastError = err;
          break;
        }
      }
      if (cancelled) return;
      setState({
        kind: "failed",
        message:
          lastError instanceof RcmApiError && lastError.notEntitled
            ? "This practice is not set up for the RCM module."
            : lastError instanceof Error
              ? lastError.message
              : "No remittance with that id in this practice.",
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [batchId, selected]);

  useEffect(load, [load]);

  /**
   * OPENING A SAVED CHECK PUTS IT BACK ON THE ORDINARY PILE.
   *
   * "Save for tomorrow" is a note to yourself, and a note has done its job the
   * moment you are reading it. Leaving the state set would make Today keep
   * offering the check you are already looking at, and would quietly turn a
   * one-press convenience into a two-press chore nobody would use twice.
   *
   * FIRE AND FORGET, on purpose. The server is idempotent over an un-saved check
   * (200, `wasParked: false`), so this is safe on every visit; and if it fails
   * there is nothing to tell anybody — a note that outlived its usefulness by an
   * hour costs nothing, while an error banner over an ordinary page-open costs
   * the reader's attention for something they never asked for.
   *
   * It does NOT re-load the page. The `parkedAt` on screen is a second old and
   * about to be irrelevant; a reload here would restart the claim bundle and the
   * Open Dental reads under it for a cosmetic field.
   */
  const parkedAt = state.kind === "loaded" ? state.data.remittance.parkedAt : null;
  const loadedOffice = state.kind === "loaded" ? state.data.office : null;
  useEffect(() => {
    if (!parkedAt || !loadedOffice || !batchId) return;
    void unparkRemittance(loadedOffice, batchId).catch(() => {
      /* see above — a stale note is not worth a banner */
    });
  }, [parkedAt, loadedOffice, batchId]);

  /**
   * Clear the batch-match summary when the page moves to a DIFFERENT
   * remittance — and only then.
   *
   * Deliberately not inside `load`: a batch match re-loads the page to pick up
   * the new match states, and clearing there would erase the very summary the
   * user just asked for, milliseconds after it appeared. That is the same class
   * of failure as the EOB panel's "Extracting" chip — a screen that stops
   * telling you something it still knows.
   */
  useEffect(() => {
    setMatchResult(null);
    setMatchError(null);
  }, [batchId]);

  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground" data-testid="remittance-loading">
        <Loader2 size={16} className="animate-spin" />
        Loading this check…
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="p-6" data-testid="remittance-error">
        <BackLink />
        <div className="mt-4 rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <div className="text-sm font-medium text-foreground">Could not open this check</div>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
        </div>
      </div>
    );
  }

  const { remittance: r, claims, office } = state.data;
  const flow = remittanceFlow(r, claims);
  /*
   * THIS CHECK'S POSTING, if it has one.
   *
   * `plans` is an array because the table permits more than one; today the
   * `(office_id, remittance_key)` unique index means at most one, so reading the
   * first is exact rather than a guess. It is typed as an array so that the day
   * 6d.2 relaxes that index (§15.1), this line is where the follow-on shows up
   * rather than a silently-wrong screen.
   */
  const plan = r.plans?.[0] ?? null;
  const unmatchedCount = claims.filter((c) => c.odMatchStatus === "not_run").length;

  /**
   * Take the operator to the approve button rather than growing a second one.
   *
   * `focus()` as well as `scrollIntoView()`: a page that jumps but leaves the
   * keyboard where it was has moved the eye and not the hand.
   */
  function goToApprovalGate() {
    const gate = document.getElementById("rcm-approval-gate");
    gate?.scrollIntoView({ behavior: "smooth", block: "start" });
    const button = gate?.querySelector<HTMLButtonElement>('[data-testid="approve-button"]');
    button?.focus({ preventScroll: true });
  }

  /** The same move, for the step after it. See `goToApprovalGate`. */
  function goToPostPanel() {
    const panel = document.querySelector<HTMLElement>('[data-testid="post-this-check"]');
    panel?.scrollIntoView({ behavior: "smooth", block: "start" });
    panel
      ?.querySelector<HTMLButtonElement>('[data-testid="post-this-check-button"]')
      ?.focus({ preventScroll: true });
  }

  async function runBatchMatch() {
    setMatching(true);
    setMatchError(null);
    try {
      const result = await matchRemittance(office, r.batchId);
      setMatchResult(result);
      load();
    } catch (err) {
      setMatchResult(null);
      // Inline, and the remittance stays on screen. See `matchError` above.
      setMatchError(
        err instanceof RcmApiError && err.code === "TIMEOUT"
          ? "The match is taking longer than expected and this page stopped waiting. It may still be running — press Refresh in a minute before trying again, so a second run does not start on top of the first."
          : err instanceof Error
            ? err.message
            : "The match could not be run.",
      );
    } finally {
      setMatching(false);
    }
  }

  return (
    <div className="p-6" data-testid="rcm-remittance-detail">
      <BackLink />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1
              className="text-2xl font-bold tracking-tight text-foreground"
              style={{ fontFamily: "Sora, sans-serif" }}
            >
              {r.payer}
            </h1>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${batchStatusTone(r.status)}`}
              data-testid="remittance-status"
            >
              {batchStatusLabel(r.status)}
            </span>
            {r.source && (
              <span
                title={SOURCE_TITLES[r.source]}
                className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                {SOURCE_LABELS[r.source]}
              </span>
            )}
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {RCM_OFFICE_LABELS[office]}
            </span>
          </div>
          <p className="mt-1 font-mono text-sm text-muted-foreground">
            {r.paymentMethod === "eft" ? "EFT" : "Check"}{" "}
            {r.checkNumber || r.eftNumber || r.traceNumber || "—"} · {day(r.depositDate)}
          </p>
        </div>

        <div className="flex flex-col items-end gap-1">
          <button
            onClick={runBatchMatch}
            disabled={matching}
            data-testid="match-all-claims"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
          >
            {matching ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {matching ? "Matching…" : "Match all claims"}
          </button>
          {matching && (
            <DisabledReason testId="match-in-flight">
              A match is running. It reads Open Dental and writes nothing.
            </DisabledReason>
          )}

          {/*
            SLICE 6b: the Approve button now lives in ApprovalPanel below, beside
            the checklist that explains it. A control whose precondition is three
            screens away from it is a control people press hopefully.
          */}
        </div>
      </div>

      {/*
        ── WHERE THIS ONE IS ───────────────────────────────────────────────────
        The same five steps as the claim screen and the Posting screen, computed
        once in `features/rcm/flow.ts`. The CTA below it is the next click — and
        the reason "approve is on a different page from review and match, with
        no link between them" (§15.2, finding 1) stops being navigation somebody
        has to already know.

        NO `here`, deliberately. This page owns BOTH of the last two steps —
        approving is the second half of "Check it over" and Post is the step
        after it, one panel under the other — so a "you are here" marker would
        have to name one of two steps the page really is. The rail's own current
        dot and the CTA below it already answer "where am I" without picking.
      */}
      <RcmStepper
        flow={flow}
        onAction={{
          "run-match": runBatchMatch,
          // NEITHER of these is a second button. Both real controls are on this
          // page already, below the checklist that explains them; the rail takes
          // you to whichever one is next and puts the focus there. Two controls
          // that both approve — or both post — would be exactly the confusion
          // this slice exists to remove.
          approve: goToApprovalGate,
          drain: goToPostPanel,
        }}
      />

      {/* SAVE FOR TOMORROW · SET ASIDE. Directly under the rail, because they
          are answers to the same question it asks — "what is next on this one" —
          and one honest answer is "not today". */}
      <CheckWorklistActions office={office} remittance={r} onChanged={load} />

      {/*
        ── REMITTANCE-LEVEL FLAGS ──────────────────────────────────────────────
        Slice 5.5 wrote these into `rcm_payment_batches.flags` and nothing
        rendered them, so a whole-check TAKEBACK surfaced only as "Held —
        something on this remittance was flagged". That is the same sin one level
        up that Slice 6a fixed at claim level: a UI announcing a flag exists and
        refusing to say which.

        Coloured by the D-11 split, from the same map the gate reads: amber will
        withhold every claim on this check, grey is true and changes nothing
        about what to post. Both are always shown.
      */}
      {r.flags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5" data-testid="remittance-flags">
          {r.flags.map((flag) => (
            <span
              key={flag}
              data-testid={`remittance-flag-${flag}`}
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${reasonTone(flag)}`}
            >
              {isBlockingReason(flag) && <AlertTriangle size={11} />}
              {label(FLAG_LABELS, flag)}
            </span>
          ))}
        </div>
      )}

      {/* ── The balance check ──────────────────────────────────────────────── */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Check total" value={money(r.totalAmountCents)} testId="stat-check-total" />
        <Stat
          label="Sum of claim payments"
          value={money(r.balance.claimTotalCents)}
          testId="stat-claim-total"
        />
        {r.plbTotalCents !== 0 && (
          <Stat
            label="Provider-level (PLB)"
            value={money(r.plbTotalCents)}
            testId="stat-plb"
            hint="Money moved at the provider level, belonging to no single claim. It is why a check total can legitimately differ from the sum of its claims."
          />
        )}
        <div
          className={`rounded-xl border p-4 ${
            r.balance.balanced
              ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/20"
              : "border-rose-200 bg-rose-50/50 dark:border-rose-900 dark:bg-rose-950/20"
          }`}
          data-testid="balance-check"
        >
          <div className="text-xs font-medium text-muted-foreground">Balance check</div>
          <div
            className={`mt-1 text-lg font-semibold ${
              r.balance.balanced
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-rose-700 dark:text-rose-400"
            }`}
          >
            {r.balance.balanced ? "Balances" : `${money(r.balance.differenceCents)} unaccounted`}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Check total {r.plbTotalCents !== 0 ? "− PLB " : ""}= sum of claim payments
          </p>
        </div>
      </div>

      {/*
        ── PROVIDER-LEVEL ADJUSTMENTS, ITEMISED ────────────────────────────────
        A dollar total is not enough to act on. A PLB is money moved at the
        provider level — an interest payment, a forward balance, a prior
        overpayment being recovered — and which of those it is decides whether a
        biller does anything at all. Slice 6a showed the total and stopped; the
        per-adjustment rows have been stored since Slice 5.
      */}
      {r.plbAdjustments.length > 0 && (
        <div
          className="mt-4 rounded-xl border border-border bg-card px-4 py-3"
          data-testid="plb-detail"
        >
          <div className="text-sm font-medium text-foreground">
            Provider-level adjustments (PLB) · {money(r.plbTotalCents)}
          </div>
          <ul className="mt-2 space-y-1 text-xs">
            {r.plbAdjustments.map((raw, i) => {
              const adj = describePlbAdjustment(raw);
              return (
                <li key={`${adj.code}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono font-medium text-foreground">{adj.code}</span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {money(adj.amountCents)}
                  </span>
                  {/* Null = a code the published list does not carry. Rendered
                      bare rather than glossed with a guess. */}
                  {adj.description && (
                    <span className="text-muted-foreground">{adj.description}</span>
                  )}
                  {adj.reference && (
                    <span className="font-mono text-muted-foreground/70">ref {adj.reference}</span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            CareIN does not post provider-level money — it belongs to no single claim.{" "}
            <Link
              href="/rcm/sop/takeback"
              className="underline underline-offset-2 hover:text-foreground"
              data-testid="plb-sop-link"
            >
              Handle it manually
            </Link>
            .
          </p>
        </div>
      )}

      {/* ── The source document ────────────────────────────────────────────── */}
      {r.upload && (
        <div
          className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-card px-4 py-3 text-sm"
          data-testid="source-document"
        >
          <a
            href={r.upload.documentUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-medium text-foreground underline-offset-4 hover:underline"
          >
            <ExternalLink size={14} />
            {r.upload.filename}
          </a>
          <span className="text-xs text-muted-foreground">
            Uploaded {stamp(r.upload.uploadedAt)}
            {" by "}
            {/* Null is "not recorded", never "the system did it" — rows uploaded
                before the staff crosswalk existed genuinely have no name. */}
            {r.upload.uploadedBy ?? <em className="not-italic text-muted-foreground/70">not recorded</em>}
          </span>

          {/* HOW THE NUMBERS ON THIS SCREEN WERE READ.
              Beside the document link rather than buried in the claims table:
              it applies to the whole remittance, and it is the first thing a
              biller checking a large check should know. A grey chip, because it
              is a fact rather than a warning — every arithmetic check on this
              page still applies, and the ones that block still block.
              Absent entirely for an 835 (parsed, never read) and for anything
              extracted before the OCR slice. */}
          {provenanceLabel(r.upload) && (
            <span
              className="inline-flex items-center gap-1.5 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground"
              data-testid="source-provenance"
              title={provenanceNote(r.upload) ?? undefined}
            >
              <ScanLine size={12} />
              {provenanceLabel(r.upload)}
            </span>
          )}
        </div>
      )}

      {matchError && (
        <div
          className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
          data-testid="batch-match-error"
        >
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>{matchError}</span>
        </div>
      )}

      {/* ── What a batch match just did ────────────────────────────────────── */}
      {matchResult && (
        <div
          className="mt-4 rounded-xl border border-border bg-card px-4 py-3 text-sm"
          data-testid="batch-match-result"
        >
          <div className="flex items-center gap-2 font-medium text-foreground">
            <Info size={14} />
            Matched {matchResult.matched.length} claim
            {matchResult.matched.length === 1 ? "" : "s"} against Open Dental
          </div>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {matchResult.matched.map((row) => (
              <li key={row.claimId}>
                {row.status === "failed"
                  ? `A claim could not be matched: ${row.error}`
                  : row.status === "already_confirmed"
                    ? "One claim was already confirmed and was left alone."
                    : row.status === "no_candidate"
                      ? "One claim has no matching claim in Open Dental."
                      : `${row.candidateCount} candidate${row.candidateCount === 1 ? "" : "s"}${row.ambiguous ? " — too close to call, needs a person" : ""}`}
              </li>
            ))}
          </ul>

          {/*
            THE UNFINISHED STATE IS ITS OWN LINE, not a sentence in a note.
            A run stopped by the clock leaves claims nobody has looked at, and
            "the note happened to mention it" is the same fragility that made
            `skipped` invisible: a boolean the server sends deserves a rendering
            of its own, so the screen cannot quietly stop saying it.
          */}
          {matchResult.outOfTime ? (
            <div
              className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
              data-testid="match-out-of-time"
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>
                Stopped at the {Math.round(matchResult.budgetMs / 1000)}-second budget —{" "}
                {matchResult.skipped} claim{matchResult.skipped === 1 ? "" : "s"} not yet examined.
                Press Match again to continue; claims nobody has looked at go first.
              </span>
            </div>
          ) : (
            matchResult.skipped > 0 && (
              <div
                className="mt-2 text-xs text-amber-700 dark:text-amber-400"
                data-testid="match-skipped"
              >
                {matchResult.note}
              </div>
            )
          )}
        </div>
      )}

      {/*
        ── POST THIS CHECK ─────────────────────────────────────────────────────
        Rendered only once this check HAS a posting — that is, only once somebody
        has approved it. Before then the next act is the approval, which is the
        panel below, and a Post button beside a check nothing has authorised
        would be a control whose precondition is invisible.

        ONE code path with the office-wide press: the same server route, narrowed
        by `queueId`. See the component's header.
      */}
      {plan && <PostThisCheck office={office} queueId={plan.queueId} onPosted={load} />}

      {/* ── The approval gate ──────────────────────────────────────────────── */}
      <ApprovalPanel
        office={office}
        batchId={r.batchId}
        onApproved={load}
        unmatchedCount={unmatchedCount}
        onRunMatch={runBatchMatch}
      />
      {/*
        D-6. Rendered BESIDE the ordinary panel rather than inside it, and it
        returns null when this remittance carries no takeback — so a biller
        never sees a takeback control on a remittance that has none, and never
        finds "approve nine claims" and "authorise a permanent write" behind the
        same button.

        It sits OUTSIDE the stepper deliberately: the stepper describes the
        ordinary path a remittance walks, and a takeback is not a step on it.
      */}
      <div className="mt-4">
        <RecoupmentPanel office={office} batchId={r.batchId} onApproved={load} />
      </div>

      {/* ── Claims ─────────────────────────────────────────────────────────── */}
      <h2 className="mt-8 text-lg font-semibold tracking-tight text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
        Claims
      </h2>

      {claims.length === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          This check carries no claims.
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {claims.map((claim) => (
            <ClaimCard
              key={claim.claimId}
              claim={claim}
              batchId={r.batchId}
              open={expanded.has(claim.claimId)}
              onToggle={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(claim.claimId)) next.delete(claim.claimId);
                  else next.add(claim.claimId);
                  return next;
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/rcm/remittances"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft size={14} />
      All checks
    </Link>
  );
}

function Stat({
  label,
  value,
  testId,
  hint,
}: {
  label: string;
  value: string;
  testId: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4" title={hint}>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

function ClaimCard({
  claim,
  batchId,
  open,
  onToggle,
}: {
  claim: RemittanceClaim;
  /** Threaded through so the claim page can offer a way back to this one. */
  batchId: string;
  open: boolean;
  onToggle: () => void;
}) {
  const deadEnd = claim.needsReviewReasons.some((r) => NO_ACTION_REASONS.has(r));
  /**
   * THE GATE IS PREDICTED HERE, AND IT BITES IN THE PANEL ABOVE.
   *
   * The ruling on "a Confirm button enabled above a red blocker": confirming
   * only LINKS a proposal to a chart claim, so it stays available — but the card
   * has to say that this confirmation cannot be approved, and why. Otherwise the
   * only place the consequence appears is at the gate, after somebody has
   * already committed the linkage.
   */
  const blocking = claim.needsReviewReasons.filter(isBlockingReason);

  return (
    <div className="rounded-xl border border-border bg-card" data-testid={`claim-card-${claim.claimId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{claim.patientName}</span>
            <span className="font-mono text-xs text-muted-foreground">#{claim.claimNumber}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${MATCH_STATUS_TONE[claim.odMatchStatus]}`}
              data-testid={`claim-match-state-${claim.claimId}`}
            >
              {matchStatusLabel(claim.odMatchStatus, claim.rejectedCandidates)}
              {claim.odClaimNum ? ` · ClaimNum ${claim.odClaimNum}` : ""}
            </span>
            {claim.reviewedAt && (
              <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
                Reviewed
              </span>
            )}
            {claim.postingQueueId && (
              <span
                className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-950/40 dark:text-sky-300"
                title="A person approved this claim for posting. Nothing has been written to Open Dental yet."
                data-testid={`claim-queued-${claim.claimId}`}
              >
                Approved — ready to post
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Service {day(claim.serviceDate)} · {claim.insuranceType}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="font-mono text-sm font-semibold tabular-nums text-foreground">
              {money(claim.totalPaidCents)}
            </div>
            <div className="font-mono text-xs tabular-nums text-muted-foreground">
              of {money(claim.totalBilledCents)} billed
            </div>
          </div>
          {/*
            "Review & match", not "Match".
            §15.2, finding 1: review and match live behind this link and approve
            lives above it, and nothing said so. The label now names BOTH things
            the claim page does, and `claimHref` carries this remittance's id so
            the claim screen can offer a way back — the claim endpoint does not
            return its own batch id (see the backend asks).
          */}
          <Link
            href={claimHref(claim.claimId, batchId)}
            data-testid={`open-claim-${claim.claimId}`}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            Review &amp; match
            <ChevronRight size={12} />
          </Link>
        </div>
      </div>

      {/* Review reasons — the flags Slices 4 and 5 wrote and nothing rendered. */}
      {claim.needsReviewReasons.length > 0 && (
        <div className="border-t border-border px-4 py-3" data-testid={`claim-flags-${claim.claimId}`}>
          {/*
            D-11: amber will WITHHOLD this claim at the approval gate; grey is
            true and does not change what to post. Both are always shown — a
            reason that vanished would make a proposal look cleaner than it is.
          */}
          <div className="flex flex-wrap gap-1.5">
            {claim.needsReviewReasons.map((reason) => (
              <span
                key={reason}
                data-testid={`claim-reason-${reason}`}
                className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${reasonTone(reason)}`}
              >
                {isBlockingReason(reason) && <AlertTriangle size={11} />}
                {reviewReasonLabel(reason)}
              </span>
            ))}
          </div>

          {blocking.length > 0 && (
            <p
              className="mt-2 flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300"
              data-testid={`claim-not-approvable-${claim.claimId}`}
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>
                Matching this claim to a chart is still worth doing — but it cannot be approved for
                posting while {blocking.length === 1 ? "this holds" : "these hold"}. See the approval
                checklist above.
              </span>
            </p>
          )}
          {deadEnd && (
            // Detect-and-flag means exactly that. A recoupment is the single
            // IRREVERSIBLE Open Dental operation, so there is no action offered
            // here — only an honest statement and the manual route.
            <p
              className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground"
              data-testid={`claim-no-action-${claim.claimId}`}
            >
              <CircleSlash size={12} className="mt-0.5 shrink-0" />
              <span>
                CareIN will not post this. A takeback cannot be reversed in Open Dental once it is
                written — handle it in Open Dental directly, following the practice's takeback
                procedure.
              </span>
            </p>
          )}
        </div>
      )}

      <button
        onClick={onToggle}
        data-testid={`toggle-lines-${claim.claimId}`}
        className="flex w-full items-center gap-1.5 border-t border-border px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40"
      >
        <ChevronRight size={12} className={open ? "rotate-90 transition-transform" : "transition-transform"} />
        {open ? "Hide" : "Show"} {claim.lines.length} procedure line
        {claim.lines.length === 1 ? "" : "s"}
      </button>

      {open && <LineTable claim={claim} />}
    </div>
  );
}

function LineTable({ claim }: { claim: RemittanceClaim }) {
  return (
    <div className="overflow-x-auto border-t border-border" data-testid={`lines-${claim.claimId}`}>
      <table className="w-full min-w-[52rem] text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2 text-left font-semibold">Code</th>
            <th className="px-2 py-2 text-right font-semibold">Billed</th>
            <th className="px-2 py-2 text-right font-semibold">Allowed</th>
            <th className="px-2 py-2 text-right font-semibold">Paid</th>
            <th className="px-2 py-2 text-right font-semibold">Write-off</th>
            <th className="px-2 py-2 text-right font-semibold">Pt resp.</th>
            <th className="px-4 py-2 text-left font-semibold">Adjustments</th>
          </tr>
        </thead>
        <tbody>
          {claim.lines.map((line) => (
            <tr key={line.lineId} className="border-b border-border last:border-b-0 align-top">
              <td className="px-4 py-2">
                <div className="font-mono text-sm text-foreground">{line.billedCode}</div>
                {/* A downcode keeps BOTH codes: the carrier adjudicated one and
                    the chart carries the other, and the difference is the money. */}
                {line.paidCode && line.paidCode !== line.billedCode && (
                  <div className="font-mono text-xs text-amber-700 dark:text-amber-400">
                    submitted as {line.paidCode}
                  </div>
                )}
                {line.description && (
                  <div className="max-w-[16rem] text-xs text-muted-foreground">{line.description}</div>
                )}
                {line.flags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {line.flags.map((flag) => (
                      <span
                        key={flag}
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${lineFlagTone(flag)}`}
                      >
                        {lineFlagLabel(flag)}
                      </span>
                    ))}
                  </div>
                )}
              </td>
              <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
                {money(line.billedCents)}
              </td>
              <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
                {money(line.allowedCents)}
              </td>
              <td className="px-2 py-2 text-right font-mono text-xs font-semibold tabular-nums text-foreground">
                {money(line.paidCents)}
              </td>
              <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
                {money(line.writeOffCents)}
              </td>
              <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
                {money(line.patientRespCents)}
              </td>
              <td className="px-4 py-2">
                {line.adjustments.length === 0 ? (
                  <span className="text-xs text-muted-foreground">—</span>
                ) : (
                  <ul className="space-y-1">
                    {line.adjustments.map((adj) => (
                      <li key={adj.adjustmentId} className="text-xs">
                        <span
                          className="font-mono font-medium text-foreground"
                          title={adj.groupDescription ?? undefined}
                        >
                          {adj.groupCode}-{adj.reasonCode}
                        </span>{" "}
                        <span className="font-mono tabular-nums text-muted-foreground">
                          {money(adj.amountCents)}
                        </span>
                        {/* Null description = a code not in the published list.
                            Rendered bare rather than glossed with a guess. */}
                        {adj.reasonDescription && (
                          <div className="text-muted-foreground">{adj.reasonDescription}</div>
                        )}
                        {adj.remarkCode && (
                          <div className="text-muted-foreground">
                            <span className="font-mono">{adj.remarkCode}</span>
                            {adj.remarkDescription ? ` — ${adj.remarkDescription}` : ""}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {line.adjustmentReason && (
                  <div className="mt-1 text-xs italic text-muted-foreground">{line.adjustmentReason}</div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
