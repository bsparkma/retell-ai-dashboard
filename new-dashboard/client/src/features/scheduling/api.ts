/**
 * Scheduling feature API client.
 *
 * Calls the Express scheduling routes at /api/scheduling/*.
 * In development, Vite proxies /api/scheduling/ to http://localhost:3000.
 * In production, the same Express server handles everything.
 */

import type {
  AppointmentEvaluation,
  AppointmentRequest,
  BookedAppointment,
  EmergencyCheckResult,
  PatientInfo,
  SchedulingPreferences,
  TimeSlot,
} from "./types";

// Base URL for scheduling API — always relative so the Vite proxy handles it in dev
// and the same Express server handles it in production.
const SCHEDULING_BASE = "/api/scheduling";

interface SchedulingRequestInit {
  method?: string;
  body?: unknown;
  clinicNum?: number;
}

async function schedulingRequest<T>(
  path: string,
  init: SchedulingRequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (init.clinicNum !== undefined) {
    headers["X-Clinic-Num"] = String(init.clinicNum);
  }

  const res = await fetch(`${SCHEDULING_BASE}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// API methods
// ---------------------------------------------------------------------------

export const schedulingApi = {
  /**
   * Run the rules engine to determine appointment type, duration, and constraints.
   */
  async evaluate(params: {
    patientInfo: PatientInfo;
    request: AppointmentRequest;
  }): Promise<{ evaluation: AppointmentEvaluation }> {
    return schedulingRequest("/evaluate", {
      body: params,
      clinicNum: params.request.clinicNum,
    });
  },

  /**
   * Find available time slots matching the evaluation + preferences.
   */
  async findSlots(params: {
    evaluation: AppointmentEvaluation;
    preferences?: SchedulingPreferences;
    preferredProviderId?: string;
    startDate?: string;
    endDate?: string;
    maxResults?: number;
    clinicNum: number;
  }): Promise<{ slots: TimeSlot[]; offerMessage: string }> {
    return schedulingRequest("/find-slots", {
      body: params,
      clinicNum: params.clinicNum,
    });
  },

  /**
   * Book an appointment. Returns the booked appointment details.
   */
  async book(params: {
    slot: TimeSlot;
    patientId?: string;
    evaluation: AppointmentEvaluation;
    notes?: string;
    clinicNum: number;
    source?: string;
  }): Promise<{ appointment: BookedAppointment }> {
    return schedulingRequest("/book", {
      body: params,
      clinicNum: params.clinicNum,
    });
  },

  /**
   * Check emergency priority slots for today and tomorrow.
   */
  async checkEmergency(clinicNum: number): Promise<EmergencyCheckResult> {
    return schedulingRequest<EmergencyCheckResult>("/emergency-check", {
      body: { clinicNum },
      clinicNum,
    });
  },

  /**
   * List appointments for a date range.
   */
  async getAppointments(params: {
    startDate: string;
    endDate: string;
    clinicNum: number;
  }): Promise<{ appointments: TimeSlot[] }> {
    const url = `/appointments?startDate=${params.startDate}&endDate=${params.endDate}&clinicNum=${params.clinicNum}`;
    return schedulingRequest(url, { method: "GET", clinicNum: params.clinicNum });
  },
};
