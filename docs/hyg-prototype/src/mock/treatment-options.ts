import { LOWER_PERMANENT, LOWER_PRIMARY, UPPER_PERMANENT, UPPER_PRIMARY } from "@/lib/dentition"
import type { DxCode, MotivationCode, ToothSurfaceLabel, TreatmentCategory } from "./types"

export interface TreatmentOption {
  code: string
  label: string
  category: TreatmentCategory
  /** Treatments that support surface toggles (M O D B L). */
  hasSurfaces?: boolean
  /** Crowns: ask initial vs. replacement. */
  hasCrownType?: boolean
  /** Dentures/partials/bridges: ask new vs. replacement (+ years if replacement). */
  hasProsthesis?: boolean
  /** Applies to the whole mouth rather than specific teeth (ortho, whitening, appliances). */
  mouthLevel?: boolean
}

export const TREATMENT_GROUPS: { category: TreatmentCategory; treatments: TreatmentOption[] }[] = [
  {
    category: "Restorative",
    treatments: [
      { code: "Comp", label: "Composite filling", category: "Restorative", hasSurfaces: true },
      { code: "Amal", label: "Amalgam filling", category: "Restorative", hasSurfaces: true },
      { code: "Onlay", label: "Onlay", category: "Restorative", hasSurfaces: true },
      { code: "Crown", label: "Crown", category: "Restorative", hasCrownType: true },
      { code: "PFM", label: "PFM crown", category: "Restorative", hasCrownType: true },
      { code: "Build-up", label: "Build-up", category: "Restorative" },
      { code: "Pulp cap", label: "Pulp cap", category: "Restorative" },
      { code: "Veneer", label: "Veneer", category: "Cosmetic" },
    ],
  },
  {
    category: "Endo",
    treatments: [
      { code: "RC", label: "Root canal", category: "Endo" },
      { code: "Retreat", label: "RCT retreat", category: "Endo" },
      { code: "Pulpotomy", label: "Pulpotomy", category: "Endo" },
    ],
  },
  {
    category: "Surgery",
    treatments: [
      { code: "EX", label: "Extraction", category: "Surgery" },
      { code: "Graft \u00bd", label: "Bone graft \u2013 partial", category: "Surgery" },
      { code: "Graft full", label: "Bone graft \u2013 full", category: "Surgery" },
      { code: "Muco", label: "Mucogingival graft", category: "Surgery" },
      { code: "Perio surg", label: "Perio surgery", category: "Surgery" },
    ],
  },
  {
    category: "Perio",
    treatments: [
      { code: "SRP", label: "SRP quad", category: "Perio" },
      { code: "Perio maint", label: "Perio maintenance", category: "Perio" },
      { code: "Referral", label: "Perio referral", category: "Perio" },
    ],
  },
  {
    category: "Prosth",
    treatments: [
      { code: "IMP", label: "Implant", category: "Prosth" },
      { code: "Mini", label: "Mini implant", category: "Prosth" },
      { code: "Bridge", label: "Bridge", category: "Prosth", hasProsthesis: true },
      { code: "PO", label: "Pontic (bridge unit)", category: "Prosth" },
      { code: "AB", label: "Abutment", category: "Prosth" },
      { code: "Denture", label: "Denture", category: "Prosth", hasProsthesis: true },
      { code: "Partial", label: "Partial denture", category: "Prosth", hasProsthesis: true },
    ],
  },
  {
    category: "Ortho",
    treatments: [
      { code: "Ortho", label: "Ortho \u2013 braces/consult", category: "Ortho", mouthLevel: true },
      { code: "Aligners", label: "Aligners", category: "Ortho", mouthLevel: true },
    ],
  },
  {
    category: "Other",
    treatments: [
      { code: "Myobrace", label: "Myobrace / myofunctional", category: "Other", mouthLevel: true },
      { code: "Whitening", label: "Whitening", category: "Cosmetic", mouthLevel: true },
      { code: "Sleep apnea", label: "Sleep apnea appliance", category: "Other", mouthLevel: true },
      { code: "TMJ", label: "TMJ / occlusal guard", category: "Other", mouthLevel: true },
      { code: "FMR", label: "Full mouth reconstruction", category: "Other", mouthLevel: true },
      { code: "Smile makeover", label: "Smile makeover", category: "Cosmetic", mouthLevel: true },
      { code: "Sealant", label: "Sealant", category: "Restorative", hasSurfaces: true },
      { code: "Watch", label: "Watch", category: "Other" },
    ],
  },
]

