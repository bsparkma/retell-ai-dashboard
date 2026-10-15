/**
 * The Checkout nav badge and the arrival toast (queue item 50).
 *
 * Polls GET /api/tc/checkout/summary for each office in scope on the repo's
 * existing visible-tab-only cadence (usePolling, 60s) — no new realtime
 * infrastructure. The FIRST answer per office only records what is already
 * waiting, so opening the app never toasts a backlog; after that, a newest
 * handoff this tab has not seen before toasts "<patient> is headed to
 * checkout", and its Open button lands on the Checkout page with that
 * handoff's sidebar open.
 *
 * Item 51 (C3) will route the toast through per-user notification
 * preferences (silent / banner / sound + banner). Today it is always a banner.
 *
 * `enabled` is false until some office in scope answers that checkout is on —
 * an unknown or switched-off office shows no nav item and no badge.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

import { usePolling } from "@/hooks/usePolling";
import { getCheckoutSummary } from "@/features/tc/checkout/checkoutApi";
import type { OfficeId } from "@shared/tc/contract";

export interface CheckoutWatch {
  enabled: boolean;
  waiting: number;
}

export function useCheckoutWatch(offices: readonly OfficeId[]): CheckoutWatch {
  const [, navigate] = useLocation();
  const [state, setState] = useState<CheckoutWatch>({ enabled: false, waiting: 0 });
  const key = [...offices].sort().join("+");
  /** The newest handoff id seen per office; absent = never asked yet. */
  const seen = useRef<Map<OfficeId, string | null>>(new Map());

  useEffect(() => {
    seen.current = new Map();
    setState({ enabled: false, waiting: 0 });
  }, [key]);

  const tick = useCallback(() => {
    if (offices.length === 0) return;
    const asked = key;
    void Promise.allSettled(offices.map((o) => getCheckoutSummary(o))).then((results) => {
      if (asked !== key) return;
      let enabled = false;
      let waiting = 0;
      results.forEach((r, i) => {
        if (r.status !== "fulfilled") return;
        const office = offices[i] as OfficeId;
        const s = r.value;
        if (!s.enabled) return;
        enabled = true;
        waiting += s.waiting;
        const newestId = s.newest?.handoffId ?? null;
        const known = seen.current.has(office);
        const before = seen.current.get(office) ?? null;
        seen.current.set(office, newestId);
        if (known && s.newest && newestId !== before) {
          const target = `/tc/checkout?office=${office}&handoff=${s.newest.handoffId}`;
          toast(`${s.newest.patientName} is headed to checkout`, {
            action: { label: "Open", onClick: () => navigate(target) },
          });
        }
      });
      setState({ enabled, waiting });
    });
    // `offices` is described by `key`.
  }, [key, navigate]);

  usePolling(tick, offices.length > 0 ? 60_000 : null);

  return state;
}
