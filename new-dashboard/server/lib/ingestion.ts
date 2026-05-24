/**
 * Retell webhook payload → normalized Call record.
 *
 * This module is the primary ingestion boundary. It validates and normalizes
 * the raw Retell call-ended webhook into the dashboard's canonical Call shape.
 * It has no side effects — all IO (storage, commlog writes) is handled by callers.
 */

import { nanoid } from "nanoid";
import type { Call, RetellWebhookPayload, RetellCallPayload, RetellTranscriptTurn } from "./types.js";

// ---------------------------------------------------------------------------
// Office mapping: maps the "to_number" (the inbound DNIS) to an office name.
// In production this would be in config; here it is a hardcoded map so the
// dashboard works offline with synthetic data.
// ---------------------------------------------------------------------------

const OFFICE_BY_NUMBER: Record<string, string> = {
  "+16025550101": "Downtown Dental",
  "+14805550202": "Scottsdale North",
  "+14805550303": "Mesa East",
  "+16235550404": "Surprise West",
};

const DEFAULT_OFFICE = "Main Office";

export function officeFromNumber(toNumber: string | undefined): string {
  if (!toNumber) return DEFAULT_OFFICE;
  const normalized = toNumber.replace(/\s+/g, "");
  return OFFICE_BY_NUMBER[normalized] ?? DEFAULT_OFFICE;
}

// ---------------------------------------------------------------------------
// Sentiment normalization
// ---------------------------------------------------------------------------

function normalizeSentiment(
  raw: string | undefined
): "positive" | "neutral" | "negative" {
  switch (raw?.toLowerCase()) {
    case "positive":
      return "positive";
    case "negative":
      return "negative";
    default:
      return "neutral";
  }
}

// ---------------------------------------------------------------------------
// Tag / disposition derivation
// Priority: custom_analysis_data.tag > call_analysis heuristics > fallback
// ---------------------------------------------------------------------------

export function deriveTag(call: RetellCallPayload): string {
  const custom = call.call_analysis?.custom_analysis_data;
  if (custom && typeof custom["tag"] === "string" && custom["tag"]) {
    return custom["tag"] as string;
  }

  if (call.call_analysis?.in_voicemail) return "voicemail";

  const summary = (call.call_analysis?.call_summary ?? "").toLowerCase();
  if (summary.includes("scheduled") || summary.includes("booked")) return "appointment_scheduled";
  if (summary.includes("cancel")) return "appointment_cancelled";
  if (summary.includes("emergency") || summary.includes("pain")) return "emergency";
  if (summary.includes("billing") || summary.includes("payment") || summary.includes("invoice")) return "billing_inquiry";
  if (summary.includes("insurance")) return "insurance_inquiry";
  if (summary.includes("transfer") || summary.includes("connected staff")) return "transferred";
  if (summary.includes("rescheduled")) return "appointment_rescheduled";
  if (summary.includes("new patient")) return "new_patient_inquiry";

  // Fallback based on call_successful
  if (call.call_analysis?.call_successful === false) return "unresolved";
  return "completed";
}

// ---------------------------------------------------------------------------
// Outcome derivation
// ---------------------------------------------------------------------------

export function deriveOutcome(call: RetellCallPayload): string {
  const custom = call.call_analysis?.custom_analysis_data;
  if (custom && typeof custom["outcome"] === "string" && custom["outcome"]) {
    return custom["outcome"] as string;
  }

  const tag = deriveTag(call);
  switch (tag) {
    case "appointment_scheduled": return "Appointment scheduled";
    case "appointment_cancelled": return "Appointment cancelled";
    case "appointment_rescheduled": return "Appointment rescheduled";
    case "emergency": return "Escalated to staff";
    case "voicemail": return "Voicemail left";
    case "transferred": return "Transferred to staff";
    case "billing_inquiry": return "Billing inquiry handled";
    case "insurance_inquiry": return "Insurance inquiry handled";
    case "new_patient_inquiry": return "New patient inquiry handled";
    case "unresolved": return "Unresolved";
    default: return "Call completed";
  }
}

// ---------------------------------------------------------------------------
// Routed-to derivation
// ---------------------------------------------------------------------------

export function deriveRoutedTo(call: RetellCallPayload): string {
  const custom = call.call_analysis?.custom_analysis_data;
  if (custom && typeof custom["routed_to"] === "string" && custom["routed_to"]) {
    return custom["routed_to"] as string;
  }

  if (call.call_analysis?.in_voicemail) return "Voicemail";

  const tag = deriveTag(call);
  if (tag === "emergency" || tag === "transferred") return "Front Desk Staff";

  return call.agent_id ? "Rover (AI)" : "Unknown";
}

// ---------------------------------------------------------------------------
// Quality score heuristic (0–100)
// ---------------------------------------------------------------------------

