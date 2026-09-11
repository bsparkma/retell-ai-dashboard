/**
 * WHAT HAPPENED AFTER THE POST — the two endings (Stage C, §7; rebuilt in S5).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FINISHED, AND STUCK. THEY ARE NOT THE SAME SCREEN.
 * ═════════════════════════════════════════════════════════════════════════════
 *   FINISHED   what each patient owes AS MEASURED out of Open Dental, what
 *              landed there field by field, what is left on the check, and the
 *              deposit step this app does not do yet.
 *   STUCK      one of TWO screens, and which one is the whole of W-16:
 *
 *                STOPPED   the run stopped before it compared anybody's balance
 *                          with anything. It says where it stopped and offers the
 *                          next posting pass. It gives NO instruction to change a
 *                          chart — nothing measured the chart.
 *                MEASURED  the run read every claim back and a patient's number
 *                          came back other than promised. In this order and no
 *                          other:
 *                            1. the payment DID reach Open Dental; do not enter it
 *                               again. Green, first, loudest.
 *                            2. what this app promised beside what the chart says
 *                               now, and what that means for a person.
 *                            3. numbered steps naming the account, the claim, the
 *                               payment, the line, the amount and the adjustment
 *                               type — then a READ to check, then the post.
 *
 * `stuckKind()` in `features/rcm/posting.ts` decides which, and its header says
 * why it reads the drain's STEP and not `reconciledAt` (PM ruling 2026-09-10).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EVERY PATIENT FIGURE HERE WAS MEASURED
 * ═════════════════════════════════════════════════════════════════════════════
 * Both endings quote what a patient owes, and the only figure allowed is the one
 * the drain read back out of Open Dental and recorded on the claim — served by
 * the claim detail route, see `features/rcm/confirmed.ts`. When that reading is
 * not in hand the screen says what the CHECK proved and quotes no patient figure,
 * rather than printing the promise under a heading that claims a measurement.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE RE-CHECK IS A READ, AND ITS LABEL SAYS SO — MEASURED BRANCH ONLY
 * ═════════════════════════════════════════════════════════════════════════════
 * `POST /posting/:id/recheck` re-runs the confirmation, calls two Open Dental
 * GETs, and writes nothing — not a chart, not the posting's state. It is offered
 * where there is a measured disagreement to re-measure, and nowhere else: on the
 * stopped branch there is nothing to compare against, and a "check it again"
 * there would invite exactly the chart edit W-16 exists to prevent.
 *
 * A re-check that comes back clean takes the stuck panel DOWN — the problem it
 * described is gone — and leaves one honest sentence: the chart agrees now, and
 * one press finishes the check. It does not show "Finished": nothing moved, the
 * posting is still part-way, and the Post press is what finishes it (and then
 * the finished screen appears, from the server's own state).
 *
 * NO REAL PATIENT DATA anywhere in this file.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  Loader2,
  PauseCircle,
  RefreshCw,
} from "lucide-react";
import {
  getRcmOfficeSettings,
  recheckPosting,
  RcmApiError,
  type PostingQueueDetail,
  type PostingRecheck,
  type RcmOfficeId,
  type RcmOfficeSettings,
} from "@/features/rcm/api";
import { money } from "@/features/rcm/format";
import { officeStamp } from "@/features/rcm/time";
import { claimHref } from "@/features/rcm/flow";
import { stoppedWhile, stuckKind } from "@/features/rcm/posting";
import {
  chartsPhrase,
  consequenceSentence,
  disagreementsOf,
  lineWords,
  measuredOutcome,
  useConfirmedClaims,
  type Disagreement,
} from "@/features/rcm/confirmed";
import { useAuth } from "@/contexts/AuthContext";
import { can } from "@/lib/permissions";
import DisabledReason from "@/components/rcm/DisabledReason";
import DepositComingSoon from "@/components/rcm/DepositComingSoon";

/** First-seen order, no duplicates. `[...new Set()]` needs downlevelIteration. */
function unique(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) if (!out.includes(v)) out.push(v);
  return out;
}

