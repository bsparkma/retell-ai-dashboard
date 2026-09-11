/**
 * "ALREADY APPROVED — see it on the Posting screen" (S5, item 4).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT AN ERROR BOX
 * ═════════════════════════════════════════════════════════════════════════════
 * On 2026-09-09 a biller met "nothing on this remittance can be approved" over a
 * check whose every claim was ALREADY approved, and pressed Approve three times
 * (W-12). The server now says which of the two it means — `alreadyApproved:
 * true` on the refusal — and this is what a screen does with that answer:
 *
 *   · it is not amber and not red. Nothing went wrong; the work is done;
 *   · it names where the approved check went, and links there;
 *   · the screen that renders it retires its own approve button. A sentence
 *     saying "already done" beside a button inviting another press is the
 *     exact shape that produced three presses.
 *
 * Both approving doors — the ordinary approve page and the takeback panel —
 * render this one component, so they cannot come to say it two ways.
 */
import { Link } from "wouter";
import { CheckCircle2, ChevronRight } from "lucide-react";

export default function AlreadyApproved({ testId = "already-approved" }: { testId?: string }) {
  return (
    <div
      className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
      data-testid={testId}
    >
      <span className="flex items-center gap-1.5 font-medium text-foreground">
        <CheckCircle2 size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
        Already approved — see it on the Posting screen.
      </span>
      <Link
        href="/rcm/posting"
        data-testid={`${testId}-link`}
        className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
      >
        Open the Posting screen
        <ChevronRight size={12} />
      </Link>
    </div>
  );
}
