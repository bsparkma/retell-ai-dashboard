/**
 * /rcm/posting — the posting queue, and the one button in this product that
 * writes to a patient's chart (Slice 6c).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SCREEN IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Approving a remittance (6b) writes a PLAN: per-line intended amounts, the
 * Open Dental identifiers a confirmed match recorded, and the fact that a human
 * authorised it. Nothing reaches a chart. This screen is where somebody presses
 * Drain and watches those plans become real insurance payments.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY CLAIM THIS SCREEN MAKES IS ONE THE SERVER PROVED
 * ─────────────────────────────────────────────────────────────────────────────
 * Open Dental returns `200 OK` on writes it silently ignores, so a posting
 * engine that believes its own status codes reports work it never did. The
 * server therefore reads every write back and compares it, and this screen shows
 * that evidence rather than a green tick:
 *
 *   - a `posted` plan shows its **ClaimPaymentNum** — the check that exists in
 *     the practice's books — and the time the reconciliation read confirmed the
 *     check carries exactly this plan's lines. The database refuses to store
 *     `posted` without both, so "verified by read-back" is a fact here.
 *   - a `partially_posted` plan shows the exact per-line positions. It does NOT
 *     say "failed": money HAS moved, and a state reading as "nothing happened"
 *     would send a biller looking for a payment that is sitting in the chart.
 *   - a `blocked` plan shows the machine reason as copy that says what to DO,
 *     because blocked means a human owes an action.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUTTON, AND WHO SEES WHAT
 * ─────────────────────────────────────────────────────────────────────────────
 * Drain needs `rcm.write` (D-9). A `reviewer` sees the whole queue — watching a
 * plan post, and reading why one is blocked, is not a posting act — with the
 * button disabled and naming the permission a colleague holds. `canDrain` is the
 * SERVER'S answer, never a role name this component inspects.
 *
 * D-7 is the server's answer too: `postingEnabled` is false for a practice that
 * has not been validated yet, and the copy says so instead of the client
 * hardcoding a practice name that would go stale the day it is switched on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RUN IS BOUNDED AND SAYS SO
 * ─────────────────────────────────────────────────────────────────────────────
 * Every Open Dental call is paced at ≥1.2 s because the credential is shared
 * with the phone system, so a large plan is minutes of wall clock. The server
 * stops cleanly BETWEEN plans when its budget runs out and returns `outOfTime`
 * with how many are left; this screen says that plainly and the button is
 * pressed again. It never stops mid-claim.
 */
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Lock,
  PlayCircle,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { useOffice } from "@/contexts/OfficeContext";
import { useRcmOfficeScope } from "@/features/rcm/officeScope";
import {
  drainPostingQueue,
  getPostingPlan,
  listPostingQueue,
  RcmApiError,
  RCM_OFFICE_LABELS,
  type DrainResult,
  type PostingQueueDetail,
  type PostingQueuePage,
  type PostingQueueRow,
  type RcmOfficeId,
} from "@/features/rcm/api";
import { day, money, officeDay, OFFICE_TIME_NOTE } from "@/features/rcm/format";
import {
  blockedCopy,
  LINE_STATE_COPY,
  QUEUE_STATE_COPY,
  queueStateTone,
  stepCopy,
} from "@/features/rcm/posting";
import { planFlow } from "@/features/rcm/flow";
import RcmStepper from "@/components/rcm/RcmStepper";
import DisabledReason from "@/components/rcm/DisabledReason";
import CopyChip from "@/components/rcm/CopyChip";

