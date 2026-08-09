/**
 * Worklist attention rules (PRD D1, extended by slice M7).
 *
 * Pure, framework-free so it can be unit-tested and shared. `callNeedsAttention`
 * decides whether a call belongs in the "Needs attention" view + count.
 */
import type { UnifiedCall, MangoWorklistMode } from "./api";

/**
 * Is this the Mango leg of a call the AI already handled end to end?
 *
 * These rows are pure duplication: the same conversation the linked Retell row already
 * holds, logged a second time because the call traversed the PBX on its way to the AI.
 * On production the day this shipped there were 67 of them in 14 days — 94% of all AI
 * calls — and every single one was still sitting unworked in "Needs attention".
 *
 * A `transferred_leg` is deliberately NOT included: that Mango recording is the human half
 * of the conversation, which the AI's transcript does not contain, so it is real work.
 */
export function isAiDuplicateLeg(c: UnifiedCall): boolean {
  return c.linkRole === "duplicate_leg";
}

/** Does this row have a twin on the other source that a human might want to jump to? */
export function hasLinkedTwin(c: UnifiedCall): boolean {
  return Boolean(c.linkedCallId);
}

/**
 * Whether a call demands worklist attention.
 *
 * Base rule (both sources): not resolved (`triageStatus !== 'done'`) and not closed out
 * as spam/not-a-patient.
 *
 * M7: the Mango leg of an AI-completed call never demands attention — working it means
 * working the same conversation twice, and for the 14 pairs on prod that had a confident
 * patient match it also meant two CareIN commlogs on one chart for one call. The row is
 * hidden from this view, NOT deleted: it stays in "All calls" and under the "Answered by
 * AI" chip, and retention owns deletion later.
 *
 * PRD D1 relief valve: when MANGO_WORKLIST_MODE is 'flagged', a Mango (staff) call only
 * demands attention if it's an emergency / requested an appointment / needs a callback.
 * Un-flagged Mango calls stay visible in "All calls" and remain sendable, but drop out of
 * the attention count and default view. Retell calls are never affected by the mode.
 */
export function callNeedsAttention(c: UnifiedCall, mangoWorklistMode: MangoWorklistMode): boolean {
  if (c.triageStatus === "done" || c.notAPatient) return false;
  if (isAiDuplicateLeg(c)) return false;
  if (c.source === "mango" && mangoWorklistMode === "flagged") {
    return Boolean(c.isEmergency || c.appointmentRequested || c.appointmentBooked || c.callbackRequested);
  }
  return true;
}
