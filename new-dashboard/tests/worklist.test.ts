/**
 * Tests for the worklist attention rule (PRD D1 / MANGO_WORKLIST_MODE).
 */
import { describe, it, expect } from "vitest";
import { callNeedsAttention } from "@/lib/worklist";
import type { UnifiedCall } from "@/lib/api";

// Minimal UnifiedCall builder — callNeedsAttention only reads a handful of fields.
function call(overrides: Partial<UnifiedCall>): UnifiedCall {
  return {
    source: "mango",
    triageStatus: "new",
    notAPatient: false,
    isEmergency: false,
    appointmentRequested: false,
    appointmentBooked: false,
    callbackRequested: false,
    ...overrides,
  } as UnifiedCall;
}

describe("callNeedsAttention", () => {
  it("resolved (triage done) or not-a-patient never needs attention, in any mode", () => {
    expect(callNeedsAttention(call({ triageStatus: "done" }), "all")).toBe(false);
    expect(callNeedsAttention(call({ triageStatus: "done" }), "flagged")).toBe(false);
    expect(callNeedsAttention(call({ notAPatient: true }), "all")).toBe(false);
    expect(callNeedsAttention(call({ notAPatient: true }), "flagged")).toBe(false);
  });

  it("mode 'all': every open Mango call needs attention", () => {
    expect(callNeedsAttention(call({ source: "mango" }), "all")).toBe(true);
    expect(callNeedsAttention(call({ source: "mango", isEmergency: false }), "all")).toBe(true);
  });

  it("mode 'flagged': only emergency / appointment / callback Mango calls need attention", () => {
    expect(callNeedsAttention(call({ source: "mango" }), "flagged")).toBe(false);
    expect(callNeedsAttention(call({ source: "mango", isEmergency: true }), "flagged")).toBe(true);
    expect(callNeedsAttention(call({ source: "mango", appointmentRequested: true }), "flagged")).toBe(true);
    expect(callNeedsAttention(call({ source: "mango", appointmentBooked: true }), "flagged")).toBe(true);
    expect(callNeedsAttention(call({ source: "mango", callbackRequested: true }), "flagged")).toBe(true);
  });

  it("Retell calls are unaffected by the Mango worklist mode", () => {
    expect(callNeedsAttention(call({ source: "retell" }), "all")).toBe(true);
    // A plain Retell call still needs attention even in 'flagged' mode.
    expect(callNeedsAttention(call({ source: "retell" }), "flagged")).toBe(true);
  });
});
