/**
 * Is referrals switched on for any office in scope? (queue item 56, R6) —
 * the gate on the "Referrals" hub nav item for tc.full (a signer's gate is
 * `signoff.enabled`, from useSignoffWatch). Asks GET /api/tc/referrals/status (never refused) once
 * per change of scope; the switch is a platform setting, not a live count, so
 * it is not polled. Reads false until an office answers `enabled: true`, so a
 * dark office never flashes the item. The caller passes offices only for
 * someone holding tc.full.
 */
import { useEffect, useState } from "react";

import { getReferralsStatus } from "@/features/tc/referrals/referralsApi";
import type { OfficeId } from "@shared/tc/contract";

export function useReferralsOn(offices: readonly OfficeId[]): boolean {
  const [on, setOn] = useState(false);
  const key = [...offices].sort().join("+");

  useEffect(() => {
    setOn(false);
    if (offices.length === 0) return;
    let cancelled = false;
    void Promise.allSettled(offices.map((o) => getReferralsStatus(o))).then((results) => {
      if (cancelled) return;
      setOn(results.some((r) => r.status === "fulfilled" && r.value.enabled));
    });
    return () => {
      cancelled = true;
    };
    // `offices` is described by `key`.
  }, [key]);

  return on;
}
