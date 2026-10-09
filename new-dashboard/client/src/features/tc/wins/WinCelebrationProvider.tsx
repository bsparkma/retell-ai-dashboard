/**
 * Win celebration trigger (PM ruling 2).
 *
 * The legacy app hung the win off CasesContext (`lastWin` / `clearWin`) and
 * rendered the overlay from App.tsx. The platform has no global TC case store,
 * so the trigger is its own tiny context: mount the provider once above the TC
 * routes, then any page can fire the celebration after a CONFIRMED accepted
 * transition (i.e. after transitionCase resolves — never optimistically).
 *
 *   const { celebrateWin } = useWinCelebration();
 *   // after transitionCase(...) resolves with an accepted-family status:
 *   celebrateWin(
 *     { caseId, patientName, caseValueCents },  // from the PERSISTED case
 *     casesSnapshot,                            // TcCaseSummary[] | null
 *   );
 *
 * Pass `null` for the snapshot when the page doesn't have the office's case
 * list — the overlay then shows the case's own value only. Never synthesize a
 * snapshot to fill the line in.
 *
 * useWinCelebration() is safe to call outside the provider: celebrateWin
 * becomes a no-op, so a page that fires it is never the thing that crashes.
 *
 * THE SERVED RATE (item 42). When the trigger carries the case's office, the
 * provider asks GET /api/tc/reports/funnel for that office's last-90-days
 * presented→accepted rate and attaches it to the overlay IF it answers in
 * time. The overlay opens immediately without it; a failed or empty answer
 * leaves the rate off — never a placeholder, never a client-side estimate.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getConversionFunnel } from "../api";
import type { TcCaseSummary } from "../api";
import { presetFromDate, servedAcceptanceRate } from "../reports/funnel";
import {
  deriveWinStats,
  isAcceptedStatus,
  withServedRate,
  type WinStats,
  type WinTrigger,
} from "./derive";
import { WinCelebration } from "./WinCelebration";

export interface WinCelebrationApi {
  /** Fire the overlay. Snapshot is optional; null omits the accepted-now line. */
  celebrateWin: (win: WinTrigger, cases?: TcCaseSummary[] | null) => void;
}

const WinCelebrationContext = createContext<WinCelebrationApi>({
  celebrateWin: () => {},
});

export function useWinCelebration(): WinCelebrationApi {
  return useContext(WinCelebrationContext);
}

/** The overlay's rate window — labeled on the overlay as "last 90 days". */
export const WIN_RATE_WINDOW_DAYS = 90;

export function WinCelebrationProvider({ children }: { children: ReactNode }) {
  const [stats, setStats] = useState<WinStats | null>(null);
  // Which celebration is current: a slow funnel answer for an EARLIER win must
  // never decorate a later one.
  const seq = useRef(0);

  const celebrateWin = useCallback(
    (win: WinTrigger, cases?: TcCaseSummary[] | null) => {
      const token = ++seq.current;
      setStats(deriveWinStats(win, cases ?? null));
      if (!win.office) return;
      getConversionFunnel(win.office, { from: presetFromDate(WIN_RATE_WINDOW_DAYS) })
        .then((funnel) => {
          if (seq.current !== token) return;
          const served = servedAcceptanceRate(funnel);
          if (!served) return;
          setStats((prev) => (prev ? withServedRate(prev, served) : prev));
        })
        .catch(() => {
          // No rate is the honest fallback; the win itself already showed.
        });
    },
    [],
  );

  const api = useMemo<WinCelebrationApi>(() => ({ celebrateWin }), [celebrateWin]);
  const clear = useCallback(() => setStats(null), []);

  return (
    <WinCelebrationContext.Provider value={api}>
      {children}
      {stats && <WinCelebration stats={stats} onDone={clear} />}
    </WinCelebrationContext.Provider>
  );
}

export { deriveWinStats, isAcceptedStatus };
export type { WinStats, WinTrigger };
