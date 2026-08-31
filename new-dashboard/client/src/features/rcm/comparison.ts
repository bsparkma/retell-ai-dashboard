/**
 * THE SHADOW-MODE COMPARISON, IN WORDS (Stage C-2).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE IS FOR
 * ═════════════════════════════════════════════════════════════════════════════
 * The running tally under the yes/no ask is one sentence, and it is the whole of
 * what the biller gets back for clicking. It has to be right and it has to sound
 * like a person, so it is built here, once, as a pure function over the counts —
 * not assembled inline in JSX where nothing can test it and every future edit is
 * a guess about the plural.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE RULE THIS FILE EXISTS TO KEEP
 * ─────────────────────────────────────────────────────────────────────────────
 * **She is checking the software. She is not being measured.**
 *
 * So: no percentage, no proportion, no badge, no streak language, no "how you
 * did". Counts and a run, said flatly. The moment this copy reads as though the
 * person is the one under examination, she stops answering honestly — and an
 * honest answer is the entire product of the shadow period.
 *
 * `matchedRun` is deliberately NOT rendered to her at all. It is the number the
 * decision to switch posting on is made from and it belongs on the admin
 * summary; a "17 in a row" on her screen is a streak, and a streak is a thing
 * people protect.
 *
 * NO REAL PATIENT DATA anywhere in this file.
 */
import type { ComparisonTally, RcmOfficeId } from "./api";
import { COMPARISON_COPY, COMPARISON_REASONS } from "./api";
import { zoneFor } from "./time";

/**
 * A slug → the words a biller would say. Falls back to the raw slug rather than
 * to nothing: a vocabulary the server widened must render as an ugly string, the
 * way every other one in this module fails.
 */
export function comparisonReasonLabel(slug: string | null | undefined): string {
  if (!slug) return "something else";
  return (COMPARISON_REASONS as readonly string[]).includes(slug)
    ? COMPARISON_COPY[slug as keyof typeof COMPARISON_COPY].label.toLowerCase()
    : slug;
}

/** "Aug 22" in the practice's own zone. No year — this is a sentence, not a stamp. */
export function shortOfficeDay(
  iso: string | null | undefined,
  office?: RcmOfficeId,
): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    timeZone: zoneFor(office),
    month: "short",
    day: "numeric",
  });
}

/**
 * The running tally, as one sentence — or null when there is nothing to say yet.
 *
 * Null on zero rather than "0 checks compared": the first time she sees this
 * panel there is no tally, and a line reading zero would be the screen making a
 * point of an absence she is about to fix.
 *
 * The single difference is NAMED — *(the payment amount, Aug 22)* — because
 * "1 marked off" with nothing beside it reads as an accusation with the evidence
 * withheld. Past one, they are counted rather than listed: a sentence that grows
 * a clause per difference stops being a sentence.
 */
export function tallySentence(
  tally: Pick<ComparisonTally, "compared" | "same" | "differed" | "latestDifference">,
  office?: RcmOfficeId,
): string | null {
  const { compared, same, differed, latestDifference } = tally;
  if (compared <= 0) return null;

  const checks = `${compared} check${compared === 1 ? "" : "s"} compared`;

  if (differed === 0) {
    return compared === 1
      ? `So far: ${checks}, and you marked it the same.`
      : `So far: ${checks}, and you marked them all the same.`;
  }

  const sameHalf = same === 0 ? "none the same" : `${same} the same`;

  if (differed === 1) {
    const when = shortOfficeDay(latestDifference?.at, office);
    const which = comparisonReasonLabel(latestDifference?.reason);
    const detail = when ? ` (${which}, ${when})` : ` (${which})`;
    return `So far: ${checks}, you marked ${sameHalf} and 1 off${detail}.`;
  }

  return `So far: ${checks}, you marked ${sameHalf} and ${differed} off.`;
}
