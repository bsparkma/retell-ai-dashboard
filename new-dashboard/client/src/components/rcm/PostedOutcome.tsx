/**
 * WHAT HAPPENED AFTER THE POST — the two endings (Stage C, §7).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FINISHED, AND STUCK. THEY ARE NOT THE SAME SCREEN.
 * ═════════════════════════════════════════════════════════════════════════════
 * B2 already said everything true about both. What it did not do was give them
 * a shape: a finished check and a check whose patient balance came back wrong
 * were the same panel with different text in it, and the second one is the most
 * consequential screen in this product.
 *
 *   FINISHED   the confirmed-register verdict, what LANDED in Open Dental
 *              field by field, and where to go next.
 *   STUCK      three things, in this order and no other:
 *                1. the payment DID reach Open Dental. Do not enter it by hand.
 *                2. the two numbers side by side, and what it means for a person.
 *                3. numbered steps that name the claim, the payment, the line
 *                   and the amount — ending with a way to check, not to guess.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY (1) IS FIRST AND IS THE LOUDEST THING ON THE SCREEN
 * ═════════════════════════════════════════════════════════════════════════════
 * `partially_posted` means money MOVED and one figure came back other than
 * promised. A biller who reads "stuck" and reaches for the desktop to post the
 * payment again has just paid a patient's claim twice, and no part of this
 * product can take that back. So the first thing on the screen is the payment
 * number and an instruction not to re-enter it — before the problem, before the
 * numbers, before anything she might act on.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE RE-CHECK IS A READ, AND THE LABEL IS ALLOWED TO SAY SO
 * ═════════════════════════════════════════════════════════════════════════════
 * `POST /posting/:id/recheck` re-runs the confirmation against the existing
 * plan, calls two Open Dental GETs, and writes nothing — not a chart, not the
 * plan's status, not CareIN's own record of the verdict. That is what lets the
 * last remediation step read *"Check it again"* honestly.
 *
 * Before it existed the only way to ask was to press Post, because the
 * confirmation ran inside the post. "Press the button that writes to a chart, in
 * order to read" is a sentence this project keeps deleting.
 *
 * A re-check that AGREES does not finish the check by itself and does not
 * pretend to: the plan is still `partially_posted` until somebody presses Post,
 * and the panel says exactly that.
 *
 * NO REAL PATIENT DATA anywhere in this file.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import {
  recheckPosting,
  RcmApiError,
  type PostingQueueDetail,
  type PostingRecheck,
  type RcmOfficeId,
} from "@/features/rcm/api";
import { money } from "@/features/rcm/format";
import { officeStamp } from "@/features/rcm/time";
import { claimHref } from "@/features/rcm/flow";

/** First-seen order, no duplicates. `[...new Set()]` needs downlevelIteration. */
function unique(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) if (!out.includes(v)) out.push(v);
  return out;
}

/**
 * WHAT LANDED IN OPEN DENTAL, added up from the plan's own lines.
 *
 * Every figure is one the drain WROTE, read off the posting lines it wrote them
 * from — not a re-derivation of what it meant to write. The two write-offs stay
 * apart, because the carrier's contractual figure and the office's own
 * concession are different decisions by different parties and a screen showing
 * only their sum shows a number nobody decided.
 */
function landed(detail: PostingQueueDetail) {
  const ordinary = detail.lines.filter((l) => !l.isSupplemental);
  return {
    paymentCents: ordinary.reduce((n, l) => n + l.intendedInsPayAmtCents, 0),
    contractualCents: ordinary.reduce((n, l) => n + l.intendedWriteOffCents, 0),
    decidedCents: ordinary.reduce((n, l) => n + (l.decidedWriteOffCents ?? 0), 0),
    /** What the check PROMISED the patients would owe. Null when nothing froze one. */
    promisedCents: ordinary.some((l) => l.intendedPatientCents != null)
      ? ordinary.reduce((n, l) => n + (l.intendedPatientCents ?? 0), 0)
      : null,
    /** The reasons behind the office's own write-offs, deduplicated. */
    reasons: unique(
      ordinary
        .filter((l) => (l.decidedWriteOffCents ?? 0) > 0 && l.decidedReason)
        .map((l) => String(l.decidedReason)),
    ),
    decidedBy: unique(
      ordinary
        .filter((l) => (l.decidedWriteOffCents ?? 0) > 0 && l.decidedBy)
        .map((l) => String(l.decidedBy)),
    ),
  };
}

