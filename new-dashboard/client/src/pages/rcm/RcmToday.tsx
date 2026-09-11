/**
 * /rcm — TODAY. The first screen of a biller's morning.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT WAS A STATS PAGE, THEN A QUEUE, THEN A DAY — AND NOW IT ANSWERS
 * ═════════════════════════════════════════════════════════════════════════════
 * Version one answered "how much of everything is there", which is a question
 * nobody standing at the front desk has. Version two answered "what is waiting
 * on me", which is better and still not first. Version three (Stage A) put the
 * day's three questions in order and got the shape right.
 *
 * Stage C fixes what was left: every one of those questions was answered with a
 * NUMBER and a link, and a number is not an answer to "where did I leave off".
 * A biller reading *3 waiting for your review* still had to open the check,
 * scroll its claim list and work out which row she had not got to — which is the
 * work the card was supposed to save her.
 *
 * So the three questions now answer in sentences:
 *
 *   1. WHERE DID I LEAVE OFF?   each card names THE NEXT THING — "keep checking
 *                               it over, so-and-so is up" — and one button goes
 *                               straight to it. `features/rcm/nextAction.ts`
 *                               decides that, once, and a test drives it
 *                               directly.
 *   2. WHAT CAME IN?            a table, one row per check, with a *What happens
 *                               next* column in her words rather than a chip in
 *                               the machine's. `features/rcm/waitingOn.ts`
 *                               decides that, once, and the Checks page's
 *                               *Waiting on* column is the same computation in
 *                               the other register.
 *   3. GET WORK IN              TWO DROP ZONES, on this page.
 *
 * and only then how the week went. Stats are below the work because a number is
 * something you look at once a day and a queue is something you work.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE UPLOAD PANELS ARE BACK ON THIS PAGE (ruling D-18)
 * ─────────────────────────────────────────────────────────────────────────────
 * They have moved twice, and the third position is the one that survives, so it
 * is worth writing down why rather than leaving the next reader to assume it
 * moved by taste.
 *
 *   STAGE A  put them at the TOP of Today. The count was right — one door — and
 *            the room was wrong: a biller opening the screen that tells her what
 *            is waiting on her met two file inputs and a cost breaker before she
 *            met a single check.
 *
 *   STAGE C  moved them to `/rcm/bring-in`, a page of their own with six source
 *            tiles, three of which could not be pressed. That fixed the top of
 *            Today and bought a second problem: adding a check — the act that
 *            starts every other act in this module — became a navigation, to a
 *            page half of which was a menu of things the product cannot do.
 *
 *   D-18     puts them back on Today, BELOW the work rather than above it. The
 *            ORDER is the whole fix: what is waiting on you, what came in, and
 *            THEN somewhere to add more. A biller with nothing to add scrolls
 *            past it; a biller holding a file finds it without leaving the
 *            screen she opened.
 *
 * The not-yet tiles are DROPPED, not relocated. A tile naming a thing the
 * product cannot do earns its space only on a page devoted to sources, and there
 * is no such page now.
 *
 * ONE UPLOAD SURFACE STILL. The invariant did not change — only which page holds
 * it. `tests/rcm-shell.test.tsx` reads the source of every RCM page and fails if
 * a second one imports a panel. `/rcm?add=1` — the link the Checks page and the
 * matching guidance use — scrolls the section into view on arrival, and
 * `/rcm/bring-in` still answers, by redirecting here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAVED FOR TOMORROW NOW COMES BACK IN ONE CLICK
 * ─────────────────────────────────────────────────────────────────────────────
 * Parking was reversible from the day it shipped — opening the check un-parks it
 * — but the only way to do it was to OPEN the check, which is the one thing a
 * biller triaging this card does not want to do four times. So a saved row
 * carries *Bring it back to tonight* beside the pick-up button: the same
 * `unparkRemittance` call the check's own page fires, from the card she is
 * already reading.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "WHERE DID I LEAVE OFF" IS TWO HONEST SIGNALS, NOT ONE INFERRED ONE
 * ─────────────────────────────────────────────────────────────────────────────
 * There is no per-user "last opened" stamp on a check anywhere in this schema,
 * so this card cannot say "the ones YOU had open yesterday" and does not
 * pretend to. It shows the things that ARE recorded:
 *
 *   PARKED    somebody pressed Save for tomorrow, on purpose, and their name and
 *             instant are on the row.
 *   STARTED   somebody pressed Approve, or decided a write-off on a line, and
 *             the check still needs attention. `lastDecidedAt` is the touch
 *             stamp §15.2's ninth finding asked for; Stage B1 shipped it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NEXT-ACTION SENTENCE COSTS ONE READ PER CARD, AND ONLY PER CARD
 * ─────────────────────────────────────────────────────────────────────────────
 * `/api/rcm/remittances` returns rows, not claims, so naming the next CLAIM
 * needs the check's own bundle. That read happens for the handful of checks on
 * the *Where you left off* card — at most four — and for nothing else on this
 * page. A bundle that fails to arrive is not an error state: the card falls back
 * to the sentence the row alone can support ("open the check to see which claim
 * is up"), which is less useful and still true.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE EACH NUMBER COMES FROM, AND WHAT IT DOES NOT KNOW
 * ─────────────────────────────────────────────────────────────────────────────
 * The three work-state counts are computed in the BROWSER over the newest 200
 * checks an office holds, because `/api/rcm/remittances` has no work-state view.
 * So the card SAYS what it counted over when the practice holds more.
 *
 * "Posted this week" and "Stuck" read the posting history's data, whose
 * `byStatus` is server-computed over the whole office. `parkedCount` and
 * `setAsideCount` come back from the SERVER over the whole office, so those two
 * carry no caveat at all.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  AlertCircle,
  ArrowRight,
  Ban,
  BookmarkCheck,
  CheckCircle2,
  Inbox,
  Loader2,
  PartyPopper,
  Search,
  ShieldCheck,
  Stethoscope,
  Undo2,
  Upload,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useOffice } from "@/contexts/OfficeContext";
import { useRcmOfficeScope } from "@/features/rcm/officeScope";
import {
  getRemittance,
  listPostingQueue,
  listRemittances,
  unparkRemittance,
  RcmApiError,
  RCM_OFFICE_LABELS,
  type PostingQueuePage,
  type RcmOfficeId,
  type Remittance,
  type RemittanceClaim,
} from "@/features/rcm/api";
import EobUploadPanel from "./EobUploadPanel";
import EraUploadPanel from "./EraUploadPanel";
import { money, withinLastDays } from "@/features/rcm/format";
import { blockedCopy, SHADOW_MODE_COPY } from "@/features/rcm/posting";
import { RCM_STEP_TITLES, remittanceHref } from "@/features/rcm/flow";
import { greetingFor, officeDay, officeDayKey, todayLongDate } from "@/features/rcm/time";
import { nextActionFor, PICK_UP_LABEL, type NextAction } from "@/features/rcm/nextAction";
import { waitingFor } from "@/features/rcm/waitingOn";
import {
  countByFilter,
  FILTER_COPY,
  newestParkedFirst,
  oldestWaitingFirst,
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
 * a card of forty rows is the queue again, one section higher. It also bounds
 * the per-card claim reads — see the header.
 */
