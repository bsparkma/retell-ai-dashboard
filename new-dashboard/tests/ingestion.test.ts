/**
 * Tests for the Retell webhook ingestion pipeline.
 *
 * Covers:
 * - validateWebhookPayload: valid, missing fields, wrong types
 * - normalizeRetellCall: all field derivations
 * - deriveTag: all tag branches
 * - deriveOutcome: outcome per tag
 * - deriveRoutedTo: routing derivations
 * - deriveQualityScore: score ranges
 * - extractCallerName: transcript-based name extraction
 * - officeFromNumber: known/unknown numbers
 * - ingestRetellWebhook: full pipeline
 * - Error paths: duplicate detection is tested in store integration
 */

import { describe, it, expect } from "vitest";
import {
  validateWebhookPayload,
  normalizeRetellCall,
  ingestRetellWebhook,
  deriveTag,
  deriveOutcome,
  deriveRoutedTo,
  deriveQualityScore,
  extractCallerName,
  officeFromNumber,
  IngestionError,
} from "../server/lib/ingestion.js";
import type { RetellCallPayload, RetellWebhookPayload } from "../server/lib/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCall(overrides: Partial<RetellCallPayload> = {}): RetellCallPayload {
  return {
    call_id: "test_call_001",
    agent_id: "agent_rover",
    start_timestamp: Date.now() - 120_000,
    end_timestamp: Date.now(),
    duration_ms: 120_000,
    from_number: "+16025550100",
    to_number: "+16025550101",
    call_analysis: {
      call_summary: "Patient called to schedule a cleaning. Appointment booked.",
      user_sentiment: "Positive",
      call_successful: true,
      in_voicemail: false,
    },
    transcript: "Agent: How can I help?\nUser: I need a cleaning.",
    transcript_object: [
      { role: "agent", content: "How can I help?" },
      { role: "user", content: "I need a cleaning." },
    ],
    recording_url: "https://example.com/recording.mp3",
    metadata: {},
    ...overrides,
  };
}

function makeWebhook(callOverrides: Partial<RetellCallPayload> = {}): RetellWebhookPayload {
  return {
    event: "call_ended",
    call: makeCall(callOverrides),
  };
}

// ---------------------------------------------------------------------------
// validateWebhookPayload
// ---------------------------------------------------------------------------

describe("validateWebhookPayload", () => {
  it("accepts a valid payload", () => {
    const payload = makeWebhook();
    const result = validateWebhookPayload(payload);
    expect(result.event).toBe("call_ended");
    expect(result.call.call_id).toBe("test_call_001");
  });

  it("rejects null", () => {
    expect(() => validateWebhookPayload(null)).toThrow(IngestionError);
  });

  it("rejects non-object", () => {
    expect(() => validateWebhookPayload("string")).toThrow(IngestionError);
    expect(() => validateWebhookPayload(42)).toThrow(IngestionError);
  });

  it("rejects missing event field", () => {
    const bad = { call: { call_id: "x" } };
    expect(() => validateWebhookPayload(bad)).toThrow(IngestionError);
  });

  it("rejects missing call field", () => {
    const bad = { event: "call_ended" };
    expect(() => validateWebhookPayload(bad)).toThrow(IngestionError);
  });

  it("rejects call with missing call_id", () => {
    const bad = { event: "call_ended", call: { agent_id: "a" } };
    expect(() => validateWebhookPayload(bad)).toThrow(IngestionError);
  });

  it("rejects call with empty call_id", () => {
    const bad = { event: "call_ended", call: { call_id: "" } };
    expect(() => validateWebhookPayload(bad)).toThrow(IngestionError);
  });

  it("reports the field name in the error for call_id", () => {
    const bad = { event: "call_ended", call: {} };
    try {
      validateWebhookPayload(bad);
      expect.fail("expected error");
    } catch (e) {
      expect(e).toBeInstanceOf(IngestionError);
      expect((e as IngestionError).field).toBe("call.call_id");
    }
  });
});

// ---------------------------------------------------------------------------
// officeFromNumber
// ---------------------------------------------------------------------------

