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
 * A DISPOSITIONED call is finished too, for the same reason a not-a-patient close-out is:
 * somebody looked at it and said what it was. That is the whole point of the field — a lab
 * confirming a case or a supply vendor needs neither a chart note nor a TC case, so before
 * this existed the only two ways to finish a call both wrote somewhere, and those rows sat
 * in "Needs attention" forever. Like every other close-out here the row is NOT removed: it
 * stays in "All calls", keeps its badge, and one click clears the disposition to undo.
 *
 * PRD D1 relief valve: when MANGO_WORKLIST_MODE is 'flagged', a Mango (staff) call only
 * demands attention if it's an emergency / requested an appointment / needs a callback.
 * Un-flagged Mango calls stay visible in "All calls" and remain sendable, but drop out of
 * the attention count and default view. Retell calls are never affected by the mode.
 */
export function callNeedsAttention(c: UnifiedCall, mangoWorklistMode: MangoWorklistMode): boolean {
  if (c.triageStatus === "done" || c.notAPatient || c.disposition) return false;
  if (isAiDuplicateLeg(c)) return false;
  if (c.source === "mango" && mangoWorklistMode === "flagged") {
    return Boolean(c.isEmergency || c.appointmentRequested || c.appointmentBooked || c.callbackRequested);
  }
  return true;
}

/**
 * Which single row action gets to carry a WORD instead of just an icon.
 *
 * A worklist row can offer five actions at once, and when each one wore a label they
 * collectively squeezed the patient's name down to a few characters. Only the call's next
 * logical step earns a label now; everything else is an icon with a tooltip.
 *
 * These are not new rules — they are the same conditions the row already used to decide
 * whether to render "Send to chart" (PatientIdentityCell) and "Transcribe"
 * (TranscribeAction), hoisted here so one row can't show two labels.
 *
 * Order matters: a matched staff call with no transcript satisfies both, and filing the
 * chart note is the step that closes the call out, so it wins.
 */
export type RowPrimaryAction = "send_to_chart" | "transcribe" | null;

export function rowPrimaryAction(c: UnifiedCall, odConnectedForCall: boolean): RowPrimaryAction {
  // Matched but not yet on the chart — the review-then-send step. Mirrors the
  // PatientIdentityCell branch order: no OD for this call's office, or a not-a-patient
  // close-out, means there is no chart action at all.
  if (odConnectedForCall && !c.notAPatient && c.odSyncStatus !== "synced" && c.odPatientId) {
    return "send_to_chart";
  }
  // A staff call nobody has read yet. (A Retell call arrives with a transcript; a Mango
  // call that already has one needs nothing.)
  if (c.source === "mango" && !c.hasTranscript) return "transcribe";
  return null;
}
