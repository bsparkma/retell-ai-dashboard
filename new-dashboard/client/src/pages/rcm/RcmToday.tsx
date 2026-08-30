/**
 * /rcm — TODAY. The first screen of a biller's morning.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT WAS A STATS PAGE, THEN A QUEUE, AND NOW IT IS A DAY
 * ═════════════════════════════════════════════════════════════════════════════
 * Version one answered "how much of everything is there", which is a question
 * nobody standing at the front desk has. Version two answered "what is waiting
 * on me", which is better and still not first: it opened with three counters and
 * no way in, and the upload controls — the actual first act of the morning — sat
 * below two more sections.
 *
 * This one answers, in order, the first three questions of the day:
 *
 *   1. WHERE DID I LEAVE OFF?   what you put down, and what you started and did
 *                               not finish
 *   2. WHAT CAME IN?            the checks, by what each one is waiting for
 *   3. GET WORK IN              the upload controls, right there
 *
 * and only then how the week went. Stats are below the work because a number is
 * something you look at once a day and a queue is something you work.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "WHERE DID I LEAVE OFF" IS TWO HONEST SIGNALS, NOT ONE INFERRED ONE
 * ─────────────────────────────────────────────────────────────────────────────
 * There is no per-user "last touched" stamp on a check anywhere in this schema,
 * so this card cannot say "the ones YOU had open yesterday" and does not
 * pretend to. It shows the two things that are actually recorded:
 *
 *   PARKED    somebody pressed Save for tomorrow, on purpose, and their name and
 *             instant are on the row. Newest first, because "where did I leave
 *             off" means the last thing.
 *   STARTED   somebody pressed Approve and the check still needs attention —
 *             `approvalAttemptedBy` is the only other attributable "a person was
 *             here and it is not finished" fact a remittance carries.
 *
 * A third source — "opened, and not finished" — would need a touch stamp the
 * backend does not have. Logged as an ask rather than guessed at: a card that
 * silently omitted half the work would be worse than one that says what it
 * knows.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE EACH NUMBER COMES FROM, AND WHAT IT DOES NOT KNOW
 * ─────────────────────────────────────────────────────────────────────────────
 * The three work-state counts are computed in the BROWSER over the newest 200
 * checks an office holds, because `/api/rcm/remittances` has no work-state view.
 * So the card SAYS what it counted over when the practice holds more — a filter
 * that will not admit what it is hiding is exactly the failure Slice 6b fixed one
 * level down.
 *
 * "Posted this week" and "Stuck" read the POSTING QUEUE, whose `byStatus` is
 * server-computed over the whole office. Its `finishedAt` is the only stamp
 * anywhere that says when money actually reached a chart.
 *
 * `parkedCount` and `setAsideCount` come back from the SERVER, over the whole
 * office, so those two carry no caveat at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE ONE PLACE IN THE MODULE THAT UPLOADS
 * ─────────────────────────────────────────────────────────────────────────────
 * §15.2 finding 6: the Upload button used to be on this page AND on the Checks
 * page, and the practice owner got lost going round the loop live. Two doors to
 * one room is worse than one door in the wrong place, because neither is the
 * place you learn. Checks keeps a button; the button comes HERE.
 * `tests/rcm-shell.test.tsx` asserts there is exactly one upload surface.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  AlertCircle,
  ArrowRight,
  Ban,
  BookmarkCheck,
  CheckCircle2,
  Inbox,
  Loader2,
  Search,
  ShieldCheck,
  Stethoscope,
  Upload,
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
import { blockedCopy, SHADOW_MODE_COPY } from "@/features/rcm/posting";
import { remittanceHref } from "@/features/rcm/flow";
import { officeDay } from "@/features/rcm/time";
import {
  countByFilter,
  FILTER_COPY,
  newestParkedFirst,
  type WorklistFilter,
} from "@/features/rcm/worklist";

/** How deep the client-side work-state count reads. The server's own cap. */
const SCAN_LIMIT = 200;

/** What "this week" means on the Posted card. Practice days, not 168 hours. */
const WEEK_DAYS = 7;

