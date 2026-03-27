/**
 * Calendar feature API — Phase 1.
 * Uses backend /api/opendental only.
 */

import api from "@/lib/api";
import type { Appointment, Operatory, Provider, Patient } from "./types";

const rawToAppointment = (a: Record<string, unknown>, providers: Provider[], operatories: Operatory[]): Appointment => {
  const id = Number((a.id ?? a.AptNum ?? 0));
  const providerId = Number((a.providerId ?? a.ProvNum ?? 0));
  const operatoryId = Number((a.operatoryId ?? a.Op ?? 0));
  const prov = providers.find((p) => p.id === providerId);
  const op = operatories.find((o) => o.id === operatoryId);
  return {
    id,
    patientId: Number(a.patientId ?? a.PatNum ?? 0),
    patient: (a.patient ?? a.patientName ?? "Patient") as string,
    dateTime: (a.dateTime ?? "") as string,
    time: (a.time ?? "09:00") as string,
    duration: Number(a.duration ?? 30),
    type: (a.type ?? a.ProcDescript ?? "Appointment") as string,
    status: (a.status ?? "scheduled") as string,
    confirmed: Boolean(a.confirmed),
    operatoryId,
    operatoryName: (op?.name ?? op?.abbr ?? a.operatoryName ?? a.operatory ?? "—") as string,
    providerId,
    providerName: (prov?.name ?? prov?.abbr ?? a.providerName ?? a.provider ?? "—") as string,
    clinicNum: a.clinicNum != null ? Number(a.clinicNum) : undefined,
    isNewPatient: (a.isNewPatient ?? a.isNew) != null ? Boolean(a.isNewPatient ?? a.isNew) : undefined,
    isHygiene: a.isHygiene != null ? Boolean(a.isHygiene) : undefined,
    note: (a.note ?? a.Note) as string | undefined,
    dateTStamp: (a.dateTStamp ?? a.DateTStamp) as string | undefined,
    dateTimeArrived: (a.dateTimeArrived ?? a.DateTimeArrived) as string | undefined,
    dateTimeSeated: (a.dateTimeSeated ?? a.DateTimeSeated) as string | undefined,
    dateTimeDismissed: (a.dateTimeDismissed ?? a.DateTimeDismissed) as string | undefined,
    dateTimeAskedToArrive: (a.dateTimeAskedToArrive ?? a.DateTimeAskedToArrive) as string | undefined,
    colorOverride: (a.colorOverride ?? a.colorOverride) as string | undefined,
    appointmentTypeNum: a.appointmentTypeNum != null ? Number(a.appointmentTypeNum) : undefined,
    priority: (a.priority ?? a.Priority) as string | undefined,
    timeLocked: a.timeLocked != null ? Boolean(a.timeLocked) : undefined,
  };
};

const rawToOperatory = (o: Record<string, unknown>): Operatory => ({
  id: Number(o.id ?? o.OperatoryNum ?? 0),
  name: (o.name ?? o.OpName ?? "") as string,
  abbr: (o.abbr ?? o.Abbrev ?? o.Abbr) as string | undefined,
  itemOrder: o.itemOrder != null ? Number(o.itemOrder) : (o.ItemOrder != null ? Number(o.ItemOrder) : undefined),
  isHidden: o.isHidden != null ? Boolean(o.isHidden) : (o.IsHidden != null ? Boolean(o.IsHidden) : undefined),
  isHygiene: o.isHygiene != null ? Boolean(o.isHygiene) : (o.IsHygiene != null ? Boolean(o.IsHygiene) : undefined),
  clinicNum: o.clinicNum != null ? Number(o.clinicNum) : (o.ClinicNum != null ? Number(o.ClinicNum) : undefined),
  provDentist: o.provDentist != null ? Number(o.provDentist) : (o.ProvDentist != null ? Number(o.ProvDentist) : undefined),
  provHygienist: o.provHygienist != null ? Number(o.provHygienist) : (o.ProvHygienist != null ? Number(o.ProvHygienist) : undefined),
});