/** How the EOB filing went, in one sentence. `none` is an answer, not a failure. */
function eobSentence(status: PostingQueueDetail["plan"]["documentAttachStatus"]): string {
  switch (status) {
    case "attached":
      return "The EOB was filed into each patient's chart.";
    case "partial":
      return "The EOB was filed into some patients' charts and not others. The posting history says which.";
    case "failed":
      return "The EOB could not be filed. The payment itself is unaffected.";
    case "none":
      return "No EOB to file — this check came in as an 835, which is not a document anybody would open.";
    default:
      return "The EOB filing was never attempted. That is work somebody still owes.";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FINISHED
// ═══════════════════════════════════════════════════════════════════════════

export function PostedOutcome({
  detail,
  office,
  batchId,
  nextClaimId,
  remaining,
}: {
  detail: PostingQueueDetail;
  office: RcmOfficeId;
  /** The check this posting belongs to, for the links out. */
  batchId: string | null;
  /** The next claim on this check that still needs somebody, if there is one. */
  nextClaimId: string | null;
  /** How many claims on this check are still unfinished. */
  remaining: number;
}) {
  const { plan } = detail;
  const l = landed(detail);

  return (
    <div className="mt-3" data-testid="posted-outcome">
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4 dark:border-emerald-900/60 dark:bg-emerald-950/15">
        <div className="flex items-start gap-2">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div>
            <p className="text-sm font-medium text-foreground" data-testid="posted-verdict">
              {plan.reconciledAt
                ? `Confirmed in Open Dental on ${officeStamp(plan.reconciledAt, office)} — the patients owe what this check said they would.`
                : "The check exists in Open Dental. It has not been confirmed by asking for it back yet."}
            </p>
            {/*
              THE REGISTER, NAMED. This figure was MEASURED out of the chart
              after the post, not computed by this app from what it meant to
              write — which is the whole difference between a confirmation and a
              projection wearing its words.
            */}
            <p className="mt-0.5 text-xs text-muted-foreground" data-testid="posted-register">
              Read out of the chart after posting, not calculated by this app.
            </p>
          </div>
        </div>
      </div>

      {/* ── WHAT LANDED IN OPEN DENTAL ─────────────────────────────────────── */}
      <div className="mt-3 rounded-lg border border-border bg-card p-4" data-testid="posted-landed">
        <h3 className="text-sm font-semibold text-foreground">What landed in Open Dental</h3>
        <dl className="mt-2 space-y-1.5 text-sm">
          <Row label="Payment entered as" value={money(l.paymentCents)} />
          <Row
            label="Open Dental payment number"
            value={plan.odClaimPaymentNum == null ? "not recorded" : `#${plan.odClaimPaymentNum}`}
            testId="posted-payment-num"
          />
          <Row label="Contractual write-offs" value={money(l.contractualCents)} />
          {l.decidedCents > 0 && (
            <Row
              label="Write-off this office chose"
              value={money(l.decidedCents)}
              testId="posted-office-writeoff"
              note={
                l.reasons.length > 0
                  ? `${l.reasons.join(" · ")}${l.decidedBy.length > 0 ? ` — decided by ${l.decidedBy.join(", ")}` : ""}. Recorded in CareIN; the chart holds the money, not the reason.`
                  : undefined
              }
            />
          )}
          <Row
            label="The patients' balance now"
            value={l.promisedCents === null ? "not recorded" : money(l.promisedCents)}
            testId="posted-balance"
            note={
              l.promisedCents === null
                ? "This check was approved before the promise was frozen, so there is no single figure to quote. The confirmation above still ran, line by line."
                : "Confirmed against the chart, line by line — not only against the total."
            }
          />
          <Row label="The EOB" value={eobSentence(plan.documentAttachStatus)} />
        </dl>
      </div>

      {/* ── WHAT'S LEFT ON THIS CHECK ──────────────────────────────────────── */}
      <div className="mt-3 rounded-lg border border-border bg-background p-3" data-testid="posted-whats-left">
        {remaining > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-foreground">
              {remaining} claim{remaining === 1 ? "" : "s"} on this check still need
              {remaining === 1 ? "s" : ""} somebody.
            </span>
            {nextClaimId && (
              <Link
                href={claimHref(nextClaimId, batchId)}
                data-testid="posted-next-claim"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                Next claim
              </Link>
            )}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">
            Nothing else on this check needs anybody. It is done.
          </span>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// STUCK AFTER POSTING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * How long the re-check button rests after a press, in seconds.
 *
 * Short enough that somebody genuinely waiting on a correction is not
 * obstructed; long enough that leaning on the button cannot turn one look into
 * a queue of Open Dental reads. See the note beside `restingFor` below.
 */
const RECHECK_REST_SECONDS = 6;

export function StuckAfterPosting({
  detail,
  office,
  batchId,
}: {
  detail: PostingQueueDetail;
  office: RcmOfficeId;
  batchId: string | null;
}) {
  const { plan } = detail;
  const l = landed(detail);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<PostingRecheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [restingFor, setRestingFor] = useState(0);

  /*
    THE BUTTON RESTS BETWEEN PRESSES.

    Every press is two Open Dental reads, and RCM shares ONE Open Dental
    credential with the voice side, paced at 1200ms per key (D-8). A check that
    is stuck and a person who wants it unstuck is a realistic pairing, so a
    double-click is four calls that a running drain then waits behind.

    This is NOT a rate limit — the server has no opinion about how often you
    look — and it is not a new state. It is a few seconds of rest, and the
    button says why rather than going quietly grey.
  */
  useEffect(() => {
    if (restingFor <= 0) return;
    const t = setTimeout(() => setRestingFor((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [restingFor]);

  /** The claims whose read-back did not agree, from the last re-check. */
  const disagreeing = (checked?.claims ?? []).filter((c) => c.verdict.state === "red");

  async function recheck() {
    setChecking(true);
    setCheckError(null);
    try {
      setChecked(await recheckPosting(office, plan.queueId));
    } catch (err) {
      setChecked(null);
      setCheckError(
        err instanceof RcmApiError || err instanceof Error
          ? err.message
          : "Open Dental could not be asked just now.",
      );
    } finally {
      setChecking(false);
      setRestingFor(RECHECK_REST_SECONDS);
    }
  }

  return (
    <div className="mt-3" data-testid="stuck-after-posting">
      {/* ── 1. THE PAYMENT DID LAND. DO NOT ENTER IT AGAIN. ─────────────────
          FIRST and LOUDEST. A biller who reads "stuck" and reaches for the
          desktop to re-enter the payment has just paid a claim twice, and
          nothing in this product can take that back. */}
      <div
        className="rounded-lg border-2 border-amber-400 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/30"
        data-testid="stuck-money-landed"
      >
        <div className="flex items-start gap-2">
          <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
          <div>
            <p className="text-base font-semibold text-foreground">
              The payment did reach Open Dental. Do not enter it again by hand.
            </p>
            <p className="mt-1 text-sm text-foreground">
              {/*
                A MISSING PAYMENT NUMBER IS ITS OWN SENTENCE, not a `#` glued to
                the word "not". `partially_posted` can be reached before the
                check itself was created — the drain records where it stopped —
                and rendering "check #not recorded" would be an identifier a
                biller would go looking for in Open Dental.
              */}
              {plan.odClaimPaymentNum == null ? (
                <>
                  It is on the chart for{" "}
                  <span className="font-mono">{money(l.paymentCents)}</span>, but this app did not
                  record the Open Dental check number
                  {plan.finishedAt ? ` when it stopped at ${officeStamp(plan.finishedAt, office)}` : ""}
                  . Find it on the patient&rsquo;s ledger before you do anything else — and do not
                  enter a second payment.
                </>
              ) : (
                <>
                  It is on the chart as check{" "}
                  <span className="font-mono font-semibold">#{plan.odClaimPaymentNum}</span> for{" "}
                  <span className="font-mono">{money(l.paymentCents)}</span>
                  {plan.finishedAt ? `, posted ${officeStamp(plan.finishedAt, office)}` : ""}. What
                  is wrong is one figure below it, not the payment.
                </>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* ── 2. THE TWO NUMBERS, SIDE BY SIDE ────────────────────────────────── */}
      <div className="mt-3 rounded-lg border border-border bg-card p-4" data-testid="stuck-numbers">
        <h3 className="text-sm font-semibold text-foreground">
          What this check promised, and what the chart says
        </h3>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-border bg-background p-3">
            <div className="text-xs font-medium text-muted-foreground">
              What this check promised
            </div>
            <div
              className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground"
              data-testid="stuck-promised"
            >
              {l.promisedCents === null ? "—" : money(l.promisedCents)}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Frozen when somebody approved this check. It is what the screen said the patients
              would owe.
            </p>
          </div>
          <div className="rounded-md border border-rose-200 bg-rose-50/50 p-3 dark:border-rose-900 dark:bg-rose-950/20">
            <div className="text-xs font-medium text-muted-foreground">What the chart says</div>
            <div
              className="mt-1 text-sm font-medium text-rose-800 dark:text-rose-300"
              data-testid="stuck-measured"
            >
              {/* THE SERVER'S OWN SENTENCE — the verdict that stopped the plan,
                  already written and already formatted. Never a paraphrase. */}
              {plan.lastError ?? "Open Dental disagreed with what this check promised."}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Measured out of Open Dental after the post, line by line.
            </p>
          </div>
        </div>

        {/* THE HUMAN CONSEQUENCE. A biller reading two numbers has to work out
            what happens to a person; saying it is one sentence and it is the
            sentence that makes the next five minutes urgent. */}
        <p
          className="mt-3 text-sm font-medium text-foreground"
          data-testid="stuck-consequence"
        >
          Until this is sorted, a patient on this check would be billed the wrong amount. The
          payment is fine; what is missing is on the line the sentence above names.
        </p>
      </div>

      {/* ── 3. WHAT TO DO, NUMBERED ─────────────────────────────────────────── */}
      <div className="mt-3 rounded-lg border border-border bg-card p-4" data-testid="stuck-steps">
        <h3 className="text-sm font-semibold text-foreground">What to do</h3>
        <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm text-foreground">
          <li>
            Open the claim the sentence above names in Open Dental.
            {plan.odClaimPaymentNum != null ? (
              <>
                {" "}
                Its check is <span className="font-mono">#{plan.odClaimPaymentNum}</span>
              </>
            ) : (
              " The Open Dental check number was not recorded — find the payment on the patient's ledger"
            )}
            {plan.checkNumber ? (
              <>
                {" "}
                and the carrier&rsquo;s is <span className="font-mono">{plan.checkNumber}</span>
              </>
            ) : null}
            .
          </li>
          <li>
            Compare the line named above against what this check promised —{" "}
            <span className="font-mono">
              {l.promisedCents === null ? "the figure on the claim's own screen" : money(l.promisedCents)}
            </span>{" "}
            across the check
            {l.decidedCents > 0 ? (
              <>
                , of which <span className="font-mono">{money(l.decidedCents)}</span> is a write-off
                this office chose
              </>
            ) : null}
            .
          </li>
          <li>
            Correct it in Open Dental. <strong>Do not add a second payment</strong> — the money is
            already there; it is the write-off or the patient portion on the line that needs
            changing.
          </li>
          <li>
            Then check it again below. That asks Open Dental and writes nothing — it will say
            whether the correction took.
          </li>
          <li>
            When it agrees, press <strong>Post to Open Dental</strong> above to finish the check
            off. Nothing else on it posts until then.
          </li>
        </ol>

        {/* ── THE RE-CHECK. A READ, and the label says so. ────────────────── */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={recheck}
            disabled={checking || restingFor > 0}
            data-testid="stuck-recheck"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {checking ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            {checking
              ? "Asking Open Dental…"
              : restingFor > 0
                ? `Asked just now — ready again in ${restingFor}s`
                : "Check it again"}
          </button>
          <span className="text-xs text-muted-foreground">
            {restingFor > 0
              ? "Each look asks Open Dental twice, over the one connection the rest of CareIN shares."
              : "Reads the chart and writes nothing to it."}
          </span>
        </div>

        {checkError && (
          <p
            className="mt-2 flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300"
            data-testid="stuck-recheck-error"
          >
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{checkError}</span>
          </p>
        )}

        {checked && (
          <div
            className={`mt-2 rounded-md border p-3 text-sm ${
              checked.agreed
                ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/20"
                : "border-rose-200 bg-rose-50/50 dark:border-rose-900 dark:bg-rose-950/20"
            }`}
            data-testid="stuck-recheck-result"
          >
            {checked.agreed ? (
              <>
                <p className="font-medium text-foreground">
                  Open Dental now says what this check promised.
                </p>
                {/* IT DID NOT FINISH THE CHECK, AND DOES NOT SAY IT DID. */}
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Nothing was written and this check has not moved. Press{" "}
                  <strong>Post to Open Dental</strong> above to finish it off.
                </p>
              </>
            ) : (
              <>
                <p className="font-medium text-foreground">Still not right.</p>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {disagreeing.map((c) => (
                    <li key={c.claimId ?? c.odClaimNum}>
                      {/* THE SERVER'S OWN SENTENCE, from the same function the
                          post's own confirmation used. */}
                      Open Dental claim {c.odClaimNum} — {c.verdict.sentence}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">
              Asked {officeStamp(checked.checkedAt, office)}.
            </p>
          </div>
        )}

        {batchId && (
          <p className="mt-3 text-xs text-muted-foreground">
            <FileCheck2 size={11} className="mr-1 inline align-[-1px]" />
            The EOB was deliberately not filed on this path — a check that needs a person should
            not quietly finish its paperwork.
          </p>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: string;
  note?: string;
  testId?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="text-right font-mono tabular-nums text-foreground" data-testid={testId}>
          {value}
        </dd>
      </div>
      {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
