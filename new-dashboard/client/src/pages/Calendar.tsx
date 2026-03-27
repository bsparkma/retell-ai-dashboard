/**
 * Calendar — Open Dental operatory-first single-day schedule (Phase 1).
 * Read-only. No mutations, ASAP, unscheduled, or open slots workflows.
 */
import { useEffect } from "react";
import { CalendarProvider, useCalendarState, useCalendarActions } from "@/features/calendar";
import { CalendarTopBar, CalendarTabs, AppointmentDrawer } from "@/features/calendar";
import { calendarApi } from "@/features/calendar";

function CalendarContent() {
  const state = useCalendarState();
  const actions = useCalendarActions();

  useEffect(() => {
    actions.setLoading(true);
    actions.setError(null);
    calendarApi
      .getCalendar({
        date: state.ui.selectedDate,
        providerIds: state.ui.providerFilter.length > 0 ? state.ui.providerFilter : undefined,
      })
      .then(({ appointments, operatories, providers }) => {
        actions.setCalendarData({ appointments, operatories, providers });
      })
      .catch((err) => {
        actions.setError(err?.message ?? "Open Dental unavailable");
        actions.setCalendarData({
          appointments: [],
          operatories: [],
          providers: [],
        });
      })
      .finally(() => actions.setLoading(false));
  }, [state.ui.selectedDate, state.ui.refreshKey]);

  return (
    <div className="p-6 space-y-4">
      {state.ui.error && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          {state.ui.error} Ensure the backend is running and Open Dental is configured.
        </div>
      )}

      <div>
        <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
          Calendar
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Open Dental appointment schedule
        </p>
      </div>

      <CalendarTopBar />
      {state.ui.loading ? (
        <div className="rounded-lg border border-border bg-muted/20 p-8 text-center text-muted-foreground">
          Loading…
        </div>
      ) : (
        <CalendarTabs />
      )}
      <AppointmentDrawer />
    </div>
  );
}

export default function Calendar() {
  return (
    <CalendarProvider>
      <CalendarContent />
    </CalendarProvider>
  );
}
