/**
 * AN EXPLANATION, FOLDED AWAY — the word diet's one mechanism (S7, Phase 2.4).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY A COMPONENT RATHER THAN A `<details>` PER SITE
 * ═════════════════════════════════════════════════════════════════════════════
 * The owner's ruling was *too many words*, and the 2026-09-11 inventory said
 * where they are: a check-flow screen renders between four and six hundred words
 * of prose, most of it paragraphs explaining a thing the reader can already see
 * a number for. None of it is WRONG — this module's sentences were written
 * carefully and several of them are load-bearing honesty — so the diet moves
 * prose down a level rather than deleting it.
 *
 * "Down a level" has to mean ONE thing on every screen, or a reader learns four
 * different affordances for the same promise. So: one component, one shape, one
 * word on the trigger.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT IS A REAL `<details>`, AND THAT IS THE POINT TWICE OVER
 * ─────────────────────────────────────────────────────────────────────────────
 * For a reader: keyboard-operable, screen-reader-announced, and openable
 * without JavaScript having to be right about anything.
 *
 * For the budget: `tests/rcm-smoke.test.tsx`'s word count walks visible text and
 * SKIPS the body of a closed `<details>` while keeping its `<summary>`. So a
 * paragraph moved in here genuinely leaves the screen a reader arrives at, and
 * the sweep's figure falls because the screen got quieter — not because the
 * words were re-described as something the counter does not look at. Moving a
 * sentence into a `title` tooltip would have scored the same and taught the
 * opposite lesson, which is exactly why the counter ignores attributes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT MUST NEVER GO IN HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * A REFUSAL, OR THE REASON FOR ONE. "Every button that can't be pressed says
 * why, next to it — never only in a tooltip" is this module's rule and
 * `DisabledReason` is where that lives. A reason folded behind a summary is a
 * reason in a tooltip with extra steps.
 *
 * A STATE SENTENCE. What a check IS stays on its face.
 *
 * THE EXEMPT SAFETY TEXTS, listed in the S7 brief: the proof block, the W-16
 * measured copy, the Q2 named-difference confirm, the D-17 typed takeback
 * confirmation and its explanation, and the W-4 confirm-to-switch. Those are
 * read at the moment they matter and are never folded.
 */
import type { ReactNode } from "react";

export default function Explainer({
  /** What the fold is about, in two or three words. Never a sentence. */
  label = "Details",
  testId,
  children,
}: {
  label?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <details className="group mt-1" data-testid={testId}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className="inline-block transition-transform group-open:rotate-90"
        >
          ›
        </span>
        {label}
      </summary>
      <div className="mt-1.5 space-y-1.5 text-xs text-muted-foreground">{children}</div>
    </details>
  );
}
