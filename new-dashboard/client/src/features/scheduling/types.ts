/**
 * Client-side scheduling types.
 * Mirror of server types — kept separate so the client bundle
 * never imports server-only code (mysql2, etc.).
 */

export type AppointmentCategory =
  | "NEW_PATIENT_EXAM"
  | "NEW_PATIENT_HYGIENE"
  | "NEW_CHILD_HYGIENE"
  | "EXISTING_ADULT_CLEANING"
  | "EXISTING_CHILD_CLEANING"
  | "EMERGENCY"
  | "ORTHO_ADJUSTMENT"
  | "EXAM"
  | "OTHER";

export type ProviderType = "DENTIST" | "HYGIENIST" | "ANY";
export type TimeOfDay = "morning" | "afternoon";
export type DayOfWeek = "early" | "late";
export type RequestedType = "cleaning" | "emergency" | "exam" | "ortho" | "new_patient" | "other";

export interface PatientInfo {
  patientId?: string;
  age?: number;
  isNewPatient: boolean;
  lastCleaningDate?: string;
  cleaningHistory?: "unknown" | "recent" | "within_year" | "over_year" | "ambiguous";
  providerPreference?: string;
  language?: string;
  isMinor?: boolean;
}

export interface AppointmentRequest {
  requestedType: RequestedType;
  notes?: string;
  isEmergency?: boolean;
  clinicNum: number;
  preferredProviderId?: string;
}

export interface SchedulingPreferences {
  timeOfDay?: TimeOfDay;
  dayOfWeek?: DayOfWeek;
}

export interface AppointmentEvaluation {
  category: AppointmentCategory;
  durationMinutes: number;
  providerType: ProviderType;
  requiresHygieneRoom: boolean;
  rationale: string;
  checkEmergencySlots: boolean;
  cleaningDeferred: boolean;
  deferredCleaningMessage?: string;
}

export interface TimeSlot {
  dateTime: string;
  duration: number;
  providerId: number;
  providerName: string;
  operatoryId: number;
  operatoryName: string;
  clinicNum: number;
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
  message: string;
}

/** Step IDs for the BookingWizard */
export type WizardStep =
  | "patient"
  | "evaluation"
  | "preferences"
  | "slots"
  | "confirmation";

export interface BookingWizardState {
  step: WizardStep;
  clinicNum: number;
  patientInfo: PatientInfo;
  request: Partial<AppointmentRequest>;
  evaluation: AppointmentEvaluation | null;
  preferences: SchedulingPreferences;
  availableSlots: TimeSlot[];
  selectedSlot: TimeSlot | null;
  offerMessage: string;
  booked: BookedAppointment | null;
  loading: boolean;
  error: string | null;
}