export default function PostingQueue() {
  const scope = useRcmOfficeScope();
  const { reload } = useOffice();

  if (scope.loading) {
    return (
      <div
        className="flex items-center gap-2 p-6 text-sm text-muted-foreground"
        data-testid="posting-loading"
      >
        <Loader2 size={16} className="animate-spin" />
        Loading offices…
      </div>
    );
  }

  if (scope.error) {
    return (
      <div className="p-6" data-testid="posting-roster-error">
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <div className="text-sm font-medium text-foreground">Could not load the office list</div>
          <p className="mt-1 text-sm text-muted-foreground">{scope.error}</p>
          <button
            onClick={reload}
            className="mt-4 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6" data-testid="rcm-posting">
      <div>
        <h1
          className="text-2xl font-bold tracking-tight text-foreground"
          style={{ fontFamily: "Sora, sans-serif" }}
        >
          Posting
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Approved remittances waiting to become insurance payments in Open Dental. Draining writes
          each line's adjudication, marks the claim received, and creates the check — reading every
          write back to prove it took.
        </p>
      </div>

      {scope.offices.length === 0 ? (
        <div
          className="mt-6 rounded-xl border border-dashed border-border bg-card p-8 text-center"
          data-testid="posting-no-offices"
        >
          <div className="text-sm font-medium text-foreground">No RCM offices</div>
        </div>
      ) : (
        <div className="mt-6 space-y-8">
          {scope.offices.map((office) => (
            <OfficePostingQueue key={office} office={office} />
          ))}
        </div>
      )}
    </div>
  );
}

function OfficePostingQueue({ office }: { office: RcmOfficeId }) {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "loaded"; page: PostingQueuePage } | { kind: "failed"; message: string }
  >({ kind: "loading" });
  const [draining, setDraining] = useState(false);
  const [result, setResult] = useState<DrainResult | null>(null);
  const [drainError, setDrainError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    listPostingQueue(office, { limit: 50 })
      .then((page) => {
        if (!cancelled) setState({ kind: "loaded", page });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof RcmApiError ? err.message : "Could not load the posting queue.";
        setState({ kind: "failed", message });
      });
    return () => {
      cancelled = true;
    };
  }, [office]);

  useEffect(load, [load]);

  const drain = useCallback(async () => {
    setDraining(true);
    setDrainError(null);
    setResult(null);
    try {
      const res = await drainPostingQueue(office);
      setResult(res);
    } catch (err: unknown) {
      setDrainError(
        err instanceof RcmApiError
          ? err.message
          : "The posting run could not be started.",
      );
    } finally {
      setDraining(false);
      // Reload either way: a run that failed part-way still changed the plans it
      // reached, and a screen showing the pre-run state after that would be the
      // stale-client bug the EOB panel already learned once.
      load();
    }
  }, [office, load]);

  const page = state.kind === "loaded" ? state.page : null;
  const waiting = page ? page.byStatus.approved + page.byStatus.failed + page.byStatus.partially_posted : 0;

  return (
    <section data-testid={`posting-office-${office}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-foreground">{RCM_OFFICE_LABELS[office]}</h2>
          {page && (
            /*
              "QUEUE:", ALWAYS — §15.2, finding 3.
              The header counts every plan this office holds; the strip after a
              run counts THAT RUN. They said "2 posted" and "1 posted" about the
              same screen and both were true, because neither said which
              population it was counting. Both now carry their scope in the
              string, so the two numbers cannot be read as one contradicting the
              other.
            */
            <span className="text-sm text-muted-foreground" data-testid={`posting-counts-${office}`}>
              Queue: {waiting} waiting · {page.byStatus.posted} posted · {page.byStatus.blocked}{" "}
              blocked · {page.total} total
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            data-testid={`posting-refresh-${office}`}
          >
            <RefreshCw size={14} />
            Refresh
          </button>
          {page && <DrainButton office={office} page={page} draining={draining} onDrain={drain} />}
        </div>
      </div>

      {/* D-7, in the server's words. A practice that has not been validated
          cannot post, and this is the only place that says why. */}
      {page && !page.postingEnabled && (
        <div
          className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30"
          data-testid={`posting-disabled-${office}`}
        >
          <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
          <div>
            <div className="font-medium text-amber-900 dark:text-amber-200">
              Posting is not switched on for {RCM_OFFICE_LABELS[office]} yet
            </div>
            <p className="mt-0.5 text-amber-800 dark:text-amber-300">
              This practice's own payment-type numbers have to be read from its own Open Dental, its
              key's write access proven, and a test-patient run completed first. Draining here marks
              each plan blocked and makes no Open Dental call at all.
            </p>
          </div>
        </div>
      )}

      {drainError && (
        <div
          className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300"
          data-testid={`posting-drain-error-${office}`}
        >
          {drainError}
        </div>
      )}

      {result && <DrainSummary office={office} result={result} />}

      <div className="mt-4">
        {state.kind === "loading" && (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            Loading…
          </div>
        )}
        {state.kind === "failed" && (
          <div className="rounded-xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
            {state.message}
          </div>
        )}
        {state.kind === "loaded" && state.page.rows.length === 0 && (
          <div
            className="rounded-xl border border-dashed border-border bg-card p-8 text-center"
            data-testid={`posting-empty-${office}`}
          >
            <div className="text-sm font-medium text-foreground">Nothing waiting to post</div>
            <p className="mt-1 text-sm text-muted-foreground">
              Approve a remittance and its posting plan appears here.
            </p>
          </div>
        )}
        {state.kind === "loaded" && state.page.rows.length > 0 && (
          <div className="space-y-3">
            {state.page.rows.map((row) => (
              <PlanCard
                key={row.queueId}
                office={office}
                row={row}
                // The explainer goes on the FIRST posted plan on the page and
                // nowhere else. See PlanCard.
                explainReadback={
                  row.queueId ===
                  state.page.rows.find((r) => r.status === "posted" && r.odClaimPaymentNum)?.queueId
                }
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The button.
 *
 * Disabled for a reviewer, and it SAYS SO — naming the permission an approver
 * holds rather than leaving the screen to be inferred from a greyed-out control.
 * `canDrain` comes from the server, so a role the client has never heard of
 * still gets the right answer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE REASON IS RENDERED, NOT HOVERED
 * ─────────────────────────────────────────────────────────────────────────────
 * It was a `title` attribute, which is to say it was invisible. §10.4 of this
 * module's walk lost real time to a Drain button greyed at `0 waiting` with
 * nothing on screen saying why: a disabled control with no reason is
 * indistinguishable from a broken one, so the replay step read as untestable
 * rather than as already-guaranteed. §15.2, finding 4. And a tooltip would not
 * have fixed it either — the practice reads this screen on a tablet.
 *
 * Permission comes FIRST in the order below, ahead of the empty queue: telling
 * a reviewer "nothing waiting to drain" would hide the thing that is still true
 * when a plan arrives.
 */
function DrainButton({
  office,
  page,
  draining,
  onDrain,
}: {
  office: RcmOfficeId;
  page: PostingQueuePage;
  draining: boolean;
  onDrain: () => void;
}) {
  const waiting = page.byStatus.approved + page.byStatus.failed + page.byStatus.partially_posted;
  const disabled = draining || !page.canDrain || waiting === 0;

  const reason = !page.canDrain
    ? `Posting to Open Dental needs ${page.drainRequires}. An approver can press this.`
    : draining
      ? "A posting run is under way. It stops cleanly between plans."
      : waiting === 0
        ? "Nothing waiting to drain."
        : null;

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={onDrain}
        disabled={disabled}
        data-testid={`posting-drain-${office}`}
        className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
          disabled
            ? "cursor-not-allowed bg-muted text-muted-foreground"
            : "bg-foreground text-background hover:opacity-90"
        }`}
      >
        {draining ? (
          <Loader2 size={14} className="animate-spin" />
        ) : page.canDrain ? (
          <PlayCircle size={14} />
        ) : (
          <Lock size={14} />
        )}
        {draining ? "Posting…" : waiting > 0 ? `Drain ${waiting}` : "Drain"}
      </button>
      {reason ? (
        <DisabledReason testId={`posting-drain-reason-${office}`}>{reason}</DisabledReason>
      ) : (
        <span className="text-xs text-muted-foreground">
          Writes {waiting} plan{waiting === 1 ? "" : "s"} to Open Dental.
        </span>
      )}
    </div>
  );
}

