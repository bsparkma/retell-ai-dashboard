/**
 * /hyg/day — the hygiene Day View.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ONE RULE THIS SCREEN IS BUILT AROUND
 * ═════════════════════════════════════════════════════════════════════════════
 * An empty day and a failed one must never look the same.
 *
 * There are FOUR states below, each visually distinct, and the reason is that a
 * hygienist reads this screen to find out what is about to happen to her all
 * day. A blank grid that actually means "we could not reach your practice's
 * database" is the single most damaging thing this page could show — she would
 * stand down, or walk into a patient she had no warning about.
 *
 *   LOADING          a skeleton in the shape of the day, so the page does not
 *                    jump when it arrives
 *   EMPTY            a positive statement: the schedule loaded, nobody is booked
 *   NOT READY        this office is not switched on for hygiene, or has no
 *                    Open Dental credentials. A setting, not an outage — so no
 *                    Retry button, because retrying will never help
 *   OD ERROR         Open Dental did not answer. The only state with a Retry
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SCHEDULE PAINTS FIRST. THE NAMES ARRIVE AFTER.
 * ═════════════════════════════════════════════════════════════════════════════
 * `GET /day` resolves identities only from the server's patient cache, so it
 * returns in list-read time — a few seconds — with `identity: 'pending'` on
 * whatever it could not name. This page then calls `GET /day/identities` in a
 * loop, merging each batch onto the cards it already has.
 *
 * A 40-patient day used to be ~40 seconds of skeleton, because every name is
 * one Open Dental request on a credential throttled to one per second and
 * shared with voice and RCM. That cost has not gone away and is not what
 * changed: the SCHEDULE no longer waits behind it.
 *
 * THE LOOP STOPS. It runs while `pending` is FALLING, and stops the moment a
 * batch does not move it. A patient Open Dental refuses comes back in
 * `unavailable` and the card says "Name unavailable"; a patient that somehow
 * neither resolves nor fails would otherwise be a spinner nobody can end, and
 * "spins forever" is the same lie as "empty day" wearing a different hat.
 *
 * A FAILED FILL DOES NOT DISCARD THE SCHEDULE. It is its own banner with its
 * own retry, because refetching the day to recover the names would throw away
 * a schedule that loaded perfectly well.
 *
 * The server is what makes this possible: it refuses with a code for every way
 * of not knowing, and `appointments: []` comes back only when nobody is booked.
 * This page renders that distinction rather than inventing it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * iPAD LANDSCAPE, 1180 × 820
 * ═════════════════════════════════════════════════════════════════════════════
 * Designed to that viewport first. Every control is at least 44px; the date
 * stepper is three big buttons rather than a date picker, because stepping to
 * tomorrow is the only date change anybody makes at a chair. Columns scroll
 * horizontally inside their own container so the page body never does.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Info,
  List,
  PlugZap,
  RefreshCw,
  UserX,
} from "lucide-react";

import { useOffice, ALL_OFFICES } from "@/contexts/OfficeContext";
import {
  isOfficeId,
  type HygAppointment,
  type HygDayIdentitiesResponse,
  type HygDayResponse,
  type HygDayScope,
  type OfficeId,
} from "@shared/hyg/contract";
import { fetchDay, fetchDayIdentities, HygApiError, HYG_OFFICE_LABELS } from "@/features/hyg/api";
import {
  byStartTime,
  columnLabel,
  filterByProvider,
  formatDayHeading,
  groupByOperatory,
  providersOnDay,
  shiftIsoDate,
  summarise,
  todayIso,
} from "@/features/hyg/day";
import { AppointmentCard } from "@/features/hyg/AppointmentCard";
import { cn } from "@/lib/utils";

/** A control big enough to hit standing up. 44px is the floor, not the target. */
const TAP =
  "inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50";

type DayState =
  | { kind: "loading" }
  | { kind: "ready"; day: HygDayResponse }
  | { kind: "error"; error: HygApiError };

