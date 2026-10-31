/**
 * Cards from today's schedule (CO-5b): the Checkout page's "today's schedule"
 * line, and the polling that keeps the server's schedule read fresh while the
 * page is open.
 *
 * WHEN IT ASKS — the day-progress pattern (pages/hyg/HygDay.tsx):
 *   - on mount, on focus, and on becoming visible;
 *   - every 60 s while visible (a hidden page asks nothing);
 *   - a few seconds after an answer that says a read is RUNNING, so the cards
 *     it makes show up without waiting out the minute.
 * Asking is cheap: the server reads Open Dental at most once per office per
 * 60-second window, however many pages ask.
 *
 * HONESTY. A failed schedule read — or a failed ask — is said, in amber, with
 * the last time the schedule WAS read: "Couldn't check today's schedule". Never
 * a quiet list that might be stale. An office with the switch off shows
 * nothing at all.
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CalendarCheck, Loader2 } from "lucide-react";

import { getScheduleCheck } from "@/features/tc/checkout/checkoutApi";
import { checkoutClock } from "@/features/tc/checkout/CheckoutOutcome";
import { OfficeBadge } from "@/features/tc/components/OfficeBadge";
import type { TcCheckoutScheduleCheck } from "@shared/tc/checkout";
import type { OfficeId } from "@shared/tc/contract";

/** How often a visible page asks. */
export const SCHEDULE_CHECK_INTERVAL_MS = 60_000;
/** How soon to ask again after an answer that says a read is running. */
export const SCHEDULE_CHECK_FOLLOW_UP_MS = 5_000;

/** One office's line: the server's answer, or the ask itself failing. */
export type ScheduleCheckState =
  | { officeId: OfficeId; kind: "answer"; check: TcCheckoutScheduleCheck }
  | { officeId: OfficeId; kind: "unreachable"; lastSuccessAt: string | null };

/**
 * Ask each office while the page is open. `onCardsMade` runs when a finished
 * read made at least one card, so the list can reload.
 */
export function useScheduleCheck(offices: readonly OfficeId[], onCardsMade: () => void): ScheduleCheckState[] {
  const [states, setStates] = useState<ScheduleCheckState[]>([]);
  const onMade = useRef(onCardsMade);
  onMade.current = onCardsMade;
  /** Per office: the last success seen, so a NEW success with cards reloads once. */
  const seen = useRef(new Map<OfficeId, string | null>());
  const key = offices.join(",");

  useEffect(() => {
    const list = key ? (key.split(",") as OfficeId[]) : [];
    if (list.length === 0) {
      setStates([]);
      return undefined;
    }
    let disposed = false;
    let followUp: ReturnType<typeof setTimeout> | null = null;
    let busy = false;

    const ask = async () => {
      if (disposed || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const next = await Promise.all(
          list.map(async (officeId): Promise<ScheduleCheckState> => {
            try {
              return { officeId, kind: "answer", check: await getScheduleCheck(officeId) };
            } catch {
              return { officeId, kind: "unreachable", lastSuccessAt: seen.current.get(officeId) ?? null };
            }
          }),
        );
        if (disposed) return;
        let made = false;
        for (const s of next) {
          if (s.kind !== "answer") continue;
          const prior = seen.current.get(s.officeId);
          if (s.check.lastSuccessAt && s.check.lastSuccessAt !== prior && (s.check.summary?.created ?? 0) > 0) made = true;
          seen.current.set(s.officeId, s.check.lastSuccessAt);
        }
        setStates(next);
        if (made) onMade.current();
        if (followUp) clearTimeout(followUp);
        followUp = next.some((s) => s.kind === "answer" && s.check.running)
          ? setTimeout(() => void ask(), SCHEDULE_CHECK_FOLLOW_UP_MS)
          : null;
      } finally {
        busy = false;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void ask();
    };
    const onFocus = () => void ask();

    void ask();
    const timer = setInterval(() => void ask(), SCHEDULE_CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      clearInterval(timer);
      if (followUp) clearTimeout(followUp);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [key]);

  return states;
}

/** "Last checked 9:58 AM", or the plain fact that it never has been. */
function lastSuccessText(at: string | null): string {
  return at ? `Last successful check: ${checkoutClock(at)}.` : "It has not been read successfully yet.";
}

/** The line under the tabs. Renders nothing for an office whose switch is off. */
export function ScheduleCheckLine({ states, showOfficeBadges }: { states: ScheduleCheckState[]; showOfficeBadges: boolean }) {
  const shown = states.filter((s) => s.kind === "unreachable" || s.check.status !== "off");
  if (shown.length === 0) return null;
  return (
    <div className="space-y-1.5 mb-3" data-testid="schedule-check">
      {shown.map((s) => {
        const badge = showOfficeBadges ? <OfficeBadge officeId={s.officeId} /> : null;
        const failed = s.kind === "unreachable" || s.check.status === "failed";
        if (failed) {
          const at = s.kind === "unreachable" ? s.lastSuccessAt : s.check.lastSuccessAt;
          return (
            <div
              key={s.officeId}
              role="status"
              className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950 px-3 py-2 text-sm text-amber-900 dark:text-amber-200 flex items-start gap-2"
              data-testid={`schedule-check-failed-${s.officeId}`}
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              {badge}
              <span className="min-w-0 flex-1">
                Couldn&apos;t check today&apos;s schedule. {lastSuccessText(at)} Patients finished in Open Dental since
                then may be missing — add them by hand if they are at the desk.
              </span>
            </div>
          );
        }
        const c = s.check;
        const checking = c.status === "pending" || c.running;
        return (
          <p
            key={s.officeId}
            className="text-xs text-muted-foreground flex flex-wrap items-center gap-1.5"
            data-testid={`schedule-check-ok-${s.officeId}`}
          >
            {checking && !c.lastSuccessAt ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <CalendarCheck className="w-3.5 h-3.5" />
            )}
            {badge}
            {c.lastSuccessAt
              ? `Today's schedule checked at ${checkoutClock(c.lastSuccessAt)}: finished non-hygiene visits get a card.`
              : "Checking today's schedule for finished non-hygiene visits…"}
            {c.summary?.partial ? (
              <span className="text-amber-700 dark:text-amber-300" data-testid={`schedule-check-partial-${s.officeId}`}>
                Only part of the schedule could be read.
              </span>
            ) : null}
          </p>
        );
      })}
    </div>
  );
}
