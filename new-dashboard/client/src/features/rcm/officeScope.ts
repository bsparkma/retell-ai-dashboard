/**
 * RCM office scoping.
 *
 * The backend has NO all-offices query: every /api/rcm route runs through
 * requireOffice, which rejects anything that isn't a concrete office id. So
 * "All Offices" is a client-side fan-out — ask each office, keep the answers
 * separate, and let the page render one card per office. Nothing is summed
 * across offices: a combined claim count reads like a number you could act on,
 * and there is no combined worklist to act on it in.
 *
 * Deliberately NOT importing features/tc/officeScope: that module is typed
 * against the TC zod contract (@shared/tc/contract) and RCM has no business
 * depending on the TC bundle. The rule is the same; the type is RCM's own.
 */
import { useMemo } from "react";
import { useOffice, ALL_OFFICES } from "@/contexts/OfficeContext";
import { isRcmOfficeId, type RcmOfficeId } from "@/features/rcm/api";

/** Anything roster-shaped; only the id matters here. */
export interface OfficeRosterEntry {
  officeId: string;
}

export interface RcmOfficeScope {
  /** Concrete offices to query, in roster order. Empty = nothing to show. */
  offices: RcmOfficeId[];
  /** The global picker is on "All Offices". */
  isAllOffices: boolean;
  /** Roster still loading — don't render an empty state yet, wait. */
  loading: boolean;
  /** Why the roster is empty, when it is empty because the fetch FAILED. */
  error: string | null;
}

/**
 * Pure resolver, so the rules are testable without React or providers.
 *
 * The roster is the source of truth for WHICH offices exist; RCM only queries
 * roster offices that are also RCM office ids. A voice-only location in the
 * roster is therefore skipped rather than queried and 400'd.
 */
export function resolveRcmOfficeScope(input: {
  /** Current OfficeContext selection: an officeId or the ALL_OFFICES sentinel. */
  selection: string;
  roster: readonly OfficeRosterEntry[];
  loading?: boolean;
  error?: string | null;
}): RcmOfficeScope {
  const { selection, roster, loading = false, error = null } = input;
  const rcmRoster = roster.map((o) => o.officeId).filter(isRcmOfficeId);

  if (selection === ALL_OFFICES) {
    return {
      offices: rcmRoster.filter((o, i) => rcmRoster.indexOf(o) === i),
      isAllOffices: true,
      loading,
      error,
    };
  }

  return {
    offices: isRcmOfficeId(selection) ? [selection] : [],
    isAllOffices: false,
    loading,
    error,
  };
}

/** React binding of resolveRcmOfficeScope over the global OfficeContext. */
export function useRcmOfficeScope(): RcmOfficeScope {
  const { office, offices, loading, error } = useOffice();
  return useMemo(
    () => resolveRcmOfficeScope({ selection: office, roster: offices, loading, error }),
    [office, offices, loading, error],
  );
}
