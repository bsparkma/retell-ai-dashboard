/**
 * Fixture-based ingestion test.
 *
 * Verifies that the committed mock webhook payload (`retell-webhook-call-ended.json`)
 * ingests to the exact expected Call record shape. This test acts as a regression
 * guard: if ingestion logic changes behavior for a known payload, this fails.
 */

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { ingestRetellWebhook } from "../server/lib/ingestion.js";

const require = createRequire(import.meta.url);
const fixture = require("./fixtures/retell-webhook-call-ended.json") as Record<string, unknown>;

describe("fixture: retell-webhook-call-ended.json", () => {
  const call = ingestRetellWebhook(fixture, { ingestedAt: "2026-05-23T00:00:00.000Z" });

  it("produces the correct call ID", () => {
    expect(call.id).toBe("call_fixture_call_001");
  });

  it("maps to the correct office (Downtown Dental from +16025550101)", () => {
    expect(call.office).toBe("Downtown Dental");
  });

  it("extracts the caller name from transcript_object", () => {
    expect(call.callerName).toBe("Sarah Mitchell");
  });

  it("sets the correct tag from custom_analysis_data", () => {
    expect(call.tag).toBe("appointment_scheduled");
  });

  it("sets the correct outcome from custom_analysis_data", () => {
    expect(call.outcome).toBe("Appointment scheduled for Tuesday 9 AM");
  });

  it("sets the correct routed_to from custom_analysis_data", () => {
    expect(call.routedTo).toBe("Rover (AI)");
  });

  it("normalizes Positive sentiment to 'positive'", () => {
    expect(call.sentiment).toBe("positive");
  });

  it("computes durationSeconds from duration_ms", () => {
    expect(call.durationSeconds).toBe(240);
  });

  it("sets the correct caller number", () => {
    expect(call.callerNumber).toBe("+16025550142");
  });

  it("maps transcript_object correctly (5 turns)", () => {
    expect(call.transcriptObject).toHaveLength(5);
    expect(call.transcriptObject[0]).toEqual({
      role: "agent",
      content: "Thank you for calling Downtown Dental, this is Rover. How can I help you today?",
    });
  });

  it("starts with commlogStatus 'pending'", () => {
    expect(call.commlogStatus).toBe("pending");
    expect(call.commlogWrittenAt).toBeNull();
    expect(call.commlogError).toBeNull();
  });

  it("uses the provided ingestedAt timestamp", () => {
    expect(call.ingestedAt).toBe("2026-05-23T00:00:00.000Z");
  });

  it("is not flagged as an emergency", () => {
    expect(call.isEmergency).toBe(false);
  });

  it("has a quality score above 80 (positive + successful)", () => {
    expect(call.qualityScore).toBeGreaterThan(80);
  });

  it("retains the Retell call_id", () => {
    expect(call.retellCallId).toBe("fixture_call_001");
  });
});
