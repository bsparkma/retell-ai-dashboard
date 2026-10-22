/**
 * The Checkout nav badge and the arrival toast (queue item 50).
 *
 * Polls GET /api/tc/checkout/summary for each office in scope on the repo's
 * existing visible-tab-only cadence (usePolling, 60s) — no new realtime
 * infrastructure. The FIRST answer per office only records what is already
 * waiting, so opening the app never toasts a backlog; after that, a newest
 * handoff CREATED LATER than anything this tab has seen for that office
 * toasts "<patient> is headed to checkout", and its Open button lands on the
 * Checkout page with that handoff's sidebar open. Comparing arrival times —
 * not ids — is what keeps answering the top row from announcing the OLDER
 * patient beneath it as a new arrival.
 *
 * ITEM 51: the arrival alert obeys the person's notification preference for
 * `checkout_handoff`, read each tick from /api/tc/notification-prefs:
 *   silent        the badge updates; no banner, no sound
 *   banner        the banner (the item-50 behaviour, and the default)
 *   sound_banner  the banner plus a short chime
 * A preference that cannot be read falls back to `banner` — the alert is
 * never lost because the preference was.
 *
 * `enabled` is false until some office in scope answers that checkout is on —
 * an unknown or switched-off office shows no nav item and no badge.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

import { usePolling } from "@/hooks/usePolling";
import { getCheckoutSummary } from "@/features/tc/checkout/checkoutApi";
import { getNotificationPrefs } from "@/features/tc/notifications/notificationsApi";
import { playChime } from "@/features/tc/notifications/chime";
import { DEFAULT_NOTIFICATION_LEVEL, type TcNotificationLevel } from "@shared/tc/notifications";
import type { OfficeId } from "@shared/tc/contract";

export interface CheckoutWatch {
  enabled: boolean;
  waiting: number;
}

export function useCheckoutWatch(offices: readonly OfficeId[]): CheckoutWatch {
  const [, navigate] = useLocation();
  const [state, setState] = useState<CheckoutWatch>({ enabled: false, waiting: 0 });
  const key = [...offices].sort().join("+");
  /**
   * The latest arrival (createdAt) seen per office; absent = never asked yet,
   * "" = asked, and nobody was waiting.
   */
  const seen = useRef<Map<OfficeId, string>>(new Map());
  /** The scope the CURRENT render is for — a response for an older scope is dropped. */
  const currentKey = useRef(key);

  useEffect(() => {
    currentKey.current = key;
    seen.current = new Map();
    setState({ enabled: false, waiting: 0 });
  }, [key]);

  const tick = useCallback(() => {
    if (offices.length === 0) return;
    const asked = key;
    void Promise.all([
      Promise.allSettled(offices.map((o) => getCheckoutSummary(o))),
      Promise.allSettled(offices.map((o) => getNotificationPrefs(o))),
    ]).then(([results, prefs]) => {
      if (asked !== currentKey.current) return;
      let chime = false;
      let enabled = false;
      let waiting = 0;
      results.forEach((r, i) => {
        if (r.status !== "fulfilled") return;
        const office = offices[i] as OfficeId;
        const s = r.value;
        if (!s.enabled) return;
        enabled = true;
        waiting += s.waiting;
        const known = seen.current.has(office);
        const latestSeen = seen.current.get(office) ?? "";
        const arrival = s.newest?.createdAt ?? "";
        if (arrival > latestSeen) seen.current.set(office, arrival);
        else if (!known) seen.current.set(office, latestSeen);
        if (known && s.newest && arrival > latestSeen) {
          const p = prefs[i];
          const level: TcNotificationLevel =
            p && p.status === "fulfilled"
              ? (p.value.events.find((e) => e.event === "checkout_handoff")?.level ?? DEFAULT_NOTIFICATION_LEVEL)
              : DEFAULT_NOTIFICATION_LEVEL;
          if (level === "silent") return; // the badge below still updates
          const target = `/tc/checkout?office=${office}&handoff=${s.newest.handoffId}`;
          toast(`${s.newest.patientName} is headed to checkout`, {
            action: { label: "Open", onClick: () => navigate(target) },
          });
          if (level === "sound_banner") chime = true;
        }
      });
      // One chime per tick, however many offices had an arrival.
      if (chime) playChime();
      setState({ enabled, waiting });
    });
    // `offices` is described by `key`.
  }, [key, navigate]);

  usePolling(tick, offices.length > 0 ? 60_000 : null);

  return state;
}
