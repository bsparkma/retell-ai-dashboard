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
  Info,
  PlugZap,
  RefreshCw,
} from "lucide-react";

import { useOffice, ALL_OFFICES } from "@/contexts/OfficeContext";
import { isOfficeId, type HygDayResponse, type OfficeId } from "@shared/hyg/contract";
import { fetchDay, HygApiError, HYG_OFFICE_LABELS } from "@/features/hyg/api";
import {
  columnLabel,
  formatDayHeading,
  groupByOperatory,
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
// The day itself
// ─────────────────────────────────────────────────────────────────────────────

function SummaryStrip({ day }: { day: HygDayResponse }) {
  const s = summarise(day);
  const items: { label: string; value: number; muted?: boolean }[] = [
    { label: "Appointments", value: s.total },
    { label: "Hygiene", value: s.hygiene },
    { label: "Flagged", value: s.flagged },
    // Counted and shown SEPARATELY. Folding unknowns into "flagged" would make
    // that number mean "at least this many", which is not a number anybody can
    // act on.
    { label: "Unknowns", value: s.unknownFlags, muted: true },
  ];
  return (
    <div className="mt-4 flex flex-wrap gap-2" data-testid="hyg-day-summary">
      {items.map((item) => (
        <div
          key={item.label}
          className={cn(
            "rounded-xl border border-border bg-card px-4 py-2",
            item.muted && "border-dashed",
          )}
        >
          <div className="text-xl font-semibold tabular-nums text-foreground">{item.value}</div>
          <div className="text-xs text-muted-foreground">{item.label}</div>
        </div>
      ))}
    </div>
  );
}

function Notices({ day }: { day: HygDayResponse }) {
  const notices: string[] = [];
  if (day.truncated) {
    notices.push(
      "This day is bigger than one read of Open Dental. Some appointments are missing from this page.",
    );
  }
  if (day.patientNamesTruncated) {
    notices.push(
      "There are more patients on this day than CareIN reads names for. Every appointment is here; some cards have no name.",
    );
  }
  for (const w of day.warnings) notices.push(w.message);
  if (day.excludedByStatus > 0) {
    const n = day.excludedByStatus;
    notices.push(
      `${n} ${n === 1 ? "row" : "rows"} on this date ${n === 1 ? "is" : "are"} not a visit ` +
        "(broken, unscheduled, planned, or a note) and " +
        `${n === 1 ? "is" : "are"} not shown.`,
    );
  }
  if (notices.length === 0) return null;

  return (
    <div
      className="mt-4 space-y-1 rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
      data-testid="hyg-day-notices"
    >
      {notices.map((n) => (
        <div key={n} className="flex items-start gap-2">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>{n}</span>
        </div>
      ))}
    </div>
  );
}

function DayColumns({ day }: { day: HygDayResponse }) {
  const columns = useMemo(
    () => groupByOperatory(day.appointments, day.operatories),
    [day.appointments, day.operatories],
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
              <AppointmentCard key={String(appt.aptNum ?? appt.start)} appointment={appt} />
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

  // A hygiene day belongs to ONE office. There is no all-offices fan-out here,
  // unlike RCM's list screens: a hygienist is standing in one building, and a
  // merged schedule would put two practices' patient numbers side by side.
  const office: OfficeId | null =
    selection !== ALL_OFFICES && isOfficeId(selection) ? selection : null;

  useEffect(() => {
    if (office === null) return;
    const abort = new AbortController();
    setState({ kind: "loading" });
    fetchDay(office, date, abort.signal)
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
  }, [office, date, reloadKey]);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  // The roster's display name is what the rest of the shell shows; the short
  // module label is the fallback when the roster has not arrived. Used only in
  // the page CAPTION — the refusal panels below name their office from the
  // SERVER's own sentence, so the two can never disagree on screen.
  const officeName =
    selected?.officeName ?? (office ? HYG_OFFICE_LABELS[office] : null) ?? "this office";

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
              specific day loaded, so it has to name the day that loaded. */}
          <EmptyDay date={state.day.date} officeName={state.day.officeName} />
        </>
      ) : (
        <>
          <SummaryStrip day={state.day} />
          <Notices day={state.day} />
          <DayColumns day={state.day} />
        </>
      )}
    </div>
  );
}
