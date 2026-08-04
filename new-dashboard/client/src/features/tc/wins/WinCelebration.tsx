/**
 * Win celebration overlay — the DentaFlow "Case Accepted!" moment, ported with
 * honest numbers (PM ruling 2). See ./derive.ts for what was dropped and why.
 *
 * Shows: the congratulatory line, the patient's first name, and the accepted
 * case's own value (real, server-confirmed). Plus, when a case snapshot was
 * available, a labeled accepted-family total for the office right now.
 * Never shows: a weekly/MTD figure or an acceptance rate.
 *
 * Presentation-only: it takes derived stats and an onDone callback. The
 * trigger lives in WinCelebrationProvider so pages fire it with one call.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, TrendingUp } from "lucide-react";
import { formatCents } from "../money";
import type { WinStats } from "./derive";

/** Matches the legacy overlay's dwell time before auto-dismiss. */
const AUTO_DISMISS_MS = 3000;
/** Exit transition length — onDone fires after the card has faded. */
const EXIT_MS = 400;

export function WinCelebration({
  stats,
  onDone,
}: {
  stats: WinStats;
  onDone: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const dismiss = useCallback(() => {
    setExiting(true);
    window.setTimeout(() => doneRef.current(), EXIT_MS);
  }, []);

  useEffect(() => {
    const showTimer = window.setTimeout(() => setVisible(true), 50);
    const dismissTimer = window.setTimeout(() => {
      setExiting(true);
      window.setTimeout(() => doneRef.current(), EXIT_MS);
    }, AUTO_DISMISS_MS);
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(dismissTimer);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dismiss]);

  const shown = visible && !exiting;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="status"
      aria-live="polite"
      onClick={dismiss}
    >
      <div
        className="absolute inset-0 bg-black/60 transition-opacity duration-300"
        style={{ opacity: shown ? 1 : 0 }}
      />

      <div
        className="relative bg-card text-card-foreground rounded-2xl border border-border shadow-2xl p-8 max-w-sm w-full mx-4 text-center transition-all duration-300"
        style={{
          transform: shown ? "scale(1) translateY(0)" : "scale(0.9) translateY(20px)",
          opacity: shown ? 1 : 0,
        }}
      >
        <div className="w-16 h-16 rounded-full mx-auto flex items-center justify-center mb-4 bg-emerald-100 dark:bg-emerald-950">
          <Sparkles className="w-8 h-8 text-emerald-600 dark:text-emerald-400" aria-hidden />
        </div>

        <h2
          className="text-xl font-bold mb-1 text-foreground"
          style={{ fontFamily: "Sora, sans-serif" }}
        >
          Case Accepted!
        </h2>
        <p className="text-sm text-muted-foreground mb-4">
          {stats.patientFirstName} is moving forward
        </p>

        <div
          className="text-3xl font-bold mb-4 text-primary"
          style={{ fontFamily: "Sora, sans-serif" }}
        >
          {formatCents(stats.caseValueCents)}
        </div>

        {stats.acceptedNow && (
          <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <TrendingUp className="w-3.5 h-3.5 text-emerald-500 shrink-0" aria-hidden />
            <span>
              Accepted in this office right now: {stats.acceptedNow.count} ·{" "}
              {formatCents(stats.acceptedNow.valueCents)}
            </span>
          </div>
        )}

        <button
          type="button"
          className="mt-4 text-[10px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            dismiss();
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
