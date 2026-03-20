"use client";

import { useCalendarState } from "../store/CalendarContext";
import { useCalendarActions } from "../store/CalendarContext";
import { appointmentCardsForColumn, blockoutsByOperatory, providerAvailabilityByOperatory } from "../store/calendarSelectors";
import { AppointmentCard } from "./AppointmentCard";
import { ScheduleOverlay } from "./ScheduleOverlay";
import { TIME_RAIL_START, TIME_RAIL_END } from "./CalendarTopBar";
import { Stethoscope } from "lucide-react";

const PIXELS_PER_HOUR = 64;
const HOURS = Array.from(
  { length: TIME_RAIL_END - TIME_RAIL_START },
  (_, i) => TIME_RAIL_START + i
);

interface OperatoryColumnProps {
  operatoryId: number;
  name: string;
  abbr?: string;
  isHygiene?: boolean;
}

export function OperatoryColumn({ operatoryId, name, abbr, isHygiene }: OperatoryColumnProps) {
  const state = useCalendarState();
  const actions = useCalendarActions();
  const cards = appointmentCardsForColumn(state, operatoryId);
  const blockouts = blockoutsByOperatory(state)[operatoryId] ?? [];
  const providerSchedules = providerAvailabilityByOperatory(state)[operatoryId] ?? [];
  const selectedId = state.ui.selectedAppointmentId;

  return (
    <div className="border-r last:border-r-0 relative flex flex-col min-w-[140px]">
      <div className="flex-1 relative" style={{ minHeight: `${HOURS.length * PIXELS_PER_HOUR}px` }}>
        {HOURS.map((hour) => (
          <div
            key={hour}
            className="border-b border-border/50 hover:bg-muted/20 transition-colors cursor-pointer"
            style={{ height: PIXELS_PER_HOUR }}
          />
        ))}
        <ScheduleOverlay schedules={blockouts} operatoryId={operatoryId} schedType="blockout" />
        <ScheduleOverlay schedules={providerSchedules} operatoryId={operatoryId} schedType="provider" />
        <div className="absolute inset-0 pointer-events-none">
          <div className="relative w-full" style={{ height: HOURS.length * PIXELS_PER_HOUR }}>
            {cards.map((vm) => (
              <div key={vm.appointment.id} className="absolute inset-x-0 pointer-events-auto">
                <AppointmentCard
                  viewModel={vm}
                  onClick={() => actions.setSelectedAppointmentId(vm.appointment.id)}
                  isSelected={selectedId === vm.appointment.id}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function OperatoryColumnHeader({
  name,
  abbr,
  isHygiene,
  count,
}: {
  name: string;
  abbr?: string;
  isHygiene?: boolean;
  count: number;
}) {
  return (
    <div className="p-3 border-b border-r last:border-r-0 text-center bg-muted/30">
      <div className="text-sm font-semibold text-foreground flex items-center justify-center gap-1">
        {abbr ?? name}
        {isHygiene && <Stethoscope size={12} className="text-muted-foreground" aria-label="Hygiene" />}
      </div>
      <div className="text-xs text-muted-foreground mt-0.5">{count} apts</div>
    </div>
  );
}
