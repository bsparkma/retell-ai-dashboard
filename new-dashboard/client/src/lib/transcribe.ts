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

/**
 * What the button is doing right now.
 *
 * `no_speech` is a state, not just a past event: an attempt that found no speech STILL
 * SPENT BUDGET, so the row has to remember it. The button stays clickable — a human may
 * have a reason to retry — but the next click costs money again, so it asks first.
 */
export type TranscribeButtonState = "idle" | "running" | "done" | "no_speech";

/** How the outcome should be announced. Maps to sonner's success/info/error toasts. */
export type TranscribeToneKind = "success" | "info" | "error";

export interface TranscribeFeedback {
  kind: TranscribeToneKind;
  text: string;
}

/**
 * The next button state for an outcome. Only a server-confirmed, persisted transcript
 * ends the run; a billed-but-empty result becomes the `no_speech` state; everything else
 * leaves the call plainly clickable again.
 */
export function nextButtonState(status: TranscribeStatus): TranscribeButtonState {
  if (status === "completed" || status === "exists") return "done";
  if (status === "no_speech") return "no_speech";
  return "idle";
}

/** Whether the call still has work the button can do. */
export function isTerminal(status: TranscribeStatus): boolean {
  return nextButtonState(status) === "done";
}

/**
 * Does clicking again SPEND BUDGET on something we already paid for? True only for a call
 * whose last attempt found no speech: Azure Speech billed for the audio and returned
 * nothing, so a retry is a fresh charge for the same silent recording.
 *
 * This is the one place the button's "an existing result is never re-billed" promise could
 * quietly break — a misclick on a silent call costs real money — so the caller must confirm
 * rather than the UI silently allowing it or silently locking it out.
 */
export function needsRebillConfirm(lastOutcome: string | null | undefined): boolean {
  return lastOutcome === "no_speech";
}

/**
 * The re-bill confirmation. Named constants because the PM reviews this wording, and
 * because the tests assert it says both true things: nothing was found last time, AND
 * doing it again costs budget again.
 */
export const REBILL_CONFIRM_TITLE = "Transcribe this call again?";
export const REBILL_CONFIRM_BODY =
  "No speech was found in this recording last time. Transcribing again will spend budget again. Continue?";
export const REBILL_CONFIRM_ACCEPT = "Transcribe again";
export const REBILL_CONFIRM_CANCEL = "Cancel";

/**
 * Does transcribing this call duplicate a transcript we ALREADY HAVE? (slice M7)
 *
 * True for the Mango leg of a call the AI answered end to end. The PBX recorded the same
 * conversation the AI did, so transcribing it spends Azure Speech + summary budget to
 * produce a second copy of the linked Retell row's transcript. This had already happened
 * twice on production before the twins were linked — which is the whole reason this
 * confirmation exists.
 *
 * Like the no-speech guard, this is a CONFIRMATION AND NOT A LOCKOUT. There are honest
 * reasons to want the PBX-side audio (a caller heard on the other channel, a recording
 * quality question), so the judgement stays with the human — they just have to be told
 * first that they are paying for a duplicate.
 */
export function needsDuplicateLegConfirm(linkRole: string | null | undefined): boolean {
  return linkRole === "duplicate_leg";
}

/**
 * The duplicate-leg confirmation. Named constants for the same reason the re-bill ones
 * are: the PM reviews this wording, and the tests assert it says both true things — the
 * AI answered this call, AND its transcript already exists on the linked row.
 */
export const DUPLICATE_LEG_CONFIRM_TITLE = "This call was already answered by the AI";
export const DUPLICATE_LEG_CONFIRM_BODY =
  "This call was answered by the AI agent — its transcript already exists on the linked call. " +
  "Transcribing this copy will spend budget to produce the same transcript again. Continue?";
export const DUPLICATE_LEG_CONFIRM_ACCEPT = "Transcribe anyway";
export const DUPLICATE_LEG_CONFIRM_CANCEL = "Cancel";
/** Label on the link that jumps to the Retell row holding the real transcript. */
export const DUPLICATE_LEG_JUMP_LABEL = "Open the AI call";
/** The worklist badge on a Mango leg the AI answered. */
export const ANSWERED_BY_AI_BADGE = "Answered by CareIN AI";

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
