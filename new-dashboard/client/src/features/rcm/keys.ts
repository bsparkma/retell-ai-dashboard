/**
 * THE KEYS A BILLER WORKING A CHECK ACTUALLY PRESSES — S8 flow-speed, item 1.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY KEYS AT ALL, ON A SCREEN BUILT FOR SOMEBODY WHO HAS NEVER SEEN IT
 * ═════════════════════════════════════════════════════════════════════════════
 * The bar is "a new team member finds the work cold AND an experienced biller
 * flies". Those pull in opposite directions everywhere except here: a shortcut
 * costs a first-time reader nothing, because nothing about the screen changes
 * until she presses one. So the keys are the one affordance this module can add
 * for speed without spending a word on the face of the page.
 *
 * WHAT THEY ARE, AND WHY THESE
 *
 *   Enter          the screen's ONE primary — the same button the sticky bar
 *                  draws. Never a second act: if the bar's button is a link,
 *                  Enter follows it; if it is disabled, Enter does nothing.
 *   [ or k         the previous claim on this check
 *   ] or j         the next one
 *   ?              the overlay that lists all of the above
 *   Escape         closes the overlay
 *
 * `j`/`k` are vim's down/up and `[`/`]` are the pager pair every reader of a
 * browser already has in their fingers; offering both costs one line and means
 * nobody has to learn which convention this app picked.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE IT REFUSES TO FIRE, AND WHY EACH ONE IS LOAD-BEARING
 * ─────────────────────────────────────────────────────────────────────────────
 * A global key handler on a screen that writes to a patient's chart has to be
 * more careful than one on a photo gallery. It stands down completely when:
 *
 *   THE CARET IS IN A FIELD. `input`, `textarea`, `select` and anything
 *   `contenteditable` — the set-aside reason box and the review note are both on
 *   these screens, and Enter inside a note must end a line, never approve a
 *   check.
 *
 *   A MODIFIER IS HELD. Ctrl/Meta/Alt+Enter belongs to the browser and the OS.
 *
 *   THE FOCUS IS ALREADY ON A CONTROL. A button, a link or a tab with the focus
 *   ring on it already answers Enter itself, and firing the page's primary as
 *   well would mean one press doing two things — the exact "two controls, one
 *   act" shape this module keeps deleting, arrived at through the keyboard.
 *
 *   AN IN-FLOW CONFIRM IS OPEN. `MatchAnywayConfirm` (Q2) and
 *   `PermanentPathConfirm` (D-17) both deliberately focus their DECLINE button
 *   and both are asking a question the page behind them must not answer. While
 *   either is on the page every key here is off.
 *
 * `?` and Escape are exempt from the last rule only in that Escape closes the
 * overlay; neither ever performs work.
 *
 * NO REAL PATIENT DATA anywhere in this file.
 */
import { useEffect } from "react";

/** The testids of the two confirms that own the page while they are open. */
const IN_FLOW_CONFIRM = ["match-anyway", "recoupment-permanent-confirm"];

/** One row of the overlay: what to press, and what it does. */
export interface KeyHint {
  /** "Enter", "] or j" — printed verbatim. */
  keys: string;
  /** What that press does, in the screen's own words. */
  does: string;
}

export interface RcmKeyHandlers {
  /** The screen's one primary. Absent ⇒ Enter does nothing here. */
  onPrimary?: (() => void) | null;
  /** Previous / next claim on this check. Absent ⇒ that key does nothing. */
  onPrev?: (() => void) | null;
  onNext?: (() => void) | null;
  /** Toggle the "?" overlay. */
  onToggleHelp?: () => void;
  /** Close it — Escape, and only when it is open. */
  onCloseHelp?: () => void;
  /** Off entirely: a loading screen, or one whose work is done. */
  enabled?: boolean;
}

/**
 * True when this event must be ignored — see the header for each reason.
 *
 * Exported so the overlay's own copy can be tested against the same predicate
 * the handler uses, rather than a second one written beside it.
 */
export function standDown(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (document.querySelector(IN_FLOW_CONFIRM.map((id) => `[data-testid="${id}"]`).join(","))) {
    return true;
  }
  return false;
}

/** The focus is on something that answers Enter for itself. */
function focusOwnsEnter(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY") return true;
  const role = el.getAttribute("role");
  return role === "button" || role === "tab" || role === "link";
}

export function useRcmKeys({
  onPrimary = null,
  onPrev = null,
  onNext = null,
  onToggleHelp,
  onCloseHelp,
  enabled = true,
}: RcmKeyHandlers): void {
  useEffect(() => {
    if (!enabled) return;
    function handle(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Escape is the one key that runs while a field has the caret: closing
        // an overlay is not work, and a reader who opened it mid-note must be
        // able to shut it without leaving the box.
        if (onCloseHelp) onCloseHelp();
        return;
      }
      if (standDown(e)) return;
      if (e.key === "?") {
        e.preventDefault();
        onToggleHelp?.();
        return;
      }
      if (e.key === "Enter") {
        if (!onPrimary || focusOwnsEnter()) return;
        e.preventDefault();
        onPrimary();
        return;
      }
      if (e.key === "[" || e.key === "k") {
        if (!onPrev) return;
        e.preventDefault();
        onPrev();
        return;
      }
      if (e.key === "]" || e.key === "j") {
        if (!onNext) return;
        e.preventDefault();
        onNext();
      }
    }
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [enabled, onPrimary, onPrev, onNext, onToggleHelp, onCloseHelp]);
}
