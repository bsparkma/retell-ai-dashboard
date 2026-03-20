"use client";

import type { Appointment } from "../types";

interface DrawerSchedulingProps {
  appointment: Appointment;
}

export function DrawerScheduling({ appointment }: DrawerSchedulingProps) {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold text-foreground">Scheduling</h4>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Date / time</dt>
        <dd>{appointment.dateTime ? new Date(appointment.dateTime).toLocaleString() : appointment.time}</dd>
        <dt className="text-muted-foreground">Duration</dt>
        <dd>{appointment.duration} min</dd>
        <dt className="text-muted-foreground">Operatory</dt>
        <dd>{appointment.operatoryName ?? "—"}</dd>
        <dt className="text-muted-foreground">Provider</dt>
        <dd>{appointment.providerName ?? "—"}</dd>
        <dt className="text-muted-foreground">Type</dt>
        <dd>{appointment.type ?? "—"}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>{appointment.status ?? "—"}</dd>
        <dt className="text-muted-foreground">Confirmed</dt>
        <dd>{appointment.confirmed ? "Yes" : "No"}</dd>
        {appointment.timeLocked && (
          <>
            <dt className="text-muted-foreground">Time locked</dt>
            <dd>Yes</dd>
          </>
        )}
        {appointment.priority && (
          <>
            <dt className="text-muted-foreground">Priority</dt>
            <dd>{appointment.priority}</dd>
          </>
        )}
        {appointment.note && (
          <>
            <dt className="text-muted-foreground">Note</dt>
            <dd className="col-span-1">{appointment.note}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
