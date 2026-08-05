/**
 * useFinancingLibrary — the calculators' live view of the office library.
 *
 * PM ruling 6.2 (TC parity slice): the legacy DentaFlow calculator re-read its
 * financing settings whenever the window regained focus, whenever `storage`
 * fired, and on a custom FINANCING_SETTINGS_CHANGED_EVENT — because settings
 * lived in this browser's localStorage. On the platform they live in the
 * server-owned office library, so the honest equivalent is to RE-FETCH:
 *
 *   - when the office changes (never render another office's rates), and
 *   - when the window regains focus / the tab becomes visible again — which is
 *     exactly when someone comes back from editing Library → Financing.
 *
 * No polling loop, no `storage` listener (nothing of ours is in localStorage),
 * no custom event bus. A focus refresh is one GET of a small JSON document.
 *
 * RACE HANDLING: every fetch takes a monotonically increasing ticket; only the
 * newest ticket may write state, so a slow response can never clobber a newer
 * one. Results are stored WITH the office they belong to and only read back
 * when that office is still selected, so an in-flight response for the previous
 * office can't be shown. All writes are gated on a mounted ref, so nothing sets
 * state after unmount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OfficeId } from "@shared/tc/contract";
import { getLibrary, tcErrorMessage } from "../api";
import type { TcLibrary } from "../api";
import {
  financingViewFromLibrary,
  treatmentPresetsFromLibrary,
  type FinancingLibraryView,
  type TreatmentPreset,
} from "./libraryAdapter";

export interface FinancingLibraryState {
  /** Library for the CURRENT office, or null while it hasn't arrived. */
  library: TcLibrary | null;
  /** Adapted provider/config view (safe when library is null). */
  view: FinancingLibraryView;
  /** Library-derived treatment presets (empty when no fee schedule). */
  presets: TreatmentPreset[];
  loading: boolean;
  /** Last fetch error. Previously loaded data is kept on a failed refresh. */
  error: string | null;
  /** Manual re-fetch (same staleness guards as the automatic ones). */
  refresh: () => void;
}

export function useFinancingLibrary(
  office: OfficeId | null,
  options: { enabled?: boolean } = {},
): FinancingLibraryState {
  const enabled = options.enabled ?? true;

  // Stored WITH its office so a stale office's data is never rendered.
  const [entry, setEntry] = useState<{ office: OfficeId; library: TcLibrary } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const ticketRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    if (!office || !enabled) return;
    const ticket = ++ticketRef.current;
    getLibrary(office)
      .then((library) => {
        if (!mountedRef.current || ticket !== ticketRef.current) return;
        setEntry({ office, library });
        setError(null);
      })
      .catch((e: unknown) => {
        if (!mountedRef.current || ticket !== ticketRef.current) return;
        // Keep the last-known library — a failed refresh shouldn't blank the
        // calculator mid-consult.
        setError(tcErrorMessage(e));
      });
  }, [office, enabled]);

  // Office change (or first enable) → fetch. Any in-flight request is
  // invalidated by the new ticket.
  useEffect(() => {
    setError(null);
    refresh();
  }, [refresh]);

  // Re-read after the TC edits Library → Financing in another tab/window.
  useEffect(() => {
    if (!office || !enabled) return;
    const onFocus = () => refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [office, enabled, refresh]);

  const library = entry && entry.office === office ? entry.library : null;
  const view = useMemo(() => financingViewFromLibrary(library), [library]);
  const presets = useMemo(() => treatmentPresetsFromLibrary(library), [library]);

  return {
    library,
    view,
    presets,
    loading: enabled && office !== null && library === null && error === null,
    error,
    refresh,
  };
}
