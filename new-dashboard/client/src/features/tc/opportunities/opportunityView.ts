/**
 * Pure view rules for the Opportunities inbox — sorting and the honest
 * "last synced" sentence. No React, so they are tested directly.
 */
import type { OpportunitySyncState, OpportunityWindow, TcOpportunity } from "./opportunitiesApi";

export type OpportunitySort = "newest" | "value" | "planned" | "lastSeen";

/** Render order of the sort buttons; the first is the default (item 45). */
export const SORT_LABELS: Record<OpportunitySort, string> = {
  newest: "Newest plan",
  value: "Value",
  planned: "Planned date",
  lastSeen: "Last seen",
};

export const DEFAULT_SORT: OpportunitySort = "newest";

/**
 * newest    NEWEST plan first (the age basis — TCs close the freshest first,
 *           then work backward); undated last (item 45, the default)
 * value     highest first
 * planned   OLDEST plan first (longest-waiting treatment at the top); undated last
 * lastSeen  most recently confirmed in Open Dental first
 * Ties fall back to value, then PatNum, so the order is stable.
 */
export function sortOpportunities<T extends TcOpportunity>(rows: readonly T[], sort: OpportunitySort): T[] {
  const byValue = (a: T, b: T) => b.valueCents - a.valueCents || a.odPatientId - b.odPatientId;
  return [...rows].sort((a, b) => {
    if (sort === "newest") {
      const ad = a.newestPlannedDate ?? "";
      const bd = b.newestPlannedDate ?? "";
      if (ad !== bd) return ad < bd ? 1 : -1;
      return byValue(a, b);
    }
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

/**
 * The age chips (item 45, Beau's ruling 2026-10-10): narrow the inbox to plans
 * whose NEWEST procedure is at most N months old. The office window is the
 * widest chip ("All" within the window), so only steps BELOW it are offered.
 */
export const AGE_STEPS = [1, 2, 3, 4, 6, 8, 12, 18] as const;

export interface AgeChip {
  /** null = the office's own window (no maxAgeMonths sent). */
  months: number | null;
  label: string;
}

/**
 * Chips for the offices in view. With one window (one office, or offices that
 * agree) the last chip is labelled with it: "18 mo · All". With differing
 * windows it is just "All" — each office then applies its own.
 */
export function ageChips(officeWindows: readonly number[]): AgeChip[] {
  const distinct = Array.from(new Set(officeWindows));
  const widest = distinct.length ? Math.max(...distinct) : 18;
  const steps: AgeChip[] = AGE_STEPS.filter((n) => n < widest).map((n) => ({ months: n, label: `${n} mo` }));
  const all = distinct.length === 1 ? `${distinct[0]} mo · All` : "All";
  return [...steps, { months: null, label: all }];
}

function monthsText(n: number): string {
  return `${n} month${n === 1 ? "" : "s"}`;
}

/**
 * The read-only line under the tabs: what the list is showing and the office
 * window it sits in. `windows` is one entry per office in view.
 */
export function windowSentence(windows: readonly { officeLabel: string; window: OpportunityWindow }[]): string | null {
  if (windows.length === 0) return null;
  const applied = Array.from(new Set(windows.map((w) => w.window.appliedMonths)));
  const office = Array.from(new Set(windows.map((w) => w.window.officeMonths)));
  if (applied.length === 1 && office.length === 1) {
    const a = applied[0]!;
    const o = office[0]!;
    return a === o
      ? `Showing plans from the last ${monthsText(a)}`
      : `Showing plans from the last ${monthsText(a)} · office window ${monthsText(o)}`;
  }
  return `Showing plans from the last ${windows
    .map((w) => `${monthsText(w.window.appliedMonths)} (${w.officeLabel})`)
    .join(", ")}`;
}