/**
 * Merge one batch of names onto the day already on screen.
 *
 * PURE, and it replaces nothing it was not given. A card that is already
 * `resolved` keeps what it has; a `pending` one whose PatNum is in this batch
 * becomes `resolved`; a PatNum the server reports as `unavailable` becomes
 * `unavailable` so its card stops waiting and says so.
 *
 * The flags are merged rather than replaced: `premed` and `medicalAlerts` are
 * the two this fill knows about, and the other five keep whatever they had.
 * Overwriting the whole object would quietly blank flags a later slice adds —
 * and blanking a clinical flag is the failure this module is written against.
 */
export function mergeIdentities(
  day: HygDayResponse,
  fill: HygDayIdentitiesResponse,
): HygDayResponse {
  const byPatNum = new Map(fill.patients.map((p) => [p.patNum, p]));
  const unavailable = new Set(fill.unavailable);

  const appointments = day.appointments.map((appt) => {
    if (appt.patNum === null) return appt;
    const named = byPatNum.get(appt.patNum);
    if (named) {
      return {
        ...appt,
        identity: "resolved" as const,
        patientName: named.patientName,
        flags: { ...appt.flags, premed: named.premed, medicalAlerts: named.medicalAlerts },
      };
    }
    if (appt.identity === "pending" && unavailable.has(appt.patNum)) {
      return { ...appt, identity: "unavailable" as const };
    }
    return appt;
  });

  return { ...day, appointments, identitiesPending: fill.pending };
}

/**
 * NOTHING IS STILL COMING. Turn every remaining shimmer into a plain answer.
 *
 * Called when the fill loop stops for ANY reason — nothing left, no progress,
 * or a failure. `pending` means "a request is on its way"; once no request is,
 * a card that keeps shimmering is claiming something that is not true, and it
 * is the same lie as an empty day wearing a different hat.
 *
 * Three ways to reach it, and all three are real:
 *
 *   - the server named everyone it was going to and some card was not among
 *     them (past the fan-out cap — `patientNamesTruncated` says so too);
 *   - a batch made no progress;
 *   - the request failed, and the banner above the list says so.
 *
 * In every one of them, waiting will not help, which is exactly what "Name
 * unavailable" means on this screen.
 */
