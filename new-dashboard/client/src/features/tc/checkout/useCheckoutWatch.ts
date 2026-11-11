/**
 * The Checkout nav badge and the arrival BANNER (queue item 50; prominence
 * ruling with CO-6/CO-7).
 *
 * Polls GET /api/tc/checkout/summary for each office in scope on the repo's
 * existing visible-tab-only cadence (usePolling, 60s) — no new realtime
 * infrastructure. The FIRST answer per office only records what is already
 * waiting, so opening the app never announces a backlog; after that, a newest
 * handoff CREATED LATER than anything this tab has seen for that office
 * becomes an ARRIVAL: "<patient> is headed to checkout", whose Open lands on
 * the Checkout page with that handoff's sidebar open. Comparing arrival times —
 * not ids — is what keeps answering the top row from announcing the OLDER
 * patient beneath it as a new arrival.
 *
 * PROMINENCE (Beau's ruling): an arrival is no longer a toast that times out.
 * It is held in `arrivals` until the person ACKNOWLEDGES it (or opens it), and
 * the layout draws it as a persistent high-contrast banner, app-wide
 * (features/tc/checkout/CheckoutArrivalBanner.tsx). Sound stays OPT-IN: only
 * `sound_banner` chimes; the default and `banner` are silent.
 * Held in this tab's memory only — never in browser storage, because it
 * carries a patient's name — so a reload clears it; the badge still counts.
 *
 * ITEM 51: the arrival obeys the person's notification preference for
 * `checkout_handoff`, read each tick from /api/tc/notification-prefs:
 *   silent        the badge updates; no banner
 *   banner        the banner (the default)
 *   sound_banner  the banner plus a short chime (the person opted in)
 * A preference that cannot be read falls back to `banner` — the alert is
 * never lost because the preference was.
 *
 * `enabled` is false until some office in scope answers that checkout is on —
 * an unknown or switched-off office shows no nav item and no badge.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { usePolling } from "@/hooks/usePolling";
import { getCheckoutSummary } from "@/features/tc/checkout/checkoutApi";
import { getNotificationPrefs } from "@/features/tc/notifications/notificationsApi";
import { playChime } from "@/features/tc/notifications/chime";
import { DEFAULT_NOTIFICATION_LEVEL, type TcNotificationLevel } from "@shared/tc/notifications";
import type { OfficeId } from "@shared/tc/contract";

/** One unacknowledged arrival, as the banner shows it. */
export interface CheckoutArrival {
  office: OfficeId;
  handoffId: string;
  patientName: string;
  createdAt: string;
  /** Where Open goes: the Checkout page with this handoff's sidebar open. */
  href: string;
}

export interface CheckoutWatch {
  enabled: boolean;
  waiting: number;
  /** Unacknowledged arrivals, oldest first. */
  arrivals: CheckoutArrival[];
  /** Acknowledge one arrival (its banner line goes away), or every one with no id. */
  acknowledge: (handoffId?: string) => void;
}

/** Where an arrival's Open lands. */
export function checkoutArrivalHref(office: OfficeId, handoffId: string): string {
  return `/tc/checkout?office=${office}&handoff=${handoffId}`;
}

export function useCheckoutWatch(offices: readonly OfficeId[]): CheckoutWatch {
  const [state, setState] = useState<{ enabled: boolean; waiting: number }>({ enabled: false, waiting: 0 });
  const [arrivals, setArrivals] = useState<CheckoutArrival[]>([]);
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
    setArrivals([]);
  }, [key]);

  const acknowledge = useCallback((handoffId?: string) => {
    setArrivals((prev) => (handoffId === undefined ? [] : prev.filter((a) => a.handoffId !== handoffId)));
  }, []);

  const tick = useCallback(() => {
    if (offices.length === 0) return;
    const asked = key;
    void Promise.all([
      Promise.allSettled(offices.map((o) => getCheckoutSummary(o))),
      Promise.allSettled(offices.map((o) => getNotificationPrefs(o))),
    ]).then(([results, prefs]) => {
      if (asked !== currentKey.current) return;
      const fresh: CheckoutArrival[] = [];
      let enabled = false;
      let waiting = 0;
      let chime = false;
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
          if (level === "sound_banner") chime = true;
          fresh.push({
            office,
            handoffId: s.newest.handoffId,
            patientName: s.newest.patientName,
            createdAt: s.newest.createdAt,
            href: checkoutArrivalHref(office, s.newest.handoffId),
          });
        }
      });
      // One chime per tick, however many offices had an arrival.
      if (chime) playChime();
      if (fresh.length > 0) {
        setArrivals((prev) => [...prev, ...fresh.filter((f) => !prev.some((p) => p.handoffId === f.handoffId))]);
      }
      setState({ enabled, waiting });
    });
    // `offices` is described by `key`.
  }, [key]);

  usePolling(tick, offices.length > 0 ? 60_000 : null);

  return { ...state, arrivals, acknowledge };
}
