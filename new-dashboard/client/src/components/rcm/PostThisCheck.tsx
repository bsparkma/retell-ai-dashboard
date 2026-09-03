/**
 * POST TO OPEN DENTAL, ON THE CHECK'S OWN PAGE.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THE BUTTON MOVED
 * ═════════════════════════════════════════════════════════════════════════════
 * §15.2, finding 1, one level up. Everything about a check happened here —
 * matching, checking over, approving — and then the last act happened somewhere
 * else, on an office-wide monitor where a biller had to find her row among
 * everyone else's and press a button whose scope was every approved check in the
 * practice. The step that actually moves money was the one step that took her
 * away from the thing she was working on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE CODE PATH. THE SAME SERVER FUNCTION AND THE SAME GUARDS.
 * ─────────────────────────────────────────────────────────────────────────────
 * This is NOT a second way to write to a chart. `POST /api/rcm/posting/drain`
 * has taken an optional `queueId` since 6c, and the narrowing is one extra
 * `AND queue_id = $3` inside the same office-scoped, status-filtered query that
 * the office-wide press runs. Everything downstream is byte-identical: the same
 * `rcm.post` middleware, the same in-handler permission re-check, the same
 * shadow-gate read, the same D-7 ceiling, the same forced write order, the same
 * mutex, the same audit row, the same one file allowed to reach an Open Dental
 * write verb.
 *
 * `tests/rcm-shell.test.tsx` proves it from the client side (both presses call
 * one function, and the only difference is the presence of `queueId`), and
 * `backend/routes/rcm/posting.test.js` proves it from the server's.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A DISABLED BUTTON ALWAYS SAYS WHY, BESIDE IT, NEVER IN A TOOLTIP
 * ─────────────────────────────────────────────────────────────────────────────
 * §15.2 finding 4. The practice reads these screens on a tablet, where a
 * tooltip does not exist. Three different silences, three different remedies,
 * and a biller must be able to tell which person to go to:
 *
 *   not your permission     an approver presses it — `canDrain`
 *   practice not validated  a code change with evidence — `postingEnabled`
 *   switched off (shadow)   an admin flips one toggle — `drainEnabled`
 *
 * One sentence for all three would send her to the wrong person twice out of
 * three times.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, FileCheck2, Loader2, Send } from "lucide-react";
import DisabledReason from "@/components/rcm/DisabledReason";
import {
  drainPostingQueue,
  getPostingPlan,
  RcmApiError,
  type PostingQueueDetail,
  type PostingQueueStatus,
  type RcmOfficeId,
} from "@/features/rcm/api";
import { money } from "@/features/rcm/format";
import { QUEUE_STATE_COPY, SHADOW_MODE_COPY, queueStateTone } from "@/features/rcm/posting";
import { officeStamp } from "@/features/rcm/time";
import { PostedOutcome, StuckAfterPosting } from "@/components/rcm/PostedOutcome";

/**
 * The states the server will actually accept a press for.
 *
 * MIRRORS `DRAINABLE_STATUSES` in `services/rcm/postingDrain.js`. A press on
 * anything else is not refused with a nice message — it selects zero rows and
 * reports a run that did nothing, which reads to a person as a button that
 * silently failed. Better to not offer it.
 *
 * `withdrawn` is deliberately absent and is the whole reason that state exists:
 * it is terminal, and §2.2.1 defines `blocked` by the promise that it has a way
 * out. Offering Post on a retired check would make that promise false.
 */
const POSTABLE: ReadonlySet<PostingQueueStatus> = new Set<PostingQueueStatus>([
  "approved",
  "failed",
  "partially_posted",
  "blocked",
]);

type State =
  | { kind: "loading" }
  | { kind: "loaded"; detail: PostingQueueDetail }
  | { kind: "failed"; message: string };