export function settleIdentities(day: HygDayResponse): HygDayResponse {
  if (!day.appointments.some((a) => a.identity === "pending")) return day;
  return {
    ...day,
    appointments: day.appointments.map((a) =>
      a.identity === "pending" ? { ...a, identity: "unavailable" as const } : a,
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The four states
// ─────────────────────────────────────────────────────────────────────────────

function LoadingDay() {
  return (
    <div className="mt-6 flex gap-4" data-testid="hyg-day-loading" aria-busy="true">
      {[0, 1, 2].map((col) => (
        <div key={col} className="w-72 shrink-0">
          <div className="h-5 w-24 animate-pulse rounded bg-muted" />
          <div className="mt-3 space-y-3">
            {[0, 1, 2].map((row) => (
              <div key={row} className="h-[88px] animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        </div>
      ))}
      <span className="sr-only">Loading the schedule</span>
    </div>
  );
}

function EmptyDay({ date, officeName }: { date: string; officeName: string }) {
  return (
    <div
      // Bordered, centred, and it states a POSITIVE FACT. The failure states
      // below are all left-aligned banners in alert colours, so the two shapes
      // cannot be confused at a glance from across a room.
      className="mt-6 flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/50 px-6 py-16 text-center"
      data-testid="hyg-day-empty"
    >
      <CalendarDays size={28} className="text-muted-foreground" />
      <h2 className="mt-3 text-lg font-semibold text-foreground">Nobody is booked</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        {officeName}&apos;s schedule loaded for {formatDayHeading(date)} and there are no
        appointments on it.
      </p>
      <p className="mt-3 max-w-md text-xs text-muted-foreground">
        This is the schedule, not a problem loading it — if Open Dental had been unreachable this
        page would say so instead.
      </p>
    </div>
  );
}

/**
 * TWO AUTHORITIES ON ONE SCREEN IS ONE TOO MANY.
 *
 * The heading here used to name the office from the CLIENT's own label while
 * the sentence under it carried the SERVER's, which names the office the
 * refusal is actually about. In production they agree; the first screenshot
 * taken of this state had them disagreeing ("not switched on for Roland" over
 * "…not switched on for Riley Family Dental yet"), and a reader has no way to
 * tell which one is wrong.
 *
 * So the heading no longer names an office at all. The server's sentence is the
 * only place a location is named on this panel.
 */
function OfficeNotReady({ error }: { error: HygApiError }) {
  const keyMissing = error.officeReason === "OFFICE_OD_KEY_MISSING";
  return (
    <div
      className="mt-6 rounded-2xl border border-sky-200 bg-sky-50/70 p-6 dark:border-sky-900 dark:bg-sky-950/30"
      data-testid="hyg-day-not-ready"
    >
      <div className="flex items-start gap-3">
        <PlugZap size={20} className="mt-0.5 shrink-0 text-sky-700 dark:text-sky-400" />
        <div>
          <h2 className="text-lg font-semibold text-sky-900 dark:text-sky-200">
            This office is not set up for hygiene yet
          </h2>
          <p className="mt-1 max-w-xl text-sm text-sky-900/80 dark:text-sky-300/80">{error.message}</p>
          <p className="mt-3 max-w-xl text-sm text-sky-900/80 dark:text-sky-300/80">
            {keyMissing
              ? "This office is switched on but CareIN has no Open Dental credentials for it. It will never borrow another location's — a patient number means a different person in each practice's database."
              : "Nothing is wrong. This location has not been enabled for the hygiene module yet."}
          </p>
          {/* NO RETRY BUTTON, DELIBERATELY. This is a setting, and offering a
              retry would invite somebody to press it for a minute before
              working out that pressing it can never help. */}
          <p className="mt-3 text-xs text-sky-900/70 dark:text-sky-300/70">
            Ask an administrator to enable it — retrying will not change this.
          </p>
        </div>
      </div>
    </div>
  );
}

function OdError({ error, onRetry }: { error: HygApiError; onRetry: () => void }) {
  return (
    <div
      className="mt-6 rounded-2xl border border-red-200 bg-red-50/70 p-6 dark:border-red-900 dark:bg-red-950/30"
      data-testid="hyg-day-error"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle size={20} className="mt-0.5 shrink-0 text-red-700 dark:text-red-400" />
        <div>
          <h2 className="text-lg font-semibold text-red-900 dark:text-red-200">
            The schedule did not load
          </h2>
          <p className="mt-1 max-w-xl text-sm text-red-900/80 dark:text-red-300/80">
            {error.message}
          </p>
          <p className="mt-3 max-w-xl text-sm text-red-900/80 dark:text-red-300/80">
            <strong className="font-semibold">This is not an empty day.</strong> There may be
            patients booked that this page cannot see — check Open Dental directly before standing
            down.
          </p>
          <button type="button" onClick={onRetry} className={cn(TAP, "mt-4 bg-background")}>
            <RefreshCw size={15} />
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The names did not finish, and the schedule did.
 *
 * Its own banner, in its own tone, with a retry that refetches ONLY the names.
 * Folding this into the day's error state would have thrown away a schedule
 * that loaded — and a hygienist can work from times and chairs while the names
 * catch up, which is the entire point of painting them separately.
 */
function FillFailed({ error, onRetry }: { error: HygApiError; onRetry: () => void }) {
  return (
    <div
      /*
       * A FAILURE WITH A REMEDY, not a note. The notices above it are amber
       * facts a hygienist reads and moves on from; this one is asking her to
       * do something, and the first screenshot had the two stacked in the same
       * tone reading as one long amber block.
       *
       * NOT red. Red on this page means "the schedule did not load", and the
       * schedule DID load — saying otherwise in colour would undo the whole
       * point of separating the two requests.
       */
      className="mt-4 rounded-xl border-2 border-amber-400 bg-amber-100/80 p-3 text-sm shadow-sm dark:border-amber-600 dark:bg-amber-950/60"
      data-testid="hyg-fill-error"
    >
      <div className="flex items-start gap-2 text-amber-950 dark:text-amber-200">
        <UserX size={15} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p>
            <strong className="font-semibold">The schedule loaded; the names did not.</strong>{" "}
            {error.message}
          </p>
          {/* WHAT OPEN DENTAL SAID. "It fails at times" costs a day to
              reproduce; a status line costs nothing to read out over a phone. */}
          {error.detail ? (
            <p className="mt-1 font-mono text-xs opacity-80" data-testid="hyg-fill-error-detail">
              {error.detail}
            </p>
          ) : null}
          <button
            type="button"
            onClick={onRetry}
            className={cn(TAP, "mt-2 bg-background")}
            data-testid="hyg-fill-retry"
          >
            <RefreshCw size={14} />
            Try the names again
          </button>
        </div>
      </div>
    </div>
  );
}

function PickAnOffice() {
  return (
    <div
      className="mt-6 rounded-2xl border border-dashed border-border bg-card/50 px-6 py-14 text-center"
      data-testid="hyg-day-pick-office"
    >
      <CalendarDays size={26} className="mx-auto text-muted-foreground" />
      <h2 className="mt-3 text-lg font-semibold text-foreground">Choose an office</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        A hygiene day belongs to one location. Pick one in the office selector — there is no
        all-offices schedule, because a patient number means a different person in each practice&apos;s
        Open Dental database.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// What this browser remembers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The view, the lens and the hygienist picker persist PER BROWSER.
 *
 * They are conveniences, not state anyone else needs: nobody's chart, nobody's
 * audit trail and nobody's other device depends on which way a hygienist likes
 * to read her day. localStorage is exactly the right size of promise for that,
 * and every read is wrapped because a private window, cleared site data or a
 * browser set to block storage all throw rather than returning null.
 */
const PREF_KEY = "hyg.day.prefs.v1";

interface DayPrefs {
  view: "list" | "grid";
  /** `hygiene` is the DEFAULT — the doctors' chairs are hidden until asked for. */
  scope: HygDayScope;
  /** A provider name, or null for all of them. */
  provider: string | null;
}

const DEFAULT_PREFS: DayPrefs = { view: "list", scope: "hygiene", provider: null };

function readPrefs(): DayPrefs {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_PREFS;
    const value = parsed as Partial<DayPrefs>;
    return {
      view: value.view === "grid" ? "grid" : "list",
      scope: value.scope === "all" ? "all" : "hygiene",
      provider: typeof value.provider === "string" ? value.provider : null,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writePrefs(prefs: DayPrefs) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    /* a preference that cannot be remembered is not worth an error */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The day itself
// ─────────────────────────────────────────────────────────────────────────────

function SummaryStrip({ day }: { day: HygDayResponse }) {
  const s = summarise(day);
  const items: { label: string; value: number; muted?: boolean }[] = [
    { label: "Appointments", value: s.total },
    { label: "Hygiene", value: s.hygiene },
    { label: "Flagged", value: s.flagged },
    // ⚠️ THIS COUNTS CARDS, AND THE CHIP ON A CARD COUNTS FLAGS. ⚠️
    //
    // It read "Unknowns 5" over a grid whose cards said "6 unknown", which is
    // two different units under one word and reads like a defect. `summarise`
    // counts APPOINTMENTS with at least one unknown flag; the chip counts the
    // unknown FLAGS on that one card. Both are useful and neither is wrong —
    // the label is what was wrong.
    //
    // Counted separately from "Flagged" for the original reason: folding
    // unknowns in would make that number mean "at least this many", which is
    // not a number anybody can act on.
    { label: "Cards with unknowns", value: s.unknownFlags, muted: true },
  ];
  return (
    // One compact row rather than four tall tiles. At five appointments the old
    // strip cost about 70px of the 820 an iPad has, above a grid that was
    // already short — so the page read as mostly empty on a normal day.
    <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="hyg-day-summary">
      {items.map((item) => (
        <div
          key={item.label}
          className={cn(
            "flex items-baseline gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5",
            item.muted && "border-dashed",
          )}
        >
          <span className="text-base font-semibold tabular-nums text-foreground">
            {item.value}
          </span>
          <span className="text-xs text-muted-foreground">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function Notices({ day }: { day: HygDayResponse }) {
  const notices: { text: string; detail?: string | null }[] = [];
  if (day.truncated) {
    notices.push({
      text: "This day is bigger than one read of Open Dental. Some appointments are missing from this page.",
    });
  }
  if (day.patientNamesTruncated) {
    notices.push({
      text: "There are more patients on this day than CareIN reads names for. Every appointment is here; some cards have no name.",
    });
  }
  // THE SERVER'S SENTENCE, AND OPEN DENTAL'S OWN WORDS UNDER IT. The first
  // tells a hygienist what she is missing; the second is what she reads out
  // when she calls somebody about it.
  for (const w of day.warnings) notices.push({ text: w.message, detail: w.detail });
  if (day.excludedByStatus > 0) {
    const n = day.excludedByStatus;
    notices.push({
      text:
        `${n} ${n === 1 ? "row" : "rows"} on this date ${n === 1 ? "is" : "are"} not a visit ` +
        "(broken, unscheduled, planned, or a note) and " +
        `${n === 1 ? "is" : "are"} not shown.`,
    });
  }
  // THE LENS SAYS WHAT IT IS HIDING. A hygienist wondering where the 2pm
  // doctor visit went gets an answer rather than a mystery — the same quiet
  // tone as the line above, because it is the same kind of fact.
  if (day.scope === "hygiene" && day.excludedByScope > 0) {
    const n = day.excludedByScope;
    notices.push({
      text:
        `${n} ${n === 1 ? "appointment" : "appointments"} on this date ${
          n === 1 ? "is" : "are"
        } not a hygiene visit and ${n === 1 ? "is" : "are"} not shown. ` +
        "Show the full day to see them.",
    });
  }
  if (notices.length === 0) return null;

  return (
    <div
      className="mt-4 space-y-1 rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
      data-testid="hyg-day-notices"
    >
      {notices.map((n) => (
        <div key={n.text} className="flex items-start gap-2">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>
            {n.text}
            {n.detail ? (
              <span className="ml-1.5 font-mono text-xs opacity-70">{n.detail}</span>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The day as a LIST, in time order. The default.
 *
 * Beau, the first time a real schedule was on this screen: the day is fine as a
 * list. The paper routing slip is a list, a hygienist reads her day forwards in
 * time, and the column grid — which is genuinely better for seeing two chairs
 * running in parallel — is one tap away rather than gone.
 *
 * The chair moves onto the row, because in a list it is a property of the
 * appointment rather than the axis it is arranged along.
 */
function DayList({ appointments, day }: { appointments: HygAppointment[]; day: HygDayResponse }) {
  const rows = useMemo(() => byStartTime(appointments), [appointments]);
  return (
    <div className="mt-3 space-y-2" data-testid="hyg-day-list">
      {rows.map((appt) => (
        <div key={String(appt.aptNum ?? appt.start)} className="flex items-stretch gap-2">
          <div className="w-28 shrink-0 pt-3 text-xs text-muted-foreground">
            {/* The chair, beside the card rather than above a column. Never
                "Op null": an appointment Open Dental gave no operatory is a
                real appointment with an unknown chair. */}
            {appt.opName ?? (appt.opNum !== null ? `Op ${appt.opNum}` : "No chair")}
          </div>
          <div className="min-w-0 flex-1">
            <AppointmentCard appointment={appt} office={day.office} date={day.date} />
          </div>
        </div>
      ))}
    </div>
  );
}

function DayColumns({ day, appointments }: { day: HygDayResponse; appointments: HygAppointment[] }) {
  const columns = useMemo(
    () => groupByOperatory(appointments, day.operatories),
    [appointments, day.operatories],
  );

  return (
    // The columns scroll, not the page. A body that scrolls sideways on a
    // tablet is a body somebody loses their place in.
    <div className="mt-4 flex gap-4 overflow-x-auto pb-4" data-testid="hyg-day-columns">
      {columns.map((column) => (
        <section key={String(column.opNum)} className="w-72 shrink-0">
          <header className="flex items-baseline justify-between gap-2 px-1">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {columnLabel(column)}
            </h2>
            <span className="text-xs tabular-nums text-muted-foreground">
              {column.appointments.length}
            </span>
          </header>
          <div className="mt-2 space-y-3">
            {column.appointments.map((appt) => (
              <AppointmentCard
                key={String(appt.aptNum ?? appt.start)}
                appointment={appt}
                office={day.office}
                date={day.date}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The page
// ─────────────────────────────────────────────────────────────────────────────

export default function HygDay() {
  const { office: selection, offices, selected, loading: rosterLoading } = useOffice();
  const [date, setDate] = useState<string>(() => todayIso());
  const [state, setState] = useState<DayState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  /** Bumped by "Try the names again" — reloads the FILL, never the schedule. */
  const [fillKey, setFillKey] = useState(0);
  const [fillError, setFillError] = useState<HygApiError | null>(null);
  const [prefs, setPrefs] = useState<DayPrefs>(() => readPrefs());

  const updatePrefs = useCallback((patch: Partial<DayPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      writePrefs(next);
      return next;
    });
  }, []);

  // A hygiene day belongs to ONE office. There is no all-offices fan-out here,
  // unlike RCM's list screens: a hygienist is standing in one building, and a
  // merged schedule would put two practices' patient numbers side by side.
  const office: OfficeId | null =
    selection !== ALL_OFFICES && isOfficeId(selection) ? selection : null;

  useEffect(() => {
    if (office === null) return;
    const abort = new AbortController();
    setState({ kind: "loading" });
    // A new day's fill has not failed yet. Carrying the last one's banner over
    // would report a failure that did not happen on this schedule.
    setFillError(null);
    // THE SCOPE IS PART OF THE REQUEST. Widening the lens is a SECOND fetch,
    // because the doctors' patients were never read the first time — that is
    // the saving, and it is the honest cost of asking for them.
    fetchDay(office, date, prefs.scope, abort.signal)
      .then((day) => {
        if (!abort.signal.aborted) setState({ kind: "ready", day });
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        setState({
          kind: "error",
          error:
            err instanceof HygApiError
              ? err
              : new HygApiError(
                  err instanceof Error ? err.message : "Could not load the schedule",
                  0,
                  null,
                ),
        });
      });
    return () => abort.abort();
  }, [office, date, prefs.scope, reloadKey]);

  const retry = useCallback(() => {
    setFillError(null);
    setReloadKey((k) => k + 1);
  }, []);

  /**
   * THE FILL.
   *
   * Runs whenever the day on screen still has unnamed cards, and asks for one
   * batch at a time. Three things end it, and all three are deliberate:
   *
   *   - `pending` reaches zero — the day is fully named;
   *   - `pending` does not FALL — a batch that made no progress will not make
   *     any on the next attempt either, and looping on it is how a spinner
   *     becomes permanent;
   *   - the request fails — its own banner, its own retry, and the schedule
   *     stays exactly where it is.
   *
   * `fillKey` is what a retry bumps. It is separate from `reloadKey` because
   * refetching the whole day to recover the names would discard a schedule that
   * loaded perfectly well.
   */
  useEffect(() => {
    if (office === null) return;
    if (state.kind !== "ready") return;
    if (state.day.identitiesPending <= 0) return;

    const abort = new AbortController();
    let cancelled = false;
    const dayKey = `${state.day.office}|${state.day.date}|${state.day.scope}`;

    /** No request is on its way any more, so no card may say one is. */
    const settle = () => {
      if (cancelled || abort.signal.aborted) return;
      setState((current) => {
        if (current.kind !== "ready") return current;
        const key = `${current.day.office}|${current.day.date}|${current.day.scope}`;
        if (key !== dayKey) return current;
        return { kind: "ready", day: settleIdentities(current.day) };
      });
    };

    (async () => {
      let pending = state.day.identitiesPending;
      while (!cancelled && pending > 0) {
        let fill: HygDayIdentitiesResponse;
        try {
          fill = await fetchDayIdentities(office, date, prefs.scope, abort.signal);
        } catch (err: unknown) {
          if (cancelled || abort.signal.aborted) return;
          setFillError(
            err instanceof HygApiError
              ? err
              : new HygApiError(
                  err instanceof Error ? err.message : "Could not load patient names",
                  0,
                  null,
                ),
          );
          settle();
          return;
        }
        if (cancelled || abort.signal.aborted) return;

        setState((current) => {
          // The day may have been replaced under us — a date change, a refresh.
          // Merging a batch onto a different day would put one day's names on
          // another's cards, which is the worst thing this loop could do.
          if (current.kind !== "ready") return current;
          const key = `${current.day.office}|${current.day.date}|${current.day.scope}`;
          if (key !== dayKey) return current;
          return { kind: "ready", day: mergeIdentities(current.day, fill) };
        });

        if (fill.pending >= pending) {
          // NO PROGRESS. Whatever is left is not going to resolve by asking
          // again, and the cards say what they know. Stop.
          settle();
          return;
        }
        pending = fill.pending;
      }
      // Nothing left pending on the server. Anything still shimmering here is
      // a card the fill was never going to reach — past the fan-out cap — and
      // it says so rather than waiting on a request nobody is making.
      settle();
    })();

    return () => {
      cancelled = true;
      abort.abort();
    };
    // `state` is intentionally read rather than depended on in full: the effect
    // re-runs when the day IDENTITY changes (office, date, scope, reload) or
    // when a fresh fill is asked for, not on every merge it performs itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [office, date, prefs.scope, reloadKey, fillKey, state.kind]);

  // The roster's display name is what the rest of the shell shows; the short
  // module label is the fallback when the roster has not arrived. Used only in
  // the page CAPTION — the refusal panels below name their office from the
  // SERVER's own sentence, so the two can never disagree on screen.
  const officeName =
    selected?.officeName ?? (office ? HYG_OFFICE_LABELS[office] : null) ?? "this office";

  /** The names the picker offers, from the day that actually loaded. */
  const providers = useMemo(
    () => (state.kind === "ready" ? providersOnDay(state.day.appointments) : []),
    [state],
  );

  /**
   * What is drawn. The SERVER decided which appointments this page is allowed
   * to have (the scope); this only narrows what is drawn from them.
   */
  const visible = useMemo(
    () =>
      state.kind === "ready"
        ? filterByProvider(state.day.appointments, prefs.provider)
        : ([] as HygAppointment[]),
    [state, prefs.provider],
  );

  return (
    <div className="p-6" data-testid="hyg-day">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            className="text-2xl font-bold tracking-tight text-foreground"
            style={{ fontFamily: "Sora, sans-serif" }}
          >
            Hygiene day
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {/* The SERVER's date once it has answered, the requested one until
                then. They are always equal in production — the route echoes
                what it was asked — and showing the answer means a day that
                somehow came back for a different date is visible rather than
                rendered under the wrong heading. */}
            {formatDayHeading(state.kind === "ready" ? state.day.date : date)}
            {office ? ` · ${officeName}` : ""}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className={TAP}
            onClick={() => setDate((d) => shiftIsoDate(d, -1))}
            aria-label="Previous day"
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            className={TAP}
            onClick={() => setDate(todayIso())}
            data-testid="hyg-day-today"
          >
            Today
          </button>
          <button
            type="button"
            className={TAP}
            onClick={() => setDate((d) => shiftIsoDate(d, 1))}
            aria-label="Next day"
          >
            <ChevronRight size={18} />
          </button>
          <button
            type="button"
            className={TAP}
            onClick={retry}
            disabled={office === null}
            data-testid="hyg-day-refresh"
          >
            <RefreshCw size={16} />
            Refresh
          </button>
        </div>
      </div>

      {/* The lens, the view and the hygienist. All three persist per browser;
          none of them changes what anybody else sees. */}
      {state.kind === "ready" ? (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="hyg-day-controls">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className={cn(TAP, prefs.view === "list" && "border-primary bg-primary/10")}
              aria-pressed={prefs.view === "list"}
              onClick={() => updatePrefs({ view: "list" })}
              data-testid="hyg-view-list"
            >
              <List size={16} />
              List
            </button>
            <button
              type="button"
              className={cn(TAP, prefs.view === "grid" && "border-primary bg-primary/10")}
              aria-pressed={prefs.view === "grid"}
              onClick={() => updatePrefs({ view: "grid" })}
              data-testid="hyg-view-grid"
            >
              <Columns3 size={16} />
              Chairs
            </button>
          </div>

          <button
            type="button"
            className={cn(TAP, prefs.scope === "all" && "border-primary bg-primary/10")}
            aria-pressed={prefs.scope === "all"}
            onClick={() =>
              updatePrefs({ scope: prefs.scope === "all" ? "hygiene" : "all", provider: null })
            }
            data-testid="hyg-scope-toggle"
          >
            {prefs.scope === "all" ? "Showing the full day" : "Show full day"}
          </button>

          {/* DISPLAY-ONLY. Open Dental has no provider filter on /appointments —
              the whole day comes down in one paged pull regardless — so this
              filters what is drawn and nothing else. */}
          {providers.length > 0 ? (
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <span className="sr-only">Hygienist</span>
              <select
                className={cn(TAP, "bg-background")}
                value={prefs.provider ?? ""}
                onChange={(e) => updatePrefs({ provider: e.target.value || null })}
                data-testid="hyg-provider-picker"
              >
                <option value="">All hygienists</option>
                {providers.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}

      {office === null ? (
        // The roster is still arriving, or the picker is on "All Offices".
        // Never an empty grid: it would read as "nobody is booked" for a day
        // nobody has asked for yet.
        rosterLoading && offices.length === 0 ? <LoadingDay /> : <PickAnOffice />
      ) : state.kind === "loading" ? (
        <LoadingDay />
      ) : state.kind === "error" ? (
        state.error.officeNotReady ? (
          <OfficeNotReady error={state.error} />
        ) : (
          <OdError error={state.error} onRetry={retry} />
        )
      ) : state.day.appointments.length === 0 ? (
        <>
          <Notices day={state.day} />
          {/* The date the SERVER answered for, not the one this page asked
              with. Same reason as the heading above: the sentence claims a
              specific day loaded, so it has to name the day that loaded.
              Notices runs FIRST so an empty hygiene day that is empty BECAUSE
              of the lens says so above the "nobody is booked" panel. */}
          <EmptyDay date={state.day.date} officeName={state.day.officeName} />
        </>
      ) : (
        <>
          <SummaryStrip day={state.day} />
          <Notices day={state.day} />
          {fillError ? (
            <FillFailed
              error={fillError}
              onRetry={() => {
                setFillError(null);
                setFillKey((k) => k + 1);
              }}
            />
          ) : null}
          {visible.length === 0 ? (
            // Filtered to nothing by the PICKER — a different fact from an
            // empty day, and it must not borrow the empty day's words.
            <p
              className="mt-4 text-sm text-muted-foreground"
              data-testid="hyg-day-filtered-empty"
            >
              No appointments for {prefs.provider}. Choose “All hygienists” to see the rest of
              the day.
            </p>
          ) : prefs.view === "list" ? (
            <DayList appointments={visible} day={state.day} />
          ) : (
            <DayColumns day={state.day} appointments={visible} />
          )}
        </>
      )}
    </div>
  );
}
