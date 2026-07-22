/**
 * Worklist attention rules (PRD D1).
 *
 * Pure, framework-free so it can be unit-tested and shared. `callNeedsAttention`
 * decides whether a call belongs in the "Needs attention" view + count.
 */
import type { UnifiedCall, MangoWorklistMode } from "./api";

/**
 * Whether a call demands worklist attention.
 *
 * Base rule (both sources): not resolved (`triageStatus !== 'done'`) and not closed out
 * as spam/not-a-patient.
 *
 * PRD D1 relief valve: when MANGO_WORKLIST_MODE is 'flagged', a Mango (staff) call only
 * demands attention if it's an emergency / requested an appointment / needs a callback.
 * Un-flagged Mango calls stay visible in "All calls" and remain sendable, but drop out of
 * the attention count and default view. Retell calls are never affected by the mode.
 */
export function callNeedsAttention(c: UnifiedCall, mangoWorklistMode: MangoWorklistMode): boolean {
  if (c.triageStatus === "done" || c.notAPatient) return false;
  if (c.source === "mango" && mangoWorklistMode === "flagged") {
    return Boolean(c.isEmergency || c.appointmentRequested || c.appointmentBooked || c.callbackRequested);
  }
  return true;
}
