/**
 * "Send to TC" — the pure rules behind the cross-module handoff button (slice M6).
 *
 * Kept out of the components so the visibility matrix and the copy are directly
 * unit-testable, and so the two places the button appears (call detail's patient
 * panel, worklist row) can never drift apart on WHEN it shows.
 *
 * The button is an offer to file a patient's call with the Treatment Coordinator.
 * It only makes sense when we know three things for certain: which patient, which
 * practice, and that this tenant actually has the TC module. Anything less is
 * hidden — not disabled-with-an-excuse — because there is nothing the person
 * looking at it could do about it from here.
 */

import type { CallActor } from "@/lib/api";

/**
 * The offices a TC case can be filed under. 'unknown' (an unmapped Mango line)
 * is deliberately absent: a case has to belong to a practice, and M5 already
 * keeps those calls out of every office-scoped action.
 */
const FILEABLE_OFFICES: ReadonlySet<string> = new Set(["roland", "valley"]);

/** The fields of a call this decision reads. Structural, so tests need no full call. */
export interface SendToTcCall {
  odPatientId?: number | string | null;
  odPatientName?: string | null;
  officeId?: string | null;
  tcCaseId?: string | null;
  tcCaseUrl?: string | null;
  tcSentBy?: CallActor | null;
}

export type SendToTcState =
  /** No button at all — this call can't be handed over and saying so would be noise. */
  | { kind: "hidden" }
  /** Already in TC: a passive link to the case, not a re-sendable button. */
  | { kind: "sent"; caseUrl: string | null }
  /** Offerable in principle, but something required is missing. Shown disabled + why. */
  | { kind: "disabled"; reason: string }
  /** Ready to send. */
  | { kind: "ready" };

/**
 * Decide what (if anything) the button should be for this call.
 *
 * @param call the call, as normalized for display
 * @param tcEntitled does this tenant have the 'tc' module (from /auth/me)?
 */
export function sendToTcState(call: SendToTcCall, tcEntitled: boolean): SendToTcState {
  // A voice-only tenant must never see a door into a product it doesn't have.
  if (!tcEntitled) return { kind: "hidden" };

  // No resolved patient → nothing to file. The worklist's own "Unmatched" action
  // is the right next step, and it's already on the row.
  const patientId = call.odPatientId;
  if (patientId === null || patientId === undefined || patientId === "") return { kind: "hidden" };

  // No known practice → no case list to file under.
  if (!call.officeId || !FILEABLE_OFFICES.has(call.officeId)) return { kind: "hidden" };

  // Already handed over. The server is idempotent, but the UI shouldn't invite a
  // second click that reads like it does something new.
  if (call.tcCaseId) return { kind: "sent", caseUrl: call.tcCaseUrl ?? null };

  // patient_name is REQUIRED by the contract and is what TC files the case under.
  // Rather than send a nameless payload, refuse and say so — this is recoverable
  // (re-match the call), so it earns a disabled button instead of a hidden one.
  if (!call.odPatientName || !call.odPatientName.trim()) {
    return { kind: "disabled", reason: "patient name unavailable" };
  }

  return { kind: "ready" };
}

/** The name to show in the success toast. Guarded by the `disabled` state above. */
export function tcPatientLabel(call: SendToTcCall): string {
  return (call.odPatientName ?? "").trim() || "this patient";
}

/**
 * Success copy. `attached` distinguishes "this joined a case that was already
 * open" from "this opened a new one" — a coordinator's next move differs, so the
 * toast must not blur them. `null` (an already-sent no-op) says exactly that.
 */
export function tcSuccessMessage(patientName: string, attached: boolean | null): string {
  if (attached === null) return `${patientName} is already in TC`;
  return attached
    ? `Added to ${patientName}'s existing TC case`
    : `Case created in TC for ${patientName}`;
}

/**
 * Failure copy. Never optimistic: every branch states that nothing was sent, or
 * names the real blocker. The 403 shouldn't reach a user (the button is hidden
 * without the module) but is handled rather than left to a generic message.
 */
export function tcErrorMessage(status: number | null, code: string | null): string {
  if (code === "MODULE_NOT_ENTITLED" || status === 403) {
    return "The TC module isn't enabled.";
  }
  if (code === "OFFICE_MISMATCH") {
    return "This call belongs to a different office — nothing was sent. Reload and try again.";
  }
  if (code === "OFFICE_UNKNOWN") {
    return "This call's phone line isn't mapped to an office yet — nothing was sent.";
  }
  if (code === "NO_MATCHED_PATIENT" || code === "PATIENT_NAME_UNAVAILABLE") {
    return "This call has no matched patient — nothing was sent. Match it first.";
  }
  return "Couldn't reach the TC app — nothing was sent. Try again.";
}