describe("officeFromNumber", () => {
  it("maps known numbers to their offices", () => {
    expect(officeFromNumber("+16025550101")).toBe("Downtown Dental");
    expect(officeFromNumber("+14805550202")).toBe("Scottsdale North");
    expect(officeFromNumber("+14805550303")).toBe("Mesa East");
    expect(officeFromNumber("+16235550404")).toBe("Surprise West");
  });

  it("returns default for unknown number", () => {
    expect(officeFromNumber("+19995559999")).toBe("Main Office");
  });

  it("returns default for undefined", () => {
    expect(officeFromNumber(undefined)).toBe("Main Office");
  });

  it("strips spaces before matching", () => {
    expect(officeFromNumber("+1 602 555 0101")).toBe("Downtown Dental");
  });
});

// ---------------------------------------------------------------------------
// extractCallerName
// ---------------------------------------------------------------------------

describe("extractCallerName", () => {
  it("extracts name from 'my name is'", () => {
    expect(
      extractCallerName("My name is John Smith and I need help.", undefined)
    ).toBe("John Smith");
  });

  it("extracts name from transcript_object user turns", () => {
    const turns = [
      { role: "agent" as const, content: "How can I help?" },
      { role: "user" as const, content: "Hi, I'm Sarah Mitchell." },
    ];
    expect(extractCallerName(undefined, turns)).toBe("Sarah Mitchell");
  });

  it("prefers transcript_object over raw transcript", () => {
    const turns = [{ role: "user" as const, content: "This is Michael Adams." }];
    const result = extractCallerName("My name is not real", turns);
    expect(result).toBe("Michael Adams");
  });

  it("returns Unknown when no name found", () => {
    expect(extractCallerName("Hello how are you", undefined)).toBe("Unknown");
  });

  it("returns Unknown for empty inputs", () => {
    expect(extractCallerName(undefined, undefined)).toBe("Unknown");
  });

  it("skips excluded words", () => {
    // "Rover" is in the exclude list
    expect(extractCallerName("I'm Rover the bot", undefined)).toBe("Unknown");
  });
});

// ---------------------------------------------------------------------------
// deriveTag
// ---------------------------------------------------------------------------