/**
 * What THE RUN JUST NOW did, including when it ran out of time.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS RUN, NOT THE QUEUE — §15.2, finding 3
 * ─────────────────────────────────────────────────────────────────────────────
 * This strip counts `result.outcomes`: the plans THIS press of Drain touched.
 * The header above counts every plan the office holds. On the walk they read
 * "1 posted" and "2 posted" on one screen, and there was no way to tell that
 * both were true — a queue that already held a posted plan, plus one more
 * posted just now.
 *
 * Neither number moves. What changed is that each one now says which population
 * it counted, in the string itself, so they cannot be read as a contradiction.
 */
function DrainSummary({ office, result }: { office: RcmOfficeId; result: DrainResult }) {
  const posted = result.outcomes.filter((o) => o.status === "posted").length;
  const blocked = result.outcomes.filter((o) => o.status === "blocked").length;
  const trouble = result.outcomes.filter(
    (o) => o.status === "failed" || o.status === "partially_posted",
  ).length;

  return (
    <div
      className="mt-3 rounded-lg border border-border bg-card p-3 text-sm"
      data-testid={`posting-drain-summary-${office}`}
    >
      <div className="font-medium text-foreground">
        {result.ran === 0
          ? "This run: nothing was waiting to post."
          : `This run: ${posted} posted · ${blocked} blocked · ${trouble} needing attention`}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground" data-testid={`posting-run-scope-${office}`}>
        Counts the {result.ran} plan{result.ran === 1 ? "" : "s"} this press of Drain touched. The
        totals beside the practice name count every plan it holds.
      </p>

      {result.outOfTime && (
        <p className="mt-1 flex items-center gap-1.5 text-amber-800 dark:text-amber-300">
          <Clock size={14} />
          The run reached its time limit and stopped cleanly between plans.{" "}
          {result.remaining} still waiting — press Drain again.
        </p>
      )}

      {/* The per-office numbers this run actually used, from THIS practice's own
          Open Dental. Configuration, not patient data — and what makes "the
          numbers never cross" checkable rather than merely asserted. */}
      {result.config && (
        <p className="mt-1 text-xs text-muted-foreground">
          Payment types read from {RCM_OFFICE_LABELS[office]}'s Open Dental:{" "}
          {result.config.payTypes.map((p) => `${p.defNum} ${p.name}`).join(" · ")}
        </p>
      )}
    </div>
  );
}