const LEFT_OFF_LIMIT = 4;

/** How many arrivals the table names. Newest first; the rest are on Checks. */
const ARRIVALS_LIMIT = 6;

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
  /** What somebody pressed Approve on, or decided a line on, and did not finish. */
  started: Remittance[];
  /** The newest arrivals, whatever state they are in. */
  arrivals: Remittance[];
  /**
   * THE ONE CHECK THE START BUTTON OPENS — the oldest still waiting on somebody.
   *
   * `null` when nothing needs anybody, which is the whole of "you're done for
   * today" and is a different answer from "we have not looked yet" (`today`
   * itself being null).
   *
   * PARKED CHECKS ARE EXCLUDED. Somebody said on the record that this one is for
   * tomorrow; a Start button that reopened it would overrule a decision a person
   * made on purpose. They keep their own card, one section down.
   */
  startHere: Remittance | null;
  postedThisWeek: number;
  postedCents: number;
  /**
   * TONIGHT, not this week — the all-done card's own numbers.
   *
   * "Tonight" is the PRACTICE's day (`officeDayKey`), not the reader's browser
   * day. A biller finishing at 11pm Central and a manager checking from a
   * laptop set to Eastern must be told about the same evening, and only the
   * office's own boundary gives them that.
   */
  postedTonight: number;
  postedTonightCents: number;
  stuckPostings: number;
  /** The commonest reason a posting is stuck, in biller words. */
  topBlocker: string | null;
  /**
   * THE SHADOW GATE, carried through from the posting read so Today says the
   * same thing the posting history screen does.
   *
   * A biller lives on this screen. If the only place that said "nothing you
   * approve is going to post yet" were a screen she has no reason to open, she
   * would find out by going to look — which is the same as not being told.
   */
  shadowMode: boolean;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; today: Today }
  | { kind: "failed"; message: string };

/**
 * WHERE THE *GET WORK IN* SECTION LIVES IN THE DOCUMENT.
 *
 * A plain element id rather than a ref threaded through three components: the
 * arrivals empty state, an arriving `?add=1`, and — one day — a link from
 * anywhere else all want to put the same section on screen, and an id is the one
 * handle all three can hold without the page inventing a context to pass it in.
 *
 * It is per office because the section is: each practice gets its own two drop
 * zones, and scrolling to "the" one on a two-office screen would be a coin flip.
 */
function getWorkInId(office: RcmOfficeId): string {
  return `rcm-get-work-in-${office}`;
}

/** Put a practice's drop zones on screen. Used by the link AND by the button. */
function scrollToGetWorkIn(office: RcmOfficeId): void {
  document.getElementById(getWorkInId(office))?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}

