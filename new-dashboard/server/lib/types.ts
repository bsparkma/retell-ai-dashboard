/**
 * Core domain types for the CareIN AI Call Dashboard.
 *
 * All external system integrations (Retell, Open Dental) are handled through
 * interfaces so the dashboard can run fully on mock data without live credentials.
 */

// ---------------------------------------------------------------------------
// Commlog write status
// ---------------------------------------------------------------------------

export type CommlogStatus = "pending" | "written" | "failed";

// ---------------------------------------------------------------------------
// Normalized Call record — the canonical shape stored and served by the dashboard
// ---------------------------------------------------------------------------

export interface Call {
  /** Unique call identifier (from Retell or generated for mocks) */
  id: string;
  /** ISO-8601 timestamp when the call started */
  startedAt: string;
  /** ISO-8601 timestamp when the call ended */
  endedAt: string;
  /** Duration in seconds */
  durationSeconds: number;
  /** E.164 caller phone number */
  callerNumber: string;
  /** Caller display name (extracted from transcript or metadata) */
  callerName: string;
  /** Which dental office received the call (mapped from toNumber or metadata) */
  office: string;
  /** Office phone number that received the call */
  toNumber: string;
  /**
   * Call tag / disposition — the primary topic or outcome of the call.
   * Examples: "appointment_scheduled", "appointment_cancelled", "emergency",
   * "billing_inquiry", "voicemail", "transferred", "completed"
   */
  tag: string;
  /** Who the call was routed to (agent name, "Staff", "Voicemail", etc.) */
  routedTo: string;
  /** Raw transcript text */
  transcript: string;
  /**
   * Structured transcript turns: [{role, content}]
   * role: "agent" | "user"
   */
  transcriptObject: Array<{ role: string; content: string }>;
  /** AI-generated summary of the call */
  summary: string;
  /** Call outcome (what was accomplished) */
  outcome: string;
  /** Sentiment derived from call analysis */
  sentiment: "positive" | "neutral" | "negative";
  /** Quality score 0–100 derived from sentiment + duration heuristics */
  qualityScore: number;
  /** URL to the call recording (may be empty) */
  recordingUrl: string;
  /** Whether the call was flagged as an emergency */
  isEmergency: boolean;
  /** Status of the Open Dental commlog write */
  commlogStatus: CommlogStatus;
  /** ISO-8601 timestamp when commlog was written (if applicable) */
  commlogWrittenAt: string | null;
  /** Error message if commlog write failed */
  commlogError: string | null;
  /** Raw Retell call_id for reference */
  retellCallId: string | null;
  /** Ingestion timestamp (when the webhook was received) */
  ingestedAt: string;
}

// ---------------------------------------------------------------------------
// Retell webhook payload shape (call_ended event)
// ---------------------------------------------------------------------------

export interface RetellTranscriptTurn {
  role: "agent" | "user";
  content: string;
}

export interface RetellCallAnalysis {
  call_summary?: string;
  in_voicemail?: boolean;
  user_sentiment?: "Positive" | "Negative" | "Neutral" | "Unknown";
  call_successful?: boolean;
  custom_analysis_data?: Record<string, unknown>;
}

export interface RetellCallPayload {
  call_id: string;
  call_type?: "web_call" | "phone_call";
  agent_id?: string;
  call_status?: string;
  start_timestamp?: number;
  end_timestamp?: number;
  duration_ms?: number;
  from_number?: string;
  to_number?: string;
  call_analysis?: RetellCallAnalysis;
  transcript?: string;
  transcript_object?: RetellTranscriptTurn[];
  recording_url?: string;
  metadata?: Record<string, unknown>;
  disconnection_reason?: string;
}

export interface RetellWebhookPayload {
  event: string;
  call: RetellCallPayload;
}

// ---------------------------------------------------------------------------
// Open Dental commlog writer interface
// ---------------------------------------------------------------------------

export interface CommlogWriteInput {
  callId: string;
  callerName: string;
  callerNumber: string;
  office: string;
  startedAt: string;
  durationSeconds: number;
  summary: string;
  tag: string;
  outcome: string;
}

export interface CommlogWriteResult {
  success: boolean;
  commlogId?: string;
  error?: string;
}

/** Interface for writing call records to Open Dental as commlogs. */
export interface OpenDentalCommlogWriter {
  write(input: CommlogWriteInput): Promise<CommlogWriteResult>;
}

// ---------------------------------------------------------------------------
// Analytics types
// ---------------------------------------------------------------------------

export interface CallCountByType {
  tag: string;
  count: number;
}

export interface CallCountByOutcome {
  outcome: string;
  count: number;
}

export interface DailyCallVolume {
  date: string; // YYYY-MM-DD
  total: number;
  byOffice: Record<string, number>;
  byTag: Record<string, number>;
}

export interface SentimentDistribution {
  positive: number;
  neutral: number;
  negative: number;
}

export interface AnalyticsResult {
  period: { startDate: string; endDate: string; days: number };
  totalCalls: number;
  byTag: CallCountByType[];
  byOutcome: CallCountByOutcome[];
  byOffice: Record<string, number>;
  dailyVolume: DailyCallVolume[];
  sentiment: SentimentDistribution;
  avgQualityScore: number;
  commlogStats: { written: number; pending: number; failed: number };
  avgDurationSeconds: number;
}

// ---------------------------------------------------------------------------
// Filter parameters for listing calls
// ---------------------------------------------------------------------------

export interface CallFilters {
  office?: string;
  startDate?: string;
  endDate?: string;
  tag?: string;
  outcome?: string;
  commlogStatus?: CommlogStatus;
  search?: string;
  limit?: number;
  offset?: number;
}