export function findTreatmentOption(code: string): TreatmentOption | undefined {
  for (const group of TREATMENT_GROUPS) {
    const found = group.treatments.find((t) => t.code === code)
    if (found) return found
  }
  return undefined
}

/** Human-readable label for a treatment code, falling back to the raw code if unknown. */
export function treatmentLabel(code: string): string {
  return findTreatmentOption(code)?.label ?? code
}

export const SURFACE_OPTIONS: ToothSurfaceLabel[] = ["M", "O", "D", "B", "L"]

export const DX_OPTIONS: DxCode[] = [
  "I",
  "D",
  "RD",
  "XD",
  "E",
  "AB",
  "EXCR",
  "FX",
  "CR",
  "PAIN",
  "RCT",
  "MISS",
  "OM",
  "N",
  "LF",
  "SAP",
  "AT",
  "OH",
  "UE",
  "GR",
]

export const MOTIVATION_OPTIONS: MotivationCode[] = ["FF", "R", "esthetic", "pain", "function", "insurance", "other"]

export const PRIORITY_OPTIONS: { id: 1 | 2 | 3 | 4; label: string }[] = [
  { id: 1, label: "P1 \u00b7 Urgent" },
  { id: 2, label: "P2 \u00b7 Soon" },
  { id: 3, label: "P3 \u00b7 Next visit" },
  { id: 4, label: "P4 \u00b7 Routine" },
]

export const STATUS_OPTIONS: { id: "proposed" | "watch" | "confirmed" | "scheduled"; label: string }[] = [
  { id: "proposed", label: "Proposed" },
  { id: "watch", label: "Watch" },
  { id: "confirmed", label: "Confirmed" },
  { id: "scheduled", label: "Scheduled" },
]

// ----- Odontogram numbering -----
// Display order comes from src/lib/dentition.ts — do not build tooth ranges here.

/** Universal numbering, adult dentition, upper arch #1-16 left-to-right. */
export const ADULT_UPPER = UPPER_PERMANENT.map(String)
/** Universal numbering, adult dentition, lower arch #32-17 left-to-right (so #32 sits under #1). */
export const ADULT_LOWER = LOWER_PERMANENT.map(String)

/** Primary dentition, universal letters, upper arch A-J left-to-right. */
export const PRIMARY_UPPER = UPPER_PRIMARY
/** Primary dentition, universal letters, lower arch T-K left-to-right (so T sits under A). */
export const PRIMARY_LOWER = LOWER_PRIMARY

export const QUADRANT_SHORTCUTS: { id: string; label: string; adultTeeth: string[]; primaryTeeth: string[] }[] = [
  { id: "ur", label: "UR", adultTeeth: UPPER_PERMANENT.slice(0, 8).map(String), primaryTeeth: UPPER_PRIMARY.slice(0, 5) },
  { id: "ul", label: "UL", adultTeeth: UPPER_PERMANENT.slice(8, 16).map(String), primaryTeeth: UPPER_PRIMARY.slice(5, 10) },
  { id: "lr", label: "LR", adultTeeth: LOWER_PERMANENT.slice(0, 8).map(String), primaryTeeth: LOWER_PRIMARY.slice(0, 5) },
  { id: "ll", label: "LL", adultTeeth: LOWER_PERMANENT.slice(8, 16).map(String), primaryTeeth: LOWER_PRIMARY.slice(5, 10) },
]
