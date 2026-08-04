/**
 * Small pure helpers for turning an Open Dental patient into TC case fields.
 *
 * Kept out of the components so the entry forms (hygiene intake, New Case) fill
 * their fields identically — a patient linked in one place must produce the same
 * name, age and phone as the same patient linked in the other.
 */
import type { OdPatient } from "../api";

/**
 * Age in whole years from an Open Dental birthdate ("YYYY-MM-DD").
 *
 * Returns null rather than guessing when the date is absent, is OD's null date
 * ('0001-01-01' — the server already strips these, this is belt and braces), or
 * yields an implausible age. The intake form validates age 0–130, so an
 * out-of-range value must not be prefilled into a field that will then block
 * submission with an error the user did not cause.
 */
export function ageFromBirthdate(birthdate: string, today: Date = new Date()): number | null {
  const m = String(birthdate || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (year < 1900) return null;

  let age = today.getFullYear() - year;
  const beforeBirthday =
    today.getMonth() + 1 < month || (today.getMonth() + 1 === month && today.getDate() < day);
  if (beforeBirthday) age -= 1;
  return age >= 0 && age <= 130 ? age : null;
}

/** The case-entry fields an OD patient link fills in. All remain editable. */
export interface OdPatientFields {
  patientName: string;
  patientAge: string;
  phone: string;
  email: string;
  odPatientId: number;
}

/**
 * Case fields from an OD patient. Name is rendered "First Last" (how the case
 * shows it), not OD's "Last, First" display form.
 */
export function fieldsFromOdPatient(p: OdPatient, today?: Date): OdPatientFields {
  const age = ageFromBirthdate(p.birthdate, today);
  return {
    patientName: [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || p.displayName,
    patientAge: age == null ? "" : String(age),
    phone: p.phone,
    email: p.email,
    odPatientId: p.patNum,
  };
}