/**
 * One plan, with its lines behind a disclosure.
 *
 * `firstPosted` decides which card carries the read-back explainer: the phrase
 * "verified by read-back" is precise and it is not self-explanatory, and
 * printing the paragraph on every posted row would turn a queue into an essay.
 * Once per page, on the first one that says it.
 */
function PlanCard({
  office,
  row,
  explainReadback,
}: {
  office: RcmOfficeId;
  row: PostingQueueRow;
  explainReadback: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<PostingQueueDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const copy = QUEUE_STATE_COPY[row.statusLabel];
  const blocked = blockedCopy(row.blockedReason);

  useEffect(() => {
    if (!open || detail || loading) return;
    setLoading(true);
    getPostingPlan(office, row.queueId)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [open, detail, loading, office, row.queueId]);

  return (
    <div
      className="rounded-xl border border-border bg-card"
      data-testid={`posting-plan-${row.queueId}`}
    >
      {/*
        ── THE DISCLOSURE IS THE HEADER ROW ONLY ───────────────────────────────
        Everything used to live INSIDE this button. It cannot any more: the check
        number is now a copyable chip, and a `<button>` inside a `<button>` is
        not something the HTML parser tolerates — it closes the outer one at the
        inner start tag, so the proof line, the explainer and the metadata all
        got ejected out of the card and rendered flush against the page edge.

        The header stays a button (it is what toggles), and the plan's facts sit
        beside it as siblings. That is also the more honest markup: a read-back
        proof and a blocking reason are content, not part of a control's label.
      */}
      <div className="p-4">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-start gap-3 text-left"
          aria-expanded={open}
          data-testid={`posting-toggle-${row.queueId}`}
        >
          {open ? (
            <ChevronDown size={16} className="mt-1 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight size={16} className="mt-1 shrink-0 text-muted-foreground" />
          )}

          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded px-1.5 py-0.5 text-xs font-semibold ${queueStateTone(row.statusLabel)}`}
                data-testid={`posting-state-${row.queueId}`}
              >
                {copy.label}
              </span>
              <span className="font-medium text-foreground">{row.payer ?? "Unknown payer"}</span>
              {row.checkNumber && (
                <span className="text-sm text-muted-foreground">check {row.checkNumber}</span>
              )}
              <span className="text-sm font-medium text-foreground">
                {money(row.intendedTotalCents)}
              </span>
            </span>

            <span className="mt-1 block text-sm text-muted-foreground">{copy.hint}</span>
          </span>
        </button>

        {/* Indented to sit under the header's text rather than under its
            chevron — the facts belong to the plan named above them. */}
        <div className="pl-7">
          {/* THE PROOF, on the row that claims it. A `posted` plan cannot exist
              without both halves — the database refuses — so this is a
              statement of fact rather than an optimistic label.

              The check number is a COPYABLE CHIP: the next thing a biller does
              with it is find that check in Open Dental, and retyping a
              seven-digit number off a screen is how the wrong check gets
              opened.

              `officeDay`, not `day`: `reconciledAt` is an instant, and slicing
              an instant to ten characters prints its UTC calendar day — which
              is what put an Aug 25 evening approval on Aug 26 (§15.2). */}
          {row.status === "posted" && row.odClaimPaymentNum && (
            <div
              className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-emerald-700 dark:text-emerald-400"
              data-testid={`posting-proof-${row.queueId}`}
            >
              <CheckCircle2 size={14} className="shrink-0" />
              <span>Open Dental check</span>
              <CopyChip
                value={String(row.odClaimPaymentNum)}
                label={`#${row.odClaimPaymentNum}`}
                testId={`posting-checknum-${row.queueId}`}
              />
              <span>verified by read-back on {officeDay(row.reconciledAt, office)}</span>
            </div>
          )}

          {/* WHAT "VERIFIED BY READ-BACK" MEANS. Once per page, under the first
              plan that claims it — the phrase is exact and it is not obvious,
              and a tooltip is no use on the tablet at the front desk. */}
          {explainReadback && (
            <p
              className="mt-1 max-w-3xl text-xs text-muted-foreground"
              data-testid={`posting-readback-explainer-${row.queueId}`}
            >
              Verified by read-back means CareIN asked Open Dental for the check after writing it
              and got back exactly this plan's lines. Open Dental answers 200 to writes it quietly
              ignores, so the read is the proof and the status code is not.
            </p>
          )}

          {blocked && (
            <div
              className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-sm dark:border-amber-900/50 dark:bg-amber-950/30"
              data-testid={`posting-blocked-${row.queueId}`}
            >
              <div className="font-medium text-amber-900 dark:text-amber-200">{blocked.label}</div>
              <p className="mt-0.5 text-amber-800 dark:text-amber-300">{blocked.fix}</p>
            </div>
          )}

          {(row.status === "failed" || row.status === "partially_posted") && row.lastError && (
            <div
              className="mt-2 flex items-start gap-1.5 rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300"
              data-testid={`posting-error-${row.queueId}`}
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{row.lastError}</span>
            </div>
          )}

          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            {/* `officeDay`, not `day`. An approval at 20:10 Central is 01:10Z
                the next morning, and `day` printed that UTC date — "Approved
                Aug 26" over work done on Aug 25. §15.2, finding 2. */}
            <span data-testid={`posting-approved-${row.queueId}`}>
              Approved {officeDay(row.approvedAt, office)}
            </span>
            {row.attemptCount > 0 && (
              <span>
                {row.attemptCount} posting attempt{row.attemptCount === 1 ? "" : "s"}
              </span>
            )}
            {row.status === "posting" && row.step && <span>{stepCopy(row.step)}</span>}
            {/* A DATE-ONLY value from the carrier's file — `day`, correctly:
                it carries no time, so no zone may move it. */}
            {row.carrierEobDate && <span>Carrier EOB date {day(row.carrierEobDate)}</span>}
            <span>{OFFICE_TIME_NOTE}</span>
          </div>
        </div>
      </div>

      {open && (
        <div className="border-t border-border px-4 py-3">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              Loading lines…
            </div>
          )}
          {!loading && !detail && (
            <div className="text-sm text-muted-foreground">Could not load this plan.</div>
          )}
          {detail && <PlanLines detail={detail} office={office} row={row} />}
        </div>
      )}
    </div>
  );
}

