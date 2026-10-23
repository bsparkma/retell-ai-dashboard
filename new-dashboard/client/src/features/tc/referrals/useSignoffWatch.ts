/**
 * The "Awaiting sign-off" nav badge and the arrival alert (queue item 53).
 *
 * The same shape as useCheckoutWatch (item 50), for referrals: polls
 * GET /api/tc/referrals/signoff/summary for each office in scope on the
 * existing visible-tab cadence (usePolling, 60s) — no new realtime machinery.
 * The FIRST answer per office only records what is already waiting, so
 * opening the app never alerts a backlog; after that, a referral that reached
 * pending sign-off LATER than anything seen alerts "<patient>'s referral is
 * waiting for your sign-off".
 *
 * The alert obeys the person's `referral_signoff` preference (item 51):
 * silent → badge only, banner → toast, sound_banner → toast + chime. The
 * preference route is a tc.full surface, so a `doctor` (who holds only the
 * sign-off) cannot read it: `canReadPrefs` false skips the call (rather than
 * a 403 every minute) and the built-in `banner` applies — the alert is never
 * lost because the preference was.
 *
 * Scope is the caller's: the layout passes offices only for someone holding
 * tc.referral_signoff. `enabled` stays false until an office in scope answers
 * that referrals is on.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

import { usePolling } from "@/hooks/usePolling";
import { getSignoffSummary } from "@/features/tc/referrals/referralsApi";
import { getNotificationPrefs } from "@/features/tc/notifications/notificationsApi";
import { playChime } from "@/features/tc/notifications/chime";
import { DEFAULT_NOTIFICATION_LEVEL, type TcNotificationLevel } from "@shared/tc/notifications";
import type { OfficeId } from "@shared/tc/contract";

export interface SignoffWatch {
  enabled: boolean;
  waiting: number;
}

export function useSignoffWatch(offices: readonly OfficeId[], canReadPrefs = true): SignoffWatch {
  const [, navigate] = useLocation();
  const [state, setState] = useState<SignoffWatch>({ enabled: false, waiting: 0 });
  const key = [...offices].sort().join("+");
  /** The latest arrival seen per office; absent = never asked, "" = nothing waiting. */
  const seen = useRef<Map<OfficeId, string>>(new Map());
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
      Promise.allSettled(offices.map((o) => getSignoffSummary(o))),
      Promise.allSettled(
        offices.map((o) => (canReadPrefs ? getNotificationPrefs(o) : Promise.reject(new Error("no tc.full")))),
      ),
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
        const arrival = s.newest?.at ?? "";
        if (arrival > latestSeen) seen.current.set(office, arrival);
        else if (!known) seen.current.set(office, latestSeen);
        if (known && s.newest && arrival > latestSeen) {
          const p = prefs[i];
          const level: TcNotificationLevel =
            p && p.status === "fulfilled"
              ? (p.value.events.find((e) => e.event === "referral_signoff")?.level ?? DEFAULT_NOTIFICATION_LEVEL)
              : DEFAULT_NOTIFICATION_LEVEL;
          if (level === "silent") return; // the badge below still updates
          // F5: the page opens this referral, as Checkout opens a handoff's sidebar.
          const target = `/tc/referrals/signoff?office=${office}&referral=${s.newest.referralId}`;
          toast(`${s.newest.patientName}'s referral is waiting for your sign-off`, {
            action: { label: "Open", onClick: () => navigate(target) },
          });
          if (level === "sound_banner") chime = true;
        }
      });
      if (chime) playChime();
      setState({ enabled, waiting });
    });
    // `offices` is described by `key`.
  }, [key, navigate, canReadPrefs]);

  usePolling(tick, offices.length > 0 ? 60_000 : null);

  return state;
}