export default function PostThisCheck({
  office,
  queueId,
  onPosted,
  batchId = null,
  nextClaimId = null,
  remaining = 0,
}: {
  office: RcmOfficeId;
  queueId: string;
  /** Re-read the check, so its rail and its claims catch up with the chart. */
  onPosted: () => void;
  /**
   * The check this posting belongs to, and what is left on it (Stage C, §7).
   *
   * All three OPTIONAL and all three default to the reading that offers
   * nothing: this component is rendered from the check's own page, which knows
   * them, and `tests/rcm-shell.test.tsx` renders it bare, which does not. A
   * "Next claim" button pointing at nothing would be worse than no button.
   */
  batchId?: string | null;
  nextClaimId?: string | null;
  remaining?: number;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [posting, setPosting] = useState(false);
  const [pressError, setPressError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    getPostingPlan(office, queueId)
      .then((detail) => {
        if (!cancelled) setState({ kind: "loaded", detail });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "failed",
          message:
            err instanceof RcmApiError && err.notEntitled
              ? "This practice is not set up for the RCM module."
              : err instanceof Error
                ? err.message
                : "Could not read this check's posting.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [office, queueId, attempt]);

  const press = useCallback(async () => {
    setPosting(true);
    setPressError(null);
    try {
      await drainPostingQueue(office, { queueId });
      // Re-read BOTH: this panel, so its own words come from the server rather
      // than from what the press hoped for, and the check around it, so the rail
      // and every claim catch up at the same instant. A panel that congratulated
      // itself while the page behind it still said "ready to post" would be two
      // screens disagreeing about the chart.
      setAttempt((n) => n + 1);
      onPosted();
    } catch (err) {
      /*
       * THE SERVER'S OWN SENTENCE, verbatim.
       *
       * The refusal a person most often meets here — the shadow gate — arrives
       * as a 409 with `DRAIN_DISABLED_FOR_OFFICE` and a sentence written for
       * exactly this moment. Replacing it with "posting failed" would throw away
       * the one thing that says nothing is wrong and the work is safe.
       */
      setPressError(
        err instanceof RcmApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "The posting could not be run.",
      );
    } finally {
      setPosting(false);
    }
  }, [office, queueId, onPosted]);

  if (state.kind === "loading") {
    return (
      <div
        className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground"
        data-testid="post-this-check-loading"
      >
        <Loader2 size={14} className="animate-spin" />
        Reading this check's posting…
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div
        className="mt-4 flex items-start gap-2 rounded-xl border border-border bg-card p-4 text-sm text-destructive"
        data-testid="post-this-check-error"
      >
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>{state.message}</span>
      </div>
    );
  }

  const { plan, canDrain, drainRequires, postingEnabled, drainEnabled } = state.detail;
  const copy = QUEUE_STATE_COPY[plan.statusLabel];
  const postable = POSTABLE.has(plan.status);

  /*
   * THE ONE REASON, in the order a person can act on it.
   *
   * Permission first — it is about who is standing there. Then the code ceiling,
   * then the switch, because those two are about the practice and one is a much
   * bigger ask than the other.
   */
  const reason = !canDrain
    ? `Posting to a chart needs ${drainRequires} — ask an approver to press it.`
    : !postingEnabled
      ? "This practice has not been switched on for posting yet. Its own Open Dental settings have to be read and proven first; the other practice is unaffected."
      : !drainEnabled
        ? SHADOW_MODE_COPY.reason(office)
        : null;

  return (
    <section
      className="mt-4 rounded-xl border border-border bg-card p-4"
      data-testid="post-this-check"
      aria-label="Post this check to Open Dental"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-foreground">Post to Open Dental</h2>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${queueStateTone(plan.statusLabel)}`}
            data-testid="post-this-check-state"
          >
            {/*
              THE ONE WORD A BILLER READS ABOUT THIS CHECK'S STATE.
              `posted` reads "Finished" HERE and "Posted" on the monitor, and
              that is deliberate rather than drift: on the check's own page the
              question is "am I done with this one", and the answer is yes.
            */}
            {plan.statusLabel === "posted" ? "Finished" : copy.label}
          </span>
        </div>

        {plan.statusLabel === "posted" ? null : postable ? (
          <div className="flex flex-col items-end gap-1">
            <button
              onClick={press}
              disabled={posting || reason !== null}
              data-testid="post-this-check-button"
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {posting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {posting ? "Posting…" : "Post to Open Dental"}
            </button>
            {/* ADJACENT, never a tooltip. See the header. */}
            {reason && (
              <DisabledReason testId="post-this-check-reason">{reason}</DisabledReason>
            )}
            {!reason && (
              <DisabledReason testId="post-this-check-note">
                Writes this check's payments into patient charts. Only this check.
              </DisabledReason>
            )}
          </div>
        ) : (
          <DisabledReason testId="post-this-check-not-postable">{copy.hint}</DisabledReason>
        )}
      </div>

      <p className="mt-1 text-sm text-muted-foreground" data-testid="post-this-check-hint">
        {plan.statusLabel === "posted"
          ? "This check is finished. The money is in Open Dental, and CareIN asked Open Dental for it afterwards and got back exactly these lines."
          : copy.hint}
      </p>

      {/*
        ── WHAT ACTUALLY HAPPENED, in place ──────────────────────────────────
        SUPPRESSED on the two ENDINGS below, which say it better and in the
        right order. On a STUCK check in particular this block was appearing
        ABOVE "the payment did reach Open Dental — do not enter it again", in a
        calm green, repeating the same payment number. §7 puts that sentence
        first and loudest for a reason: a biller who re-enters the payment has
        paid a claim twice and nothing here can take it back, and a reassuring
        green box above it is exactly what makes a warning skimmable.
      */}
      {plan.odClaimPaymentNum != null &&
        plan.statusLabel !== "posted" &&
        plan.status !== "partially_posted" && (
        <div
          className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/50 p-3 dark:border-emerald-900/60 dark:bg-emerald-950/15"
          data-testid="post-this-check-proof"
        >
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <CheckCircle2 size={14} />
            Open Dental check #{plan.odClaimPaymentNum}
            <span className="font-mono tabular-nums text-muted-foreground">
              {money(plan.postedTotalCents)}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="post-this-check-readback">
            {plan.reconciledAt
              ? `Confirmed in Open Dental on ${officeStamp(plan.reconciledAt, office)} — CareIN asked for the check afterwards and it carries exactly these lines.`
              : "The check exists in Open Dental. It has not been confirmed by asking for it back yet."}
          </p>
        </div>
      )}

      {/*
        ── THE TWO ENDINGS (Stage C, §7) ─────────────────────────────────────
        A finished check and a check whose patient balance came back wrong were
        the same panel with different text in it, and the second one is the most
        consequential screen in this product. `PostedOutcome.tsx` gives each its
        own shape — and puts "the payment DID land, do not enter it again" first
        and loudest on the second, because a biller who re-enters it has paid a
        claim twice and nothing here can take that back.
      */}
      {plan.statusLabel === "posted" ? (
        <PostedOutcome
          detail={state.detail}
          office={office}
          batchId={batchId}
          nextClaimId={nextClaimId}
          remaining={remaining}
        />
      ) : plan.status === "partially_posted" ? (
        <StuckAfterPosting detail={state.detail} office={office} batchId={batchId} />
      ) : (
        /* THE EOB LINE — its own axis, and `none` is an answer rather than a
           failure: an 835 is not a document anybody would open, so there was
           nothing to file and the server says so. On the two ENDINGS above it
           is folded into their own copy, where it belongs beside the rest of
           what did or did not land. */
        plan.documentAttachStatus && (
          <p
            className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"
            data-testid="post-this-check-eob"
          >
            <FileCheck2 size={12} />
            {plan.documentAttachStatus === "attached"
              ? "The EOB was filed into each patient's chart."
              : plan.documentAttachStatus === "partial"
                ? "The EOB was filed into some patients' charts and not others. The posting history says which."
                : plan.documentAttachStatus === "failed"
                  ? "The EOB could not be filed. The payment itself is unaffected."
                  : "No EOB to file — this check came in as an 835, which is not a document anybody would open."}
          </p>
        )
      )}

      {pressError && (
        <div
          className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
          data-testid="post-this-check-press-error"
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>{pressError}</span>
        </div>
      )}

      {plan.lastError && plan.statusLabel !== "posted" && plan.status !== "partially_posted" && (
        <p className="mt-2 text-xs text-rose-700 dark:text-rose-400" data-testid="post-this-check-last-error">
          {plan.lastError}
        </p>
      )}

      <p className="mt-2 text-xs text-muted-foreground">
        <Link
          href="/rcm/posting"
          className="font-medium text-foreground underline-offset-4 hover:underline"
          data-testid="post-this-check-monitor-link"
        >
          Open the Posting screen
        </Link>{" "}
        to see every check in this practice, line by line, with what each one has already written.
      </p>
    </section>
  );
}