export function deriveQualityScore(call: RetellCallPayload): number {
  let score = 50;

  const sentiment = call.call_analysis?.user_sentiment;
  if (sentiment === "Positive") score += 30;
  else if (sentiment === "Negative") score -= 20;
  else if (sentiment === "Neutral") score += 5;

  if (call.call_analysis?.call_successful === true) score += 20;
  else if (call.call_analysis?.call_successful === false) score -= 20;

  // Duration bonus: calls between 30s and 5 minutes are "normal"
  const durationSec = (call.duration_ms ?? 0) / 1000;
  if (durationSec >= 30 && durationSec <= 300) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ---------------------------------------------------------------------------
// Caller name extraction from transcript
// ---------------------------------------------------------------------------

export function extractCallerName(
  transcript: string | undefined,
  transcriptObject: RetellTranscriptTurn[] | undefined
): string {
  const patterns = [
    /(?:my name is|i'm|this is|i am)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
    /(?:call me|name's|it's)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
    /(?:hi|hello),?\s+(?:my name is|i'm|this is)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
  ];
  const exclude = new Set([
    "okay", "yes", "no", "sure", "well", "um", "uh", "the", "that", "this",
    "here", "calling", "assistant", "agent", "bot", "rover",
  ]);

  const textToSearch: string[] = [];

  if (transcriptObject && transcriptObject.length > 0) {
    textToSearch.push(
      ...transcriptObject
        .filter((u) => u.role === "user")
        .map((u) => u.content)
    );
  }
  if (transcript) textToSearch.push(transcript);

  for (const text of textToSearch) {
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m?.[1]) {
        const name = m[1].trim();
        const words = name.toLowerCase().split(/\s+/);
        if (name.length > 1 && !words.some((w) => exclude.has(w))) {
          return name.charAt(0).toUpperCase() + name.slice(1);
        }
      }
    }
  }

  return "Unknown";
}

// ---------------------------------------------------------------------------
// Main normalization function
// ---------------------------------------------------------------------------

/**
 * Normalizes a Retell call payload into a dashboard Call record.
 * Pure function — no side effects.
 */
export function normalizeRetellCall(payload: RetellCallPayload): Omit<Call,
  "commlogStatus" | "commlogWrittenAt" | "commlogError" | "ingestedAt"> {
  const now = new Date();
  const startMs = payload.start_timestamp ?? now.getTime() - (payload.duration_ms ?? 0);
  const endMs = payload.end_timestamp ?? now.getTime();
  const durationSec = payload.duration_ms != null
    ? Math.round(payload.duration_ms / 1000)
    : Math.round((endMs - startMs) / 1000);

  const startedAt = new Date(startMs).toISOString();
  const endedAt = new Date(endMs).toISOString();

  const callerName = extractCallerName(payload.transcript, payload.transcript_object);

  const tag = deriveTag(payload);
  const outcome = deriveOutcome(payload);
  const routedTo = deriveRoutedTo(payload);
  const sentiment = normalizeSentiment(payload.call_analysis?.user_sentiment);
  const qualityScore = deriveQualityScore(payload);

  return {
    id: `call_${payload.call_id}`,
    startedAt,
    endedAt,
    durationSeconds: durationSec,
    callerNumber: payload.from_number ?? "Unknown",
    callerName,
    office: officeFromNumber(payload.to_number),
    toNumber: payload.to_number ?? "",
    tag,
    routedTo,
    transcript: payload.transcript ?? "",
    transcriptObject: (payload.transcript_object ?? []).map((t) => ({
      role: t.role,
      content: t.content,
    })),
    summary: payload.call_analysis?.call_summary ?? "",
    outcome,
    sentiment,
    qualityScore,
    recordingUrl: payload.recording_url ?? "",
    isEmergency: tag === "emergency" || Boolean(payload.metadata?.["is_emergency"]),
    retellCallId: payload.call_id,
  };
}

// ---------------------------------------------------------------------------
// Webhook payload validation
// ---------------------------------------------------------------------------

export class IngestionError extends Error {
  constructor(
    message: string,
    public readonly field?: string
  ) {
    super(message);
    this.name = "IngestionError";
  }
}

/**
 * Validates the raw webhook body and extracts the call payload.
 * Throws IngestionError for invalid payloads.
 */
export function validateWebhookPayload(body: unknown): RetellWebhookPayload {
  if (!body || typeof body !== "object") {
    throw new IngestionError("Payload must be a non-null object");
  }

  const obj = body as Record<string, unknown>;

  if (typeof obj["event"] !== "string") {
    throw new IngestionError("Missing or invalid 'event' field", "event");
  }

  if (!obj["call"] || typeof obj["call"] !== "object") {
    throw new IngestionError("Missing or invalid 'call' field", "call");
  }

  const call = obj["call"] as Record<string, unknown>;
  if (typeof call["call_id"] !== "string" || !call["call_id"]) {
    throw new IngestionError("Missing or invalid 'call.call_id'", "call.call_id");
  }

  return obj as unknown as RetellWebhookPayload;
}

/**
 * Full ingestion pipeline: validate → normalize → return call record with
 * ingestion metadata. The caller is responsible for persisting the record.
 */
export function ingestRetellWebhook(
  body: unknown,
  overrides?: { ingestedAt?: string }
): Call {
  const payload = validateWebhookPayload(body);
  const normalized = normalizeRetellCall(payload.call);
  const ingestedAt = overrides?.ingestedAt ?? new Date().toISOString();

  return {
    ...normalized,
    commlogStatus: "pending",
    commlogWrittenAt: null,
    commlogError: null,
    ingestedAt,
  };
}

/**
 * Generates a call ID for manually-created (seed) records.
 */
export function generateCallId(): string {
  return `call_${nanoid(10)}`;
}
