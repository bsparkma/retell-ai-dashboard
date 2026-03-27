/**
 * Calendar feature types — Phase 1.
 * Aligned with docs/OPEN_DENTAL_CALENDAR_BACKEND_SPEC.md and PHASE1_SPEC.md.
 */

export interface Appointment {
  id: number;
  patientId: number;
  patient?: string;
  dateTime: string;
  time: string;
  duration: number;
  type: string;
  status: string;
  confirmed: boolean;
  operatoryId: number;
  operatoryName: string;
  providerId: number;
  providerName: string;
  clinicNum?: number;
  isNewPatient?: boolean;
  isHygiene?: boolean;
  note?: string;
  dateTStamp?: string;
  dateTimeArrived?: string;
  dateTimeSeated?: string;
  dateTimeDismissed?: string;
  dateTimeAskedToArrive?: string;
  colorOverride?: string;
  appointmentTypeNum?: number;
  priority?: string;
  timeLocked?: boolean;
}

export interface Operatory {
  id: number;
  name: string;
  abbr?: string;
  itemOrder?: number;
  isHidden?: boolean;
  isHygiene?: boolean;
  clinicNum?: number;
  provDentist?: number;
  provHygienist?: number;
}

export interface Provider {
  id: number;
  name: string;
  abbr?: string;
  provColor?: string;
  isHidden?: boolean;
  isHygienist?: boolean;
}

export interface Schedule {
  scheduleNum: number;
  schedDate: string;
  startTime: string;
  stopTime: string;
  schedType: string;
  provNum?: number;
  blockoutType?: string;
  note?: string;
  operatories?: string;
  dateTStamp?: string;
}

export interface ScheduleOp {
  scheduleOpNum: number;
  scheduleNum: number;
  operatoryNum: number;
}

export interface Patient {
  id: number;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  preferred?: string;
  dateOfBirth?: string;
  language?: string;
  wirelessPhone?: string;
  hmPhone?: string;
  wkPhone?: string;
  email?: string;
  txtMsgOk?: boolean;
  preferConfirmMethod?: string;
  preferContactMethod?: string;
  priProv?: number;
  priProvAbbr?: string;
  clinicNum?: number;
  clinicAbbr?: string;
  premed?: string;
  apptModNote?: string;
  medUrgNote?: string;
  famFinUrgNote?: string;
}

export interface CalendarDataState {
  appointmentsById: Record<number, Appointment>;
  operatoriesById: Record<number, Operatory>;
  providersById: Record<number, Provider>;
  schedulesById: Record<number, Schedule>;
  scheduleOpsByScheduleNum: Record<number, number[]>;
  patientsById: Record<number, Patient>;
}

export interface CalendarUIState {
  selectedDate: string;
  selectedAppointmentId: number | null;
  providerFilter: number[];
  loading: boolean;
  error: string | null;
  activeTab: "day" | "asap" | "unscheduled" | "openSlots";
  refreshKey: number;
}

export interface CalendarState {
  data: CalendarDataState;
  ui: CalendarUIState;
}

export interface AppointmentCardViewModel {
  appointment: Appointment;
  providerAbbr: string;
  statusLabel: string;
  typeLabel: string;
  color: { bg: string; border: string; text: string };
}
