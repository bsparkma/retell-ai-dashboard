/**
 * PMS Adapter — Abstract Interface
 *
 * All PMS adapters (Open Dental, Dentrix, Eaglesoft) implement this interface.
 * The scheduling engine only talks to this interface — never to PMS-specific code.
 */

import type { DateRange, SlotSearchParams, SyncResult, TimeSlot } from "../scheduling/types.js";

// ---------------------------------------------------------------------------
// PMS-level types (shared across adapters)
// ---------------------------------------------------------------------------

export interface PMSPatient {
  id: string;
  firstName: string;
  lastName: string;
  preferred?: string;
  dateOfBirth?: string;
  language?: string;
  wirelessPhone?: string;
  hmPhone?: string;
  wkPhone?: string;
  email?: string;
  /** Primary provider ID */
  priProv?: number;
  clinicNum: number;
}

export interface PMSProvider {
  id: number;
  name: string;
  abbr?: string;
  isHygienist: boolean;
  isHidden: boolean;
  clinicNum: number;
}

export interface PMSOperatory {
  id: number;
  name: string;
  abbr?: string;
  isHygiene: boolean;
  isHidden: boolean;
  hasNitrous?: boolean;
  hasScanner?: boolean;
  clinicNum: number;
  itemOrder?: number;
}

export interface PMSAppointment {
  id: string;
  patientId: string;
  providerId: number;
  operatoryId: number;
  dateTime: string;
  duration: number;
  status: string;
  type?: string;
  note?: string;
  clinicNum: number;
  confirmedAt?: string;
}

export interface CreateAppointmentInput {
  patientId?: string;
  providerId: number;
  operatoryId: number;
  dateTime: string;
  duration: number;
  type?: string;
  note?: string;
  clinicNum: number;
}

export interface UpdateAppointmentInput {
  providerId?: number;
  operatoryId?: number;
  dateTime?: string;
  duration?: number;
  status?: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Abstract adapter interface
// ---------------------------------------------------------------------------

export interface PMSAdapter {
  /** Fetch a single patient by PMS ID */
  getPatient(patientId: string): Promise<PMSPatient>;

  /** Search patients by name, phone, or DOB */
  searchPatients(query: string): Promise<PMSPatient[]>;

  /** Get available scheduling slots for the given params */
  getAvailableSlots(params: SlotSearchParams): Promise<TimeSlot[]>;

  /** Book a new appointment */
  createAppointment(appointment: CreateAppointmentInput): Promise<PMSAppointment>;

  /** Update an existing appointment */
  updateAppointment(appointmentId: string, updates: UpdateAppointmentInput): Promise<PMSAppointment>;

  /** Cancel an appointment */
  cancelAppointment(appointmentId: string, reason: string): Promise<void>;

  /** List all active providers for the clinic */
  getProviders(): Promise<PMSProvider[]>;

  /** List all operatories for the clinic */
  getOperatories(): Promise<PMSOperatory[]>;

  /** Sync schedule data for a date range */
  syncSchedule(dateRange: DateRange): Promise<SyncResult>;
}
