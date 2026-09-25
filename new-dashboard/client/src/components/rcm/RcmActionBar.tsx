/**
 * THE NEXT PRESS, WITHOUT SCROLLING FOR IT — S8 flow-speed, item 1.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FIXES, MEASURED RATHER THAN FELT
 * ═════════════════════════════════════════════════════════════════════════════
 * The owner worked a real EOB and could not find the button. Rendering each RCM
 * screen at 1280x800 with the app's own CSS and reading every control's offset
 * says why — the screen's ONE primary sat, in three of the four states a biller
 * spends her day in, below the fold:
 *
 *   claim page, linked           "Mark checked over"          2190px
 *   claim page, decided          "Approve for posting"        1566px
 *   approve page                 "Yes — this check is right"  1122px
 *
 * The figures are in `docs/reports/rcm-s8-flow-speed.md` with the rest of the
 * audit. A button at 2190px on an 800px screen is not a button anybody finds;
 * it is a button they scroll past three panels of evidence to reach, having
 * already decided — which is the slowest possible ordering of read-then-press.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT IS A MOVE, NOT AN ADDITION — AND THAT IS WHAT KEEPS THE SWEEP GREEN
 * ─────────────────────────────────────────────────────────────────────────────
 * `tests/rcm-smoke.test.tsx` allows AT MOST ONE primary-styled control per
 * screen. This bar does not draw a second copy of anything: every page that
 * mounts it stops drawing its primary where it used to and hands the same node
 * here. Same `RcmPrimaryAction`, same `flow.cta`, same label, same disabled
 * state, same reason. If a page ever passed one and kept the other, the sweep
 * fails — which is the guard, not a comment.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY STICKY-BOTTOM, AND WHY THAT DOES NOT BREAK STAGE C §8
 * ─────────────────────────────────────────────────────────────────────────────
 * §8 rules that *Save for tomorrow* and *Set aside* open ANCHORED, in normal
 * flow, pushing the claim list down rather than covering it, because deciding to
 * set a check aside is deciding about the claims underneath. That ruling is
 * about the two PANELS, and it is untouched: `CheckWorklistActions` stays
 * exactly where it is, in flow, above the claim list, panels and all.
 *
 * This bar carries the primary and the pager — controls that open nothing. It is
 * `sticky bottom-0`, a slim strip at the end of the page's own scroll box, so it
 * covers no evidence at any scroll position. A bottom bar is also the only
 * variant that is in reach on ARRIVAL as well as after scrolling; a sticky top
 * bar is only useful once you have scrolled past where it rests.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE POSITION FOR THE QUIET ACTIONS
 * ─────────────────────────────────────────────────────────────────────────────
 * `left` is the same slot on every flow screen: where this claim sits on the
 * check, and the pager to the ones either side. The primary is always hard
 * right. A biller who has learned where to look on the check page has learned
 * the claim page and the approve page too.
 *
 * NO REAL PATIENT DATA anywhere in this file.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Keyboard, X } from "lucide-react";
import { useRcmKeys, type KeyHint } from "@/features/rcm/keys";

export interface RcmActionBarProps {
  /**
   * The screen's ONE primary, already built by the page. Null when the screen
   * genuinely has none — a finished check, or a candidate list the app has
   * deliberately not chosen from. The bar still draws, because the pager and
   * the keys are still worth having, and an empty right-hand side is honest.
   */
  primary?: ReactNode;
  /** The quiet side: where this claim sits, and the pager where there is one. */
  left?: ReactNode;
  /**
   * WHAT COMES AFTER THIS PRESS, named before it is made.
   *
   * "Next: claim 3 of 6 — so-and-so". Dropped, never guessed, when the page
   * cannot say — see each caller.
   */
  note?: ReactNode;
  /** The keys this screen answers. Empty ⇒ no trigger is drawn at all. */
  hints?: KeyHint[];
  /**
   * Off entirely — a loading or failed screen has no primary to press and no
   * claims to page between.
   */
  keysEnabled?: boolean;
  /** Previous / next claim on this check. See `useRcmKeys`. */
  onPrev?: (() => void) | null;
  onNext?: (() => void) | null;
  testId?: string;
}

