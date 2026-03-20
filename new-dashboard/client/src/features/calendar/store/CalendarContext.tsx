"use client";

import React, { createContext, useContext, useReducer, useCallback } from "react";
import type { CalendarState } from "../types";
import type { CalendarAction } from "./calendarStore";
import { initialCalendarState, calendarReducer } from "./calendarStore";

type Dispatch = React.Dispatch<CalendarAction>;

const CalendarStateContext = createContext<CalendarState | null>(null);
const CalendarDispatchContext = createContext<Dispatch | null>(null);

export function CalendarProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(calendarReducer, initialCalendarState);
  return (
    <CalendarStateContext.Provider value={state}>
      <CalendarDispatchContext.Provider value={dispatch}>
        {children}
      </CalendarDispatchContext.Provider>
    </CalendarStateContext.Provider>
  );
}

export function useCalendarState(): CalendarState {
  const ctx = useContext(CalendarStateContext);
  if (!ctx) throw new Error("useCalendarState must be used within CalendarProvider");
  return ctx;
}

export function useCalendarDispatch(): Dispatch {
  const ctx = useContext(CalendarDispatchContext);
  if (!ctx) throw new Error("useCalendarDispatch must be used within CalendarProvider");
  return ctx;
}

type SetCalendarDataPayload = {
  appointments: import("../types").Appointment[];
  operatories: import("../types").Operatory[];
  providers: import("../types").Provider[];
  schedules?: import("../types").Schedule[];
  scheduleOps?: import("../types").ScheduleOp[];
};

export function useCalendarActions() {
  const dispatch = useCalendarDispatch();
  return {
    setCalendarData: useCallback(
      (payload: SetCalendarDataPayload) => dispatch({ type: "SET_CALENDAR_DATA", payload }),
      [dispatch]
    ),
    setSelectedDate: useCallback((date: string) => dispatch({ type: "SET_SELECTED_DATE", payload: date }), [dispatch]),
    setSelectedAppointmentId: useCallback(
      (id: number | null) => dispatch({ type: "SET_SELECTED_APPOINTMENT_ID", payload: id }),
      [dispatch]
    ),
    setProviderFilter: useCallback(
      (ids: number[]) => dispatch({ type: "SET_PROVIDER_FILTER", payload: ids }),
      [dispatch]
    ),
    setPatient: useCallback(
      (patientId: number, patient: import("../types").Patient) =>
        dispatch({ type: "SET_PATIENT", payload: { patientId, patient } }),
      [dispatch]
    ),
    setLoading: useCallback((v: boolean) => dispatch({ type: "SET_LOADING", payload: v }), [dispatch]),
    setError: useCallback((v: string | null) => dispatch({ type: "SET_ERROR", payload: v }), [dispatch]),
    setActiveTab: useCallback(
      (tab: "day" | "asap" | "unscheduled" | "openSlots") => dispatch({ type: "SET_ACTIVE_TAB", payload: tab }),
      [dispatch]
    ),
    refresh: useCallback(() => dispatch({ type: "REFRESH" }), [dispatch]),
  };
}