/**
 * WHAT THE POST WROTE, added up from the posting's own lines.
 *
 * Every figure is one the run WROTE, read off the lines it wrote them from. The
 * two write-offs stay apart: the carrier's contractual figure and the office's
 * own concession are different decisions by different parties.
 *
 * The PROMISE is here too, because the stuck screen's fallback needs it — but it
 * is never printed as what a patient owes. That figure only ever comes from
 * `features/rcm/confirmed.ts`.
 */
function landed(detail: PostingQueueDetail) {
  const ordinary = detail.lines.filter((l) => !l.isSupplemental);
  const paidAt = ordinary
    .map((l) => l.paidAt)
    .filter((t): t is string => typeof t === "string")
    .sort();
  return {
    lineCount: ordinary.length,
    paymentCents: ordinary.reduce((n, l) => n + l.intendedInsPayAmtCents, 0),
    contractualCents: ordinary.reduce((n, l) => n + l.intendedWriteOffCents, 0),
    /** What the check PROMISED the patients would owe. Null when nothing froze one. */
    promisedCents: ordinary.some((l) => l.intendedPatientCents != null)
      ? ordinary.reduce((n, l) => n + (l.intendedPatientCents ?? 0), 0)
      : null,
    /** The office's own write-offs, per line, from the posting — the fallback when no verdict is in hand. */
    lineDecisions: ordinary
      .filter((l) => (l.decidedWriteOffCents ?? 0) > 0)
      .map((l) => ({
        amountCents: l.decidedWriteOffCents ?? 0,
        reason: l.decidedReason ? String(l.decidedReason) : null,
      })),
    /** Did this run book any office write-off as a ledger adjustment? */
    bookedAdjustment: ordinary.some((l) => l.odWriteoffAdjustmentNum != null),
    /** When the payment went onto the check — the latest line, in the office's zone. */
    paidAt: paidAt.length > 0 ? paidAt[paidAt.length - 1] : null,
  };
}

