/**
 * The triage vocabulary — what "done" can mean, in words.
 *
 * Lifted out of CallWorklist so the worklist row and the call-detail page name the
 * same five outcomes. When these lived privately in the worklist there was exactly
 * one place a call could be closed out; the detail page — where the team actually
 * reads the call — could only show that it had been.
 *
 * `TriageOutcome` is a closed union in `lib/api.ts` and the backend validates against
 * the same five values (`TRIAGE_OUTCOMES` in backend/routes/unifiedCalls.js), so a
 * value added on one side is a compile error here rather than a blank chip.
 */
import type { TriageOutcome } from "@/lib/api";

/** Offered in this order: the outcomes that close a call out, most common first. */
export const OUTCOMES: { value: TriageOutcome; label: string }[] = [
  { value: "scheduled", label: "Scheduled" },
  { value: "called_back", label: "Called back" },
  { value: "left_voicemail", label: "Left voicemail" },
  { value: "no_answer", label: "No answer" },
  { value: "no_action_needed", label: "No action needed" },
];

export const OUTCOME_LABEL: Record<TriageOutcome, string> = Object.fromEntries(
  OUTCOMES.map((o) => [o.value, o.label])
) as Record<TriageOutcome, string>;

/**
 * How a resolved call reads. A call marked done before the outcome field existed
 * carries no outcome, so "Done" is the honest fallback rather than an invented one.
 */
export function outcomeLabel(outcome: TriageOutcome | null | undefined): string {
  return outcome ? OUTCOME_LABEL[outcome] : "Done";
}
