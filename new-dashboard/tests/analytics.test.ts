/**
 * Tests for analytics aggregation functions.
 *
 * Covers:
 * - countByTag
 * - countByOutcome
 * - countByOffice
 * - sentimentDistribution
 * - dailyVolume
 * - avgQualityScore
 * - commlogStats
 * - filterCalls
 * - computeAnalytics (integration of all)
 */

import { describe, it, expect } from "vitest";
import {
  countByTag,
  countByOutcome,
  countByOffice,
  sentimentDistribution,
  dailyVolume,
  avgQualityScore,
  commlogStats,
  filterCalls,
  computeAnalytics,
  isoToDate,
} from "../server/lib/analytics.js";
import type { Call } from "../server/lib/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCall(overrides: Partial<Call>): Call {
  return {
    id: "call_test_001",
    startedAt: "2026-05-10T10:00:00.000Z",
    endedAt: "2026-05-10T10:02:00.000Z",
    durationSeconds: 120,
    callerNumber: "+16025550100",
    callerName: "Test Caller",
    office: "Downtown Dental",
    toNumber: "+16025550101",
    tag: "appointment_scheduled",
    routedTo: "Rover (AI)",
    transcript: "",
    transcriptObject: [],
    summary: "Test summary",
    outcome: "Appointment scheduled",
    sentiment: "positive",
    qualityScore: 80,
    recordingUrl: "",
    isEmergency: false,
    commlogStatus: "written",
    commlogWrittenAt: "2026-05-10T10:05:00.000Z",
    commlogError: null,
    retellCallId: "retell_001",
    ingestedAt: "2026-05-10T10:00:01.000Z",
    ...overrides,
  };
}

/** Creates n calls with sequential IDs and staggered timestamps */
function makeCalls(n: number, overrides: Partial<Call> = {}): Call[] {
  return Array.from({ length: n }, (_, i) =>
    makeCall({ id: `call_test_${String(i + 1).padStart(3, "0")}`, ...overrides })
  );
}

const FIXTURE_CALLS: Call[] = [
  makeCall({ id: "c1", office: "Downtown Dental", tag: "appointment_scheduled", outcome: "Appointment scheduled", sentiment: "positive", qualityScore: 90, commlogStatus: "written", startedAt: "2026-05-10T10:00:00Z" }),
  makeCall({ id: "c2", office: "Downtown Dental", tag: "emergency", outcome: "Escalated to staff", sentiment: "negative", qualityScore: 40, commlogStatus: "pending", startedAt: "2026-05-10T11:00:00Z" }),
  makeCall({ id: "c3", office: "Scottsdale North", tag: "appointment_scheduled", outcome: "Appointment scheduled", sentiment: "positive", qualityScore: 85, commlogStatus: "written", startedAt: "2026-05-11T09:00:00Z" }),
  makeCall({ id: "c4", office: "Scottsdale North", tag: "voicemail", outcome: "Voicemail left", sentiment: "neutral", qualityScore: 50, commlogStatus: "failed", startedAt: "2026-05-11T14:00:00Z" }),
  makeCall({ id: "c5", office: "Mesa East", tag: "billing_inquiry", outcome: "Billing inquiry handled", sentiment: "neutral", qualityScore: 70, commlogStatus: "pending", startedAt: "2026-05-12T10:00:00Z" }),
];

// ---------------------------------------------------------------------------
// isoToDate
// ---------------------------------------------------------------------------

describe("isoToDate", () => {
  it("extracts date portion from ISO string", () => {
    expect(isoToDate("2026-05-10T10:00:00.000Z")).toBe("2026-05-10");
  });

  it("handles midnight timestamp", () => {
    expect(isoToDate("2026-01-01T00:00:00Z")).toBe("2026-01-01");
  });
});

// ---------------------------------------------------------------------------
// countByTag
// ---------------------------------------------------------------------------

