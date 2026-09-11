/**
 * W-4 — THE PERMANENT TAKEBACK PATH ASKS BEFORE IT IS CHOSEN (S5).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IT STANDS IN FRONT OF
 * ═════════════════════════════════════════════════════════════════════════════
 * The takeback panel offers two ways to write a takeback. The adjustment is the
 * default and can be undone by an offsetting adjustment. The negative
 * supplemental cannot: Open Dental refuses to revert or delete it and it pins the
 * claim and its procedure for good. Until this slice the two were one radio
 * click apart — the most consequential choice on the panel, made by the same
 * gesture as the least.
 *
 * So selecting the permanent one opens THIS, in the flow, and the radio does
 * not move until it is answered. Decline keeps the adjustment.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SAME SHAPE AS MATCH ANYWAY, ON PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 *   · the affirmative button SAYS THE CONSEQUENCE, never "OK";
 *   · DECLINE takes focus when it opens, so Enter backs out, and Escape backs
 *     out from anywhere inside;
 *   · in the flow, never over it — the explanation it is asking about is on the
 *     panel right above it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CLIENT FRICTION, NOTHING MORE
 * ─────────────────────────────────────────────────────────────────────────────
 * It changes nothing about what is allowed. The server's `defaultPath` still
 * decides which radio starts selected, the typed confirmation is untouched, and
 * `POST /approve-recoupment` still validates the path and the typed total itself.
 * A request that skips this screen is refused or accepted exactly as before.
 */
import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";

export default function PermanentPathConfirm({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const declineRef = useRef<HTMLButtonElement>(null);

  /*
   * THE DEFAULT IS DECLINE — an explicit focus rather than `autoFocus`, which
   * React honours only on some mount paths (see MatchAnywayConfirm).
   * `scrollIntoView` is feature-detected: jsdom lacks it, and the focus is the
   * part that matters.
   */
  useEffect(() => {
    declineRef.current?.focus({ preventScroll: true });
    const panel = declineRef.current?.closest("section");
    if (panel && typeof panel.scrollIntoView === "function") {
      panel.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

  return (
    <section
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
      role="group"
      aria-label="Confirm the permanent way of writing this takeback"
      className="mt-3 rounded-lg border-2 border-rose-400 bg-rose-50 p-3 dark:border-rose-800 dark:bg-rose-950/40"
      data-testid="recoupment-permanent-confirm"
    >
      <p className="flex items-center gap-1.5 text-sm font-semibold text-rose-900 dark:text-rose-200">
        <AlertTriangle size={14} className="shrink-0" />
        Use the permanent way?
      </p>
      <p className="mt-1 text-xs text-rose-900 dark:text-rose-200">
        A negative supplemental can never be undone. Once it posts, nothing in CareIN or the Open
        Dental API can reverse or delete it, and it pins the claim and its procedure for good. The
        adjustment does the same job and can be reversed.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* THE DECLINE COMES FIRST in the DOM as well as in the focus order. */}
        <button
          ref={declineRef}
          type="button"
          onClick={onCancel}
          data-testid="recoupment-permanent-cancel"
          className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
        >
          Keep the adjustment
        </button>
        {/* The label IS the consequence. */}
        <button
          type="button"
          onClick={onConfirm}
          data-testid="recoupment-permanent-yes"
          className="inline-flex items-center gap-1.5 rounded-md border border-rose-500 px-3 py-1.5 text-sm font-medium text-rose-900 transition-colors hover:bg-rose-100 dark:text-rose-200 dark:hover:bg-rose-900/40"
        >
          Use the permanent one — it can never be undone
        </button>
      </div>
    </section>
  );
}