describe("deriveTag", () => {
  it("uses custom_analysis_data.tag if present", () => {
    const call = makeCall({
      call_analysis: {
        custom_analysis_data: { tag: "special_tag" },
      },
    });
    expect(deriveTag(call)).toBe("special_tag");
  });

  it("returns 'voicemail' when in_voicemail is true", () => {
    const call = makeCall({
      call_analysis: { in_voicemail: true },
    });
    expect(deriveTag(call)).toBe("voicemail");
  });

  it("derives 'appointment_scheduled' from summary keyword 'scheduled'", () => {
    const call = makeCall({
      call_analysis: { call_summary: "Patient scheduled their appointment." },
    });
    expect(deriveTag(call)).toBe("appointment_scheduled");
  });

  it("derives 'appointment_cancelled' from summary keyword 'cancel'", () => {
    const call = makeCall({
      call_analysis: { call_summary: "Patient called to cancel their appointment." },
    });
    expect(deriveTag(call)).toBe("appointment_cancelled");
  });

  it("derives 'emergency' from summary keyword 'emergency'", () => {
    const call = makeCall({
      call_analysis: { call_summary: "Patient reported an emergency situation." },
    });
    expect(deriveTag(call)).toBe("emergency");
  });

  it("derives 'billing_inquiry' from summary keyword 'billing'", () => {
    const call = makeCall({
      call_analysis: { call_summary: "Patient had a billing question." },
    });
    expect(deriveTag(call)).toBe("billing_inquiry");
  });

  it("derives 'insurance_inquiry' from summary keyword 'insurance'", () => {
    const call = makeCall({
      call_analysis: { call_summary: "Patient asked about insurance." },
    });
    expect(deriveTag(call)).toBe("insurance_inquiry");
  });

  it("derives 'transferred' from summary keyword 'transfer'", () => {
    const call = makeCall({
      call_analysis: { call_summary: "Call was transferred to staff." },
    });
    expect(deriveTag(call)).toBe("transferred");
  });

  it("derives 'new_patient_inquiry' from 'new patient' in summary", () => {
    const call = makeCall({
      call_analysis: { call_summary: "A new patient called to inquire about services." },
    });
    expect(deriveTag(call)).toBe("new_patient_inquiry");
  });

  it("derives 'unresolved' when call_successful is false", () => {
    const call = makeCall({
      call_analysis: { call_summary: "", call_successful: false },
    });
    expect(deriveTag(call)).toBe("unresolved");
  });

  it("returns 'completed' as default", () => {
    const call = makeCall({
      call_analysis: { call_summary: "Patient called and spoke with the team.", call_successful: true },
    });
    expect(deriveTag(call)).toBe("completed");
  });

  it("returns 'completed' when call_analysis is undefined", () => {
    const call = makeCall({ call_analysis: undefined });
    expect(deriveTag(call)).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// deriveOutcome
// ---------------------------------------------------------------------------

describe("deriveOutcome", () => {
  it("uses custom_analysis_data.outcome if present", () => {
    const call = makeCall({
      call_analysis: { custom_analysis_data: { outcome: "Custom outcome" } },
    });
    expect(deriveOutcome(call)).toBe("Custom outcome");
  });

  it("maps appointment_scheduled tag to correct outcome", () => {
    const call = makeCall({
      call_analysis: { call_summary: "Patient scheduled appointment." },
    });
    expect(deriveOutcome(call)).toBe("Appointment scheduled");
  });

  it("maps voicemail tag", () => {
    const call = makeCall({ call_analysis: { in_voicemail: true } });
    expect(deriveOutcome(call)).toBe("Voicemail left");
  });

  it("maps emergency tag", () => {
    const call = makeCall({
      call_analysis: { call_summary: "Patient reported emergency pain." },
    });
    expect(deriveOutcome(call)).toBe("Escalated to staff");
  });

  it("maps unresolved tag", () => {
    const call = makeCall({
      call_analysis: { call_summary: "", call_successful: false },
    });
    expect(deriveOutcome(call)).toBe("Unresolved");
  });

  it("returns 'Call completed' for default", () => {
    const call = makeCall({
      call_analysis: { call_summary: "A routine call.", call_successful: true },
    });
    expect(deriveOutcome(call)).toBe("Call completed");
  });
});

// ---------------------------------------------------------------------------
// deriveRoutedTo
// ---------------------------------------------------------------------------

describe("deriveRoutedTo", () => {
  it("uses custom_analysis_data.routed_to if present", () => {
    const call = makeCall({
      call_analysis: { custom_analysis_data: { routed_to: "Dr. Smith" } },
    });
    expect(deriveRoutedTo(call)).toBe("Dr. Smith");
  });

  it("returns 'Voicemail' when in_voicemail", () => {
    const call = makeCall({ call_analysis: { in_voicemail: true } });
    expect(deriveRoutedTo(call)).toBe("Voicemail");
  });

  it("returns 'Front Desk Staff' for emergency tag", () => {
    const call = makeCall({
      call_analysis: { call_summary: "Patient reported emergency." },
    });
    expect(deriveRoutedTo(call)).toBe("Front Desk Staff");
  });

  it("returns 'Rover (AI)' when agent_id is set", () => {
    const call = makeCall({
      agent_id: "agent_rover_01",
      call_analysis: { call_summary: "Routine call.", call_successful: true },
    });
    expect(deriveRoutedTo(call)).toBe("Rover (AI)");
  });

  it("returns 'Unknown' when no agent_id", () => {
    const call = makeCall({
      agent_id: undefined,
      call_analysis: { call_summary: "Routine.", call_successful: true },
    });
    expect(deriveRoutedTo(call)).toBe("Unknown");
  });
});

// ---------------------------------------------------------------------------
// deriveQualityScore
// ---------------------------------------------------------------------------

describe("deriveQualityScore", () => {
  it("returns a score between 0 and 100", () => {
    const call = makeCall();
    const score = deriveQualityScore(call);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("gives a higher score for Positive sentiment + successful", () => {
    const good = makeCall({
      call_analysis: { user_sentiment: "Positive", call_successful: true },
    });
    const bad = makeCall({
      call_analysis: { user_sentiment: "Negative", call_successful: false },
    });
    expect(deriveQualityScore(good)).toBeGreaterThan(deriveQualityScore(bad));
  });

  it("clamps to 0 minimum", () => {
    const call = makeCall({
      call_analysis: { user_sentiment: "Negative", call_successful: false },
      duration_ms: 1000,
    });
    const score = deriveQualityScore(call);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("clamps to 100 maximum", () => {
    const call = makeCall({
      call_analysis: { user_sentiment: "Positive", call_successful: true },
      duration_ms: 120_000,
    });
    const score = deriveQualityScore(call);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("handles missing call_analysis", () => {
    const call = makeCall({ call_analysis: undefined });
    expect(() => deriveQualityScore(call)).not.toThrow();
    const score = deriveQualityScore(call);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// normalizeRetellCall
// ---------------------------------------------------------------------------

describe("normalizeRetellCall", () => {
  it("produces a record with required fields", () => {
    const call = makeCall();
    const result = normalizeRetellCall(call);

    expect(result.id).toBe(`call_${call.call_id}`);
    expect(result.callerNumber).toBe(call.from_number);
    expect(result.office).toBe("Downtown Dental");
    expect(result.durationSeconds).toBe(120);
    expect(result.sentiment).toBe("positive");
    expect(result.qualityScore).toBeGreaterThan(0);
    expect(result.recordingUrl).toBe("https://example.com/recording.mp3");
    expect(result.retellCallId).toBe("test_call_001");
  });

  it("handles missing timestamps by using now", () => {
    const before = Date.now();
    const call = makeCall({
      start_timestamp: undefined,
      end_timestamp: undefined,
      duration_ms: 60_000,
    });
    const result = normalizeRetellCall(call);
    const after = Date.now();

    const endMs = new Date(result.endedAt).getTime();
    expect(endMs).toBeGreaterThanOrEqual(before);
    expect(endMs).toBeLessThanOrEqual(after);
    expect(result.durationSeconds).toBe(60);
  });

  it("normalizes Neutral sentiment to 'neutral'", () => {
    const call = makeCall({
      call_analysis: { user_sentiment: "Neutral" },
    });
    expect(normalizeRetellCall(call).sentiment).toBe("neutral");
  });

  it("normalizes Negative sentiment to 'negative'", () => {
    const call = makeCall({
      call_analysis: { user_sentiment: "Negative" },
    });
    expect(normalizeRetellCall(call).sentiment).toBe("negative");
  });

  it("marks isEmergency true for emergency tag", () => {
    const call = makeCall({
      call_analysis: { call_summary: "Patient had a dental emergency." },
    });
    expect(normalizeRetellCall(call).isEmergency).toBe(true);
  });

  it("marks isEmergency true when metadata.is_emergency is true", () => {
    const call = makeCall({
      call_analysis: { call_summary: "Routine.", call_successful: true },
      metadata: { is_emergency: true },
    });
    expect(normalizeRetellCall(call).isEmergency).toBe(true);
  });

  it("maps transcriptObject correctly", () => {
    const call = makeCall();
    const result = normalizeRetellCall(call);
    expect(result.transcriptObject).toHaveLength(2);
    expect(result.transcriptObject[0]).toEqual({ role: "agent", content: "How can I help?" });
    expect(result.transcriptObject[1]).toEqual({ role: "user", content: "I need a cleaning." });
  });

  it("handles empty transcript_object", () => {
    const call = makeCall({ transcript_object: [] });
    const result = normalizeRetellCall(call);
    expect(result.transcriptObject).toHaveLength(0);
  });

  it("uses caller_number fallback for unknown from_number", () => {
    const call = makeCall({ from_number: undefined });
    expect(normalizeRetellCall(call).callerNumber).toBe("Unknown");
  });
});

// ---------------------------------------------------------------------------
// ingestRetellWebhook
// ---------------------------------------------------------------------------

describe("ingestRetellWebhook", () => {
  it("returns a full Call record with commlog fields", () => {
    const webhook = makeWebhook();
    const call = ingestRetellWebhook(webhook);

    expect(call.commlogStatus).toBe("pending");
    expect(call.commlogWrittenAt).toBeNull();
    expect(call.commlogError).toBeNull();
    expect(call.ingestedAt).toBeDefined();
  });

  it("uses the provided ingestedAt override", () => {
    const webhook = makeWebhook();
    const ts = "2026-01-01T00:00:00.000Z";
    const call = ingestRetellWebhook(webhook, { ingestedAt: ts });
    expect(call.ingestedAt).toBe(ts);
  });

  it("throws IngestionError for invalid payload", () => {
    expect(() => ingestRetellWebhook(null)).toThrow(IngestionError);
    expect(() => ingestRetellWebhook({ event: "call_ended" })).toThrow(IngestionError);
  });

  it("produces consistent id from call_id", () => {
    const webhook = makeWebhook({ call_id: "abc123" });
    const call = ingestRetellWebhook(webhook);
    expect(call.id).toBe("call_abc123");
  });
});
