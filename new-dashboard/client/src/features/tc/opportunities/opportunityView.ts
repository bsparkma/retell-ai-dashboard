/**
 * Pure view rules for the Opportunities inbox — sorting and the honest
 * "last synced" sentence. No React, so they are tested directly.
 */
import type { OpportunitySyncState, TcOpportunity } from "./opportunitiesApi";

export type OpportunitySort = "value" | "planned" | "lastSeen";

export const SORT_LABELS: Record<OpportunitySort, string> = {
  value: "Value",
  planned: "Planned date",
  lastSeen: "Last seen",
};

/**
 * value     highest first
 * planned   OLDEST plan first (longest-waiting treatment at the top); undated last
 * lastSeen  most recently confirmed in Open Dental first
 * Ties fall back to value, then PatNum, so the order is stable.
 */
export function sortOpportunities<T extends TcOpportunity>(rows: readonly T[], sort: OpportunitySort): T[] {
  const byValue = (a: T, b: T) => b.valueCents - a.valueCents || a.odPatientId - b.odPatientId;
  return [...rows].sort((a, b) => {
    if (sort === "planned") {
      const ad = a.plannedDate ?? "9999-12-31";
      const bd = b.plannedDate ?? "9999-12-31";
      if (ad !== bd) return ad < bd ? -1 : 1;
      return byValue(a, b);
    }
    if (sort === "lastSeen") {
      const as = a.lastSeenAt ?? "";
      const bs = b.lastSeenAt ?? "";
      if (as !== bs) return as < bs ? 1 : -1;
      return byValue(a, b);
    }
    return byValue(a, b);
  });
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * The sentence under the header, per office. Never claims more freshness than
 * the last COMPLETED sweep; a failed or partial attempt after it is said out
 * loud, with what the page is still showing.
 */
export function syncSentence(sync: OpportunitySyncState | null): { text: string; tone: "ok" | "warn" | "muted" } {
  if (!sync || (!sync.lastSyncedAt && !sync.lastAttemptAt)) {
    return {
      text: "Not synced yet — the nightly Open Dental sync has not run for this office.",
      tone: "muted",
    };
  }
  const pending =
    sync.namesPending && sync.namesPending > 0
      ? ` · ${sync.namesPending} name${sync.namesPending === 1 ? "" : "s"} still to read`
      : "";
  if (sync.lastStatus === "ok" && sync.lastSyncedAt) {
    return { text: `Synced from Open Dental ${when(sync.lastSyncedAt)}${pending}`, tone: "ok" };
  }
  const attempted = sync.lastAttemptAt ? when(sync.lastAttemptAt) : "recently";
  const showing = sync.lastSyncedAt
    ? `showing the sync from ${when(sync.lastSyncedAt)}`
    : "nothing has synced successfully yet";
  return {
    text: `Last sync (${attempted}) did not finish — ${showing}${pending}`,
    tone: "warn",
  };
}

/** "Aug 15, 2026" for a YYYY-MM-DD, without a timezone shift. */
export function formatPlannedDate(d: string | null): string {
  if (!d) return "Undated";
  const [y, m, day] = d.split("-").map(Number);
  if (!y || !m || !day) return d;
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