describe("countByTag", () => {
  it("counts calls by tag", () => {
    const result = countByTag(FIXTURE_CALLS);
    const scheduled = result.find((r) => r.tag === "appointment_scheduled");
    expect(scheduled?.count).toBe(2);
  });

  it("returns results sorted descending by count", () => {
    const result = countByTag(FIXTURE_CALLS);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1]!.count).toBeGreaterThanOrEqual(result[i]!.count);
    }
  });

  it("returns empty array for no calls", () => {
    expect(countByTag([])).toEqual([]);
  });

  it("counts all distinct tags", () => {
    const result = countByTag(FIXTURE_CALLS);
    const tags = result.map((r) => r.tag);
    expect(tags).toContain("appointment_scheduled");
    expect(tags).toContain("emergency");
    expect(tags).toContain("voicemail");
    expect(tags).toContain("billing_inquiry");
    expect(result).toHaveLength(4);
  });

  it("handles calls with repeated tags", () => {
    const calls = makeCalls(5, { tag: "completed" });
    const result = countByTag(calls);
    expect(result).toHaveLength(1);
    expect(result[0]!.count).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// countByOutcome
// ---------------------------------------------------------------------------

describe("countByOutcome", () => {
  it("counts calls by outcome", () => {
    const result = countByOutcome(FIXTURE_CALLS);
    const scheduled = result.find((r) => r.outcome === "Appointment scheduled");
    expect(scheduled?.count).toBe(2);
  });

  it("uses 'Unknown' for empty outcome", () => {
    const calls = [makeCall({ outcome: "" })];
    const result = countByOutcome(calls);
    expect(result[0]?.outcome).toBe("Unknown");
  });

  it("returns empty array for no calls", () => {
    expect(countByOutcome([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// countByOffice
// ---------------------------------------------------------------------------

describe("countByOffice", () => {
  it("counts calls by office", () => {
    const result = countByOffice(FIXTURE_CALLS);
    expect(result["Downtown Dental"]).toBe(2);
    expect(result["Scottsdale North"]).toBe(2);
    expect(result["Mesa East"]).toBe(1);
  });

  it("returns empty object for no calls", () => {
    expect(countByOffice([])).toEqual({});
  });

  it("uses 'Unknown' for missing office", () => {
    const calls = [makeCall({ office: "" })];
    const result = countByOffice(calls);
    expect(result["Unknown"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sentimentDistribution
// ---------------------------------------------------------------------------

describe("sentimentDistribution", () => {
  it("counts positive, neutral, negative correctly", () => {
    const result = sentimentDistribution(FIXTURE_CALLS);
    expect(result.positive).toBe(2);
    expect(result.neutral).toBe(2);
    expect(result.negative).toBe(1);
  });

  it("returns zeros for no calls", () => {
    expect(sentimentDistribution([])).toEqual({ positive: 0, neutral: 0, negative: 0 });
  });

  it("counts all-positive correctly", () => {
    const calls = makeCalls(3, { sentiment: "positive" });
    const result = sentimentDistribution(calls);
    expect(result.positive).toBe(3);
    expect(result.neutral).toBe(0);
    expect(result.negative).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dailyVolume
// ---------------------------------------------------------------------------

describe("dailyVolume", () => {
  it("returns one entry per day in the range", () => {
    const result = dailyVolume(FIXTURE_CALLS, "2026-05-10", "2026-05-12");
    expect(result).toHaveLength(3);
    expect(result[0]!.date).toBe("2026-05-10");
    expect(result[1]!.date).toBe("2026-05-11");
    expect(result[2]!.date).toBe("2026-05-12");
  });

  it("counts correctly per day", () => {
    const result = dailyVolume(FIXTURE_CALLS, "2026-05-10", "2026-05-12");
    expect(result[0]!.total).toBe(2); // c1, c2
    expect(result[1]!.total).toBe(2); // c3, c4
    expect(result[2]!.total).toBe(1); // c5
  });

  it("fills days with zero for days outside the data", () => {
    const result = dailyVolume([], "2026-05-10", "2026-05-12");
    expect(result).toHaveLength(3);
    expect(result.every((r) => r.total === 0)).toBe(true);
  });

  it("excludes calls outside the date range", () => {
    const result = dailyVolume(FIXTURE_CALLS, "2026-05-11", "2026-05-12");
    expect(result).toHaveLength(2);
    expect(result[0]!.total).toBe(2); // c3, c4
    expect(result[1]!.total).toBe(1); // c5
  });

  it("fills byOffice breakdown correctly", () => {
    const result = dailyVolume(FIXTURE_CALLS, "2026-05-10", "2026-05-10");
    expect(result[0]!.byOffice["Downtown Dental"]).toBe(2);
  });

  it("fills byTag breakdown correctly", () => {
    const result = dailyVolume(FIXTURE_CALLS, "2026-05-10", "2026-05-10");
    expect(result[0]!.byTag["appointment_scheduled"]).toBe(1);
    expect(result[0]!.byTag["emergency"]).toBe(1);
  });

  it("handles single-day range", () => {
    const result = dailyVolume(FIXTURE_CALLS, "2026-05-10", "2026-05-10");
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// avgQualityScore
// ---------------------------------------------------------------------------

describe("avgQualityScore", () => {
  it("computes average correctly", () => {
    const result = avgQualityScore(FIXTURE_CALLS);
    const expected = Math.round((90 + 40 + 85 + 50 + 70) / 5);
    expect(result).toBe(expected);
  });

  it("returns 0 for empty array", () => {
    expect(avgQualityScore([])).toBe(0);
  });

  it("handles single call", () => {
    const calls = [makeCall({ qualityScore: 77 })];
    expect(avgQualityScore(calls)).toBe(77);
  });
});

// ---------------------------------------------------------------------------
// commlogStats
// ---------------------------------------------------------------------------

describe("commlogStats", () => {
  it("counts written, pending, failed correctly", () => {
    const result = commlogStats(FIXTURE_CALLS);
    expect(result.written).toBe(2); // c1, c3
    expect(result.pending).toBe(2); // c2, c5
    expect(result.failed).toBe(1);  // c4
  });

  it("returns zeros for empty array", () => {
    expect(commlogStats([])).toEqual({ written: 0, pending: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// filterCalls
// ---------------------------------------------------------------------------

describe("filterCalls", () => {
  it("filters by office", () => {
    const result = filterCalls(FIXTURE_CALLS, { office: "Downtown Dental" });
    expect(result).toHaveLength(2);
    expect(result.every((c) => c.office === "Downtown Dental")).toBe(true);
  });

  it("filters by tag", () => {
    const result = filterCalls(FIXTURE_CALLS, { tag: "appointment_scheduled" });
    expect(result).toHaveLength(2);
  });

  it("filters by outcome", () => {
    const result = filterCalls(FIXTURE_CALLS, { outcome: "Appointment scheduled" });
    expect(result).toHaveLength(2);
  });

  it("filters by commlogStatus", () => {
    const result = filterCalls(FIXTURE_CALLS, { commlogStatus: "failed" });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("c4");
  });

  it("filters by startDate", () => {
    const result = filterCalls(FIXTURE_CALLS, { startDate: "2026-05-11" });
    expect(result).toHaveLength(3); // c3, c4, c5
  });

  it("filters by endDate", () => {
    const result = filterCalls(FIXTURE_CALLS, { endDate: "2026-05-10" });
    expect(result).toHaveLength(2); // c1, c2
  });

  it("filters by both startDate and endDate", () => {
    const result = filterCalls(FIXTURE_CALLS, { startDate: "2026-05-11", endDate: "2026-05-11" });
    expect(result).toHaveLength(2); // c3, c4
  });

  it("filters by search (callerName)", () => {
    const calls = [
      makeCall({ id: "s1", callerName: "Alice Wonder" }),
      makeCall({ id: "s2", callerName: "Bob Builder" }),
    ];
    const result = filterCalls(calls, { search: "alice" });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("s1");
  });

  it("filters by search (office)", () => {
    const result = filterCalls(FIXTURE_CALLS, { search: "mesa" });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("c5");
  });

  it("applies multiple filters (AND)", () => {
    const result = filterCalls(FIXTURE_CALLS, {
      office: "Downtown Dental",
      tag: "appointment_scheduled",
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("c1");
  });

  it("returns empty array when no match", () => {
    const result = filterCalls(FIXTURE_CALLS, { office: "Nonexistent" });
    expect(result).toHaveLength(0);
  });

  it("returns all calls when no filters applied", () => {
    const result = filterCalls(FIXTURE_CALLS, {});
    expect(result).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// computeAnalytics — integration
// ---------------------------------------------------------------------------

describe("computeAnalytics", () => {
  const START = "2026-05-10";
  const END = "2026-05-12";

  it("returns the correct period", () => {
    const result = computeAnalytics(FIXTURE_CALLS, START, END);
    expect(result.period.startDate).toBe(START);
    expect(result.period.endDate).toBe(END);
    expect(result.period.days).toBe(3);
  });

  it("reports correct totalCalls", () => {
    const result = computeAnalytics(FIXTURE_CALLS, START, END);
    expect(result.totalCalls).toBe(5);
  });

  it("includes byTag aggregation", () => {
    const result = computeAnalytics(FIXTURE_CALLS, START, END);
    const scheduled = result.byTag.find((t) => t.tag === "appointment_scheduled");
    expect(scheduled?.count).toBe(2);
  });

  it("includes byOutcome aggregation", () => {
    const result = computeAnalytics(FIXTURE_CALLS, START, END);
    const scheduled = result.byOutcome.find((o) => o.outcome === "Appointment scheduled");
    expect(scheduled?.count).toBe(2);
  });

  it("includes byOffice aggregation", () => {
    const result = computeAnalytics(FIXTURE_CALLS, START, END);
    expect(result.byOffice["Downtown Dental"]).toBe(2);
    expect(result.byOffice["Scottsdale North"]).toBe(2);
    expect(result.byOffice["Mesa East"]).toBe(1);
  });

  it("includes dailyVolume with 3 entries", () => {
    const result = computeAnalytics(FIXTURE_CALLS, START, END);
    expect(result.dailyVolume).toHaveLength(3);
  });

  it("includes correct sentiment distribution", () => {
    const result = computeAnalytics(FIXTURE_CALLS, START, END);
    expect(result.sentiment.positive).toBe(2);
    expect(result.sentiment.neutral).toBe(2);
    expect(result.sentiment.negative).toBe(1);
  });

  it("includes commlogStats", () => {
    const result = computeAnalytics(FIXTURE_CALLS, START, END);
    expect(result.commlogStats.written).toBe(2);
    expect(result.commlogStats.pending).toBe(2);
    expect(result.commlogStats.failed).toBe(1);
  });

  it("computes avgQualityScore", () => {
    const result = computeAnalytics(FIXTURE_CALLS, START, END);
    const expected = Math.round((90 + 40 + 85 + 50 + 70) / 5);
    expect(result.avgQualityScore).toBe(expected);
  });

  it("computes avgDurationSeconds", () => {
    // All fixture calls have durationSeconds: 120
    const result = computeAnalytics(FIXTURE_CALLS, START, END);
    expect(result.avgDurationSeconds).toBe(120);
  });

  it("handles empty call list", () => {
    const result = computeAnalytics([], START, END);
    expect(result.totalCalls).toBe(0);
    expect(result.byTag).toHaveLength(0);
    expect(result.sentiment).toEqual({ positive: 0, neutral: 0, negative: 0 });
    expect(result.avgQualityScore).toBe(0);
    expect(result.avgDurationSeconds).toBe(0);
  });
});