const rawToProvider = (p: Record<string, unknown>): Provider => ({
  id: Number(p.id ?? p.ProvNum ?? 0),
  name: (p.name ?? (`${p.FName ?? ""} ${p.LName ?? ""}`.trim() || `Provider ${p.id ?? p.ProvNum}`)) as string,
  abbr: (p.abbr ?? p.Abbr) as string | undefined,
  provColor: (p.provColor ?? p.color) as string | undefined,
  isHidden: p.isHidden != null ? Boolean(p.isHidden) : (p.IsHidden != null ? Boolean(p.IsHidden) : undefined),
  isHygienist: p.isHygienist != null ? Boolean(p.isHygienist) : (p.IsHygienist != null ? Boolean(p.IsHygienist) : undefined),
});

export const calendarApi = {
  async getCalendar(params: { date: string; providerIds?: number[]; operatoryIds?: number[] }) {
    const data = await api.getOpenDentalCalendar({
      date: params.date,
      providerIds: params.providerIds?.map(String),
      operatoryIds: params.operatoryIds?.map(String),
    });
    const providers: Provider[] = (data.providers ?? []).map((p) => rawToProvider(p as Record<string, unknown>));
    const operatories: Operatory[] = (data.operatories ?? []).map((o) => rawToOperatory(o as Record<string, unknown>));
    const appointments: Appointment[] = (data.appointments ?? []).map((a, i) => {
      const raw = a as Record<string, unknown>;
      const apt = rawToAppointment(raw, providers, operatories);
      if (!apt.providerName || apt.providerName === "—") {
        const p = providers.find((pr) => pr.id === apt.providerId);
        if (p) apt.providerName = p.name ?? p.abbr ?? "—";
      }
      if (!apt.operatoryName || apt.operatoryName === "—") {
        const op = operatories.find((o) => o.id === apt.operatoryId);
        if (op) apt.operatoryName = op.name ?? op.abbr ?? "—";
      }
      return apt;
    });
    return { appointments, providers, operatories };
  },

  async getPatient(patientId: number): Promise<Patient> {
    const raw = await api.getOpenDentalPatient(patientId) as Record<string, unknown>;
    const preferred = (raw.Preferred ?? raw.preferred ?? raw.preferredName) as string | undefined;
    const first = (raw.FName ?? raw.firstName ?? "") as string;
    const last = (raw.LName ?? raw.lastName ?? "") as string;
    const displayName = preferred ? `${preferred} ${last}`.trim() : `${first} ${last}`.trim() || "Patient";
    return {
      id: Number(raw.PatNum ?? raw.id ?? patientId),
      displayName,
      firstName: (raw.FName ?? raw.firstName) as string | undefined,
      lastName: (raw.LName ?? raw.lastName) as string | undefined,
      preferred: (raw.Preferred ?? raw.preferred) as string | undefined,
      dateOfBirth: (raw.Birthdate ?? raw.dateOfBirth) as string | undefined,
      language: (raw.Language ?? raw.language) as string | undefined,
      wirelessPhone: (raw.WirelessPhone ?? raw.wirelessPhone) as string | undefined,
      hmPhone: (raw.HmPhone ?? raw.hmPhone) as string | undefined,
      wkPhone: (raw.WkPhone ?? raw.wkPhone) as string | undefined,
      email: (raw.Email ?? raw.email) as string | undefined,
      txtMsgOk: raw.TxtMsgOk != null ? Boolean(raw.TxtMsgOk) : (raw.txtMsgOk != null ? Boolean(raw.txtMsgOk) : undefined),
      preferConfirmMethod: (raw.PreferConfirmMethod ?? raw.preferConfirmMethod) as string | undefined,
      preferContactMethod: (raw.PreferContactMethod ?? raw.preferContactMethod) as string | undefined,
      priProv: raw.PriProv != null ? Number(raw.PriProv) : undefined,
      priProvAbbr: (raw.priProvAbbr ?? raw.PriProvAbbr) as string | undefined,
      clinicNum: raw.ClinicNum != null ? Number(raw.ClinicNum) : undefined,
      clinicAbbr: (raw.clinicAbbr ?? raw.ClinicAbbr) as string | undefined,
      premed: (raw.Premed ?? raw.premed) as string | undefined,
      apptModNote: (raw.ApptModNote ?? raw.apptModNote) as string | undefined,
      medUrgNote: (raw.MedUrgNote ?? raw.medUrgNote) as string | undefined,
      famFinUrgNote: (raw.FamFinUrgNote ?? raw.famFinUrgNote) as string | undefined,
    };
  },
};
