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
 */
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { TcCaseSummary } from "../api";
import { deriveWinStats, isAcceptedStatus, type WinStats, type WinTrigger } from "./derive";
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

export function WinCelebrationProvider({ children }: { children: ReactNode }) {
  const [stats, setStats] = useState<WinStats | null>(null);

  const celebrateWin = useCallback(
    (win: WinTrigger, cases?: TcCaseSummary[] | null) => {
      setStats(deriveWinStats(win, cases ?? null));
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
