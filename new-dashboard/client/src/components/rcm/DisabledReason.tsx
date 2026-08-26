/**
 * Why a control cannot be pressed — printed, not hovered.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A COMPONENT AND NOT A `title` ATTRIBUTE
 * ─────────────────────────────────────────────────────────────────────────────
 * §15.2, finding 4: the Drain button is disabled at `0 waiting` with no text
 * saying why, and it cost real time on the staging walk — a greyed button with
 * no reason is indistinguishable from a broken one, so the step reads as
 * untestable rather than as already-guaranteed.
 *
 * A tooltip does not fix it. The practice reads these screens on a tablet at the
 * front desk, and there is no hover on a tablet. So the reason is rendered
 * beside the control, always, in the flow of the page.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MARKER IS LOAD-BEARING
 * ─────────────────────────────────────────────────────────────────────────────
 * `data-disabled-reason` is what `rcm-disabled-reasons.test.tsx` scans for. It
 * renders every RCM screen, finds every `[disabled]` control, and fails if one
 * has no reason beside it. That test is the reason this component exists rather
 * than a `<span className="text-xs">` copied eleven times: a marker nobody can
 * forget to add is a marker a test can enforce.
 *
 * The honest-states rule that governs the backend applies to a greyed button
 * too — say what is true, and say it where it is read.
 */
import type { ReactNode } from "react";

export default function DisabledReason({
  children,
  tone = "muted",
  testId,
}: {
  children: ReactNode;
  /**
   * `muted` for "not yet" — nothing is wrong, the precondition simply is not
   * met. `warn` for a refusal a person has to act on.
   */
  tone?: "muted" | "warn";
  testId?: string;
}) {
  return (
    <span
      data-disabled-reason=""
      data-testid={testId}
      className={`block text-xs ${
        tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"
      }`}
    >
      {children}
    </span>
  );
}