/**
 * How many unfinished checks the top card lists before it stops naming them.
 *
 * "Where did I leave off" is answered by a handful or it is not answered at all;
 * a card of forty rows is the queue again, one section higher.
 */
const LEFT_OFF_LIMIT = 4;

interface Today {
  counts: Record<WorklistFilter, number>;
  /** How many checks the client-side counts were computed over, and how many exist. */
  scanned: number;
  total: number;
  /** Server-counted over the whole office — these two carry no caveat. */
  parkedCount: number;
  setAsideCount: number;
  /** What somebody put down on purpose, newest first. */
  parked: Remittance[];
  /** What somebody pressed Approve on and did not finish. */
  started: Remittance[];
  /** The newest arrivals, whatever state they are in. */
  arrivals: Remittance[];
  postedThisWeek: number;
  postedCents: number;
  stuckPostings: number;
  /** The commonest reason a posting is stuck, in biller words. */
  topBlocker: string | null;
  /**
   * THE SHADOW GATE, carried through from the posting queue so Today says the
   * same thing the Posting page does.
   *
   * A biller lives on this screen. If the only place that said "nothing you
   * approve is going to post yet" were the Posting page, she would find out by
   * going to look — which is the same as not being told.
   */
  shadowMode: boolean;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; today: Today }
  | { kind: "failed"; message: string };

