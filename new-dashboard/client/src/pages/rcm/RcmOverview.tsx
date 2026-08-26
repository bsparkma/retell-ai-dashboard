/**
 * /rcm — WHAT NEEDS ME.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT WAS A STATS PAGE AND NOW IT IS A QUEUE
 * ─────────────────────────────────────────────────────────────────────────────
 * This page used to answer "how much of everything is there" — claims, batches,
 * queue depth — which is a question nobody standing at the front desk has. The
 * 2026-08-25 walk started here and the first move was always to leave, because
 * three totals do not tell you what to do next. RCM_POSTING.md §15.2.
 *
 * It now answers "what is waiting on me": three cards for the three states a
 * biller works, each a link into the remittance list already filtered to that
 * state, plus what got finished and what is stuck. `features/rcm/worklist.ts`
 * owns the predicate, so a card and the page it opens cannot disagree about
 * what "waiting on match" means.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE EACH NUMBER COMES FROM, AND WHAT IT DOES NOT KNOW
 * ─────────────────────────────────────────────────────────────────────────────
 * The three work-state counts are computed in the BROWSER over the newest 200
 * remittances an office holds, because `/api/rcm/remittances` has no work-state
 * view. So the card SAYS what it counted over when the practice holds more — a
 * filter that will not admit what it is hiding is exactly the failure Slice 6b
 * fixed one level down, and it is not being re-introduced quietly here.
 *
 * "Posted this week" and "Blocked" read the POSTING QUEUE, whose `byStatus` is
 * server-computed over the whole office. Its `finishedAt` is the only stamp
 * anywhere that says when money actually reached a chart — a remittance row
 * carries no posted-at (a backend ask), so the week is measured from the plan.
 *
 * The ingestion panels are still here, unchanged, below the work. They are also
 * on the remittance list now, which is where somebody who bookmarked the work
 * would look for them.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  AlertCircle,
  ArrowRight,
  Ban,
  CheckCircle2,
  Loader2,
  ScrollText,
  Search,
  ShieldCheck,
  Stethoscope,
} from "lucide-react";
import { useOffice } from "@/contexts/OfficeContext";
import { useRcmOfficeScope } from "@/features/rcm/officeScope";
import EobUploadPanel from "./EobUploadPanel";
import EraUploadPanel from "./EraUploadPanel";
import {
  listPostingQueue,
  listRemittances,
  RcmApiError,
  RCM_OFFICE_LABELS,
  type PostingQueuePage,
  type RcmOfficeId,
  type Remittance,
} from "@/features/rcm/api";
import { money, withinLastDays } from "@/features/rcm/format";
import { blockedCopy } from "@/features/rcm/posting";
import { countByFilter, FILTER_COPY, type WorklistFilter } from "@/features/rcm/worklist";

/** How deep the client-side work-state count reads. The server's own cap. */
const SCAN_LIMIT = 200;

/** What "this week" means on the Posted card. Practice days, not 168 hours. */
const WEEK_DAYS = 7;

interface Inbox {
  counts: Record<WorklistFilter, number>;
  /** How many remittances the counts were computed over, and how many exist. */
  scanned: number;
  total: number;
  postedThisWeek: number;
  postedCents: number;
  blockedPlans: number;
  /** The commonest blocking reason among blocked plans, in biller words. */
  topBlocker: string | null;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; inbox: Inbox }
  | { kind: "failed"; message: string };

