import type { TreatmentItem } from "./types"

/** Records required before treatment can be planned/scheduled, keyed by treatment code. */
export const RECORDS_MATRIX: Record<string, string[]> = {
  Crown: ["Pre-op PA", "Missing teeth note", "New/replacement noted"],
  PFM: ["Pre-op PA", "Missing teeth note", "New/replacement noted"],
  Onlay: ["Pre-op PA", "Pre-op photo"],
  Comp: ["Pre-op photo (anterior only)"],
  Amal: [],
  "Build-up": ["Pre-op PA"],
  "Pulp cap": ["Pre-op PA"],
  Veneer: ["Pre-op photo", "Shade photo"],
  RC: ["Pre-op PA", "Working length PA"],
  Retreat: ["Pre-op PA"],
  Pulpotomy: ["Pre-op PA"],
  EX: ["Pre-op PA"],
  "Graft \u00bd": ["Pre-op PA", "Perio chart"],
  "Graft full": ["Pre-op PA", "Perio chart", "Pano"],
  Muco: ["Perio chart", "Pre-op photo"],
  "Perio surg": ["Perio chart", "Pano"],
  SRP: ["Perio chart", "Pano"],
  "Perio maint": ["Perio chart"],
  IMP: ["PA", "CT scan", "Perio chart", "Missing teeth note", "Surgical guide"],
  Mini: ["PA", "CT scan", "Missing teeth note"],
  Bridge: ["Pano", "Missing teeth note", "New/replacement noted"],
  PO: ["Pano", "Missing teeth note"],
  AB: ["PA"],
  Denture: ["Pano", "Missing teeth note", "New/replacement + years"],
  Partial: ["Pano", "Missing teeth note", "New/replacement + years"],
  Ortho: ["Pano", "Ceph", "Ortho photos", "Ortho workup"],
  Aligners: ["Pano", "Ceph", "Ortho photos", "Ortho workup", "Scan U/L"],
  Myobrace: ["Ortho photos", "Ortho workup"],
  Whitening: ["Pre-op photo", "Shade photo"],
  "Sleep apnea": ["Pano", "Airway screening"],
  TMJ: ["Pano", "TMJ history"],
  FMR: ["Pano", "Full series photos", "Ortho workup"],
  "Smile makeover": ["Pre-op photo", "Shade photo"],
  Sealant: [],
  Watch: [],
}

/** Union of all records required across a set of treatment items, deduped, in matrix order. */
export function recordsNeededFor(items: TreatmentItem[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const needed = RECORDS_MATRIX[item.code] ?? []
    for (const r of needed) {
      if (!seen.has(r)) {
        seen.add(r)
        out.push(r)
      }
    }
  }
  return out
}
