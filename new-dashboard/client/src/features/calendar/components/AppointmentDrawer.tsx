"use client";

import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useCalendarState } from "../store/CalendarContext";
import { useCalendarActions } from "../store/CalendarContext";
import { selectedAppointment } from "../store/calendarSelectors";
import { calendarApi } from "../api";
import { DrawerScheduling } from "../drawer/DrawerScheduling";
import { DrawerVisitProgression } from "../drawer/DrawerVisitProgression";
import { DrawerPatientContext } from "../drawer/DrawerPatientContext";
import { DrawerCustomFields } from "../drawer/DrawerCustomFields";
import { DrawerActions } from "../drawer/DrawerActions";
import type { Patient } from "../types";

export function AppointmentDrawer() {
  const state = useCalendarState();
  const actions = useCalendarActions();
  const appointment = selectedAppointment(state);
  const [patientLoading, setPatientLoading] = useState(false);

  const open = state.ui.selectedAppointmentId != null;

  useEffect(() => {
    if (!appointment?.patientId) return;
    const pid = appointment.patientId;
    if (state.data.patientsById[pid]) return;
    setPatientLoading(true);
    calendarApi
      .getPatient(pid)
      .then((p) => actions.setPatient(pid, p as Patient))
      .catch(() => {})
      .finally(() => setPatientLoading(false));
  }, [appointment?.patientId, open]);

  const patient = appointment?.patientId != null ? state.data.patientsById[appointment.patientId] ?? null : null;

  return (
    <Sheet
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) actions.setSelectedAppointmentId(null);
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col p-0">
        {appointment ? (
          <>
            <SheetHeader className="p-4 border-b shrink-0">
              <SheetTitle>{appointment.patient ?? "Appointment"}</SheetTitle>
              <SheetDescription>
                {appointment.time} · {appointment.type} · {appointment.operatoryName}
              </SheetDescription>
            </SheetHeader>
            <ScrollArea className="flex-1">
              <div className="p-4 space-y-6">
                <DrawerScheduling appointment={appointment} />
                <DrawerVisitProgression appointment={appointment} />
                <DrawerPatientContext patient={patient} loading={patientLoading} />
                <DrawerCustomFields />
                <DrawerActions />
              </div>
            </ScrollArea>
          </>
        ) : (
          <div className="p-4 text-muted-foreground">No appointment selected</div>
        )}
      </SheetContent>
    </Sheet>
  );
}