function PlanLines({
  detail,
  office,
  row,
}: {
  detail: PostingQueueDetail;
  office: RcmOfficeId;
  row: PostingQueueRow;
}) {
  const patients = new Set(detail.claims.map((c) => c.patientName ?? c.claimId)).size;

  return (
    <div data-testid="posting-plan-lines">
      {/*
        THE SAME SEVEN STEPS AS THE OTHER TWO SCREENS.
        Everything before `post` is done by construction — a plan cannot exist
        unless a person confirmed every match and approved the check — so this
        stepper is mostly a record of what already happened, and one live step.
        Its value is that a biller who opened this row from the posting queue
        can still see where the remittance is and click back to it.
      */}
      <RcmStepper flow={planFlow(row)} here="post" testId={`posting-stepper-${row.queueId}`} />

      {/*
        HOW MANY PATIENTS. A check for $4,317 across nine patients and one
        across nine lines of the same patient are different things to reconcile,
        and the row above shows neither. The count comes from the plan's own
        claims — the queue LIST row does not carry it (see the backend asks).
      */}
      <p
        className="mb-3 mt-3 text-xs text-muted-foreground"
        data-testid={`posting-plan-scope-${row.queueId}`}
      >
        {detail.lines.length} line{detail.lines.length === 1 ? "" : "s"} · {detail.claims.length}{" "}
        claim{detail.claims.length === 1 ? "" : "s"} · {patients} patient
        {patients === 1 ? "" : "s"}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="pb-2 pr-3 font-medium">#</th>
              <th className="pb-2 pr-3 font-medium">OD claim</th>
              <th className="pb-2 pr-3 font-medium">OD line</th>
              <th className="pb-2 pr-3 text-right font-medium">Paid</th>
              <th className="pb-2 pr-3 text-right font-medium">Write-off</th>
              <th className="pb-2 pr-3 text-right font-medium">Deductible</th>
              <th className="pb-2 pr-3 font-medium">State</th>
              <th className="pb-2 font-medium">Verified</th>
            </tr>
          </thead>
          <tbody>
            {detail.lines.map((line) => (
              <tr key={line.queueLineId} className="border-t border-border/60">
                <td className="py-2 pr-3 text-muted-foreground">{line.position}</td>
                <td className="py-2 pr-3">{line.odClaimNum ?? "—"}</td>
                <td className="py-2 pr-3">{line.odClaimProcNum}</td>
                <td className="py-2 pr-3 text-right">{money(line.intendedInsPayAmtCents)}</td>
                <td className="py-2 pr-3 text-right">{money(line.intendedWriteOffCents)}</td>
                <td className="py-2 pr-3 text-right">{money(line.intendedDedAppliedCents)}</td>
                <td className="py-2 pr-3">
                  <span data-testid={`posting-line-state-${line.queueLineId}`}>
                    {LINE_STATE_COPY[line.status] ?? line.status}
                  </span>
                  {line.odClaimPaymentNum && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      check #{line.odClaimPaymentNum}
                    </span>
                  )}
                </td>
                <td className="py-2">
                  {/* The read-back verdict. `agreed: false` is a FAILURE of that
                      step whatever the HTTP status said, and the fields that
                      disagreed are named rather than summarised — "OD write
                      failed" tells nobody which number lied. */}
                  {line.readback ? (
                    line.readback.agreed ? (
                      <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 size={14} />
                        read back {officeDay(line.readbackAt, office)}
                      </span>
                    ) : (
                      <span className="text-rose-700 dark:text-rose-400">
                        disagreed on{" "}
                        {(line.readback.mismatches ?? []).map((m) => m.field).join(", ") ||
                          "an unnamed field"}
                      </span>
                    )
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The 6d seam, said out loud. A screen that showed nothing here would
          leave a biller assuming the EOB PDF had been filed into the chart. */}
      {!detail.documentAttach.implemented && (
        <p
          className="mt-3 text-xs text-muted-foreground"
          data-testid="posting-document-seam"
        >
          {detail.documentAttach.note}
        </p>
      )}
    </div>
  );
}
