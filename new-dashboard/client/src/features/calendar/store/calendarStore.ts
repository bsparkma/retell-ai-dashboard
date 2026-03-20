/**
 * Calendar feature store — Phase 1.
 * Normalized state + UI state; no mutations beyond selection/filters.
 */

import type {
  CalendarState,
  CalendarDataState,
  CalendarUIState,
  Appointment,
  Operatory,
  Provider,
  Schedule,
  ScheduleOp,
  Patient,
} from "../types";

const initialData: CalendarDataState = {
  appointmentsById: {},
  operatoriesById: {},
  providersById: {},
  schedulesById: {},
  scheduleOpsByScheduleNum: {},
  patientsById: {},
};

const initialUI: CalendarUIState = {
  selectedDate: new Date().toISOString().split("T")[0],
  selectedAppointmentId: null,
  providerFilter: [],
  loading: true,
  error: null,
  activeTab: "day",
  refreshKey: 0,
};

export const initialCalendarState: CalendarState = {
  data: initialData,
  ui: initialUI,
};

export type CalendarAction =
  | { type: "SET_CALENDAR_DATA"; payload: { appointments: Appointment[]; operatories: Operatory[]; providers: Provider[]; schedules?: Schedule[]; scheduleOps?: ScheduleOp[] } }
  | { type: "SET_SCHEDULES"; payload: { schedules: Schedule[]; scheduleOps: ScheduleOp[] } }
  | { type: "SET_SELECTED_DATE"; payload: string }
  | { type: "SET_SELECTED_APPOINTMENT_ID"; payload: number | null }
  | { type: "SET_PROVIDER_FILTER"; payload: number[] }
  | { type: "SET_PATIENT"; payload: { patientId: number; patient: Patient } }
  | { type: "SET_LOADING"; payload: boolean }
  | { type: "SET_ERROR"; payload: string | null }
  | { type: "SET_ACTIVE_TAB"; payload: CalendarUIState["activeTab"] }
  | { type: "REFRESH" };

function byId<T extends { id: number }>(items: T[]): Record<number, T> {
  const out: Record<number, T> = {};
  items.forEach((item) => { out[item.id] = item; });
  return out;
}

function scheduleById(items: Schedule[]): Record<number, Schedule> {
  const out: Record<number, Schedule> = {};
  items.forEach((item) => { out[item.scheduleNum] = item; });
  return out;
}

export function calendarReducer(state: CalendarState, action: CalendarAction): CalendarState {
  switch (action.type) {
    case "SET_CALENDAR_DATA": {
      const { appointments, operatories, providers, schedules = [], scheduleOps = [] } = action.payload;
      const scheduleOpsByScheduleNum: Record<number, number[]> = {};
      scheduleOps.forEach((so) => {
        if (!scheduleOpsByScheduleNum[so.scheduleNum]) scheduleOpsByScheduleNum[so.scheduleNum] = [];
        scheduleOpsByScheduleNum[so.scheduleNum].push(so.operatoryNum);
      });
      return {
        ...state,
        data: {
          ...state.data,
          appointmentsById: byId(appointments),
          operatoriesById: byId(operatories),
          providersById: byId(providers),
          schedulesById: scheduleById(schedules),
          scheduleOpsByScheduleNum,
        },
      };
    }
    case "SET_SCHEDULES": {
      const { schedules, scheduleOps } = action.payload;
      const scheduleOpsByScheduleNum: Record<number, number[]> = {};
      scheduleOps.forEach((so) => {
        if (!scheduleOpsByScheduleNum[so.scheduleNum]) scheduleOpsByScheduleNum[so.scheduleNum] = [];
        scheduleOpsByScheduleNum[so.scheduleNum].push(so.operatoryNum);
      });
      return {
        ...state,
        data: {
          ...state.data,
          schedulesById: scheduleById(schedules),
          scheduleOpsByScheduleNum,
        },
      };
    }
    case "SET_SELECTED_DATE":
      return { ...state, ui: { ...state.ui, selectedDate: action.payload } };
    case "SET_SELECTED_APPOINTMENT_ID":
      return { ...state, ui: { ...state.ui, selectedAppointmentId: action.payload } };
    case "SET_PROVIDER_FILTER":
      return { ...state, ui: { ...state.ui, providerFilter: action.payload } };
    case "SET_PATIENT":
      return {
        ...state,
        data: {
          ...state.data,
          patientsById: { ...state.data.patientsById, [action.payload.patientId]: action.payload.patient },
        },
      };
    case "SET_LOADING":
      return { ...state, ui: { ...state.ui, loading: action.payload } };
    case "SET_ERROR":
      return { ...state, ui: { ...state.ui, error: action.payload } };
    case "SET_ACTIVE_TAB":
      return { ...state, ui: { ...state.ui, activeTab: action.payload } };
    case "REFRESH":
      return { ...state, ui: { ...state.ui, refreshKey: (state.ui.refreshKey ?? 0) + 1 } };
    default:
      return state;
  }
}