export default function RcmToday() {
  const scope = useRcmOfficeScope();
  const { reload } = useOffice();
  const uploadRef = useRef<HTMLDivElement | null>(null);

  /**
   * `/rcm?add=1` scrolls to Get work in.
   *
   * The Checks page's one Upload button links here with it. Read from the URL
   * on mount and never written back — writing it would make the behaviour
   * depend on the router's search hook being wired, which it is not everywhere
   * this component renders (the lesson from PR #112's tab).
   */
  useEffect(() => {
    if (!window.location.search.includes("add=1")) return;
    const t = window.setTimeout(() => {
      uploadRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);
    return () => window.clearTimeout(t);
  }, []);

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
    <div className="p-6" data-testid="rcm-today">
      <h1
        className="text-2xl font-bold tracking-tight text-foreground"
        style={{ fontFamily: "Sora, sans-serif" }}
      >
        Today
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Carrier payments, from the check that arrived to the money on the chart.
      </p>

      {/* THE FLOW, SAID ONCE AT THE TOP. The same five the rail draws on every
          screen below, so the shape is learned before it is needed. */}
      <p
        className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground"
        data-testid="rcm-flow-legend"
      >
        {["Add the check", "Match it up", "Check it over", "Post"].map((s, i) => (
          <span key={s} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-muted-foreground/40">›</span>}
            <span className="font-medium text-foreground">{s}</span>
          </span>
        ))}
        <span className="text-muted-foreground/40">›</span>
        <span className="italic">Deposit — coming soon</span>
      </p>

      {scope.offices.length === 0 ? (
        <Notice
          testId="rcm-no-offices"
          title="No RCM offices"
          body="None of this practice's offices are set up for revenue cycle work yet."
        />
      ) : (
        <>
          <div className="mt-6 space-y-8" data-testid="rcm-office-cards">
            {scope.offices.map((office) => (
              <OfficeToday key={office} office={office} />
            ))}
          </div>

          {/* ── 3. GET WORK IN ─────────────────────────────────────────────
              The module's ONE upload surface. EOB and 835 side by side rather
              than in two sections a scroll apart: they are the two ways the
              same thing arrives, and a biller holding a PDF should not have to
              work out which heading is hers. The distinction that matters — a
              PDF is READ by a model and can be wrong, an 835 is PARSED and can
              only be malformed — is on each panel, where it is actionable. */}
          <div className="mt-10 scroll-mt-6" ref={uploadRef} data-testid="rcm-get-work-in">
            <h2
              className="flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground"
              style={{ fontFamily: "Sora, sans-serif" }}
            >
              <Upload size={17} />
              Get work in
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Add a check and it becomes a <strong>proposal</strong> — claims and procedure lines
              waiting for a person. Nothing added here is posted to a patient chart.
            </p>
            {scope.offices.map((office) => (
              <div key={office} className="mt-4">
                {scope.offices.length > 1 && (
                  <h3 className="mb-2 text-sm font-semibold text-foreground">
                    {RCM_OFFICE_LABELS[office]}
                  </h3>
                )}
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  <EobUploadPanel office={office} />
                  <EraUploadPanel office={office} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One practice's day.
 *
 * Two calls, deliberately: the check list answers "what is waiting on a person",
 * the posting queue answers "what happened to the money". Neither can answer the
 * other's question, and folding them into one derived number would mean a card
 * asserting something no endpoint said.
 */
function OfficeToday({ office }: { office: RcmOfficeId }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  /** Bumped by Try again. The effect is the ONE place that loads. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    Promise.all([
      listRemittances(office, { limit: SCAN_LIMIT, offset: 0, view: "all" }),
      listPostingQueue(office, { limit: SCAN_LIMIT }),
    ])
      .then(([remittances, queue]) => {
        if (cancelled) return;
        setState({ kind: "loaded", today: summarise(remittances, queue) });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // The server's own words. A tenant without the module says exactly that,
        // rather than the page inventing "something went wrong".
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
  }, [office, attempt]);

  const today = state.kind === "loaded" ? state.today : null;
  const stuckTotal = today ? today.counts.blocked + today.stuckPostings : null;

  return (
    <section
      className="rounded-xl border border-border bg-card p-5 shadow-sm"
      data-testid={`rcm-summary-${office}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-foreground">{RCM_OFFICE_LABELS[office]}</h2>
          {/* The same badge, the same words, the same quiet tone as the Posting
              page's. Nothing is wrong here — the work just waits. */}
          {today?.shadowMode && (
            <span
              className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
              data-testid={`rcm-shadow-badge-${office}`}
              title={SHADOW_MODE_COPY.hint}
            >
              {SHADOW_MODE_COPY.badge}
            </span>
          )}
        </div>
        {state.kind === "loading" && (
          <Loader2 size={14} className="animate-spin text-muted-foreground" />
        )}
      </div>

      {today?.shadowMode && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid={`rcm-shadow-hint-${office}`}>
          {SHADOW_MODE_COPY.hint}
        </p>
      )}

      {state.kind === "failed" ? (
        <div
          className="mt-4 flex items-start gap-2 text-sm text-destructive"
          data-testid={`rcm-summary-error-${office}`}
        >
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <span>{state.message}</span>
          <button
            onClick={() => setAttempt((n) => n + 1)}
            className="ml-auto rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {/* ── 1. WHERE DID I LEAVE OFF ─────────────────────────────────── */}
          <LeftOff office={office} today={today} />

          {/* ── 2. WHAT CAME IN ──────────────────────────────────────────── */}
          <h3
            className="mt-6 flex items-center gap-1.5 text-sm font-semibold text-foreground"
            data-testid={`rcm-what-came-in-${office}`}
          >
            <Inbox size={14} />
            What came in
          </h3>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <QueueCard
              office={office}
              filter="match"
              icon={<Search size={14} />}
              count={today ? today.counts.match : null}
            />
            <QueueCard
              office={office}
              filter="review"
              icon={<Stethoscope size={14} />}
              count={today ? today.counts.review : null}
            />
            <QueueCard
              office={office}
              filter="approve"
              icon={<ShieldCheck size={14} />}
              count={today ? today.counts.approve : null}
            />
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Link
              href="/rcm/remittances?view=blocked"
              data-testid={`rcm-blocked-${office}`}
              className={`rounded-lg border p-3 transition-colors ${
                stuckTotal && stuckTotal > 0
                  ? "border-rose-200 bg-rose-50/50 hover:bg-rose-50 dark:border-rose-900/60 dark:bg-rose-950/15 dark:hover:bg-rose-950/30"
                  : "border-border/60 bg-muted/30 hover:bg-muted/50"
              }`}
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Ban size={14} />
                {FILTER_COPY.blocked.label}
              </div>
              <div
                className="mt-1 text-2xl font-semibold tabular-nums text-foreground"
                data-testid={`rcm-blocked-count-${office}`}
              >
                {stuckTotal === null ? "—" : stuckTotal}
              </div>
              {/* THE TOP REASON, not just a number. "3 stuck" sends somebody
                  looking; "3 stuck · this practice is not switched on for
                  posting yet" ends the search on the card. */}
              <p className="mt-0.5 text-xs text-muted-foreground">
                {today
                  ? (today.topBlocker ??
                    (today.counts.blocked > 0
                      ? "Claims were held back at approval — the check says what stopped each one."
                      : FILTER_COPY.blocked.empty))
                  : "…"}
              </p>
            </Link>

            <Link
              href="/rcm/remittances?view=set_aside"
              data-testid={`rcm-set-aside-${office}`}
              className="rounded-lg border border-border/60 bg-muted/20 p-3 transition-colors hover:bg-muted/40"
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Ban size={14} />
                {FILTER_COPY.set_aside.label}
              </div>
              <div
                className="mt-1 text-2xl font-semibold tabular-nums text-foreground"
                data-testid={`rcm-set-aside-count-${office}`}
              >
                {today ? today.setAsideCount : "—"}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {today && today.setAsideCount > 0
                  ? "Out of the counts above, and one click from being back in them."
                  : FILTER_COPY.set_aside.empty}
              </p>
            </Link>
          </div>

          {/* THE NEWEST ARRIVALS, by name, under the counts. A count says how
              much there is; a row says which one, and a biller who recognises a
              payer can start there rather than opening the list to find it. */}
          {today && today.arrivals.length > 0 && (
            <>
              <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Newest in
              </h4>
              <ul className="mt-1 space-y-1" data-testid={`rcm-arrivals-${office}`}>
              {today.arrivals.map((r) => (
                <li key={r.batchId}>
                  <Link
                    href={remittanceHref(r.batchId)}
                    className="group flex items-baseline gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-muted/50"
                  >
                    <span className="truncate font-medium text-foreground">{r.payer}</span>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {money(r.totalAmountCents)}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {r.checkNumber ? `check ${r.checkNumber}` : "no check number"}
                      {r.createdAt ? ` · ${officeDay(r.createdAt, office)}` : ""}
                    </span>
                    <ArrowRight
                      size={13}
                      className="ml-auto flex-shrink-0 self-center text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                    />
                  </Link>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* WHAT THE THREE COUNTS WERE COMPUTED OVER. Only when it is not the
              whole practice — a caveat printed over a complete answer teaches
              people to ignore caveats. */}
          {today && today.total > today.scanned && (
            <p className="mt-3 text-xs text-muted-foreground" data-testid={`rcm-scan-note-${office}`}>
              The three counts above read the newest {today.scanned} of {today.total} checks this
              practice holds.
            </p>
          )}

          {/* ── HOW THE WEEK WENT — below the work, on purpose ───────────── */}
          <Link
            href="/rcm/posting"
            data-testid={`rcm-posted-week-${office}`}
            className="mt-6 flex items-center gap-3 rounded-lg border border-border/60 bg-emerald-50/40 p-3 transition-colors hover:bg-emerald-50 dark:bg-emerald-950/10 dark:hover:bg-emerald-950/25"
          >
            <CheckCircle2 size={16} className="flex-shrink-0 text-muted-foreground" />
            <div>
              <div className="flex items-baseline gap-2">
                <span
                  className="text-xl font-semibold tabular-nums text-foreground"
                  data-testid={`rcm-posted-count-${office}`}
                >
                  {today ? today.postedThisWeek : "—"}
                </span>
                <span className="text-xs font-medium text-muted-foreground">posted this week</span>
                {today && today.postedThisWeek > 0 && (
                  <span className="font-mono text-sm tabular-nums text-muted-foreground">
                    {money(today.postedCents)}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Every one confirmed in Open Dental afterwards, by asking for the check back.
              </p>
            </div>
            <ArrowRight size={14} className="ml-auto flex-shrink-0 text-muted-foreground" />
          </Link>
        </>
      )}
    </section>
  );
}

/**
 * What a STARTED row says about itself.
 *
 * Two facts can put a check here, and they are different sentences. The newer
 * one wins, because the question the card answers is "what was I last doing".
 *
 * A decision names the person and the day and stops there — the check is
 * unfinished by definition or it would not be in this list, and adding "and it
 * still needs somebody" to a row she was working on ten minutes ago reads as a
 * reprimand. The approve sentence keeps it, because pressing Approve is a thing
 * somebody expected to FINISH the check.
 */
function startedNote(r: Remittance, office: RcmOfficeId): string {
  const approved = r.approvalAttemptedAt ? Date.parse(r.approvalAttemptedAt) : 0;
  const decided = r.lastDecidedAt ? Date.parse(r.lastDecidedAt) : 0;

  if (decided > 0 && decided >= approved) {
    return `Write-offs decided${r.lastDecidedBy ? ` by ${r.lastDecidedBy}` : ""}${
      r.lastDecidedAt ? ` on ${officeDay(r.lastDecidedAt, office)}` : ""
    }.`;
  }
  return `Approve was pressed${
    r.approvalAttemptedBy ? ` by ${r.approvalAttemptedBy}` : ""
  }${
    r.approvalAttemptedAt ? ` on ${officeDay(r.approvalAttemptedAt, office)}` : ""
  } and this check still needs somebody.`;
}

/**
 * "Where did I leave off?" — the card that opens the day.
 *
 * It renders NOTHING when there is nothing unfinished, rather than an empty
 * state. An empty "where you left off" every morning is furniture, and the
 * section below it — what came in — is the honest first thing on a clean desk.
 */
function LeftOff({ office, today }: { office: RcmOfficeId; today: Today | null }) {
  if (!today) return null;
  const rows = [
    ...today.parked.map((r) => ({ r, kind: "parked" as const })),
    ...today.started.map((r) => ({ r, kind: "started" as const })),
  ].slice(0, LEFT_OFF_LIMIT);
  if (rows.length === 0) return null;

  const more = today.parkedCount - today.parked.length;

  return (
    <div
      className="mt-4 rounded-lg border border-border bg-background p-3"
      data-testid={`rcm-left-off-${office}`}
    >
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <BookmarkCheck size={14} />
        Where you left off
      </h3>
      <ul className="mt-2 space-y-1">
        {rows.map(({ r, kind }) => (
          <li key={`${kind}-${r.batchId}`}>
            <Link
              href={remittanceHref(r.batchId)}
              data-testid={`rcm-left-off-row-${r.batchId}`}
              className="group flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/60"
            >
              {/*
                PARKED AND STARTED ARE VISUALLY DIFFERENT, AND NEITHER LOOKS
                STUCK. A parked check is a note somebody left themselves; a
                started one is work in progress. Both are ordinary. The rose
                tone on this page belongs to "Stuck — needs you" alone, so a
                card of things you meant to come back to cannot read as a card
                of problems.
              */}
              <span
                className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium ${
                  kind === "parked"
                    ? "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {kind === "parked" ? "Saved" : "Started"}
              </span>
              <span className="truncate text-sm font-medium text-foreground">{r.payer}</span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {money(r.totalAmountCents)}
              </span>
              <span className="w-full truncate text-xs text-muted-foreground">
                {kind === "parked"
                  ? (r.parkedNote ??
                    `Saved${r.parkedBy ? ` by ${r.parkedBy}` : ""}${
                      r.parkedAt ? ` on ${officeDay(r.parkedAt, office)}` : ""
                    }`)
                  : startedNote(r, office)}
              </span>
              <ArrowRight
                size={13}
                className="ml-auto flex-shrink-0 self-center text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
              />
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-2 px-2 text-xs text-muted-foreground">
        Opening a saved check puts it back on the ordinary pile.
        {more > 0 && (
          <>
            {" "}
            <Link
              href="/rcm/remittances?view=parked"
              className="font-medium text-foreground underline-offset-4 hover:underline"
              data-testid={`rcm-left-off-more-${office}`}
            >
              {more} more saved for tomorrow
            </Link>
          </>
        )}
      </p>
    </div>
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
  page: {
    remittances: Remittance[];
    total: number;
    parkedCount: number;
    setAsideCount: number;
  },
  queue: PostingQueuePage,
  now: Date = new Date(),
): Today {
  const rows = page.remittances;
  const counts = countByFilter(rows);

  const postedRecently = queue.rows.filter(
    (r) => r.status === "posted" && withinLastDays(r.finishedAt, WEEK_DAYS, now),
  );

  /*
   * THE COMMONEST REASON A POSTING IS STUCK, not the first one seen.
   *
   * A practice that is not switched on for posting has every one stuck for the
   * same reason, and that is the sentence worth putting on a card. Ties resolve
   * to whichever the queue returned first, which is fine — the point is to name
   * a reason, not to rank them.
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

  /*
   * "STARTED" EXCLUDES ANYTHING ALREADY LISTED AS PARKED.
   *
   * A check somebody approved and then parked is one piece of unfinished work,
   * and naming it twice in a four-row card would crowd out something else she
   * has to do. The parked reading wins because it is the one SHE chose.
   */
  const parked = newestParkedFirst(rows.filter((r) => r.parkedAt != null && r.setAsideAt == null))
    .slice(0, LEFT_OFF_LIMIT);
  const parkedIds = new Set(parked.map((r) => r.batchId));
  /*
   * "STARTED" NOW HAS A THIRD, BETTER FACT — §15.2's finding 9, closed.
   *
   * It had two: somebody pressed Approve, and somebody parked the check. Both
   * are real and neither is what a biller means by leaving off — that is the
   * check she was READING when the phone rang, which she neither parked nor
   * tried to approve. A write-off decision is exactly that: per user, per
   * instant, on one check, recorded because it has to be recorded anyway.
   *
   * The two facts are ORed rather than one replacing the other, and the row
   * reads whichever is NEWER — a check she decided a line on this morning and
   * approved last week is a check she last touched this morning.
   */
  const touchedAt = (r: Remittance): number => {
    const approved = r.approvalAttemptedAt ? Date.parse(r.approvalAttemptedAt) : 0;
    const decided = r.lastDecidedAt ? Date.parse(r.lastDecidedAt) : 0;
    return Math.max(approved, decided);
  };
  const started = rows
    .filter(
      (r) =>
        r.setAsideAt == null &&
        (r.approvalAttemptedAt != null || r.lastDecidedAt != null) &&
        r.needsAttention &&
        !parkedIds.has(r.batchId),
    )
    .sort((a, b) => touchedAt(b) - touchedAt(a))
    .slice(0, LEFT_OFF_LIMIT);

  return {
    counts,
    scanned: rows.length,
    total: page.total,
    parkedCount: page.parkedCount,
    setAsideCount: page.setAsideCount,
    parked,
    started,
    /*
     * NEWEST FIRST, and set-aside checks are not arrivals. Every other queue on
     * this page is worked oldest-first; "what came in" is the one question whose
     * answer is the newest thing.
     */
    arrivals: rows
      .filter((r) => r.setAsideAt == null)
      .slice()
      .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""))
      .slice(0, 3),
    postedThisWeek: postedRecently.length,
    postedCents: postedRecently.reduce((sum, r) => sum + r.postedTotalCents, 0),
    stuckPostings: queue.byStatus.blocked,
    topBlocker: topReason ? (blockedCopy(topReason)?.label ?? null) : null,
    /*
     * SHADOW ONLY WHEN THE PRACTICE IS OTHERWISE READY.
     *
     * A practice D-7 has never validated is not "in shadow mode" — it is not set
     * up, and its postings say so per row. Showing both would offer two
     * explanations for one silence, and the biller would have to guess which one
     * an admin can act on.
     */
    shadowMode: queue.postingEnabled && !queue.drainEnabled,
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
