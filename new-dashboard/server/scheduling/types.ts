/**
 * CareIN Scheduling Engine — Type Definitions
 *
 * All types for the Phase 2 scheduling system. Shared between
 * the rules engine, slot finder, constraint checker, and PMS adapters.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum AppointmentCategory {
  /** New patient exam + X-rays (no cleaning) — 60 min */
  NEW_PATIENT_EXAM = "NEW_PATIENT_EXAM",
  /** New adult patient hygiene (exam + X-rays + cleaning) — 90 min */
  NEW_PATIENT_HYGIENE = "NEW_PATIENT_HYGIENE",
  /** New child patient hygiene (exam + X-rays + cleaning) — 60 min */
  NEW_CHILD_HYGIENE = "NEW_CHILD_HYGIENE",
  /** Existing adult cleaning — 60 min */
  EXISTING_ADULT_CLEANING = "EXISTING_ADULT_CLEANING",
  /** Existing child cleaning — 30 min */
  EXISTING_CHILD_CLEANING = "EXISTING_CHILD_CLEANING",
  /** Emergency limited exam — 60 min */
  EMERGENCY = "EMERGENCY",
  /** Orthodontic adjustment — 30 min */
  ORTHO_ADJUSTMENT = "ORTHO_ADJUSTMENT",
  /** General exam */
  EXAM = "EXAM",
  /** Other/custom appointment type */
  OTHER = "OTHER",
}

export enum PMSType {
  OPEN_DENTAL = "OPEN_DENTAL",
  DENTRIX = "DENTRIX",
  EAGLESOFT = "EAGLESOFT",
}

export enum ProviderType {
  DENTIST = "DENTIST",
  HYGIENIST = "HYGIENIST",
  ANY = "ANY",
}

export enum TimeOfDay {
  MORNING = "morning",
  AFTERNOON = "afternoon",
}

export enum DayOfWeek {
  EARLY = "early",  // Mon/Tue
  LATE = "late",    // Wed/Thu
}

// ---------------------------------------------------------------------------
// Core scheduling types
// ---------------------------------------------------------------------------

export interface PatientInfo {
  /** PMS patient ID if known */
  patientId?: string;
  /** Patient's age in years */
  age?: number;
  /** Whether this is a new patient (no prior appointments at this practice) */
  isNewPatient: boolean;
  /** ISO date of last cleaning (used to determine hygiene path) */
  lastCleaningDate?: string;
  /**
   * How the patient described their cleaning history.
   * "unknown" | "recent" (< 6 months) | "within_year" (6-12 months) |
   * "over_year" (> 12 months) | "ambiguous" ("about a year", unsure)
   */
  cleaningHistory?: "unknown" | "recent" | "within_year" | "over_year" | "ambiguous";
  /** Preferred provider ID */
  providerPreference?: string;
  /** Patient's preferred language */
  language?: string;
  /** Whether the patient is under 18 */
  isMinor?: boolean;
}

export interface AppointmentRequest {
  /** What the patient is calling for */
  requestedType: "cleaning" | "emergency" | "exam" | "ortho" | "new_patient" | "other";
  /** Any additional context from the voice agent or front desk */
  notes?: string;
  /** Whether this is marked as an emergency by the caller */
  isEmergency?: boolean;
  /** Clinic number for multi-tenant routing */
  clinicNum: number;
  /** Preferred provider ID if stated */
  preferredProviderId?: string;
}

export interface SchedulingPreferences {
  timeOfDay?: TimeOfDay;
  dayOfWeek?: DayOfWeek;
}

export interface OperatoryConstraints {
  hasNitrous: boolean;
  hasScanner: boolean;
  isHygieneRoom: boolean;
  operatoryId: number;
  name: string;
}

export interface TimeSlot {
  /** ISO datetime of the slot start */
  dateTime: string;
  /** Duration in minutes */
  duration: number;
  /** Provider ID */
  providerId: number;
  /** Provider display name */
  providerName: string;
  /** Operatory ID */
  operatoryId: number;
  /** Operatory display name */
  operatoryName: string;
  /** Clinicnum */
  clinicNum: number;
}

export interface SlotSearchParams {
  clinicNum: number;
  /** ISO date to start searching from (inclusive) */
  startDate: string;
  /** ISO date to stop searching at (inclusive) */
  endDate: string;
  /** Required appointment duration in minutes */
  durationMinutes: number;
  /** Required provider type */
  providerType: ProviderType;
  /** Preferred provider ID (show first) */
  preferredProviderId?: string;
  /** Only use operatories that are hygiene rooms */
  requireHygieneRoom?: boolean;
  /** Scheduling preferences from the 2-question script */
  preferences?: SchedulingPreferences;
  /** Max slots to return */
  maxResults?: number;
}

export interface AppointmentEvaluation {
  /** Determined appointment category */
  category: AppointmentCategory;
  /** Required duration in minutes */
  durationMinutes: number;
  /** What type of provider is needed */
  providerType: ProviderType;
  /** Whether this requires a hygiene room/operatory */
  requiresHygieneRoom: boolean;
  /** Human-readable reason for the determination (shown to front desk staff) */
  rationale: string;
  /** Whether to check for emergency priority slots first */
  checkEmergencySlots: boolean;
  /** Whether a cleaning was deferred (new patient >12 months since last clean) */
  cleaningDeferred: boolean;
  /** Message to offer the patient about deferred cleaning, if applicable */
  deferredCleaningMessage?: string;
}

export interface BookAppointmentInput {
  clinicNum: number;
  slot: TimeSlot;
  patientId?: string;
  patientInfo?: PatientInfo;
  category: AppointmentCategory;
  notes?: string;
  /** ID of the staff or system creating this appointment */
  bookedBy: string;
  /** Source of the booking (voice agent, front desk, web) */
  source: "voice_agent" | "front_desk" | "web";
}

export interface BookedAppointment {
  appointmentId: string;
  pmsAppointmentId?: string;
  clinicNum: number;
  dateTime: string;
  duration: number;
  providerId: number;
  providerName: string;
  operatoryId: number;
  operatoryName: string;
  patientId?: string;
  category: AppointmentCategory;
  confirmedAt: string;
}

export interface EmergencyCheckResult {
  hasPrioritySlot: boolean;
  prioritySlots: TimeSlot[];
  /** Message to read to the patient about emergency options */
  message: string;
}

export interface DateRange {
  startDate: string;
  endDate: string;
}

export interface SyncResult {
  success: boolean;
  appointmentsSynced: number;
  errors: string[];
  syncedAt: string;
}
