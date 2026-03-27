"use client";

import type { Patient } from "../types";

interface DrawerPatientContextProps {
  patient: Patient | null;
  loading: boolean;
}

export function DrawerPatientContext({ patient, loading }: DrawerPatientContextProps) {
  if (loading) {
    return (
      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-foreground">Patient</h4>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </section>
    );
  }
  if (!patient) {
    return (
      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-foreground">Patient</h4>
        <p className="text-sm text-muted-foreground">No patient data</p>
      </section>
    );
  }

  const displayName =
    patient.displayName ?? ([patient.firstName, patient.lastName].filter(Boolean).join(" ") || "Patient");
  const phone = patient.wirelessPhone ?? patient.hmPhone ?? patient.wkPhone;

  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold text-foreground">Patient</h4>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Name</dt>
        <dd>{displayName}</dd>
        {patient.dateOfBirth && (
          <>
            <dt className="text-muted-foreground">DOB</dt>
            <dd>{patient.dateOfBirth}</dd>
          </>
        )}
        {patient.language && (
          <>
            <dt className="text-muted-foreground">Language</dt>
            <dd>{patient.language}</dd>
          </>
        )}
        {phone && (
          <>
            <dt className="text-muted-foreground">Phone</dt>
            <dd>{phone}</dd>
          </>
        )}
        {patient.txtMsgOk != null && (
          <>
            <dt className="text-muted-foreground">Texting OK</dt>
            <dd>{patient.txtMsgOk ? "Yes" : "No"}</dd>
          </>
        )}
        {patient.preferConfirmMethod && (
          <>
            <dt className="text-muted-foreground">Confirm method</dt>
            <dd>{patient.preferConfirmMethod}</dd>
          </>
        )}
        {patient.preferContactMethod && (
          <>
            <dt className="text-muted-foreground">Contact method</dt>
            <dd>{patient.preferContactMethod}</dd>
          </>
        )}
        {patient.priProvAbbr && (
          <>
            <dt className="text-muted-foreground">Primary provider</dt>
            <dd>{patient.priProvAbbr}</dd>
          </>
        )}
        {patient.clinicAbbr && (
          <>
            <dt className="text-muted-foreground">Clinic</dt>
            <dd>{patient.clinicAbbr}</dd>
          </>
        )}
        {patient.premed && (
          <>
            <dt className="text-muted-foreground">Premed</dt>
            <dd>{patient.premed}</dd>
          </>
        )}
        {patient.apptModNote && (
          <>
            <dt className="text-muted-foreground">Appt note</dt>
            <dd className="col-span-1">{patient.apptModNote}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
