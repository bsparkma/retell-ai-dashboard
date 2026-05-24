/**
 * Analytics aggregation functions.
 *
 * Pure functions that compute analytics over an array of Call records.
 * No database or file I/O — all data is passed in, making these trivially testable.
 */

import type {
  Call,
  AnalyticsResult,
  CallCountByType,
  CallCountByOutcome,
  DailyCallVolume,
  SentimentDistribution,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the YYYY-MM-DD portion of an ISO-8601 string (UTC). */
export function isoToDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Clamps n to [min, max]. */
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// Core aggregations
// ---------------------------------------------------------------------------

/**
 * Counts calls by tag/disposition.
 * Sorted descending by count.
 */
export function countByTag(calls: Call[]): CallCountByType[] {
  const map = new Map<string, number>();
  for (const c of calls) {
    map.set(c.tag, (map.get(c.tag) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Counts calls by outcome.
 * Sorted descending by count.
 */
export function countByOutcome(calls: Call[]): CallCountByOutcome[] {
  const map = new Map<string, number>();
  for (const c of calls) {
    const key = c.outcome || "Unknown";
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([outcome, count]) => ({ outcome, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Counts calls by office.
 */
export function countByOffice(calls: Call[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const c of calls) {
    const key = c.office || "Unknown";
    map[key] = (map[key] ?? 0) + 1;
  }
  return map;
}

/**
 * Computes sentiment distribution as absolute counts.
 */
export function sentimentDistribution(calls: Call[]): SentimentDistribution {
  let positive = 0;
  let neutral = 0;
  let negative = 0;
  for (const c of calls) {
    if (c.sentiment === "positive") positive++;
    else if (c.sentiment === "negative") negative++;
    else neutral++;
  }
  return { positive, neutral, negative };
}

/**
 * Builds a daily call volume series over the given date range.
 * Fills every day in the range even if it has 0 calls.
 */
export function dailyVolume(
  calls: Call[],
  startDate: string,
  endDate: string
): DailyCallVolume[] {
  // Build a lookup: date → { total, byOffice, byTag }
  const map = new Map<string, DailyCallVolume>();

  for (const c of calls) {
    const date = isoToDate(c.startedAt);
    if (date < startDate || date > endDate) continue;

    if (!map.has(date)) {
      map.set(date, { date, total: 0, byOffice: {}, byTag: {} });
    }
    const entry = map.get(date)!;
    entry.total++;
    entry.byOffice[c.office] = (entry.byOffice[c.office] ?? 0) + 1;
    entry.byTag[c.tag] = (entry.byTag[c.tag] ?? 0) + 1;
  }

  // Enumerate every day in the range
  const result: DailyCallVolume[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  while (cursor <= end) {
    const dateStr = cursor.toISOString().slice(0, 10);
    result.push(
      map.get(dateStr) ?? { date: dateStr, total: 0, byOffice: {}, byTag: {} }
    );
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return result;
}

/**
 * Computes average quality score for a set of calls.
 * Returns 0 if the array is empty.
 */
export function avgQualityScore(calls: Call[]): number {
  if (calls.length === 0) return 0;
  const sum = calls.reduce((acc, c) => acc + c.qualityScore, 0);
  return clamp(Math.round(sum / calls.length), 0, 100);
}

/**
 * Computes commlog status breakdown.
 */
export function commlogStats(calls: Call[]): {
  written: number;
  pending: number;
  failed: number;
} {
  let written = 0;
  let pending = 0;
  let failed = 0;
  for (const c of calls) {
    if (c.commlogStatus === "written") written++;
    else if (c.commlogStatus === "failed") failed++;
    else pending++;
  }
  return { written, pending, failed };
}

/**
 * Filters calls by the provided criteria.
 * All filters are optional and additive (AND logic).
 */
export function filterCalls(
  calls: Call[],
  opts: {
    office?: string;
    startDate?: string;
    endDate?: string;
    tag?: string;
    outcome?: string;
    commlogStatus?: string;
    search?: string;
  }
): Call[] {
  return calls.filter((c) => {
    if (opts.office && c.office !== opts.office) return false;

    if (opts.startDate) {
      const date = isoToDate(c.startedAt);
      if (date < opts.startDate) return false;
    }
    if (opts.endDate) {
      const date = isoToDate(c.startedAt);
      if (date > opts.endDate) return false;
    }

    if (opts.tag && c.tag !== opts.tag) return false;
    if (opts.outcome && c.outcome !== opts.outcome) return false;
    if (opts.commlogStatus && c.commlogStatus !== opts.commlogStatus) return false;

    if (opts.search) {
      const q = opts.search.toLowerCase();
      const haystack = [
        c.callerName,
        c.callerNumber,
        c.office,
        c.tag,
        c.outcome,
        c.summary,
        c.routedTo,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// Full analytics report
// ---------------------------------------------------------------------------

/**
 * Computes the full analytics result for a set of calls and date range.
 * Returns a structured report suitable for direct API response.
 */
export function computeAnalytics(
  calls: Call[],
  startDate: string,
  endDate: string
): AnalyticsResult {
  const days =
    Math.round(
      (new Date(endDate).getTime() - new Date(startDate).getTime()) /
        86_400_000
    ) + 1;

  const totalDuration = calls.reduce((a, c) => a + c.durationSeconds, 0);

  return {
    period: { startDate, endDate, days },
    totalCalls: calls.length,
    byTag: countByTag(calls),
    byOutcome: countByOutcome(calls),
    byOffice: countByOffice(calls),
    dailyVolume: dailyVolume(calls, startDate, endDate),
    sentiment: sentimentDistribution(calls),
    avgQualityScore: avgQualityScore(calls),
    commlogStats: commlogStats(calls),
    avgDurationSeconds: calls.length > 0 ? Math.round(totalDuration / calls.length) : 0,
  };
}
