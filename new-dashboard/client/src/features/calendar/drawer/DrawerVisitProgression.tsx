"use client";

import type { Appointment } from "../types";

interface DrawerVisitProgressionProps {
  appointment: Appointment;
}

export function DrawerVisitProgression({ appointment }: DrawerVisitProgressionProps) {
  const hasAny =
    appointment.dateTimeAskedToArrive ||
    appointment.dateTimeArrived ||
    appointment.dateTimeSeated ||
    appointment.dateTimeDismissed;
  if (!hasAny) return null;

  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold text-foreground">Visit progression</h4>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {appointment.dateTimeAskedToArrive && (
          <>
            <dt className="text-muted-foreground">Asked to arrive</dt>
            <dd>{new Date(appointment.dateTimeAskedToArrive).toLocaleString()}</dd>
          </>
        )}
        {appointment.dateTimeArrived && (
          <>
            <dt className="text-muted-foreground">Arrived</dt>
            <dd>{new Date(appointment.dateTimeArrived).toLocaleString()}</dd>
          </>
        )}
        {appointment.dateTimeSeated && (
          <>
            <dt className="text-muted-foreground">Seated</dt>
            <dd>{new Date(appointment.dateTimeSeated).toLocaleString()}</dd>
          </>
        )}
        {appointment.dateTimeDismissed && (
          <>
            <dt className="text-muted-foreground">Dismissed</dt>
            <dd>{new Date(appointment.dateTimeDismissed).toLocaleString()}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
