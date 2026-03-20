/**
 * Calendar selectors — Phase 1.
 * Pure functions; no side effects.
 */

import type { CalendarState, Appointment, Schedule } from "../types";
import { getAppointmentCardColor } from "../constants/calendarColors";
import type { AppointmentCardViewModel } from "../types";

export function visibleOperatories(state: CalendarState): { id: number; name: string; abbr?: string; isHygiene?: boolean }[] {
  const { operatoriesById } = state.data;
  const list = Object.values(operatoriesById)
    .filter((o) => !o.isHidden)
    .sort((a, b) => (a.itemOrder ?? 999) - (b.itemOrder ?? 999));
  return list.map((o) => ({ id: o.id, name: o.name, abbr: o.abbr, isHygiene: o.isHygiene }));
}

export function appointmentsForSelectedDay(state: CalendarState): Appointment[] {
  const { appointmentsById } = state.data;
  const date = state.ui.selectedDate;
  return Object.values(appointmentsById).filter((a) => a.dateTime?.startsWith(date));
}

export function appointmentsGroupedByOperatory(state: CalendarState): Record<number, Appointment[]> {
  const list = filteredAppointmentsForDay(state);
  const byOp: Record<number, Appointment[]> = {};
  list.forEach((apt) => {
    if (!byOp[apt.operatoryId]) byOp[apt.operatoryId] = [];
    byOp[apt.operatoryId].push(apt);
  });
  return byOp;
}

export function appointmentCardsForColumn(
  state: CalendarState,
  operatoryId: number
): AppointmentCardViewModel[] {
  const group = appointmentsGroupedByOperatory(state);
  const appointments = group[operatoryId] ?? [];
  const { providersById } = state.data;
  return appointments.map((apt) => {
    const provider = providersById[apt.providerId];
    const color = getAppointmentCardColor(apt);
    return {
      appointment: apt,
      providerAbbr: provider?.abbr ?? apt.providerName ?? "—",
      statusLabel: apt.status ?? "scheduled",
      typeLabel: apt.type ?? "Appointment",
      color,
    };
  });
}

export function schedulesForSelectedDay(state: CalendarState): Schedule[] {
  const { schedulesById } = state.data;
  const date = state.ui.selectedDate;
  return Object.values(schedulesById).filter((s) => s.schedDate === date || s.schedDate?.startsWith(date));
}

export function blockoutsByOperatory(state: CalendarState): Record<number, Schedule[]> {
  const schedules = schedulesForSelectedDay(state).filter((s) => (s.schedType ?? "").toLowerCase() === "blockout");
  const { scheduleOpsByScheduleNum } = state.data;
  const byOp: Record<number, Schedule[]> = {};
  schedules.forEach((s) => {
    const opIds = scheduleOpsByScheduleNum[s.scheduleNum] ?? [];
    opIds.forEach((opId) => {
      if (!byOp[opId]) byOp[opId] = [];
      byOp[opId].push(s);
    });
  });
  return byOp;
}

export function providerAvailabilityByOperatory(state: CalendarState): Record<number, Schedule[]> {
  const schedules = schedulesForSelectedDay(state).filter((s) => (s.schedType ?? "").toLowerCase() === "provider");
  const { scheduleOpsByScheduleNum } = state.data;
  const byOp: Record<number, Schedule[]> = {};
  schedules.forEach((s) => {
    const opIds = scheduleOpsByScheduleNum[s.scheduleNum] ?? [];
    opIds.forEach((opId) => {
      if (!byOp[opId]) byOp[opId] = [];
      byOp[opId].push(s);
    });
  });
  return byOp;
}

export function practiceSchedulesForDay(state: CalendarState): Schedule[] {
  return schedulesForSelectedDay(state).filter((s) => (s.schedType ?? "").toLowerCase() === "practice");
}

export function selectedAppointment(state: CalendarState): Appointment | null {
  const id = state.ui.selectedAppointmentId;
  if (id == null) return null;
  return state.data.appointmentsById[id] ?? null;
}

export function filteredAppointmentsForDay(state: CalendarState): Appointment[] {
  let list = appointmentsForSelectedDay(state);
  const { providerFilter } = state.ui;
  if (providerFilter.length > 0) {
    list = list.filter((a) => providerFilter.includes(a.providerId));
  }
  return list;
}

export function topBarMetrics(state: CalendarState): {
  total: number;
  confirmed: number;
  unconfirmed: number;
} {
  const list = appointmentsForSelectedDay(state);
  const confirmed = list.filter((a) => a.confirmed).length;
  return {
    total: list.length,
    confirmed,
    unconfirmed: list.length - confirmed,
  };
}