export default function RcmToday() {
  const scope = useRcmOfficeScope();
  const { reload } = useOffice();
  const auth = useAuth();

  /**
   * `/rcm?add=1` — the Checks page's *Add a check*, the matching guidance's
   * *bring the check in*, and any bookmark from before Stage C.
   *
   * It SCROLLS rather than navigates, because the section is on this page again
   * (D-18). The first scoped office wins: on a one-office practice that is the
   * only answer, and on a two-office one the top of the section is where a
   * reader can see both.
   *
   * The delay is the same 60ms the Bring in page used, and for the same reason:
   * the section renders on the first paint but the office cards above it settle
   * a tick later, and scrolling before they do lands short.
   */
  const first = scope.offices[0];
  useEffect(() => {
    if (!first) return;
    if (!window.location.search.includes("add=1")) return;
    const t = window.setTimeout(() => scrollToGetWorkIn(first), 60);
    return () => window.clearTimeout(t);
  }, [first]);

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
      {/*
        THE GREETING AND THE DATE.
        ─────────────────────────────────────────────────────────────────────
        A heading reading "Today" told a reader nothing she did not already
        know from having clicked Today. The date does one useful thing: it is
        the practice's own, so somebody reading this from a laptop in another
        timezone at 11pm can see at a glance which evening every row below
        belongs to. See `todayLongDate`.

        The name is the person signed in, and is DROPPED rather than guessed at
        when the session has not resolved — "Good morning," with a comma and
        nothing after it is worse than "Good morning." on its own.
      */}
      <h1
        className="text-2xl font-bold tracking-tight text-foreground"
        style={{ fontFamily: "Sora, sans-serif" }}
        data-testid="rcm-today-greeting"
      >
        {greetingFor()}
        {auth.status === "authenticated" && firstName(auth.user.name)
          ? `, ${firstName(auth.user.name)}`
          : ""}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground" data-testid="rcm-today-date">
        {todayLongDate()} · carrier payments, from the check that arrived to the money on the
        chart.
      </p>

      {/*
        THE FLOW, SAID ONCE AT THE TOP — the same steps the rail draws on every
        screen below, so the shape is learned before it is needed.

        S7: it used to be a hand-copied array of four strings sitting a file away
        from the rail's own names, which is how a legend and the thing it legends
        drift apart. It reads `RCM_STEP_TITLES` now, so renaming a stage renames
        it here in the same commit or not at all.
      */}
      <p
        className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground"
        data-testid="rcm-flow-legend"
      >
        {(["upload", "match", "review", "post"] as const).map((step, i) => (
          <span key={step} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-muted-foreground/40">›</span>}
            <span className="font-medium text-foreground">{RCM_STEP_TITLES[step]}</span>
          </span>
        ))}
        <span className="text-muted-foreground/40">›</span>
        <span className="italic">{RCM_STEP_TITLES.deposit} (soon)</span>
      </p>

      {scope.offices.length === 0 ? (
        <Notice
          testId="rcm-no-offices"
          title="No RCM offices"
          body="None of this practice's offices are set up for revenue cycle work yet."
        />
      ) : (
        <div className="mt-6 space-y-8" data-testid="rcm-office-cards">
          {scope.offices.map((office) => (
            <OfficeToday key={office} office={office} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The name to greet somebody by.
 *
 * The first word of `AuthUser.name`, which is a STAFF name — never a patient's.
 * A name that is one word is used whole; an empty one yields empty, and the
 * caller drops the comma with it rather than printing a dangling one.
 *
 * TYPED `string`, GUARDED ANYWAY. `/auth/me` is external data and this is the
 * greeting on the module's landing screen: a session whose payload omits `name`
 * must produce "Good morning", not a blank page. The vitest fixtures build a
 * user without one, which is exactly the shape a real thin session has.
 */
function firstName(name: string | null | undefined): string {
  if (typeof name !== "string") return "";
  return name.trim().split(/\s+/)[0] ?? "";
}

/**
 * One practice's day.
 *
 * Two calls, deliberately: the check list answers "what is waiting on a person",
 * the posting read answers "what happened to the money". Neither can answer the
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
  /** Re-read this practice after something on the page changed it. */
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <section
      className="rounded-xl border border-border bg-card p-5 shadow-sm"
      data-testid={`rcm-summary-${office}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-foreground">{RCM_OFFICE_LABELS[office]}</h2>
          {/* The same badge, the same words, the same quiet tone as the posting
              history screen's. Nothing is wrong here — the work just waits. */}
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
          {/* ── 0. START HERE — the one thing this screen is for ─────────── */}
          <StartHere office={office} today={today} />

          {/* ── 1. WHERE DID I LEAVE OFF ─────────────────────────────────── */}
          <LeftOff office={office} today={today} onChanged={reload} />

          {/* ── 2. WHAT CAME IN ──────────────────────────────────────────── */}
          <Arrivals office={office} today={today} />

          {/* ── 3. GET WORK IN ───────────────────────────────────────────── */}
          <GetWorkIn office={office} />

          {/* ── HOW IT STANDS — below the work, on purpose ───────────────── */}
          <h3
            className="mt-6 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            data-testid={`rcm-stats-${office}`}
          >
            How it stands
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

          {/* WHAT THE THREE COUNTS WERE COMPUTED OVER. Only when it is not the
              whole practice — a caveat printed over a complete answer teaches
              people to ignore caveats. */}
          {today && today.total > today.scanned && (
            <p className="mt-3 text-xs text-muted-foreground" data-testid={`rcm-scan-note-${office}`}>
              The three counts above read the newest {today.scanned} of {today.total} checks this
              practice holds.
            </p>
          )}

          <Link
            href="/rcm/posting"
            data-testid={`rcm-posted-week-${office}`}
            className="mt-3 flex items-center gap-3 rounded-lg border border-border/60 bg-emerald-50/40 p-3 transition-colors hover:bg-emerald-50 dark:bg-emerald-950/10 dark:hover:bg-emerald-950/25"
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
 * "Get work in" — the module's one upload surface, back on Today (D-18).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO DROP ZONES, AND THE DIFFERENCE BETWEEN THEM IS THE POINT
 * ─────────────────────────────────────────────────────────────────────────────
 * An 835 is parsed; every figure on it is exactly what the carrier sent, so a
 * bad file can be malformed but it cannot be MISREAD. A PDF is read by a model,
 * and every figure it produces is a proposal somebody checks. Those are not two
 * flavours of upload, they are two different promises about the numbers, and a
 * biller choosing between them is choosing how much she will have to verify.
 *
 * So the two zones say which is which, in one line each, above the panels
 * themselves. The panels are UNCHANGED — this section chooses where they sit
 * and nothing else. A zone that re-implemented an upload would be a second
 * ingest path wearing a new label.
 *
 * A PAYER PORTAL DOWNLOAD IS THE EOB ZONE. Stage C gave it a tile of its own,
 * because that is where a biller looks for it, and pointed it at the very same
 * endpoint. With the tiles gone the honest thing is to NAME it in the EOB
 * zone's line rather than leave somebody holding a portal PDF wondering whether
 * this product has a place for it.
 */
function GetWorkIn({ office }: { office: RcmOfficeId }) {
  return (
    <section className="mt-8 scroll-mt-6" id={getWorkInId(office)} data-testid={`rcm-get-work-in-${office}`}>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Upload size={14} />
        Get work in
      </h3>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Whatever you add here becomes a <strong>proposal</strong> — claims and procedure lines
        waiting for a person. Nothing added is posted to a patient chart.
      </p>

      <div className="mt-3 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div data-testid={`rcm-drop-era-${office}`}>
          <p className="mb-1.5 text-xs font-medium text-foreground">
            An 835 file from the carrier — <span className="font-normal text-muted-foreground">reads itself; every figure is exactly what was sent.</span>
          </p>
          <EraUploadPanel office={office} />
        </div>
        <div data-testid={`rcm-drop-eob-${office}`}>
          <p className="mb-1.5 text-xs font-medium text-foreground">
            A scanned EOB or a payer portal download —{" "}
            <span className="font-normal text-muted-foreground">
              read by a model, so every figure needs your eyes.
            </span>
          </p>
          <EobUploadPanel office={office} />
        </div>
      </div>
    </section>
  );
}

/**
 * WHAT A STARTED ROW SAYS ABOUT ITSELF.
 *
 * Two facts can put a check here and they are different sentences. The newer one
 * wins, because the question the card answers is "what was I last doing".
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
function LeftOff({
  office,
  today,
  onChanged,
}: {
  office: RcmOfficeId;
  today: Today | null;
  /** Re-read the practice, so the card and every count below move together. */
  onChanged: () => void;
}) {
  /**
   * The claim bundles for the cards on screen, keyed by check.
   *
   * At most `LEFT_OFF_LIMIT` reads, and only for the checks this card names. A
   * bundle that never arrives leaves its entry absent, and `nextActionFor`
   * handles that as a first-class case rather than as an error — see its header.
   */
  const [claims, setClaims] = useState<Record<string, RemittanceClaim[]>>({});

  const rows = today
    ? [
        ...today.parked.map((r) => ({ r, kind: "parked" as const })),
        ...today.started.map((r) => ({ r, kind: "started" as const })),
      ].slice(0, LEFT_OFF_LIMIT)
    : [];

  /** The ids, as a stable string, so the effect does not re-run on every render. */
  const ids = rows.map(({ r }) => r.batchId).join(",");

  useEffect(() => {
    if (!ids) return;
    let cancelled = false;
    const wanted = ids.split(",");
    Promise.all(
      wanted.map((batchId) =>
        getRemittance(office, batchId).then(
          (detail) => [batchId, detail.claims] as const,
          // Silent, and deliberately: the card still says something true without
          // it, and an error banner over a convenience nobody asked for costs
          // the reader's attention for nothing.
          () => null,
        ),
      ),
    ).then((results) => {
      if (cancelled) return;
      const next: Record<string, RemittanceClaim[]> = {};
      for (const entry of results) {
        if (entry) next[entry[0]] = entry[1];
      }
      setClaims(next);
    });
    return () => {
      cancelled = true;
    };
  }, [ids, office]);

  if (!today || rows.length === 0) return null;

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
      <ul className="mt-2 space-y-2">
        {rows.map(({ r, kind }) => (
          <LeftOffRow
            key={`${kind}-${r.batchId}`}
            office={office}
            remittance={r}
            kind={kind}
            action={nextActionFor(r, claims[r.batchId] ?? null)}
            onChanged={onChanged}
          />
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

/**
 * "N CHECKS NEED YOU → START" — the dominant thing on this screen (S7, Phase 1).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS CARD EXISTS
 * ═════════════════════════════════════════════════════════════════════════════
 * The 2026-09-11 inventory measured this page and found SIXTEEN clickable things
 * and, in the ordinary populated state, ZERO primary buttons — the only solid
 * button on Today rendered in the empty state, when the practice had never taken
 * a check in. A new hire opening the screen met sixteen equal-weight links and
 * nothing saying where to begin, which is exactly the ruling the owner gave:
 * *unclear where to go*.
 *
 * So: one count, one destination, one button. Everything else on the page — what
 * you left off, what came in, somewhere to add more, how the week went — is
 * still here, and is now visibly secondary to this.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT OPENS A CHECK, NOT A LIST
 * ─────────────────────────────────────────────────────────────────────────────
 * The obvious build is a link to `?view=attention`, and it is the wrong one: it
 * answers "where is the work" with another screen of choices. Start opens the
 * oldest check still waiting on somebody, by name, so the first click of the day
 * lands on work rather than on a filter.
 *
 * `today.startHere` decides WHICH, in `summarise`, where a test can drive it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COUNT IS HONEST ABOUT WHAT IT COUNTED
 * ─────────────────────────────────────────────────────────────────────────────
 * `counts.attention` is computed in the browser over the newest `SCAN_LIMIT`
 * checks, like the three below it — `/api/rcm/remittances` has no work-state
 * count for a whole office. On a practice holding more than that, the card says
 * so in the same words the stats section already uses, rather than presenting a
 * partial count as a total.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DONE IS A REAL ANSWER AND GETS THE SAME ROOM
 * ─────────────────────────────────────────────────────────────────────────────
 * An empty queue renders the card, not nothing: *You're done for today.* A
 * screen that silently omits its own headline when there is no work leaves the
 * reader to work out from an absence whether she is finished or whether it has
 * not loaded — and `today === null` (still loading) IS the other case, which is
 * why the two are branched apart rather than collapsed into a falsy check.
 */
function StartHere({ office, today }: { office: RcmOfficeId; today: Today | null }) {
  if (!today) return null;

  const waiting = today.counts.attention;
  const start = today.startHere;
  const partial = today.total > today.scanned;

  if (waiting === 0 || !start) {
    return (
      <div
        className="mt-4 flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50/50 p-4 dark:border-emerald-900/60 dark:bg-emerald-950/15"
        data-testid={`rcm-start-here-${office}`}
      >
        <PartyPopper size={18} className="flex-shrink-0 text-emerald-700 dark:text-emerald-400" />
        <p
          className="text-base font-semibold text-foreground"
          data-testid={`rcm-start-here-done-${office}`}
        >
          You&rsquo;re done for today.
        </p>
      </div>
    );
  }

  return (
    <div
      className="mt-4 flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-between"
      data-testid={`rcm-start-here-${office}`}
    >
      <div>
        <p
          className="text-lg font-semibold text-foreground"
          data-testid={`rcm-start-here-count-${office}`}
        >
          {waiting} check{waiting === 1 ? "" : "s"} need{waiting === 1 ? "s" : ""} you
        </p>
        {/* WHICH ONE, by name — so the button is not a leap of faith. */}
        <p className="mt-0.5 text-sm text-muted-foreground">
          Oldest first: {start.payer} · {money(start.totalAmountCents)}
        </p>
        {partial && (
          <p
            className="mt-0.5 text-xs text-muted-foreground"
            data-testid={`rcm-start-here-scan-${office}`}
          >
            Counted over the newest {today.scanned} of {today.total}.
          </p>
        )}
      </div>
      <Link
        href={remittanceHref(start.batchId)}
        data-testid={`rcm-start-here-go-${office}`}
        className="inline-flex flex-shrink-0 items-center gap-1.5 self-start rounded-md bg-foreground px-4 py-2 text-sm font-semibold text-background transition-opacity hover:opacity-90 sm:self-auto"
      >
        Start
        <ArrowRight size={14} />
      </Link>
    </div>
  );
}

/**
 * One unfinished check: what it is, what she wrote on it, and the next click.
 *
 * The whole row is NOT a link any more. It carries a button that goes somewhere
 * more specific than the row does — straight to the claim that is up — and a
 * link wrapping a link is markup no browser agrees about.
 */
function LeftOffRow({
  office,
  remittance: r,
  kind,
  action,
  onChanged,
}: {
  office: RcmOfficeId;
  remittance: Remittance;
  kind: "parked" | "started";
  action: NextAction;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Un-save, from the card.
   *
   * A REFUSAL IS SHOWN, not swallowed. Everything else on this card is a
   * convenience that can fail silently because the card still says something
   * true without it; this one is a press, and a press that appears to do nothing
   * is the honest-states rule broken in the smallest possible way.
   */
  async function bringBack() {
    setBusy(true);
    setError(null);
    try {
      await unparkRemittance(office, r.batchId);
      onChanged();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "That could not be brought back — try it again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      data-testid={`rcm-left-off-row-${r.batchId}`}
      className="rounded-md border border-border/60 bg-card px-2.5 py-2"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {/*
          PARKED AND STARTED ARE VISUALLY DIFFERENT, AND NEITHER LOOKS STUCK. A
          parked check is a note somebody left themselves; a started one is work
          in progress. Both are ordinary. The rose tone on this page belongs to
          "Stuck — needs you" alone, so a card of things you meant to come back
          to cannot read as a card of problems.
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
        <Link
          href={remittanceHref(r.batchId)}
          className="truncate text-sm font-medium text-foreground underline-offset-4 hover:underline"
        >
          {r.payer}
        </Link>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {money(r.totalAmountCents)}
        </span>
        {/*
          HER OWN LINE, IN QUOTATION MARKS — the same treatment the set-aside
          banner gives a reason note, and for the same reason: a sentence
          somebody typed reads differently from a sentence the product composed,
          and the quotes are what say which one this is. When there is no note,
          the composed fallback is not quoted.

          AND IT WRAPS. Both branches are sentences — hers, or `startedNote`'s
          "Approve was pressed by … and this check still needs somebody" — and a
          note somebody wrote to herself is the last thing on this page that
          should arrive with its ending cut off. Same rule as the arrivals
          table's *What happens next*; see the long note there.
        */}
        <span className="w-full break-words text-xs text-muted-foreground">
          {kind === "parked" ? (
            r.parkedNote ? (
              <span data-testid={`rcm-left-off-note-${r.batchId}`}>“{r.parkedNote}”</span>
            ) : (
              `Saved${r.parkedBy ? ` by ${r.parkedBy}` : ""}${
                r.parkedAt ? ` on ${officeDay(r.parkedAt, office)}` : ""
              }`
            )
          ) : (
            startedNote(r, office)
          )}
        </span>
      </div>

      {/* THE NEXT THING, BY NAME, AND THE BUTTONS THAT ACT ON IT. */}
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        <span
          className="text-xs font-medium text-foreground"
          data-testid={`rcm-next-action-${r.batchId}`}
        >
          {action.sentence}
        </span>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {/*
            ONLY ON A SAVED ROW. A started check was never put down on purpose,
            so there is nothing to bring back from — and a button that un-does
            something nobody did is a control with no meaning.
          */}
          {kind === "parked" && (
            <button
              type="button"
              onClick={bringBack}
              disabled={busy}
              data-testid={`rcm-bring-back-${r.batchId}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
              Bring it back to tonight
            </button>
          )}
          <Link
            href={action.href}
            data-testid={`rcm-pick-up-${r.batchId}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            {PICK_UP_LABEL}
            <ArrowRight size={12} />
          </Link>
        </div>
      </div>

      {error && (
        <p
          className="mt-1.5 text-xs text-amber-700 dark:text-amber-400"
          data-testid={`rcm-bring-back-error-${r.batchId}`}
        >
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * "What came in" — the arrivals table.
 *
 * A row per check rather than a count per state, because a biller who recognises
 * a payer can start there, and because the question this section asks is
 * answered by names. The last column is the point: *What happens next*, in her
 * words, from the same predicate the Checks page's *Waiting on* column reads.
 */
function Arrivals({ office, today }: { office: RcmOfficeId; today: Today | null }) {
  return (
    <>
      <h3
        className="mt-6 flex items-center gap-1.5 text-sm font-semibold text-foreground"
        data-testid={`rcm-what-came-in-${office}`}
      >
        <Inbox size={14} />
        What came in
      </h3>

      {!today ? (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-background p-4 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          Loading…
        </div>
      ) : today.arrivals.length === 0 ? (
        <EmptyArrivals office={office} today={today} />
      ) : (
        <div className="mt-2 overflow-hidden rounded-lg border border-border" data-testid={`rcm-arrivals-${office}`}>
          <div className="hidden grid-cols-[minmax(8rem,1.2fr)_7rem_6rem_4rem_minmax(11rem,1.4fr)_1.25rem] gap-3 border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground md:grid">
            <span>Payer</span>
            <span>Check</span>
            <span className="text-right">Amount</span>
            <span className="text-right">Claims</span>
            <span>What happens next</span>
            <span />
          </div>
          {today.arrivals.map((r) => {
            const waiting = waitingFor(r, { office, shadowMode: today.shadowMode });
            return (
              <Link
                key={r.batchId}
                href={remittanceHref(r.batchId)}
                data-testid={`rcm-arrival-${r.batchId}`}
                className="grid grid-cols-1 items-center gap-3 border-b border-border px-3 py-2 transition-colors last:border-b-0 hover:bg-muted/40 md:grid-cols-[minmax(8rem,1.2fr)_7rem_6rem_4rem_minmax(11rem,1.4fr)_1.25rem]"
              >
                <span className="truncate text-sm font-medium text-foreground">{r.payer}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {r.checkNumber || r.eftNumber || r.traceNumber || "no number"}
                </span>
                <span className="text-right font-mono text-sm tabular-nums text-foreground">
                  {money(r.totalAmountCents)}
                </span>
                <span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {r.claimCount}
                </span>
                {/*
                  THIS CELL WRAPS. IT MUST NEVER TRUNCATE.
                  ───────────────────────────────────────────────────────────
                  It did, and the practice owner's screen read *The carrier is
                  reclaiming money. It i…* — a takeback announced by half a
                  sentence, cut mid-word, with the half that says what to do
                  about it on the other side of the ellipsis.

                  A column whose job is a SENTENCE may not cut itself off. The
                  ellipsis is an honest device for an identifier — a payer name
                  or a check number is recognisable from its first characters
                  and the rest is lookup — and a dishonest one for prose, where
                  the clipped half is the half carrying the verb.

                  So the row grows instead. `min-w-0` lets the grid track shrink
                  below the sentence's natural width (without it a long sentence
                  pushes the whole row wide rather than wrapping), and
                  `break-words` catches the pathological case of a single
                  unbroken token longer than the column.

                  The `title` that used to carry the full text is gone with the
                  truncation: it existed only because the cell was clipped, and
                  a tooltip repeating text already fully on screen is noise a
                  screen reader reads twice.
                */}
                <span
                  className={`min-w-0 break-words text-xs ${
                    waiting.urgent ? "font-medium text-foreground" : "text-muted-foreground"
                  }`}
                  data-testid={`rcm-arrival-next-${r.batchId}`}
                >
                  {waiting.next}
                </span>
                <ArrowRight
                  size={13}
                  className="hidden justify-self-end text-muted-foreground md:block"
                />
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}

/**
 * NOTHING CAME IN — and the two reasons for that are not the same news.
 *
 * A practice with no checks at all is a first evening: the honest thing is to
 * point at the door. A practice that HAS checks and none waiting is a finished
 * evening, and it should feel like one — with the numbers, because "you are
 * done" without them reads like the screen failed to load.
 */
function EmptyArrivals({ office, today }: { office: RcmOfficeId; today: Today }) {
  if (today.total === 0) {
    return (
      <div
        className="mt-2 rounded-lg border border-dashed border-border bg-background p-6 text-center"
        data-testid={`rcm-arrivals-none-ever-${office}`}
      >
        <Inbox size={20} className="mx-auto text-muted-foreground/50" />
        <p className="mt-2 text-sm font-medium text-foreground">
          Nothing has come in for {RCM_OFFICE_LABELS[office]} yet
        </p>
        <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">
          This is where a carrier&rsquo;s payments land. Add an 835 file or an EOB PDF and CareIN
          reads it into one check per payment, finds each claim in Open Dental, and works out what
          the carrier paid, what it wrote off, and what the patient is left owing. All of that is a
          proposal you read and change before anything happens to it.
        </p>
        {/*
          A BUTTON, NOT A LINK — the drop zones are further down THIS page now
          (D-18), so there is nowhere to navigate to. It scrolls, which is the
          honest verb for what it does.
        */}
        <button
          type="button"
          onClick={() => scrollToGetWorkIn(office)}
          data-testid={`rcm-arrivals-none-ever-add-${office}`}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
        >
          <Upload size={14} />
          Bring one in
        </button>
        {/*
          THE FOOTER IS THE POINT OF THE WHOLE MODULE, and a first-run reader is
          exactly who needs it. Somebody meeting this screen for the first time
          is being asked to feed a carrier's file to software that can write to
          patients' charts, and every hesitation about doing that is answered by
          one sentence. It is a footer rather than a paragraph because it stays
          true on every visit, not only this one.
        */}
        <p
          className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground"
          data-testid={`rcm-arrivals-none-ever-safety-${office}`}
        >
          Nothing you do here reaches Open Dental until you say so.
        </p>
      </div>
    );
  }

  /*
   * FINISHED, WITH THE NUMBERS.
   *
   * "You're done" on its own reads like a screen that failed to load, so it
   * carries a small summary of the evening. Every line is computed from data
   * this page ALREADY holds, and each is dropped on its own when it is not
   * there — a card with two lines is honest; a card with a fourth line invented
   * to balance the layout is not. See `summariseTonight`.
   */
  const summary = summariseTonight(today);
  return (
    <div
      className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50/50 p-6 text-center dark:border-emerald-900/60 dark:bg-emerald-950/15"
      data-testid={`rcm-arrivals-all-done-${office}`}
    >
      <PartyPopper size={20} className="mx-auto text-emerald-600 dark:text-emerald-400" />
      <p className="mt-2 text-sm font-medium text-foreground">You&rsquo;re done for tonight.</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Nothing at {RCM_OFFICE_LABELS[office]} is waiting on anybody.
      </p>

      {summary.length > 0 && (
        <dl
          className="mx-auto mt-4 w-fit min-w-[15rem] space-y-1 rounded-lg border border-border bg-card px-4 py-3 text-left"
          data-testid={`rcm-tonight-summary-${office}`}
        >
          {summary.map((line) => (
            <div key={line.label} className="flex items-baseline justify-between gap-6 text-xs">
              <dt className="text-muted-foreground">{line.label}</dt>
              <dd
                className="font-mono font-semibold tabular-nums text-foreground"
                data-testid={`rcm-tonight-${line.testId}-${office}`}
              >
                {line.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

interface SummaryLine {
  label: string;
  value: string;
  testId: string;
}

/**
 * The evening, in the lines this page can actually evidence.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS HERE, AND WHAT IS DELIBERATELY NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * The design asked for four lines. Two of them have no client-side source and
 * are therefore ABSENT rather than approximated:
 *
 *   WRITTEN OFF BY THE OFFICE lives on `PostingQueueLine.intendedWriteOffCents`
 *   — per LINE, and the posting rows this page reads carry no lines. Summing
 *   something else and labelling it "written off" would put a number a biller
 *   might quote to a patient beside a word it does not mean.
 *
 *   YOU STARTED AT would need a session start, and nothing records one. The
 *   earliest posting that FINISHED tonight is a different fact wearing the same
 *   sentence, and it would be wrong on the commonest evening of all — one where
 *   she worked for an hour and posted nothing.
 *
 * Both are written up as backend asks in the PR rather than guessed at here.
 */
export function summariseTonight(today: Today): SummaryLine[] {
  const lines: SummaryLine[] = [];
  if (today.postedTonight > 0) {
    lines.push({
      label: "Checks finished tonight",
      value: String(today.postedTonight),
      testId: "finished",
    });
    lines.push({
      label: "Money accounted for",
      value: money(today.postedTonightCents),
      testId: "money",
    });
  }
  /*
   * The fallback, and it is not a consolation prize: on an evening where
   * nothing posted — every check matched, checked over, and left for an
   * administrator to switch posting on — "12 checks on file, all worked
   * through" is the true summary of it, and the count is the reassurance.
   */
  if (lines.length === 0 && today.total > 0) {
    lines.push({
      label: `Check${today.total === 1 ? "" : "s"} on file, all worked through`,
      value: String(today.total),
      testId: "onfile",
    });
  }
  return lines;
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
   * The subset that finished TODAY in the practice's own timezone. Narrowed
   * from `postedRecently` rather than from `queue.rows`, so both numbers are
   * about the same population and cannot disagree about what "posted" means.
   */
  const nowIso = now.toISOString();
  const postedTonight = postedRecently.filter((r) => {
    // Each row is compared against "now" IN ITS OWN OFFICE'S day, so the two
    // keys can never be taken from two different boundaries. A row with no
    // finishedAt yields null and is excluded rather than counted as today.
    const key = officeDayKey(r.finishedAt, r.office);
    return key !== null && key === officeDayKey(nowIso, r.office);
  });

  /*
   * THE COMMONEST REASON A POSTING IS STUCK, not the first one seen.
   *
   * A practice that is not switched on for posting has every one stuck for the
   * same reason, and that is the sentence worth putting on a card. Ties resolve
   * to whichever the read returned first, which is fine — the point is to name
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
   * "STARTED" HAS A THIRD, BETTER FACT — §15.2's finding 9, closed by B1.
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
      .slice(0, ARRIVALS_LIMIT),
    /*
     * OLDEST WAITING FIRST — `oldestWaitingFirst`'s own reason, applied to the
     * one row that gets a button: a queue is worked from the end that has been
     * waiting longest, and money ages. Parked and set-aside are out for the
     * reason on the field.
     */
    startHere:
      oldestWaitingFirst(
        rows.filter((r) => r.needsAttention && r.setAsideAt == null && r.parkedAt == null),
      )[0] ?? null,
    postedThisWeek: postedRecently.length,
    postedCents: postedRecently.reduce((sum, r) => sum + r.postedTotalCents, 0),
    postedTonight: postedTonight.length,
    postedTonightCents: postedTonight.reduce((sum, r) => sum + r.postedTotalCents, 0),
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
