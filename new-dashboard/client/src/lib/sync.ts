/**
 * Copy and formatting for the worklist's "Sync now" button.
 *
 * Kept out of the component because this is where the button stops lying: the old
 * Retell-only sync reported a flat "Sync complete" no matter what happened, so a staff
 * call that never arrived looked like a successful pull. Every branch below names a
 * source and says what it actually did.
 */

import type { SyncNowResponse, SyncSourceResult } from "@/lib/api";

/**
 * Mirrors MANUAL_SYNC_COOLDOWN_MS in services/manualSyncThrottle.js. Used only to render
 * "Synced Ns ago" — the server is the authority on whether a sync is allowed, so a drift
 * here costs a slightly-off label, never a wrong decision.
 */
export const SYNC_COOLDOWN_SECONDS = 60;

/** Human label for a source in toast copy. */
const SOURCE_LABEL = { mango: "Mango", retell: "Retell" } as const;
type SourceKey = keyof typeof SOURCE_LABEL;

/** New calls this source brought in. Retell counts `added`, Mango counts `imported`. */
function newCount(key: SourceKey, r: SyncSourceResult): number {
  if (r.status !== "ok") return 0;
  return (key === "mango" ? r.imported : r.added) ?? 0;
}

/** What the toast should say, and whether it's a failure. */
export interface SyncToast {
  kind: "success" | "error";
  message: string;
}

/**
 * Build the post-sync toast from the per-source outcomes.
 *
 * Rules (spec, 2026-08-11):
 *  - any source errored → ONE error toast naming only the source(s) that failed;
 *  - Mango 'already_running' → say the autosync has it, don't imply a failure;
 *  - Mango 'off' → say ingestion is off in this environment. Only environments where
 *    that is true can produce it, and silence about "we didn't pull Mango" is exactly
 *    the dishonesty this button exists to remove;
 *  - otherwise → per-source new-call counts.
 */
export function syncToast(res: SyncNowResponse): SyncToast {
  const sources: [SourceKey, SyncSourceResult][] = [
    ["mango", res.mango],
    ["retell", res.retell],
  ];

  const failed = sources.filter(([, r]) => r.status === "error");
  if (failed.length > 0) {
    return {
      kind: "error",
      message: failed
        .map(([key, r]) => {
          const detail = r.status === "error" && r.message ? `: ${r.message}` : "";
          return `${SOURCE_LABEL[key]} sync failed${detail}`;
        })
        .join(" · "),
    };
  }

  const parts: string[] = [];
  for (const [key, r] of sources) {
    if (r.status === "already_running") {
      parts.push(`${SOURCE_LABEL[key]}: autosync already running — new calls will appear shortly`);
    } else if (r.status === "off") {
      parts.push(`${SOURCE_LABEL[key]} ingestion is off in this environment`);
    } else if (r.status === "ok" && newCount(key, r) > 0) {
      parts.push(`${SOURCE_LABEL[key]}: ${newCount(key, r)} new`);
    }
  }

  // Every source was fine and none of them had anything for us. Saying so beats a
  // per-source "0 new · 0 new", and beats an unqualified "Sync complete".
  if (parts.length === 0) return { kind: "success", message: "Up to date — no new calls" };

  return { kind: "success", message: parts.join(" · ") };
}

/**
 * A clock time in the viewer's timezone — the containers and the front desk both run
 * America/Chicago, so formatting the ISO string locally gives office time without
 * hard-coding a zone into the bundle.
 */
function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * The freshness caption, e.g. "Last synced 12:19 PM · next auto 1:15 PM".
 * Returns "" when neither time is known — better no caption than "Last synced never".
 */
export function syncCaption(lastSyncedAt: string | null, nextAutoSync: string | null): string {
  const parts: string[] = [];
  const last = lastSyncedAt ? clock(lastSyncedAt) : "";
  const next = nextAutoSync ? clock(nextAutoSync) : "";
  if (last) parts.push(`Last synced ${last}`);
  if (next) parts.push(`next auto ${next}`);
  return parts.join(" · ");
}