export default function RcmOverview() {
  const scope = useRcmOfficeScope();
  const { reload } = useOffice();

  if (scope.loading) {
    return (
      <div
        className="flex items-center gap-2 p-6 text-sm text-muted-foreground"
        data-testid="rcm-loading"
      >
        <Loader2 size={16} className="animate-spin" />
        Loading offices…
      </div>
    );
  }

  if (scope.error) {
    return (
      <Notice
        testId="rcm-roster-error"
        title="Could not load the office list"
        body={scope.error}
        action={
          <button
            onClick={reload}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            Try again
          </button>
        }
      />
    );
  }

  return (
    <div className="p-6" data-testid="rcm-overview">
      <h1
        className="text-2xl font-bold tracking-tight text-foreground"
        style={{ fontFamily: "Sora, sans-serif" }}
      >
        Revenue Cycle
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Carrier payments, from the file that arrived to the money on the chart.
      </p>

      {/* THE FLOW, SAID ONCE AT THE TOP. The same seven the stepper draws on
          every screen below, so the shape is learned before it is needed. */}
      <p
        className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground"
        data-testid="rcm-flow-legend"
      >
        {["Upload", "Match", "Confirm", "Review", "Approve", "Post"].map((s, i) => (
          <span key={s} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-muted-foreground/40">›</span>}
            <span className="font-medium text-foreground">{s}</span>
          </span>
        ))}
        <span className="text-muted-foreground/40">›</span>
        <span className="italic">Deposit — coming soon</span>
      </p>

      <Link
        href="/rcm/remittances"
        className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline"
        data-testid="rcm-open-workbench"
      >
        <ScrollText size={14} />
        Open the review workbench
      </Link>

      {scope.offices.length === 0 ? (
        <Notice
          testId="rcm-no-offices"
          title="No RCM offices"
          body="None of this practice's offices are set up for revenue cycle work yet."
        />
      ) : (
        <>
          <div className="mt-6 space-y-6" data-testid="rcm-office-cards">
            {scope.offices.map((office) => (
              <OfficeInbox key={office} office={office} />
            ))}
          </div>

          {/* Slice 4. One panel per office in scope, because uploading is an
              office-scoped act — there is no "upload to whichever practice"
              affordance, by design. */}
          <div className="mt-10">
            <h2
              className="text-lg font-semibold tracking-tight text-foreground"
              style={{ fontFamily: "Sora, sans-serif" }}
            >
              EOB ingestion
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Upload an EOB PDF and it is read into a <strong>proposal</strong> — claims and
              procedure lines waiting for a human. Nothing here is posted to a patient chart.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2" data-testid="rcm-eob-panels">
              {scope.offices.map((office) => (
                <EobUploadPanel key={office} office={office} />
              ))}
            </div>
          </div>

          {/* Slice 5. Beside EOB ingestion rather than merged into it: an EOB
              PDF must be READ by a model and can be wrong, an 835 is PARSED and
              can only be malformed. Same per-office shape, same reason. */}
          <div className="mt-8">
            <h2
              className="text-lg font-semibold tracking-tight text-foreground"
              style={{ fontFamily: "Sora, sans-serif" }}
            >
              Remittance files (835)
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Upload a carrier's 835 and it is parsed into a <strong>proposal</strong> — payment
              batches, claims and service lines waiting for a human. Uploading the same
              remittance twice is refused, per office.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2" data-testid="rcm-era-panels">
              {scope.offices.map((office) => (
                <EraUploadPanel key={office} office={office} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One practice's queue.
 *
 * Two calls, deliberately: the remittance list answers "what is waiting on a
 * person", the posting queue answers "what happened to the money". Neither can
 * answer the other's question, and folding them into one derived number would
 * mean a card asserting something no endpoint said.
 */
function OfficeInbox({ office }: { office: RcmOfficeId }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    Promise.all([
      listRemittances(office, { limit: SCAN_LIMIT, offset: 0, view: "all" }),
      listPostingQueue(office, { limit: SCAN_LIMIT }),
    ])
      .then(([remittances, queue]) => {
        if (cancelled) return;
        setState({
          kind: "loaded",
          inbox: summarise(remittances.remittances, remittances.total, queue),
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // The server's own words. A tenant without the module says exactly
        // that, rather than the page inventing "something went wrong".
        const message =
          err instanceof RcmApiError && err.notEntitled
            ? "This practice is not set up for the RCM module."
            : err instanceof Error
              ? err.message
              : "Could not load this practice's work.";
        setState({ kind: "failed", message });
      });
    return () => {
      cancelled = true;
    };
  }, [office]);

  const blockedTotal =
    state.kind === "loaded" ? state.inbox.counts.blocked + state.inbox.blockedPlans : null;

  return (
    <section
      className="rounded-xl border border-border bg-card p-5 shadow-sm"
      data-testid={`rcm-summary-${office}`}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">{RCM_OFFICE_LABELS[office]}</h2>
        {state.kind === "loading" && (
          <Loader2 size={14} className="animate-spin text-muted-foreground" />
        )}
      </div>

      {state.kind === "failed" ? (
        <div
          className="mt-4 flex items-start gap-2 text-sm text-destructive"
          data-testid={`rcm-summary-error-${office}`}
        >
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <span>{state.message}</span>
        </div>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <QueueCard
              office={office}
              filter="match"
              icon={<Search size={14} />}
              count={state.kind === "loaded" ? state.inbox.counts.match : null}
            />
            <QueueCard
              office={office}
              filter="review"
              icon={<Stethoscope size={14} />}
              count={state.kind === "loaded" ? state.inbox.counts.review : null}
            />
            <QueueCard
              office={office}
              filter="approve"
              icon={<ShieldCheck size={14} />}
              count={state.kind === "loaded" ? state.inbox.counts.approve : null}
            />
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* FINISHED. Not a work queue — it is here so a biller can see the
                week went somewhere, which is the one thing a pure worklist
                never tells anybody. */}
            <Link
              href="/rcm/posting"
              data-testid={`rcm-posted-week-${office}`}
              className="rounded-lg border border-border/60 bg-emerald-50/40 p-3 transition-colors hover:bg-emerald-50 dark:bg-emerald-950/10 dark:hover:bg-emerald-950/25"
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <CheckCircle2 size={14} />
                Posted this week
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span
                  className="text-2xl font-semibold tabular-nums text-foreground"
                  data-testid={`rcm-posted-count-${office}`}
                >
                  {state.kind === "loaded" ? state.inbox.postedThisWeek : "—"}
                </span>
                {state.kind === "loaded" && state.inbox.postedThisWeek > 0 && (
                  <span className="font-mono text-sm tabular-nums text-muted-foreground">
                    {money(state.inbox.postedCents)}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Verified by reading each write back out of Open Dental.
              </p>
            </Link>

            <Link
              href="/rcm/remittances?view=blocked"
              data-testid={`rcm-blocked-${office}`}
              className={`rounded-lg border p-3 transition-colors ${
                blockedTotal && blockedTotal > 0
                  ? "border-rose-200 bg-rose-50/50 hover:bg-rose-50 dark:border-rose-900/60 dark:bg-rose-950/15 dark:hover:bg-rose-950/30"
                  : "border-border/60 bg-muted/30 hover:bg-muted/50"
              }`}
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Ban size={14} />
                Blocked
              </div>
              <div
                className="mt-1 text-2xl font-semibold tabular-nums text-foreground"
                data-testid={`rcm-blocked-count-${office}`}
              >
                {blockedTotal === null ? "—" : blockedTotal}
              </div>
              {/* THE TOP REASON, not just a number. "3 blocked" sends somebody
                  looking; "3 blocked · this practice is not switched on for
                  posting yet" ends the search on the card. */}
              <p className="mt-0.5 text-xs text-muted-foreground">
                {state.kind === "loaded"
                  ? (state.inbox.topBlocker ??
                    (state.inbox.counts.blocked > 0
                      ? "Claims were withheld at approval — the remittance says which check failed."
                      : "Nothing is blocked."))
                  : "…"}
              </p>
            </Link>
          </div>

          {/* WHAT THE THREE COUNTS WERE COMPUTED OVER. Only when it is not the
              whole practice — a caveat printed over a complete answer teaches
              people to ignore caveats. */}
          {state.kind === "loaded" && state.inbox.total > state.inbox.scanned && (
            <p
              className="mt-3 text-xs text-muted-foreground"
              data-testid={`rcm-scan-note-${office}`}
            >
              The three counts above read the newest {state.inbox.scanned} of {state.inbox.total}{" "}
              remittances this practice holds.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** One work state: its count, its name, and where it goes. */
function QueueCard({
  office,
  filter,
  icon,
  count,
}: {
  office: RcmOfficeId;
  filter: WorklistFilter;
  icon: React.ReactNode;
  /** `null` renders an em dash — not a 0 we have not measured. */
  count: number | null;
}) {
  const copy = FILTER_COPY[filter];
  return (
    <Link
      href={`/rcm/remittances?view=${filter}`}
      data-testid={`rcm-queue-${filter}-${office}`}
      className={`group rounded-lg border p-3 transition-colors ${
        count && count > 0
          ? "border-border bg-background hover:bg-muted/60"
          : "border-border/60 bg-muted/20 hover:bg-muted/40"
      }`}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {copy.label}
      </div>
      <div className="mt-1 flex items-center justify-between">
        <span
          className="text-2xl font-semibold tabular-nums text-foreground"
          data-testid={`rcm-queue-count-${filter}-${office}`}
        >
          {count === null ? "—" : count}
        </span>
        <ArrowRight
          size={14}
          className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
        />
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{copy.hint}</p>
    </Link>
  );
}

/**
 * The two payloads, folded into what the cards print.
 *
 * `now` is defaulted here and passed explicitly by the test: "this week" has to
 * be assertable without depending on when the suite runs.
 */
export function summarise(
  rows: Remittance[],
  total: number,
  queue: PostingQueuePage,
  now: Date = new Date(),
): Inbox {
  const counts = countByFilter(rows);

  const postedRecently = queue.rows.filter(
    (r) => r.status === "posted" && withinLastDays(r.finishedAt, WEEK_DAYS, now),
  );

  /*
   * THE COMMONEST BLOCKING REASON, not the first one seen.
   *
   * A practice that is not switched on for posting has every plan blocked for
   * the same reason, and that is the sentence worth putting on a card. Ties
   * resolve to whichever the queue returned first, which is fine — the point is
   * to name a reason, not to rank them.
   */
  const tally: Record<string, number> = {};
  for (const r of queue.rows) {
    if (r.status !== "blocked" || !r.blockedReason) continue;
    tally[r.blockedReason] = (tally[r.blockedReason] ?? 0) + 1;
  }
  let topReason: string | null = null;
  let best = 0;
  for (const reason of Object.keys(tally)) {
    if (tally[reason] > best) {
      best = tally[reason];
      topReason = reason;
    }
  }

  return {
    counts,
    scanned: rows.length,
    total,
    postedThisWeek: postedRecently.length,
    postedCents: postedRecently.reduce((sum, r) => sum + r.postedTotalCents, 0),
    blockedPlans: queue.byStatus.blocked,
    topBlocker: topReason ? (blockedCopy(topReason)?.label ?? null) : null,
  };
}

function Notice({
  testId,
  title,
  body,
  action,
}: {
  testId: string;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      className="mt-6 rounded-xl border border-dashed border-border bg-card p-8 text-center"
      data-testid={testId}
    >
      <div className="text-sm font-medium text-foreground">{title}</div>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
