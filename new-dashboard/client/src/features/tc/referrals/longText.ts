/**
 * Long text in the referral surfaces (fix/referral-note-scroll).
 *
 * The shared Textarea is `field-sizing-content`: it grows with what is typed,
 * with no ceiling. Inside a centered, fixed Dialog that has no max-height, a
 * long note pushed the dialog past the bottom of the screen — the rest of the
 * note and the Save / Log it buttons could not be reached, and nothing
 * scrolled. Two rules fix it, and every referral note field follows both:
 *
 *   1. A note field grows only to REFERRAL_LONG_TEXT_CLASS's ceiling, then
 *      scrolls inside itself.
 *   2. A referral dialog caps its own height to the viewport
 *      (REFERRAL_DIALOG_CONTENT_CLASS) and scrolls its BODY
 *      (REFERRAL_DIALOG_BODY_CLASS), while the header and the action row sit
 *      outside the scroll region so the buttons are always on screen.
 *
 * `dvh` rather than `vh` so a phone's browser chrome does not hide the bottom.
 */

/** A note field: grows to 40% of the viewport, then scrolls inside itself. */
export const REFERRAL_LONG_TEXT_CLASS = "max-h-[40dvh] overflow-y-auto resize-y break-words";

/** A read-only echo of a note (e.g. "this exact text will be written"). */
export const REFERRAL_LONG_TEXT_ECHO_CLASS = "max-h-[40dvh] overflow-y-auto break-words";

/** DialogContent: never taller than the screen, and laid out header / body / actions. */
export const REFERRAL_DIALOG_CONTENT_CLASS = "flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0";

/** The scrolling middle of a referral dialog. `min-h-0` lets a flex child shrink below its content. */
export const REFERRAL_DIALOG_BODY_CLASS = "min-h-0 flex-1 overflow-y-auto px-6 pb-4";