/** "claim #53648" / "claims #1 and #2" / "this check's claims". */
function claimsPhrase(detail: PostingQueueDetail): string {
  const nums = unique(
    detail.claims.map((c) => (c.odClaimNum == null ? "" : `#${c.odClaimNum}`)).filter(Boolean),
  );
  if (nums.length === 0) return "this check's claims";
  if (nums.length === 1) return `claim ${nums[0]}`;
  return `claims ${nums.slice(0, -1).join(", ")} and ${nums[nums.length - 1]}`;
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
  checkAmountCents = null,
}: {
  detail: PostingQueueDetail;
  office: RcmOfficeId;
  /** The check this posting belongs to, for the links out. */
  batchId: string | null;
  /** The next claim on this check that still needs somebody, if there is one. */
  nextClaimId: string | null;
  /** How many claims on this check are still unfinished. */
  remaining: number;
  /** The carrier's check total, for the deposit card. Null renders a dash. */
  checkAmountCents?: number | null;
}) {
  const { plan } = detail;
  const l = landed(detail);
  const read = useConfirmedClaims(
    office,
    detail.claims.map((c) => c.claimId),
  );
  const measured = measuredOutcome(read);
  const latestConfirmed = measured
    ? measured.claims
        .map((c) => c.confirmedAt)
        .filter((t): t is string => typeof t === "string")
        .sort()
        .pop() ?? null
    : null;

  /*
   * THE OFFICE'S OWN WRITE-OFFS, code · amount · reason.
   *
   * From the measured verdicts when they are in hand — they carry the procedure
   * code and the name of whoever decided — and from the posting's own lines
   * otherwise, which carry the amount and the reason but no code. Either way
   * nothing here re-derives an amount.
   */
  const writeoffs: { code: string | null; amountCents: number; reason: string | null; by: string | null }[] =
    measured
      ? measured.claims.flatMap((c) =>
          c.verdict.decisions
            .filter((d) => d.amountCents > 0)
            .map((d) => ({
              code: d.code || null,
              amountCents: d.amountCents,
              reason: d.reasonLabel ?? d.reason,
              by: d.decidedBy,
            })),
        )
      : l.lineDecisions.map((d) => ({ code: null, amountCents: d.amountCents, reason: d.reason, by: null }));

  const attachedDocs = (detail.documentAttach?.documents ?? []).filter(
    (d) => d.status === "attached" && d.odDocNum != null,
  );

  return (
    <div className="mt-3" data-testid="posted-outcome">
      {/* ── THE MEASURED BANNER ──────────────────────────────────────────────── */}
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4 dark:border-emerald-900/60 dark:bg-emerald-950/15">
        <div className="flex items-start gap-2">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="min-w-0">
            {measured ? (
              <>
                {/*
                  THE SERVER'S OWN SENTENCE for one claim — "Patient owes $X —
                  confirmed in Open Dental." — and a total over several, which is
                  a sum of measured figures and nothing else.
                */}
                <p className="text-sm font-medium text-foreground" data-testid="posted-verdict">
                  {measured.claims.length === 1
                    ? measured.claims[0].verdict.sentence
                    : `The patients on this check owe ${money(measured.owedCents)} between them — confirmed in Open Dental.`}
                </p>
                {measured.claims.length > 1 && (
                  <ul className="mt-1 space-y-0.5 text-xs text-foreground" data-testid="posted-measured-claims">
                    {measured.claims.map((c) => (
                      <li key={c.claimId}>
                        {c.patientName ?? "A patient"} — {c.verdict.sentence}
                      </li>
                    ))}
                  </ul>
                )}
                {/* THE REGISTER, NAMED. Read out of the chart, not worked out here.
                    "Read out of", not "read back from": the second is on the
                    banned list (`rcm-plain-language.test.ts`) — the module's
                    one established phrase for a measurement is this one. */}
                <p className="mt-0.5 text-xs text-muted-foreground" data-testid="posted-register">
                  Read out of {chartsPhrase(measured.patients)} after posting, not calculated by
                  this app.
                  {latestConfirmed ? ` As Open Dental had it ${officeStamp(latestConfirmed, office)}.` : ""}
                </p>
              </>
            ) : (
              <>
                {/*
                  NO MEASURED PATIENT FIGURE IN HAND — so none is quoted. What the
                  CHECK proved is still true and still worth saying.
                */}
                <p className="text-sm font-medium text-foreground" data-testid="posted-verdict">
                  {plan.reconciledAt
                    ? `Confirmed in Open Dental on ${officeStamp(plan.reconciledAt, office)} — the check there carries exactly these lines.`
                    : "The check exists in Open Dental. It has not been confirmed by asking for it back yet."}
                </p>
                {read.status !== "loading" && (
                  <p className="mt-0.5 text-xs text-muted-foreground" data-testid="posted-unmeasured">
                    {read.status === "failed"
                      ? "What each patient owes could not be read just now, so it is not shown here. Open a claim to see it."
                      : "No measured patient figure is on record for every claim on this check, so none is shown here."}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── WHAT LANDED IN OPEN DENTAL — each line only when the server sent it ── */}
      <div className="mt-3 rounded-lg border border-border bg-card p-4" data-testid="posted-landed">
        <h3 className="text-sm font-semibold text-foreground">What landed in Open Dental</h3>
        <dl className="mt-2 space-y-1.5 text-sm">
          {l.lineCount > 0 && (
            <Row label="Payment entered as" value={money(l.paymentCents)} testId="posted-payment" />
          )}
          {plan.odClaimPaymentNum != null && (
            <Row
              label="Open Dental payment number"
              value={`#${plan.odClaimPaymentNum}`}
              testId="posted-payment-num"
            />
          )}
          {plan.checkNumber && (
            <Row label="Carrier's check number" value={plan.checkNumber} testId="posted-check-num" />
          )}
          {l.lineCount > 0 && (
            <Row label="Contractual write-offs" value={money(l.contractualCents)} testId="posted-contractual" />
          )}
          {writeoffs.map((w, i) => (
            <Row
              key={`${w.code ?? "line"}-${i}`}
              label="Office write-off"
              testId={`posted-office-writeoff-${i}`}
              value={
                <>
                  {w.code ? `${w.code} · ` : null}
                  {money(w.amountCents)}
                </>
              }
              note={
                w.reason || w.by
                  ? `${w.reason ?? "no reason recorded"}${w.by ? ` — decided by ${w.by}` : ""}. Recorded in CareIN; the chart holds the money, not the reason.`
                  : undefined
              }
            />
          ))}
          {measured && (
            <Row
              label="The patients' balance now"
              value={money(measured.owedCents)}
              testId="posted-balance"
              note="Measured in Open Dental after posting, claim by claim."
            />
          )}
          {plan.documentAttachStatus !== null && (
            <Row
              label="Where the EOB was filed"
              value={eobSentence(plan.documentAttachStatus)}
              testId="posted-eob"
              note={
                attachedDocs.length > 0
                  ? attachedDocs.map((d) => `DocNum ${d.odDocNum} on PatNum ${d.odPatientId}`).join(" · ")
                  : undefined
              }
              prose
            />
          )}
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground">
              Nothing else on this check needs anybody. It is done.
            </span>
            <Link
              href="/rcm"
              data-testid="posted-back-today"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              Back to Today
            </Link>
          </div>
        )}
      </div>

      <DepositComingSoon checkAmountCents={checkAmountCents} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// STUCK AFTER POSTING — which of the two
// ═══════════════════════════════════════════════════════════════════════════

export function StuckAfterPosting({
  detail,
  office,
  batchId,
}: {
  detail: PostingQueueDetail;
  office: RcmOfficeId;
  batchId: string | null;
}) {
  /*
   * THE W-16 BRANCH. Two components rather than one with conditions inside, so
   * the stopped screen cannot reach a hook, a read or a sentence that belongs
   * to the measured one — `rcm-ui-s5.test.tsx` pins that nothing from the fix
   * steps or the re-check is reachable when nothing was measured.
   */
  return stuckKind(detail.plan) === "measured" ? (
    <StuckMeasured detail={detail} office={office} batchId={batchId} />
  ) : (
    <StuckStopped detail={detail} office={office} />
  );
}

/**
 * "IF YOU'D RATHER DEAL WITH IT TOMORROW" — both branches.
 *
 * A stuck check at 5:55pm is a check somebody will be tempted to rush. This says
 * the true thing that makes rushing unnecessary: it keeps. The check stays among
 * the ones that still need somebody, and nothing already done is undone by
 * leaving it.
 */
function TomorrowCard() {
  return (
    <div className="mt-3 rounded-lg border border-border bg-background p-3" data-testid="stuck-tomorrow">
      <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <PauseCircle size={14} className="shrink-0 text-muted-foreground" />
        If you&rsquo;d rather deal with it tomorrow
      </p>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Leave it. This check stays on Today under Where you left off, and on the Posting screen,
        until it is finished. Nothing you have done is lost.
      </p>
    </div>
  );
}

// ─── (a) STOPPED BEFORE MEASURING ─────────────────────────────────────────────

/**
 * THE RUN STOPPED BEFORE IT COMPARED ANYTHING.
 *
 * What it says: where it stopped, in plain words; that nothing compared a
 * patient's balance; not to re-enter the payment; and the next posting pass.
 *
 * What it deliberately does NOT say, and the reason for each:
 *
 *   · no "what the chart says" box, no promised-versus-chart figures — nothing
 *     was measured, so there is no second figure to put in it;
 *   · no fix steps and no "check it again" — both invite a person into a chart
 *     that nothing has shown to be wrong;
 *   · not the run's own error text. It can be a database message, and it can be
 *     a server sentence that ends "resolve the extra line in the chart" — a
 *     remediation instruction on the one screen that must carry none. The next
 *     posting pass turns a real chart problem into its own named state (the
 *     precondition check refuses it as `blocked`, with copy written for it); the
 *     step name is the diagnostic that belongs here.
 */
function StuckStopped({ detail, office }: { detail: PostingQueueDetail; office: RcmOfficeId }) {
  const { plan } = detail;
  return (
    <div className="mt-3" data-testid="stuck-stopped">
      <div className="rounded-lg border border-border bg-muted/40 p-4">
        <p className="text-base font-semibold text-foreground">
          Posting stopped part-way through this check
        </p>
        <p className="mt-1 text-sm text-foreground" data-testid="stuck-stopped-step">
          It stopped {stoppedWhile(plan.step)}
          {plan.finishedAt ? `, at ${officeStamp(plan.finishedAt, office)}` : ""} — before it compared
          any patient&rsquo;s balance with what this check promised.
        </p>
        <p className="mt-1 text-sm text-foreground" data-testid="stuck-stopped-nothing-measured">
          Nothing has compared the chart with this check yet, so there is nothing here to correct in
          Open Dental. Do not change anything there because of this screen.
        </p>
        <p className="mt-1 text-sm text-foreground" data-testid="stuck-stopped-no-reentry">
          {plan.odClaimPaymentNum != null ? (
            <>
              Open Dental already holds check{" "}
              <span className="font-mono font-semibold">#{plan.odClaimPaymentNum}</span> from this
              run — do not enter the payment by hand.
            </>
          ) : (
            "Part of it may already be in Open Dental — do not enter the payment by hand."
          )}
        </p>
      </div>

      <div className="mt-3 rounded-lg border border-border bg-card p-4" data-testid="stuck-stopped-next">
        <h3 className="text-sm font-semibold text-foreground">What to do</h3>
        <p className="mt-1 text-sm text-foreground">
          Press <strong>Post to Open Dental</strong> for this check again. Posting re-reads Open
          Dental first and resumes from what the chart shows.
        </p>
      </div>

      <TomorrowCard />
    </div>
  );
}

// ─── (b) MEASURED, AND IT DISAGREED ───────────────────────────────────────────

/**
 * How long the re-check button rests after a press, in seconds.
 *
 * Short enough that somebody genuinely waiting on a correction is not
 * obstructed; long enough that leaning on the button cannot turn one look into
 * a queue of Open Dental reads. See the note beside `restingFor` below.
 */
const RECHECK_REST_SECONDS = 6;

/**
 * THE PRACTICE'S OWN WRITE-OFF ADJUSTMENT TYPE — when this person may read it.
 *
 * The name lives on the office settings, which only `rcm.settings` may read.
 * Not merely "don't render" for everybody else — don't ASK: a request we know
 * will 403 fills the audit trail with noise. Everybody else gets a step that
 * says where an administrator can see the name.
 */
function useWriteoffSettings(office: RcmOfficeId): RcmOfficeSettings | null {
  const auth = useAuth();
  const allowed =
    auth.status === "authenticated" &&
    (auth.user.isSuperAdmin || can(auth.user.permissions, "rcm.settings"));
  const [settings, setSettings] = useState<RcmOfficeSettings | null>(null);
  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    getRcmOfficeSettings(office).then(
      (s) => {
        if (!cancelled) setSettings(s);
      },
      () => {
        if (!cancelled) setSettings(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [office, allowed]);
  return settings;
}

function StuckMeasured({
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
  const read = useConfirmedClaims(
    office,
    detail.claims.map((c) => c.claimId),
  );
  const disagreements = disagreementsOf(read);
  const settings = useWriteoffSettings(office);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<PostingRecheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [restingFor, setRestingFor] = useState(0);

  /*
    THE BUTTON RESTS BETWEEN PRESSES.

    Every press is two Open Dental reads, and RCM shares ONE Open Dental
    credential with the voice side, paced at 1200ms per key (D-8). A check that
    is stuck and a person who wants it unstuck is a realistic pairing, so a
    double-click is four calls that a running post then waits behind.

    This is NOT a rate limit — the server has no opinion about how often you
    look — and it is not a new state. It is a few seconds of rest, and the
    button says why rather than going quietly grey.
  */
  useEffect(() => {
    if (restingFor <= 0) return;
    const t = setTimeout(() => setRestingFor((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [restingFor]);

  /** The claims whose confirmation did not agree, from the last re-check. */
  const stillOff = (checked?.claims ?? []).filter((c) => c.verdict.state === "red");

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

  /*
   * ── A CLEAN RE-CHECK TAKES THE STUCK PANEL DOWN ────────────────────────────
   * The disagreement it described is gone, so the numbered steps, the amber
   * compare and the red would all be describing a chart that no longer looks
   * like that. What is left is one fact and one press. NOT "Finished": nothing
   * moved — see the file header.
   */
  if (checked?.agreed) {
    return (
      <div className="mt-3" data-testid="stuck-resolved">
        <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50/60 p-4 dark:border-emerald-800 dark:bg-emerald-950/20">
          <div className="flex items-start gap-2">
            <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div>
              <p className="text-base font-semibold text-foreground">
                Open Dental now says what this check promised.
              </p>
              <p className="mt-1 text-sm text-foreground" data-testid="stuck-resolved-next">
                That was only a look, and this check is not finished yet. One press left:{" "}
                <strong>Post to Open Dental</strong> for this check again — posting re-reads Open
                Dental first and resumes from what the chart shows. When it finishes, this page shows
                the finished check.
              </p>
              {plan.odClaimPaymentNum != null && (
                <p className="mt-1 text-sm text-foreground">
                  The payment is still there as check{" "}
                  <span className="font-mono font-semibold">#{plan.odClaimPaymentNum}</span> — do not
                  enter it again by hand.
                </p>
              )}
              <p className="mt-1 text-[11px] text-muted-foreground">
                Asked {officeStamp(checked.checkedAt, office)}.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /** Where an admin looks the adjustment type up, when this person cannot. */
  const writeoffMode = settings?.writeoffMode ?? (l.bookedAdjustment ? "adjustment_by_name" : null);
  const adjTypeName = settings?.writeoffAdjTypeName ?? null;

  return (
    <div className="mt-3" data-testid="stuck-measured">
      {/* ── 1. THE PAYMENT DID LAND. DO NOT ENTER IT AGAIN. ─────────────────
          FIRST, GREEN, and the loudest thing here. A biller who reads "stuck"
          and reaches for the desktop to re-enter the payment has just paid a
          claim twice, and nothing in this product can take that back. Green
          because the fact it states is GOOD news — the money is right. */}
      <div
        className="rounded-lg border-2 border-emerald-300 bg-emerald-50/60 p-4 dark:border-emerald-800 dark:bg-emerald-950/20"
        data-testid="stuck-money-landed"
      >
        <div className="flex items-start gap-2">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div>
            <p className="text-base font-semibold text-foreground">
              The payment did reach Open Dental.
            </p>
            <p className="mt-1 text-sm text-foreground">
              <span className="font-mono">{money(l.paymentCents)}</span> was entered against{" "}
              {claimsPhrase(detail)}
              {plan.odClaimPaymentNum != null ? (
                <>
                  {" "}as payment{" "}
                  <span className="font-mono font-semibold">#{plan.odClaimPaymentNum}</span>
                </>
              ) : null}
              {l.paidAt ? ` at ${officeStamp(l.paidAt, office)}` : ""}.{" "}
              <strong>Do not enter it again by hand.</strong>
            </p>
          </div>
        </div>
      </div>

      {/* ── 2. PROMISED, BESIDE WHAT THE CHART SAYS NOW ───────────────────────── */}
      <div
        className="mt-3 rounded-lg border border-amber-300 bg-amber-50/60 p-4 dark:border-amber-800 dark:bg-amber-950/20"
        data-testid="stuck-numbers"
      >
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <AlertTriangle size={14} className="shrink-0 text-amber-700 dark:text-amber-400" />
          What this app promised, and what the chart says now
        </h3>

        {disagreements.length > 0 ? (
          disagreements.map((d) => (
            <div key={d.claimId} className="mt-2" data-testid={`stuck-compare-${d.claimId}`}>
              {disagreements.length > 1 && (
                <p className="text-xs font-medium text-muted-foreground">
                  {d.patientName ?? "A patient"}
                  {d.odClaimNum != null ? ` · claim #${d.odClaimNum}` : ""}
                </p>
              )}
              <ComparePair
                promised={money(d.promisedCents)}
                promisedWhy={`Frozen when this check was approved: what ${d.patientName ?? "the patient"} would owe once the office's write-offs came off the EOB.`}
                measured={money(d.measuredCents)}
                measuredWhy={`Read out of ${d.patientName ? `${d.patientName}'s` : "the patient's"} chart in Open Dental after posting, line by line.`}
              />
              <p className="mt-2 text-sm font-medium text-foreground" data-testid="stuck-consequence">
                {consequenceSentence(d)}
              </p>
            </div>
          ))
        ) : (
          /*
           * THE FIGURES ARE NOT IN HAND — the claim read is still loading or
           * failed. The server's own sentence is still a measurement here: on
           * this branch it is, by construction, the confirmation that stopped
           * the check (`patient_total_unconfirmed`), so it may sit under "what
           * the chart says". Nothing is computed in its place.
           */
          <div className="mt-2">
            <ComparePair
              promised={l.promisedCents === null ? "—" : money(l.promisedCents)}
              promisedWhy="Frozen when this check was approved: what the screen said the patients would owe."
              measured={plan.lastError ?? "Open Dental disagreed with what this check promised."}
              measuredWhy="Read out of Open Dental after posting, line by line."
              measuredIsSentence
            />
            <p className="mt-2 text-sm font-medium text-foreground" data-testid="stuck-consequence">
              Until this is sorted, a patient on this check would be billed the wrong amount. The
              payment is fine; what is off is on the line the sentence above names.
            </p>
          </div>
        )}
      </div>

      {/* ── 3. WHAT TO DO, NUMBERED ─────────────────────────────────────────── */}
      <div className="mt-3 rounded-lg border border-border bg-card p-4" data-testid="stuck-steps">
        <h3 className="text-sm font-semibold text-foreground">What to do</h3>
        <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm text-foreground">
          {disagreements.length > 0 ? (
            disagreements.map((d) => (
              <FixSteps
                key={d.claimId}
                d={d}
                paymentNum={plan.odClaimPaymentNum}
                paymentCents={l.paymentCents}
                writeoffMode={writeoffMode}
                adjTypeName={adjTypeName}
              />
            ))
          ) : (
            <>
              <li>
                Open the claim the sentence above names in Open Dental.
                {plan.odClaimPaymentNum != null ? (
                  <>
                    {" "}Its payment is check{" "}
                    <span className="font-mono">#{plan.odClaimPaymentNum}</span> — leave that payment
                    alone; it is right.
                  </>
                ) : null}
              </li>
              <li>
                Correct the line it names so the patient owes what this check promised — change the
                write-off or the patient portion, not the payment.
              </li>
            </>
          )}
          <li>
            <strong>Do not add a second payment.</strong> The money is already there.
          </li>
          <li>
            Check it again below — it reads the chart and writes nothing — to see whether the
            correction took.
          </li>
          <li data-testid="stuck-post-again">
            Then press <strong>Post to Open Dental</strong> for this check again — posting re-reads
            Open Dental first and resumes from what the chart shows.
          </li>
        </ol>

        {/* ── THE RE-CHECK. A READ, and the label says so. ────────────────── */}
        <div className="mt-3 flex flex-col items-start gap-1">
          <button
            onClick={recheck}
            disabled={checking || restingFor > 0}
            data-testid="stuck-recheck"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {checking
              ? "Asking Open Dental…"
              : restingFor > 0
                ? `Asked just now — ready again in ${restingFor}s`
                : "Check it again — reads the chart, writes nothing"}
          </button>
          {/* THE COOLDOWN IS THE REASON, so it is marked as one. */}
          {restingFor > 0 && (
            <DisabledReason testId="stuck-recheck-reason">
              Each look asks Open Dental twice, over the one connection the rest of CareIN shares.
            </DisabledReason>
          )}
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

        {checked && !checked.agreed && (
          <div
            className="mt-2 rounded-md border border-rose-200 bg-rose-50/50 p-3 text-sm dark:border-rose-900 dark:bg-rose-950/20"
            data-testid="stuck-recheck-result"
          >
            <p className="font-medium text-foreground">Still not right.</p>
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {stillOff.map((c) => (
                <li key={c.claimId ?? c.odClaimNum}>
                  {/* THE SERVER'S OWN SENTENCE, from the same function the
                      post's own confirmation used. */}
                  Open Dental claim {c.odClaimNum} — {c.verdict.sentence}
                </li>
              ))}
            </ul>
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

      <TomorrowCard />
    </div>
  );
}

/**
 * THE STEPS FOR ONE CLAIM — naming the account, the claim, the payment, the
 * line, the amount and, where it can, the practice's own adjustment type.
 *
 * The correcting step says "put back the write-off" ONLY when the gap is
 * exactly the office's own write-off on this claim; any other gap gets a step
 * that names the line and the target figure and no cause. The type name comes
 * from the office settings when this person may read them, and is otherwise
 * pointed at rather than guessed.
 */
function FixSteps({
  d,
  paymentNum,
  paymentCents,
  writeoffMode,
  adjTypeName,
}: {
  d: Disagreement;
  paymentNum: number | null;
  paymentCents: number;
  writeoffMode: string | null;
  adjTypeName: string | null;
}) {
  const who = d.patientName ?? "the patient";
  const where = lineWords(d.codes);

  let fix: ReactNode;
  if (d.writeOffMissing && writeoffMode === "writeoff_field") {
    fix = (
      <>
        On {where}, raise the write-off by <span className="font-mono">{money(d.diffCents)}</span> —
        the write-off this office chose.
      </>
    );
  } else if (d.writeOffMissing && writeoffMode === "adjustment_by_name") {
    fix = (
      <>
        On {who}&rsquo;s account, add a <span className="font-mono">{money(d.diffCents)}</span>{" "}
        adjustment for {where}
        {adjTypeName ? (
          <>
            , of type <strong>&ldquo;{adjTypeName}&rdquo;</strong> — the type this practice books
            its own write-offs under.
          </>
        ) : (
          <>
            , of the type this practice books its own write-offs under. An administrator can see its
            name under Admin → Office.
          </>
        )}
      </>
    );
  } else if (d.writeOffMissing) {
    fix = (
      <>
        Put back the <span className="font-mono">{money(d.diffCents)}</span> write-off this office
        chose on {where}, the way this practice books its own write-offs.
      </>
    );
  } else {
    fix = (
      <>
        Correct {where} so {who} owes <span className="font-mono">{money(d.promisedCents)}</span> —
        change the write-off or the patient portion, not the payment.
      </>
    );
  }

  return (
    <>
      <li data-testid={`stuck-step-account-${d.claimId}`}>
        In Open Dental, open {who}&rsquo;s account
        {d.odPatientId != null ? (
          <>
            {" "}(<span className="font-mono">PatNum {d.odPatientId}</span>)
          </>
        ) : null}
        .
      </li>
      <li data-testid={`stuck-step-claim-${d.claimId}`}>
        {d.odClaimNum != null ? (
          <>
            Find claim <span className="font-mono">#{d.odClaimNum}</span>.
          </>
        ) : (
          "Find the claim this check paid."
        )}
        {paymentNum != null ? (
          <>
            {" "}Its payment is check <span className="font-mono">#{paymentNum}</span> for{" "}
            <span className="font-mono">{money(paymentCents)}</span> — leave that payment alone; it
            is right.
          </>
        ) : null}
      </li>
      <li data-testid={`stuck-step-fix-${d.claimId}`}>{fix}</li>
    </>
  );
}

function ComparePair({
  promised,
  promisedWhy,
  measured,
  measuredWhy,
  measuredIsSentence = false,
}: {
  promised: string;
  promisedWhy: string;
  measured: string;
  measuredWhy: string;
  /** The server's sentence rather than a figure — rendered as prose, not a number. */
  measuredIsSentence?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="rounded-md border border-border bg-background p-3">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          What this app promised
        </div>
        <div
          className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground"
          data-testid="stuck-promised"
        >
          {promised}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{promisedWhy}</p>
      </div>
      <div className="rounded-md border border-rose-200 bg-rose-50/50 p-3 dark:border-rose-900 dark:bg-rose-950/20">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          What the chart says now
        </div>
        <div
          className={
            measuredIsSentence
              ? "mt-1 text-sm font-medium text-rose-800 dark:text-rose-300"
              : "mt-1 font-mono text-xl font-semibold tabular-nums text-rose-800 dark:text-rose-300"
          }
          data-testid="stuck-measured-figure"
        >
          {measured}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{measuredWhy}</p>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  note,
  testId,
  prose = false,
}: {
  label: string;
  value: ReactNode;
  note?: string;
  testId?: string;
  /** A sentence rather than a figure — wraps, and is not set in the figure face. */
  prose?: boolean;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="shrink-0 text-muted-foreground">{label}</dt>
        <dd
          className={
            prose
              ? "min-w-0 text-right text-foreground"
              : "text-right font-mono tabular-nums text-foreground"
          }
          data-testid={testId}
        >
          {value}
        </dd>
      </div>
      {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
