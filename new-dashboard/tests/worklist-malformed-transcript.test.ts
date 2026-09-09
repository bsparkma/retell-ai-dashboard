/**
 * One malformed row must not blank the worklist.
 *
 * THE INCIDENT THIS PINS (2026-09-03 → 2026-09-09, prod):
 * A zero-length Retell call was stored with `transcript: []` — an ARRAY, where the
 * type said string. `normalizeUnifiedCall` falls back to `extractNameFromText` when
 * `caller_name` is null, and that function guarded with a bare `if (transcript)`.
 * An empty array is TRUTHY, so it reached `transcript.match(pat)` and threw
 * `TypeError: transcript.match is not a function`.
 *
 * The throw happened inside `calls.map(normalizeUnifiedCall)`, so ONE bad row
 * rejected the whole request. `CallWorklist` caught it with `.catch(() => setCalls([]))`
 * and rendered its ordinary "No calls match the current filters" empty state. Result:
 * every office showed zero calls for six days, with nothing in the console and a
 * healthy 200 on the wire.
 *
 * Two lessons, both pinned below:
 *   1. A TS annotation on untrusted backend data is a wish, not a guard.
 *   2. `map` over a payload is all-or-nothing — one row's defect is every row's.
 *
 * No PHI: every value here is synthetic.
 */
import { describe, expect, it } from "vitest";
import { normalizeUnifiedCall, type BackendUnifiedCall } from "@/lib/api";

/** The exact shape of the prod row that caused the outage, minus its real id. */
const poisonRow = {
  id: "call_synthetic_zero_length",
  source: "retell",
  call_date: "2026-09-03T20:30:49.756Z",
  caller_name: null,
  // The defect: an array where a string was promised, and `[]` is truthy.
  transcript: [],
  call_summary: "No conversation happened.",
  duration_seconds: 0,
} as unknown as BackendUnifiedCall;

const healthyRow = {
  id: "call_synthetic_healthy",
  source: "mango",
  call_date: "2026-09-09T15:00:00.000Z",
  caller_name: null,
  transcript: "Hi, my name is Dana Fielder and I need to reschedule.",
  call_summary: "Caller asked to move an appointment.",
  duration_seconds: 91,
} as unknown as BackendUnifiedCall;

describe("normalizeUnifiedCall — malformed backend values", () => {
  it("does not throw when transcript is an empty array", () => {
    expect(() => normalizeUnifiedCall(poisonRow)).not.toThrow();
  });

  it("does not throw for any non-string transcript or summary shape", () => {
    const shapes: unknown[] = [[], [{ role: "agent", content: "hi" }], {}, 42, true];
    for (const bad of shapes) {
      expect(() =>
        normalizeUnifiedCall({ ...poisonRow, transcript: bad } as unknown as BackendUnifiedCall),
      ).not.toThrow();
      expect(() =>
        normalizeUnifiedCall({ ...poisonRow, call_summary: bad } as unknown as BackendUnifiedCall),
      ).not.toThrow();
    }
  });

  it("falls back to a usable patientName instead of a crash", () => {
    const call = normalizeUnifiedCall(poisonRow);
    expect(call.id).toBe("call_synthetic_zero_length");
    expect(typeof call.patientName).toBe("string");
  });

  it("still extracts a name from a well-formed string transcript", () => {
    // The guard must not cost us the behaviour it protects.
    const call = normalizeUnifiedCall(healthyRow);
    expect(call.patientName).toBe("Dana Fielder");
  });

  it("maps a whole page when one row is malformed — the actual outage", () => {
    const page = [healthyRow, poisonRow, healthyRow];
    const mapped = page.map(normalizeUnifiedCall);
    expect(mapped).toHaveLength(3);
    expect(mapped.every((c) => typeof c.id === "string")).toBe(true);
  });
});
