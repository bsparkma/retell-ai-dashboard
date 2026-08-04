/**
 * Debounced, office-scoped case search for the TC command palette.
 *
 * ENHANCEMENT — beyond DentaFlow parity. The legacy GlobalSearch filtered an
 * in-memory mock store synchronously with no debounce and no failure state;
 * here every keystroke burst resolves against the real office-scoped API.
 *
 * Scope: it searches whatever the TC office scope currently covers — one
 * office, or every TC office when the picker is on "All Offices" — using the
 * same fan-out the rest of the module uses (features/tc/officeScope.ts). No
 * new backend route: /api/tc/cases has no text-search parameter, so the
 * palette fetches the office-scoped list(s) and matches in matchCases.ts.
 *
 * Honesty rules baked in:
 *  - a fan-out where EVERY office failed sets `error` and clears results — a
 *    failed search is never rendered as "no matches"
 *  - a partial fan-out shows what loaded plus a `notice` naming what didn't
 *  - stale responses are dropped by sequence number, so a slow early request
 *    can't overwrite the results of the query the user is actually looking at
 *  - below MIN_QUERY_LENGTH nothing is fetched and nothing is claimed
 */
import { useEffect, useRef, useState } from "react";
import type { OfficeId } from "@shared/tc/contract";
import { listCases, tcErrorMessage } from "../api";
import {
  fanOutOfficeRows,
  hardErrorMessage,
  officeScopeKey,
  partialNotice,
} from "../officeScope";
import { MIN_QUERY_LENGTH, matchCases, normalizeQuery } from "./matchCases";
import type { CaseSearchResult } from "./matchCases";

/** Keystroke settle time before a request goes out. */
export const SEARCH_DEBOUNCE_MS = 250;

export interface TcCaseSearchState {
  results: CaseSearchResult[];
  loading: boolean;
  /** Set only when every office in scope failed. */
  error: string | null;
  /** Set when some offices loaded and others didn't. */
  notice: string | null;
  /** True once a query long enough to search has been resolved or rejected. */
  searched: boolean;
}

const IDLE: TcCaseSearchState = {
  results: [],
  loading: false,
  error: null,
  notice: null,
  searched: false,
};

export function useTcCaseSearch(
  offices: readonly OfficeId[],
  rawQuery: string,
  /** Skip work entirely while the palette is closed. */
  enabled = true,
): TcCaseSearchState {
  const [state, setState] = useState<TcCaseSearchState>(IDLE);
  // Monotonic request id — only the newest request may write state.
  const seqRef = useRef(0);
  // Depend on the scope's identity, not the array's, so a re-rendered parent
  // handing back an equal-but-new array can't retrigger the search. The array
  // itself is read through a ref so it stays out of the dependency list.
  const scopeKey = officeScopeKey(offices);
  const officesRef = useRef<readonly OfficeId[]>(offices);
  officesRef.current = offices;

  useEffect(() => {
    const query = normalizeQuery(rawQuery);
    const scopeOffices = officesRef.current;
    if (!enabled || scopeOffices.length === 0 || query.length < MIN_QUERY_LENGTH) {
      seqRef.current += 1; // invalidate anything in flight
      setState(IDLE);
      return;
    }

    setState((prev) => ({ ...prev, loading: true, error: null, notice: null }));
    const seq = (seqRef.current += 1);
    const timer = setTimeout(() => {
      // fanOutOfficeRows captures per-office rejections itself; the catch is
      // the belt-and-braces path so a throw can't leave a permanent spinner.
      fanOutOfficeRows(scopeOffices, listCases)
        .then((fan) => {
          if (seqRef.current !== seq) return; // stale — a newer query won
          const failure = hardErrorMessage(fan);
          setState({
            results: failure ? [] : matchCases(fan.rows, query),
            loading: false,
            error: failure,
            notice: partialNotice(fan),
            searched: true,
          });
        })
        .catch((e: unknown) => {
          if (seqRef.current !== seq) return;
          setState({
            results: [],
            loading: false,
            error: tcErrorMessage(e),
            notice: null,
            searched: true,
          });
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [scopeKey, rawQuery, enabled]);

  return state;
}
