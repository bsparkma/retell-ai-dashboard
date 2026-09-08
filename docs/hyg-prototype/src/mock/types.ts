// Core domain types for the CareIN Hygiene prototype.
// Everything here is mock-only: no backend, no real PHI.

export type OfficeId = "roland" | "valley"

export interface Office {
  id: OfficeId
  name: string
  shortName: string
}

export interface Operatory {
  id: string
  officeId: OfficeId
  name: string
  isHygiene: boolean
}

export interface Hygienist {
  id: string
  officeId: OfficeId
  name: string
  credential: string
  license: string
}

export type AppointmentType =
  | "Prophy Adult"
  | "Prophy Child"
  | "SRP"
  | "Perio Maint"
  | "Ortho Adj"
  | "New Pt Hyg"

export type ConfirmationStatus = "Unconfirmed" | "Confirmed" | "Arrived" | "In Chair" | "Done"

export interface Patient {
  id: string
  officeId: OfficeId
  name: string
  age: number
  phone: string
  email: string
  premedRequired: boolean
  orthoPatient: boolean
}

export interface Appointment {
  id: string
  officeId: OfficeId
  patientId: string
  operatoryId: string
  hygienistId: string
  date: string // yyyy-mm-dd
  startMinutes: number // minutes from midnight
  lengthMinutes: number
  type: AppointmentType
  isHygiene: boolean
  status: ConfirmationStatus
  xraysDue: boolean
  perioChartDue: boolean
  doctorExamNeeded: boolean
  hasOpenTcCase: boolean
}

// ----- Staged writes (the "nothing writes automatically" model) -----

export type StagedWriteKind = "router" | "perio" | "note" | "tc-handoff"

export type StagedWriteState = "Draft" | "Staged" | "Sending" | "Written" | "Failed"

export interface StagedWrite {
  id: string
  apptId: string
  kind: StagedWriteKind
  title: string
  summary: string
  state: StagedWriteState
  createdAt: number
  /** Rendered preview payload (HTML-safe plain text / structured lines) */
  preview: string[]
  errorMessage?: string
  /** For tc-handoff writes: what kind of case this is (e.g. "ortho"). */
  caseType?: string
}

// ----- Perio charting -----

export type ToothSurface = "DB" | "B" | "MB" | "DL" | "L" | "ML"

export interface SiteReading {
  depth: number | null
  bleeding: boolean
  suppuration: boolean
  plaque: boolean
  calculus: boolean
}

export interface ToothChart {
  toothNumber: number // 1-32
  missing: boolean
  sites: Record<ToothSurface, SiteReading>
}

export interface PerioExam {
  id: string
  patientId: string
  date: string
  teeth: ToothChart[]
}

// ----- Treatment identification (tooth chart + treatment items) -----

export type TreatmentCategory = "Restorative" | "Endo" | "Surgery" | "Perio" | "Prosth" | "Ortho" | "Cosmetic" | "Other"

export type ToothSurfaceLabel = "M" | "O" | "D" | "B" | "L"

export type DxCode =
  | "I" // Incipient
  | "D" // Decay
  | "RD" // Recurrent decay
  | "XD" // Extensive decay
  | "E" // Existing (defective restoration)
  | "AB" // Abscess
  | "EXCR" // Existing crack
  | "FX" // Fracture
  | "CR" // Cracked tooth
  | "PAIN" // Pain / sensitivity
  | "RCT" // Needs root canal
  | "MISS" // Missing tooth
  | "OM" // Open margin
  | "N" // Necrosis
  | "LF" // Leaking filling
  | "SAP" // Symptomatic apical periodontitis
  | "AT" // Attrition
  | "OH" // Poor oral hygiene
  | "UE" // Unesthetic
  | "GR" // Gingival recession

export const DX_LABELS: Record<DxCode, string> = {
  I: "Incipient lesion",
  D: "Decay",
  RD: "Recurrent decay",
  XD: "Extensive decay",
  E: "Existing defective restoration",
  AB: "Abscess",
  EXCR: "Existing crack",
  FX: "Fracture",
  CR: "Cracked tooth",
  PAIN: "Pain / sensitivity",
  RCT: "Needs root canal treatment",
  MISS: "Missing tooth",
  OM: "Open margin",
  N: "Necrosis",
  LF: "Leaking filling",
  SAP: "Symptomatic apical periodontitis",
  AT: "Attrition",
  OH: "Poor oral hygiene",
  UE: "Unesthetic",
  GR: "Gingival recession",
}

export type MotivationCode = "FF" | "R" | "esthetic" | "pain" | "function" | "insurance" | "other"

export const MOTIVATION_LABELS: Record<MotivationCode, string> = {
  FF: "Failing filling",
  R: "Patient request",
  esthetic: "Esthetic concern",
  pain: "Pain",
  function: "Function",
  insurance: "Insurance renewal / benefit",
  other: "Other",
}

export type TreatmentStatus = "proposed" | "watch" | "confirmed" | "scheduled"

export interface TreatmentItem {
  id: string
  teeth: number[] | "mouth"
  code: string // e.g. "Comp", "Crown", "RC", "EX", "IMP", "Ortho", "Aligners"
  category: TreatmentCategory
  surfaces?: ToothSurfaceLabel[]
  dx: DxCode[]
  dxNote?: string
  priority: 1 | 2 | 3 | 4
  motivation: MotivationCode[]
  motivationNote?: string
  status: TreatmentStatus
  crownType?: "initial" | "replacement"
  prosthesis?: { newOrReplacement: "new" | "replacement"; years?: string }
  scheduleNext: boolean
  note?: string
  photos: string[]
  tags?: string[] // e.g. "post-ortho"
  createdBy: string
  createdAt: string
}

/** Priority order when multiple treatment items imply different Submission categories. */
const CATEGORY_PRIORITY: Submission["category"][] = ["Ortho", "Implant", "Restorative", "Cosmetic", "Perio", "Other"]

/** Picks the single Submission category that best represents a set of treatment items. */
export function deriveCategory(items: TreatmentItem[]): Submission["category"] {
  if (items.length === 0) return "Other"
  const present = new Set<Submission["category"]>()
  for (const item of items) {
    if (item.category === "Prosth") {
      present.add(item.code === "IMP" || item.code === "Mini" ? "Implant" : "Restorative")
    } else if (item.category === "Endo" || item.category === "Surgery") {
      present.add("Restorative")
    } else if (item.category === "Cosmetic") {
      present.add("Cosmetic")
    } else if (item.category === "Ortho") {
      present.add("Ortho")
    } else if (item.category === "Perio") {
      present.add("Perio")
    } else {
      present.add("Other")
    }
  }
  return CATEGORY_PRIORITY.find((c) => present.has(c)) ?? "Other"
}

// ----- Templates -----

export interface NoteTemplateField {
  id: string
  label: string
  type: "text" | "textarea" | "select"
  options?: string[]
  defaultValue?: string
  autofillSource?: "Router" | "Perio" | "Findings" | "Ortho"
}

export interface NoteTemplate {
  id: string
  name: string
  fields: NoteTemplateField[]
  narrativePattern: string // template string with {{fieldId}} placeholders
}

// ----- Submissions (TC handoffs) -----

export type SubmissionStatus = "Pending TC" | "Presented" | "Accepted" | "Lost"

export interface Submission {
  id: string
  officeId: OfficeId
  patientId: string
  date: string
  category: "Restorative" | "Perio" | "Ortho" | "Cosmetic" | "Implant" | "Other"
  urgency: "Routine" | "Soon" | "Urgent"
  status: SubmissionStatus
  hygienistId: string
}
