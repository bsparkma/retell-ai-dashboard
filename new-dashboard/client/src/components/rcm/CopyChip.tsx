/**
 * A number a biller is about to type into Open Dental — copyable, in one click.
 *
 * The Open Dental check number is the first thing somebody does something ELSE
 * with: they go and find that check in the practice management system. Retyping
 * a seven-digit number off a screen is exactly how the wrong check gets opened,
 * and the number is right there.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT SAYS WHETHER IT WORKED
 * ─────────────────────────────────────────────────────────────────────────────
 * `navigator.clipboard` is not available on an insecure origin and can be
 * refused by permissions policy, so the promise is caught and the chip says
 * "select it" rather than flashing "Copied" over a clipboard that never
 * changed. The same honest-states rule the rest of this module runs on: a
 * success we cannot prove is not reported as one.
 *
 * The value stays selectable text either way, so the fallback is always the
 * thing the chip already was.
 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";

type Outcome = "idle" | "copied" | "failed";

export default function CopyChip({
  value,
  label,
  testId,
}: {
  /** What lands on the clipboard. */
  value: string;
  /** What the chip reads, when that differs — "#4471" for the value "4471". */
  label?: string;
  testId?: string;
}) {
  const [outcome, setOutcome] = useState<Outcome>("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setOutcome("copied");
    } catch {
      setOutcome("failed");
    }
    window.setTimeout(() => setOutcome("idle"), 2000);
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={copy}
        data-testid={testId}
        aria-label={`Copy ${value}`}
        className="inline-flex items-center gap-1 rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-xs font-semibold text-foreground transition-colors hover:bg-muted"
      >
        {label ?? value}
        {outcome === "copied" ? <Check size={11} /> : <Copy size={11} className="opacity-60" />}
      </button>
      {outcome !== "idle" && (
        <span
          className="text-[11px] text-muted-foreground"
          role="status"
          data-testid={testId ? `${testId}-outcome` : undefined}
        >
          {outcome === "copied" ? "Copied" : "Could not copy — select it"}
        </span>
      )}
    </span>
  );
}
