"use client";

import { useCalendarState } from "../store/CalendarContext";
import { visibleOperatories, appointmentsGroupedByOperatory, practiceSchedulesForDay } from "../store/calendarSelectors";
import { OperatoryColumn, OperatoryColumnHeader } from "./OperatoryColumn";
import { PracticeBanner } from "./ScheduleOverlay";
import { TIME_RAIL_START, TIME_RAIL_END } from "./CalendarTopBar";

const PIXELS_PER_HOUR = 64;
const HOURS = Array.from(
  { length: TIME_RAIL_END - TIME_RAIL_START },
  (_, i) => TIME_RAIL_START + i
);

export function CalendarGrid() {
  const state = useCalendarState();
  const operatories = visibleOperatories(state);
  const byOp = appointmentsGroupedByOperatory(state);
  const practiceSchedules = practiceSchedulesForDay(state);

  if (operatories.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/20 p-8 text-center text-muted-foreground">
        No operatories loaded. Check Open Dental connection.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {practiceSchedules.length > 0 && <PracticeBanner schedules={practiceSchedules} />}
      <div className="rounded-lg border border-border overflow-hidden bg-card">
        <div
          className="grid border-b bg-muted/20"
          style={{ gridTemplateColumns: `60px repeat(${operatories.length}, minmax(140px, 1fr))` }}
        >
          <div className="p-3 border-r" />
          {operatories.map((op) => (
            <OperatoryColumnHeader
              key={op.id}
              name={op.name}
              abbr={op.abbr}
              isHygiene={op.isHygiene}
              count={(byOp[op.id] ?? []).length}
            />
          ))}
        </div>
        <div
          className="grid overflow-x-auto"
          style={{ gridTemplateColumns: `60px repeat(${operatories.length}, minmax(140px, 1fr))` }}
        >
          <div className="border-r bg-muted/10">
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="h-16 border-b border-r flex items-start pt-1 px-2"
                style={{ height: PIXELS_PER_HOUR }}
              >
                <span className="text-xs font-mono text-muted-foreground">
                  {hour > 12 ? `${hour - 12}PM` : hour === 12 ? "12PM" : `${hour}AM`}
                </span>
              </div>
            ))}
          </div>
          {operatories.map((op) => (
            <OperatoryColumn
              key={op.id}
              operatoryId={op.id}
              name={op.name}
              abbr={op.abbr}
              isHygiene={op.isHygiene}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
