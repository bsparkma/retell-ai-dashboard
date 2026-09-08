import type { Appointment, AppointmentType, ConfirmationStatus } from "./types"

export const today = new Date().toISOString().slice(0, 10)

function appt(
  id: string,
  officeId: "roland" | "valley",
  patientId: string,
  operatoryId: string,
  hygienistId: string,
  startMinutes: number,
  lengthMinutes: number,
  type: AppointmentType,
  status: ConfirmationStatus,
  extras: Partial<Appointment> = {},
): Appointment {
  return {
    id,
    officeId,
    patientId,
    operatoryId,
    hygienistId,
    date: today,
    startMinutes,
    lengthMinutes,
    type,
    isHygiene: true,
    status,
    xraysDue: false,
    perioChartDue: false,
    doctorExamNeeded: false,
    hasOpenTcCase: false,
    ...extras,
  }
}

// 7:00am = 420 minutes from midnight
export const appointments: Appointment[] = [
  appt("apt-rol-1", "roland", "pt-roland-1", "rol-op2", "rol-hyg-a", 7 * 60, 60, "Prophy Adult", "Confirmed", {
    xraysDue: true,
    doctorExamNeeded: true,
  }),
  appt("apt-rol-2", "roland", "pt-roland-2", "rol-op3", "rol-hyg-b", 7 * 60 + 30, 30, "Prophy Child", "Arrived"),
  appt("apt-rol-3", "roland", "pt-roland-3", "rol-op2", "rol-hyg-a", 8 * 60 + 30, 60, "SRP", "In Chair", {
    perioChartDue: true,
    hasOpenTcCase: true,
  }),
  appt("apt-rol-4", "roland", "pt-roland-4", "rol-op3", "rol-hyg-b", 9 * 60, 45, "Perio Maint", "Confirmed", {
    perioChartDue: true,
  }),
  appt("apt-rol-5", "roland", "pt-roland-5", "rol-op2", "rol-hyg-a", 10 * 60 + 30, 60, "New Pt Hyg", "Unconfirmed", {
    xraysDue: true,
    doctorExamNeeded: true,
    perioChartDue: true,
  }),
  appt("apt-rol-6", "roland", "pt-roland-6", "rol-op3", "rol-hyg-b", 12 * 60 + 30, 30, "Ortho Adj", "Confirmed", {
    doctorExamNeeded: false,
  }),
  appt("apt-rol-7", "roland", "pt-roland-7", "rol-op2", "rol-hyg-a", 13 * 60 + 30, 60, "Prophy Adult", "Confirmed"),
  appt("apt-rol-8", "roland", "pt-roland-8", "rol-op3", "rol-hyg-b", 14 * 60 + 45, 30, "Prophy Child", "Unconfirmed", {
    xraysDue: true,
  }),

  appt("apt-val-1", "valley", "pt-valley-1", "val-op2", "val-hyg-a", 7 * 60 + 15, 60, "SRP", "Confirmed", {
    perioChartDue: true,
    hasOpenTcCase: true,
  }),
  appt("apt-val-2", "valley", "pt-valley-2", "val-op3", "val-hyg-b", 8 * 60, 45, "Perio Maint", "Arrived", {
    perioChartDue: true,
  }),
  appt("apt-val-3", "valley", "pt-valley-3", "val-op2", "val-hyg-a", 9 * 60 + 15, 30, "Ortho Adj", "In Chair"),
  appt("apt-val-4", "valley", "pt-valley-4", "val-op3", "val-hyg-b", 10 * 60, 60, "Prophy Adult", "Confirmed", {
    doctorExamNeeded: true,
  }),
  appt("apt-val-5", "valley", "pt-valley-5", "val-op2", "val-hyg-a", 11 * 60 + 15, 60, "New Pt Hyg", "Unconfirmed", {
    xraysDue: true,
    perioChartDue: true,
    doctorExamNeeded: true,
  }),
  appt("apt-val-6", "valley", "pt-valley-6", "val-op3", "val-hyg-b", 13 * 60, 30, "Ortho Adj", "Confirmed"),
  appt("apt-val-7", "valley", "pt-valley-7", "val-op2", "val-hyg-a", 14 * 60, 60, "Perio Maint", "Confirmed", {
    perioChartDue: true,
  }),
  appt("apt-val-8", "valley", "pt-valley-8", "val-op3", "val-hyg-b", 15 * 60 + 15, 30, "Prophy Child", "Unconfirmed", {
    xraysDue: true,
  }),
]

export function appointmentsForOffice(officeId: string): Appointment[] {
  return appointments.filter((a) => a.officeId === officeId)
}

export function getAppointment(id: string): Appointment | undefined {
  return appointments.find((a) => a.id === id)
}
