/**
 * THE NEXT CLICK, IN THE HEADER — one button, computed in `flow.ts`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY IT MOVED UP, AND WHY THAT IS THE SAME AS DELETING A BUTTON
 * ═════════════════════════════════════════════════════════════════════════════
 * The check's own page is a triage screen: a header, five steps, and a table of
 * claims to rank. S3 puts the header's three actions where a person looks for
 * them — *Save for tomorrow*, *Set aside*, and whatever the check's next step
 * actually is.
 *
 * That last one is not a new control. It is `flow.cta`, the SAME object the
 * rail has always rendered under its five steps, moved to the top of the page;
 * the rail on this one screen is told not to draw it (`RcmStepper hideCta`).
 * Before this, a check standing on *Match it up* offered a rail CTA reading
 * "Match it up" AND a header button reading "Match all claims" — two controls,
 * two names, one act. W-11's rule is exactly one page-level match verb, and this
 * component is where it lives.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT CARRIES THE WHOLE CONTRACT, INCLUDING THE REFUSALS
 * ─────────────────────────────────────────────────────────────────────────────
 * A CTA has four shapes and all four are here, because a page that hoisted only
 * the happy one would have quietly dropped the reason a blocked step cannot be
 * done — §15.2's fourth finding, and the thing `DisabledReason` exists to make
 * impossible:
 *
 *   disabled + reason   the step is blocked. Greyed, and the reason is beside it.
 *   a handler           a verb this page owns. Fires it.
 *   an href             the work is on another screen. A link.
 *   neither             a verb nobody here can perform. Greyed, with the note as
 *                       the reason — never a live button that does nothing.
 *
 * `note` — "Reads Open Dental. Writes nothing to any chart." — rides along under
 * it. On the match verb that sentence is the one thing standing between a biller
 * and treating every press as a commitment, so it does not get left behind in
 * the move.
 */
import { Link } from "wouter";
import { ArrowRight, Loader2 } from "lucide-react";
import type { RcmAction, RcmCta } from "@/features/rcm/flow";
import DisabledReason from "@/components/rcm/DisabledReason";

export default function RcmPrimaryAction({
  cta,
  onAction,
  /**
   * The verb this page owns is in flight.
   *
   * Separate from `cta.disabled`, which is the FLOW's answer about whether the
   * step can be done at all. "Not yet" and "already running" are two different
   * sentences and only one of them is a refusal.
   */
  busy = false,
  busyLabel,
  testId = "rcm-cta",
}: {
  cta: RcmCta;
  onAction?: Partial<Record<RcmAction, () => void>>;
  busy?: boolean;
  busyLabel?: string;
  testId?: string;
}) {
  const handler = cta.action ? onAction?.[cta.action] : undefined;
  const solid =
    "inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-60";
  const dead =
    "inline-flex cursor-not-allowed items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-sm font-semibold text-muted-foreground";

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      {cta.disabled ? (
        <>
          <button type="button" disabled className={dead} data-testid={testId}>
            {cta.label}
          </button>
          {/* ALWAYS. `flow.ts` guarantees a blocked CTA carries its reason. */}
          <DisabledReason tone="warn" testId={`${testId}-reason`}>
            {cta.reason ?? "This step cannot be done yet."}
          </DisabledReason>
        </>
      ) : handler ? (
        <button
          type="button"
          onClick={handler}
          disabled={busy}
          className={solid}
          data-testid={testId}
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          {busy && busyLabel ? busyLabel : cta.label}
          {!busy && <ArrowRight size={14} />}
        </button>
      ) : cta.href ? (
        <Link href={cta.href} className={solid} data-testid={testId}>
          {cta.label}
          <ArrowRight size={14} />
        </Link>
      ) : (
        <>
          <button type="button" disabled className={dead} data-testid={testId}>
            {cta.label}
          </button>
          <DisabledReason testId={`${testId}-reason`}>
            {cta.note ?? "This step is done on another screen."}
          </DisabledReason>
        </>
      )}

      {!cta.disabled && cta.note && (
        <span
          className="max-w-xs text-xs text-muted-foreground sm:text-right"
          data-testid={`${testId}-note`}
        >
          {cta.note}
        </span>
      )}
    </div>
  );
}
