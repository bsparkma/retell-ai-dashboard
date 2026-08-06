/**
 * On-demand transcription: button state machine + the user-facing copy (Mango slice M4).
 *
 * Both placements — the worklist row action and the primary button on the call detail
 * page — drive off THIS module, so the two can never drift into telling a user different
 * things about the same outcome. It is also what the unit tests exercise: the states and
 * the wording are the contract, the JSX is just a rendering of it.
 *
 * HONEST STATES, the rule this exists to enforce:
 *   - "running" is entered only when the request is actually in flight, and is the ONLY
 *     state in which the button is disabled — a second click during a run does nothing
 *     rather than erroring.
 *   - "done" is entered only for `completed` / `exists`, i.e. only when the server has
 *     confirmed a transcript is PERSISTED. There is no optimistic success.
 *   - Every refusal returns to "idle" so the call stays transcribable. A failed attempt
 *     never consumes the affordance.
 */

import type { TranscribeResult, TranscribeStatus } from "@/lib/api";

/** What the button is doing right now. */
export type TranscribeButtonState = "idle" | "running" | "done";

/** How the outcome should be announced. Maps to sonner's success/info/error toasts. */
export type TranscribeToneKind = "success" | "info" | "error";

export interface TranscribeFeedback {
  kind: TranscribeToneKind;
  text: string;
}

/**
 * The next button state for an outcome. Only a server-confirmed, persisted transcript
 * ends the run; everything else leaves the call clickable again.
 */
export function nextButtonState(status: TranscribeStatus): TranscribeButtonState {
  return status === "completed" || status === "exists" ? "done" : "idle";
}

/** Whether the call still has work the button can do. */
export function isTerminal(status: TranscribeStatus): boolean {
  return nextButtonState(status) === "done";
}

/**
 * Format an ISO instant as a short local clock time ("12:00 AM"). Used so the budget
 * message can say WHEN it resets rather than a vague "tomorrow". Falls back to the raw
 * string if the date is unparseable — never renders "Invalid Date" at a user.
 */
export function formatResetTime(iso: string | undefined): string {
  if (!iso) return "midnight";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "midnight";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * The message for an outcome. Wording is deliberate: each refusal says what happened, and
 * — where there is one — what the person can do about it. No error blobs, no fake success.
 */
export function transcribeFeedback(result: TranscribeResult): TranscribeFeedback {
  switch (result.status) {
    case "completed":
      return {
        kind: "success",
        text: result.minutesUsed
          ? `Transcribed and summarized (${result.minutesUsed.toFixed(1)} min of audio).`
          : "Transcribed and summarized.",
      };

    case "exists":
      return { kind: "info", text: "This call already has a transcript — nothing was re-run." };

    case "in_progress":
      return { kind: "info", text: "This call is already being transcribed — hang tight." };

    case "budget_exhausted":
      return {
        kind: "error",
        text:
          `Daily transcription budget is used up — resets at ${formatResetTime(result.resetsAt)}. ` +
          "Try again tomorrow or transcribe fewer calls.",
      };

    case "recording_not_ready":
      return { kind: "error", text: "Recording isn't ready yet — try again in a few minutes." };

    case "recording_unavailable":
      return { kind: "error", text: "Recording is no longer available from the phone system." };

    case "no_speech":
      return { kind: "error", text: "No speech was detected in this recording — there's nothing to summarize." };

    case "unavailable":
      return { kind: "error", text: "Transcription isn't set up in this environment yet." };

    case "not_found":
      return { kind: "error", text: "That call is no longer in the worklist." };

    default:
      return { kind: "error", text: "Transcription failed — nothing was saved. Try again." };
  }
}

/** How long a failure toast stays up. Refusals need reading; successes don't. */
export function toastDuration(kind: TranscribeToneKind): number {
  return kind === "error" ? 8000 : 4000;
}
