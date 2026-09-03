/**
 * RECORDS_MATRIX — what has to exist before a treatment can be planned.
 *
 * Ported from the prototype unchanged. This is the office's own standard,
 * encoded: a crown needs a pre-op PA, a missing-teeth note and new/replacement
 * marked; an implant needs a CT scan and a surgical guide. It is the thing that
 * stops a case reaching a treatment coordinator without the records that make
 * it presentable, which is the most common reason a case stalls.
 *
 * ⚠️ IT DOES NOT GATE ANYTHING. Beau's ruling: the matrix produces WARNINGS a
 * hygienist can see and proceed past. Nothing in this module hard-blocks a Send
 * on a completeness check. The prototype's Finish tab treated two of these as
 * blocking gates ("Recare scheduled", "TX entered in OD") — both are things the
 * FRONT DESK does after the hygienist is finished, so blocking on them makes a
 * hygienist wait on work she cannot do. They become warnings in slice 2.
 *
 * PER-OFFICE LATER, NOT NOW. This is the office standard as one table; when the
 * two practices' standards diverge it moves into per-office settings. Making it
 * per-office speculatively would mean two tables to keep in step and one
 * practice's rules quietly drifting.
 */

/** Treatment code → the records that treatment needs. */
export const RECORDS_MATRIX: Record<string, readonly string[]> = {
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
  "Graft ½": ["Pre-op PA", "Perio chart"],
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
};

/**
 * Every record a set of proposed treatments needs, deduplicated, in matrix
 * order.
 *
 * An UNKNOWN treatment code contributes nothing rather than throwing. The codes
 * are free text on a `TreatmentItem` (they are the office's shorthand, not a
 * closed enum), so a hygienist typing one this table has never heard of must
 * still be able to finish her visit — she gets no records prompt for that item,
 * which is the honest answer to "we do not know what this needs".
 */
export function recordsNeededFor(
  items: readonly { code: string }[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    for (const record of RECORDS_MATRIX[item.code] ?? []) {
      if (seen.has(record)) continue;
      seen.add(record);
      out.push(record);
    }
  }
  return out;
}
