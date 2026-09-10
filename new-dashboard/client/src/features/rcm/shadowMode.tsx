/**
 * IS POSTING SWITCHED OFF? — asked once, answered everywhere.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY A CONTEXT AND NOT A THIRD COPY OF THE SAME FETCH
 * ═════════════════════════════════════════════════════════════════════════════
 * Three screens needed this fact and two of them asked for it themselves.
 * `RcmToday` folded `postingEnabled && !drainEnabled` into its own model;
 * `RemittanceDetail` ran its own `listPostingQueue(office, { limit: 1 })` for
 * the same two flags; and the Checks list — the screen a biller spends her
 * morning in — never asked at all, so its *Waiting on* column could not say
 * "posting is switched off" and quietly told her a check was hers to move when
 * it was not.
 *
 * A fact that three screens compute and one forgets is the drift `waitingOn.ts`
 * and `worklist.ts` were both written to end. So it is read here, once per
 * office in scope, and handed out.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PREDICATE IS THE ONE THE OTHER SCREENS ALREADY USED
 * ─────────────────────────────────────────────────────────────────────────────
 *   shadow  ⇔  postingEnabled && !drainEnabled
 *
 * BOTH halves matter and they are not the same news. `postingEnabled: false`
 * means this practice has never been validated for posting at all — not "in
 * shadow mode", not set up, and its postings say so per row. `drainEnabled:
 * false` means somebody has flipped one switch and an administrator can flip it
 * back. Showing the shadow pill for the first would offer a remedy that does
 * not apply, so a practice that is merely unvalidated reads as NOT in shadow —
 * exactly as `RcmToday` and `RemittanceDetail` already had it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `undefined` IS A THIRD ANSWER, AND IT IS THE DEFAULT
 * ─────────────────────────────────────────────────────────────────────────────
 * An office we have not heard back about — still loading, or the read failed —
 * is `undefined`, never `false`. `false` is a CLAIM: it means "posting is on,
 * this really will reach a chart". Rendering it from a failed fetch would be
 * the screen asserting something nobody told it, and the direction of that lie
 * is the expensive one. Every consumer treats `undefined` as "say nothing":
 * the pill does not render, and `waitingFor` is passed no `shadowMode` at all,
 * which its own contract already defines as "this screen did not ask".
 *
 * NO NEW ENDPOINT. `listPostingQueue` with `limit: 1` is the read
 * `RemittanceDetail` was already making for exactly these two flags — the rows
 * are not wanted, they belong to the posting history screen.
 */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { listPostingQueue, type RcmOfficeId } from "@/features/rcm/api";
import { useRcmOfficeScope } from "@/features/rcm/officeScope";

export interface RcmShadowState {
  /**
   * Per office: `true` switched off, `false` posting is live, `undefined` we
   * do not know. Read it with `shadowFor()` rather than indexing directly.
   */
  byOffice: Readonly<Partial<Record<RcmOfficeId, boolean>>>;
  /**
   * Is ANY office in scope switched off? Drives the one pill in the header,
   * which is global chrome and cannot be per-office.
   *
   * `true` from a single office is correct and deliberate: with the picker on
   * "All Offices" the pill's claim is "something on this screen will not
   * reach a chart", and that is true the moment one practice is switched off.
   */
  any: boolean;
}

const EMPTY: RcmShadowState = { byOffice: {}, any: false };

const RcmShadowContext = createContext<RcmShadowState>(EMPTY);

/** The switch for one office. `undefined` means nobody has told us. */
export function shadowFor(
  state: RcmShadowState,
  office: RcmOfficeId | null | undefined,
): boolean | undefined {
  return office ? state.byOffice[office] : undefined;
}

/**
 * Read the switch. Safe outside the provider — every screen that is not an RCM
 * screen gets `EMPTY`, which says nothing about anything.
 */
export function useRcmShadow(): RcmShadowState {
  return useContext(RcmShadowContext);
}

export function RcmShadowProvider({ children }: { children: ReactNode }) {
  const scope = useRcmOfficeScope();
  const [byOffice, setByOffice] = useState<Partial<Record<RcmOfficeId, boolean>>>({});

  // The offices in scope as a stable string, so the effect below re-runs when
  // the PICKER changes and not on every render of a new array with the same
  // contents.
  const key = scope.offices.join(",");

  useEffect(() => {
    if (scope.offices.length === 0) return;
    let cancelled = false;
    for (const office of scope.offices) {
      listPostingQueue(office, { limit: 1 }).then(
        (q) => {
          if (cancelled) return;
          setByOffice((prev) => ({ ...prev, [office]: q.postingEnabled && !q.drainEnabled }));
        },
        () => {
          /*
           * A FAILED READ LEAVES THE OFFICE UNKNOWN.
           *
           * Deliberately not `false`. This read is a courtesy — nothing on any
           * screen is gated on it — so a 403 for a role that cannot see the
           * posting queue, or an outage, must cost the reader a pill and never
           * a wrong claim about where their work is going.
           */
          if (cancelled) return;
          setByOffice((prev) => {
            if (!(office in prev)) return prev;
            const next = { ...prev };
            delete next[office];
            return next;
          });
        },
      );
    }
    return () => {
      cancelled = true;
    };
    // Keyed on `key`, not on `scope.offices`: the array identity changes every
    // render and would re-fetch both practices on each one. (This repo has no
    // eslint, so the exhaustive-deps rule is a convention here, not a check.)
  }, [key]);

  const value = useMemo<RcmShadowState>(
    () => ({
      byOffice,
      // Only offices currently IN SCOPE count. A stale `true` for a practice
      // the picker has moved away from would keep a pill on a screen that is
      // not showing that practice's work.
      any: scope.offices.some((o) => byOffice[o] === true),
    }),
    [byOffice, key, scope.offices],
  );

  return <RcmShadowContext.Provider value={value}>{children}</RcmShadowContext.Provider>;
}