export default function RcmActionBar({
  primary = null,
  left = null,
  note = null,
  hints = [],
  keysEnabled = true,
  onPrev = null,
  onNext = null,
  testId = "rcm-action-bar",
}: RcmActionBarProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  const slot = useRef<HTMLDivElement | null>(null);

  /*
   * ENTER PRESSES THE BUTTON THIS BAR IS DRAWING — not a copy of what it does.
   *
   * The alternative is for every page to hand over a callback beside the node,
   * and the two would then be free to disagree: a page that changed its CTA's
   * handler and forgot the callback would give the keyboard a different act
   * from the mouse, silently, on a screen that writes to charts. Clicking the
   * rendered control cannot drift, and it inherits every refusal for free —
   * a disabled primary is not matched by the selector, so Enter does nothing,
   * and a link is followed exactly as a click on it would be.
   *
   * It looks only inside the primary slot, so the keys toggle beside it and
   * anything in `left` can never be what Enter presses.
   */
  const pressPrimary = useCallback(() => {
    const el = slot.current?.querySelector<HTMLElement>("button:not([disabled]), a[href]");
    el?.click();
  }, []);

  useRcmKeys({
    onPrimary: primary ? pressPrimary : null,
    onPrev,
    onNext,
    onToggleHelp: hints.length > 0 ? () => setHelpOpen((v) => !v) : undefined,
    onCloseHelp: helpOpen ? () => setHelpOpen(false) : undefined,
    enabled: keysEnabled,
  });

  return (
    /*
     * The negative margins bleed through the page's own `p-6`, so the strip runs
     * edge to edge and its top border reads as a rule under the page rather than
     * as a floating card. The page needs no extra bottom padding: the bar IS the
     * bottom of the page.
     */
    <div
      className="sticky bottom-0 z-30 -mx-6 -mb-6 mt-8 border-t border-border bg-background/95 px-6 py-2.5 backdrop-blur"
      data-testid={testId}
    >
      {helpOpen && hints.length > 0 && (
        /*
         * ABSOLUTE, AND DELIBERATELY SO — unlike the §8 panels, this one covers
         * nothing a decision depends on. It is a legend for the bar it sits on,
         * it is raised and dismissed by the same key, and Escape closes it.
         */
        <div
          className="absolute bottom-full right-6 mb-2 w-64 rounded-lg border border-border bg-card p-3 shadow-lg"
          data-testid={`${testId}-keys`}
          role="dialog"
          aria-label="Keyboard shortcuts"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="text-xs font-semibold text-foreground">Keys</div>
            <button
              type="button"
              onClick={() => setHelpOpen(false)}
              data-testid={`${testId}-keys-close`}
              aria-label="Close"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <X size={13} />
            </button>
          </div>
          <dl className="mt-2 space-y-1">
            {hints.map((h) => (
              <div key={h.keys} className="flex items-baseline justify-between gap-3 text-xs">
                <dt className="shrink-0 font-mono text-foreground">{h.keys}</dt>
                <dd className="min-w-0 text-right text-muted-foreground">{h.does}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
          data-testid={`${testId}-left`}
        >
          {left}
        </div>

        <div className="flex items-center gap-3">
          {note && (
            <span className="text-xs text-muted-foreground" data-testid={`${testId}-note`}>
              {note}
            </span>
          )}
          {hints.length > 0 && (
            /*
             * A GLYPH, NOT A WORD. The budget counts what a reader reads, and a
             * legend for a legend is the first thing that should not cost a
             * sentence. The name a screen reader speaks is on `aria-label`,
             * which the sweep's banned-word and office-key scans still read.
             */
            <button
              type="button"
              onClick={() => setHelpOpen((v) => !v)}
              data-testid={`${testId}-keys-toggle`}
              aria-label="Keyboard shortcuts"
              aria-expanded={helpOpen}
              title="Keyboard shortcuts"
              className="inline-flex items-center rounded-md border border-border px-2 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Keyboard size={14} />
            </button>
          )}
          <div ref={slot} data-testid={`${testId}-primary`}>
            {primary}
          </div>
        </div>
      </div>
    </div>
  );
}
