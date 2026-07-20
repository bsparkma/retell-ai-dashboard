/**
 * CareIn Dashboard API client
 * Connects to the existing backend at VITE_API_URL (default http://localhost:5000/api)
 *
 * Auth: when VITE_DASHBOARD_API_TOKEN is set, every request includes
 *   `Authorization: Bearer <token>`. The backend requires this token on
 *   /api/* (webhooks and /api/health are exempt). Set the same value as
 *   DASHBOARD_API_TOKEN on the backend.
 */

import type { AgentConfig } from "@/pages/AgentBuilder";

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:5000/api";
const DASHBOARD_TOKEN = (import.meta.env.VITE_DASHBOARD_API_TOKEN ?? "").trim();

async function request<T>(
  path: string,
  options?: RequestInit & { params?: Record<string, string | number | boolean | undefined> }
): Promise<T> {
  const { params, ...init } = options ?? {};
  // Resolve relative bases (e.g. VITE_API_URL="/api" for same-origin prod)
  // against the current origin; absolute URLs ignore the base. Lets the team hit
  // it by LAN IP or hostname without baking a host into the bundle.
  const url = new URL(
    path.startsWith("http") ? path : `${BASE}${path.startsWith("/") ? "" : "/"}${path}`,
    window.location.origin,
  );
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    });
  }
  const authHeaders: Record<string, string> = DASHBOARD_TOKEN
    ? { Authorization: `Bearer ${DASHBOARD_TOKEN}` }
    : {};
  const res = await fetch(url.toString(), {
    ...init,
    // Send the Entra SSO session cookie (HttpOnly) alongside any bearer token.
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders, ...init.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error((err as { message?: string }).message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Backend response types (minimal)
// ---------------------------------------------------------------------------

// --- Slice B: triage worklist + patient review queue ------------------------

/** Who performed a triage/resolve action (from the SSO session). */
export interface CallActor {
  name: string | null;
  email: string | null;
}

export type TriageStatus = "new" | "needs_action" | "done";
export type TriageOutcome =
  | "called_back" | "scheduled" | "left_voicemail" | "no_answer" | "no_action_needed";
export type NotAPatientReason = "spam" | "solicitor" | "wrong_number" | "other";

/** Open Dental commlog sync state written by Slice A. */
export type OdSyncStatus =
  | "synced" | "needs_review" | "pending_match" | "pending" | "error" | "unlinked" | null;

/** A stored patient match candidate for the Pick Patient modal ({ id, name }). */
export interface OdMatchCandidate {
  id: number;
  name: string;
}

/** One office in the worklist selector (from the real agent→office config). */
export interface OfficeConfig {
  officeId: string;
  officeName: string;
  odConnected: boolean;
}

export interface BackendUnifiedCall {
  id: string;
  source?: "retell" | "mango";
  caller_number?: string;
  caller_name?: string;
  call_date?: string;
  duration_seconds?: number;
  duration?: number;
  transcript?: string;
  transcript_object?: Array<{ role?: string; content?: string }>;
  recording_url?: string;
  call_analysis?: { call_summary?: string };
  call_summary?: string;
  summary?: string;
  sentiment?: string;
  metadata?: Record<string, unknown>;
  handler_type?: string;
  is_emergency?: boolean;
  is_new_patient?: boolean | null;
  appointment_booked?: boolean | null;
  dental_insurance?: boolean | null;
  // Slice A — Open Dental sync state
  od_sync_status?: OdSyncStatus;
  od_patient_id?: number | string | null;
  od_patient_name?: string | null;
  od_commlog_num?: number | null;
  od_match_confidence?: number | null;
  od_match_candidates?: OdMatchCandidate[] | null;
  // Slice B — triage / review-queue state
  triage_status?: TriageStatus | null;
  triage_outcome?: TriageOutcome | null;
  triage_by?: CallActor | null;
  triage_at?: string | null;
  triage_note?: string | null;
  not_a_patient?: boolean | null;
  not_a_patient_reason?: NotAPatientReason | null;
  resolved_by?: CallActor | null;
  resolved_at?: string | null;
  [key: string]: unknown;
}

export interface BackendLiveCall {
  call_id: string;
  agent_id?: string;
  agent_name?: string;
  caller_number?: string;
  caller_name?: string;
  started_at?: string;
  duration?: number;
  status?: string;
  is_emergency?: boolean;
  sentiment?: string;
  transcript?: Array<{ role?: string; content?: string; text?: string }>;
  transcript_text?: string;
  [key: string]: unknown;
}

export interface OdPatientAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

export interface OdPatientInsurance {
  primary: string;
  secondary: string;
}

export interface OdPatient {
  id: number;
  firstName: string;
  lastName: string;
  preferredName: string;
  fullName: string;
  dateOfBirth: string;
  phone: string;
  email: string;
  address: OdPatientAddress;
  insurance: OdPatientInsurance;
  lastVisit: string;
  balance: number;
  isActive: boolean;
}

/**
 * Per-tool enable/disable flags for the four Retell custom-function endpoints
 * (`/api/retell-tools/lookup_patient`, `/find_available_slots`,
 * `/book_appointment`, `/create_callback`).
 *
 * The global `RETELL_TOOLS_ENABLED` env var is still the master switch — when
 * it is `false` no tool fires regardless of these flags.
 *
 * Persisted in `data/retell-tools-config.json`. `lastSaved` is ISO-8601 from
 * the server, or `null` if the file has never been written.
 */
export interface RetellToolsConfig {
  lookupPatient: boolean;
  findAvailableSlots: boolean;
  bookAppointment: boolean;
  createCallback: boolean;
  lastSaved: string | null;
}

export interface NotificationsConfig {
  emergencyCallAlerts: boolean;
  missedCallNotifications: boolean;
  dailyCallSummaryEmail: boolean;
  agentErrorAlerts: boolean;
  lastSaved: string | null;
}

export interface AdminServiceStatus {
  status: string;
  connected_clients?: number;
  active_calls?: number;
  webhook_configured?: boolean;
  last_sync?: string | null;
  next_sync?: string | null;
  scheduler_running?: boolean;
  connection_type?: string;
  provider?: string;
  stats?: Record<string, unknown>;
}

export interface AdminHealthData {
  status: string;
  timestamp: string;
  mangoSync?: {
    lastRunAt: string | null;
    lastSuccess: string | null;
    lastErrorAt: string | null;
    lastErrorMessage: string | null;
  } | null;
  services: Record<string, AdminServiceStatus>;
}

export interface AdminCostsData {
  transcription?: {
    provider: string;
    total_minutes: number;
    total_transcriptions: number;
    estimated_cost: number;
    rate: string;
  };
  analysis?: {
    provider: string;
    total_analyses: number;
    total_tokens: number;
    estimated_cost: number;
    rate: string;
  };
  total_estimated: number;
}

export interface AdminConfigData {
  mango?: {
    portal_url?: string;
    sync_schedule?: string;
    max_calls_per_sync?: number;
    download_recordings?: boolean;
    credentials_configured?: boolean;
    enabled?: boolean;
    sync_interval?: string;
    [k: string]: unknown;
  };
  openDental?: {
    enabled?: boolean;
    connection_type?: string;
    api_url_configured?: boolean;
    api_key_configured?: boolean;
    developer_key_configured?: boolean;
    customer_key_configured?: boolean;
    db_url_configured?: boolean;
    api_url?: string;
    [k: string]: unknown;
  };
  transcription?: { provider?: string; configured?: boolean; enabled?: boolean };
  analysis?: { provider?: string; model?: string; configured?: boolean; enabled?: boolean };
}

export interface SyncHistoryEntry {
  id: string;
  started_at: string;
  completed_at?: string;
  calls_processed?: number;
  errors?: string[];
  status?: string;
}

export interface AdminQueuesData {
  transcription: { pending: number; processing: number; completed_today: number };
  analysis: { pending: number; processing: number; completed_today: number };
  open_dental_sync: { pending: number; processing: number; completed_today: number };
}

export interface AdminErrorEntry {
  sync_id: string;
  timestamp: string;
  error: string;
}

export interface BackendCallback {
  id: string;
  patient_name?: string;
  patientName?: string;
  phone?: string;
  reason?: string;
  priority?: string;
  status?: string;
  due_at?: string;
  dueDate?: string;
  attempts?: number;
  last_attempt?: string;
  notes?: string;
  linked_call_id?: string;
  completed_at?: string;
  assigned_to?: string;
  claimed_by?: string | null;
  claimed_at?: string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Normalizers: map backend shape to UI-friendly shape (mock-compatible)
// ---------------------------------------------------------------------------

function extractNameFromText(transcript?: string, summary?: string): string | null {
  // Try summary first
  if (summary) {
    const summaryPatterns = [
      /(?:patient|caller),\s+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})(?:,|\s+(?:called|requested|asked|provided|said)\b)/,
      /(?:patient|caller)\s+named\s+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})\b/,
      /([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+called/i,
      /(?:Mr|Mrs|Ms)\.?\s+([A-Z][a-zA-Z]+)/i,
      /([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+is\s+(?:calling|requesting|asking)/i,
    ];
    const exclude = new Set(["patient", "caller", "person", "user", "someone", "individual", "the", "unknown", "reached", "provided", "requested", "assistant", "office", "appointment", "number"]);
    for (const pat of summaryPatterns) {
      const m = summary.match(pat);
      if (m?.[1]) {
        const name = m[1].trim();
        const words = name.toLowerCase().split(/\s+/);
        if (!words.some((word) => exclude.has(word))) return name;
      }
    }
  }
  // Try transcript
  if (transcript) {
    const transcriptPatterns = [
      /(?:my name is|i'm|this is|i am)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
      /(?:call me|name's|it's)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
      /(?:hi|hello),?\s+(?:my name is|i'm|this is)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
    ];
    const commonWords = new Set(["okay", "yes", "no", "sure", "well", "um", "uh", "the", "that", "this", "here", "calling", "karen", "assistant", "agent", "bot"]);
    for (const pat of transcriptPatterns) {
      const m = transcript.match(pat);
      if (m?.[1]) {
        const name = m[1].trim();
        if (name.length > 1 && !commonWords.has(name.toLowerCase())) {
          return name.charAt(0).toUpperCase() + name.slice(1);
        }
      }
    }
  }
  return null;
}

export function normalizeUnifiedCall(c: BackendUnifiedCall) {
  const date = c.call_date ?? (c as unknown as { start_timestamp?: string }).start_timestamp ?? new Date().toISOString();
  const duration = c.duration_seconds ?? (c.duration as number) ?? 0;
  const summary = c.call_summary ?? c.call_analysis?.call_summary ?? c.summary ?? "";
  return {
    id: c.id,
    source: (c.source === "mango" ? "mango" : "retell") as "retell" | "mango",
    agentName: c.source === "mango" ? "Staff" : "Rover",
    fromNumber: c.caller_number ?? "Unknown",
    patientName: (c.caller_name as string) || extractNameFromText(c.transcript, c.call_summary ?? c.call_analysis?.call_summary ?? c.summary) || c.caller_number || "Unknown",
    patientId: (c.metadata as Record<string, string> | undefined)?.patient_id ?? "",
    duration,
    status: (c.metadata as Record<string, string> | undefined)?.call_status ?? "completed",
    intent: "",
    sentiment: (c.sentiment as "positive" | "neutral" | "negative") ?? "neutral",
    outcome: "",
    date,
    hasRecording: Boolean(c.recording_url),
    hasTranscript: Boolean(c.transcript || (c.transcript_object && c.transcript_object.length > 0)),
    summary,
    isEmergency: c.is_emergency ?? (c.metadata as Record<string, boolean> | undefined)?.is_emergency ?? false,
    transcript: c.transcript,
    transcript_object: c.transcript_object,
    recording_url: c.recording_url,

    // Disposition signals for the worklist chips (from call analysis; absent → false).
    isNewPatient: c.is_new_patient ?? false,
    appointmentBooked: c.appointment_booked ?? false,
    insuranceMentioned: c.dental_insurance ?? false,

    // Slice A — Open Dental patient linkage / review state
    odSyncStatus: (c.od_sync_status ?? null) as OdSyncStatus,
    odPatientId: c.od_patient_id ?? null,
    odPatientName: c.od_patient_name ?? null,
    odCommlogNum: c.od_commlog_num ?? null,
    odMatchConfidence: c.od_match_confidence ?? null,
    odMatchCandidates: (c.od_match_candidates ?? []) as OdMatchCandidate[],

    // Slice B — triage / review-queue state (triage_status defaults to "new")
    triageStatus: (c.triage_status ?? "new") as TriageStatus,
    triageOutcome: (c.triage_outcome ?? null) as TriageOutcome | null,
    triageBy: (c.triage_by ?? null) as CallActor | null,
    triageAt: c.triage_at ?? null,
    triageNote: c.triage_note ?? null,
    notAPatient: Boolean(c.not_a_patient),
    notAPatientReason: (c.not_a_patient_reason ?? null) as NotAPatientReason | null,
    resolvedBy: (c.resolved_by ?? null) as CallActor | null,
    resolvedAt: c.resolved_at ?? null,
  };
}

export function normalizeLiveCall(c: BackendLiveCall) {
  const transcript = (c.transcript ?? []).map((u) => ({
    role: (u.role ?? "user") as "agent" | "patient" | "user",
    text: (u.content ?? u.text ?? "") as string,
    ts: 0,
  }));
  return {
    id: c.call_id,
    source: "retell" as const,
    agentId: c.agent_id ?? "",
    agentName: c.agent_name ?? "AI Agent",
    fromNumber: c.caller_number ?? "Unknown",
    patientName: c.caller_name ?? "Unknown",
    duration: c.duration ?? 0,
    status: "active" as const,
    intent: "",
    sentiment: (c.sentiment as "positive" | "neutral" | "negative") ?? "neutral",
    transcript,
    startTime: c.started_at ?? new Date().toISOString(),
    isEmergency: c.is_emergency ?? false,
  };
}

export function normalizeCallback(c: BackendCallback) {
  return {
    id: c.id,
    patientName: String((c.patient_name ?? c.patientName ?? (c as Record<string, unknown>).caller_name) ?? "Unknown"),
    phone: String((c.phone ?? (c as Record<string, unknown>).caller_number) ?? ""),
    reason: String(c.reason ?? ""),
    priority: (c.priority as "high" | "medium" | "low") ?? "medium",
    status: (c.status as "pending" | "in-progress" | "completed" | "failed") ?? "pending",
    dueDate: (c.due_at ?? c.dueDate) ?? "",
    attempts: c.attempts ?? 0,
    lastAttempt: c.last_attempt,
    notes: c.notes,
    linkedCallId: c.linked_call_id,
    completedAt: c.completed_at,
    assignedTo: c.assigned_to,
    claimed_by: c.claimed_by ?? null,
    claimed_at: c.claimed_at ?? null,
  };
}

/** Display shape for a unified call (from API or normalized) */
export type UnifiedCall = ReturnType<typeof normalizeUnifiedCall>;
/** Display shape for a callback */
export type CallbackDisplay = ReturnType<typeof normalizeCallback>;

// ---------------------------------------------------------------------------
// API methods
// ---------------------------------------------------------------------------

export const api = {
  async getUnifiedCalls(params?: {
    source?: string;
    limit?: number;
    offset?: number;
    start_date?: string;
    end_date?: string;
    search?: string;
    office_id?: string;
  }) {
    const data = await request<{
      calls: BackendUnifiedCall[];
      total?: number;
      stats?: unknown;
      offices?: OfficeConfig[];
    }>("/unified-calls", { params: params as Record<string, string | number | boolean | undefined> });
    return {
      calls: (data.calls ?? []).map(normalizeUnifiedCall),
      total: data.total ?? data.calls?.length ?? 0,
      stats: data.stats,
      offices: data.offices ?? [],
    };
  },

  /**
   * Set a call's triage state (worklist). `triage_outcome` is required when
   * `triage_status === 'done'`. Returns the updated raw call record.
   */
  async triageCall(
    id: string,
    body: { triage_status: TriageStatus; triage_outcome?: TriageOutcome; triage_note?: string }
  ): Promise<BackendUnifiedCall> {
    return request<BackendUnifiedCall>(`/unified-calls/${encodeURIComponent(id)}/triage`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  },

  /**
   * Resolve a needs-review call to a patient (writes the CareIN commlog via the
   * idempotent Slice-A path) OR close it out as "not a patient" (no OD write).
   */
  async resolvePatient(
    id: string,
    body: { patientId: number } | { notAPatient: true; reason: NotAPatientReason }
  ): Promise<{ success: boolean; alreadySynced?: boolean; commLogNum?: number | null; call?: BackendUnifiedCall }> {
    return request(`/unified-calls/${encodeURIComponent(id)}/resolve-patient`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** Office roster for the global office selector (agent→office config + odConnected). */
  async getOffices(): Promise<OfficeConfig[]> {
    const data = await request<{ offices?: OfficeConfig[] }>("/unified-calls/offices");
    return data.offices ?? [];
  },

  /** Search Open Dental patients for the Pick Patient modal (LName/FName/Phone). */
  async searchPatients(q: string): Promise<OdPatient[]> {
    if (!q || q.trim().length < 2) return [];
    try {
      const res = await request<{ success: boolean; patients: OdPatient[]; count: number }>(
        `/opendental/patients/search?q=${encodeURIComponent(q.trim())}`
      );
      return res.patients ?? [];
    } catch {
      return [];
    }
  },

  async getUnifiedCall(id: string) {
    const c = await request<BackendUnifiedCall>(`/unified-calls/${encodeURIComponent(id)}`);
    return normalizeUnifiedCall(c);
  },

  async getUnifiedStats() {
    return request<{ bySource?: Record<string, number>; lastSync?: Record<string, string> }>("/unified-calls/stats");
  },

  async syncRetell(options?: { limit?: number; offset?: number }) {
    return request<{ message?: string; added?: number }>("/unified-calls/sync-retell", {
      method: "POST",
      body: JSON.stringify(options ?? {}),
    });
  },

  async getCallbacks(params?: { status?: string; priority?: string }) {
    const data = await request<{ callbacks?: BackendCallback[] }>("/callbacks", {
      params: params as Record<string, string>,
    });
    return (data.callbacks ?? []).map(normalizeCallback);
  },

  async getCallbackStats() {
    return request<{ stats?: { total?: number; pending?: number; overdue?: number } }>("/callbacks/stats");
  },

  async getCallback(id: string) {
    const data = await request<{ callback: BackendCallback }>(`/callbacks/${id}`);
    return normalizeCallback(data.callback);
  },

  async updateCallback(id: string, updates: Partial<BackendCallback>) {
    await request(`/callbacks/${id}`, { method: "PATCH", body: JSON.stringify(updates) });
  },

  async logCallbackAttempt(
    id: string,
    data?: { result?: "completed" | "no_answer"; notes?: string }
  ): Promise<void> {
    await request(`/callbacks/${encodeURIComponent(id)}/attempt`, {
      method: "POST",
      body: JSON.stringify(data ?? {}),
    });
  },

  async deleteCallback(id: string): Promise<void> {
    await request(`/callbacks/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  async claimCallback(id: string, claimedBy: string | null): Promise<CallbackDisplay> {
    const res = await request<{ success: boolean; callback: BackendCallback }>(
      `/callbacks/${encodeURIComponent(id)}/claim`,
      { method: 'PATCH', body: JSON.stringify({ claimed_by: claimedBy }) }
    );
    return normalizeCallback(res.callback);
  },

  async getLiveCalls() {
    const data = await request<BackendLiveCall[] | { calls?: BackendLiveCall[] }>("/live-calls");
    const list = Array.isArray(data) ? data : (data as { calls?: BackendLiveCall[] }).calls ?? [];
    return list.map(normalizeLiveCall);
  },

  async getHealth() {
    return request<{ status?: string; services?: unknown; realtime?: { active_calls?: number } }>("/health");
  },

  /** Returns { appointments, providers, operatories } from Open Dental. Calendar shows only scheduled appointments for the date (no patient list). */
  async getOpenDentalCalendar(params?: { date?: string; providerIds?: string[]; operatoryIds?: string[] }) {
    const p: Record<string, string> = {};
    if (params?.date) p.date = params.date;
    if (params?.providerIds?.length) p.providerIds = params.providerIds.join(",");
    if (params?.operatoryIds?.length) p.operatoryIds = params.operatoryIds.join(",");
    const data = await request<{
      appointments?: unknown[];
      providers?: Array<{ id?: number; name?: string; abbr?: string }>;
      operatories?: Array<{ id?: number; name?: string; abbr?: string; isHidden?: boolean }>;
    }>("/opendental/calendar", { params: p });
    const appointments = Array.isArray(data?.appointments) ? data.appointments : [];
    const providers = Array.isArray(data?.providers) ? data.providers : [];
    const operatories = Array.isArray(data?.operatories) ? data.operatories : [];
    return { appointments, providers, operatories };
  },

  async getOpenDentalAppointmentsRange(params: { startDate: string; endDate: string }) {
    return request<unknown[]>("/opendental/appointments/range", { params: params as Record<string, string> });
  },

  /** Lazy-load patient for drawer. GET /api/opendental/patients/:id */
  async getOpenDentalPatient(patientId: number): Promise<OdPatient> {
    const res = await request<{ success: boolean; patient: OdPatient }>(
      `/opendental/patients/${patientId}`
    );
    return res.patient;
  },

  /**
   * Look up an Open Dental patient by phone number.
   * Returns the first match or null. Network/server failures resolve to null
   * so callers can fall through to a no-match UI without try/catch.
   */
  async searchPatientByPhone(phone: string): Promise<OdPatient | null> {
    try {
      const res = await request<{
        success: boolean;
        patients: OdPatient[];
        count: number;
      }>(`/opendental/patients/search?q=${encodeURIComponent(phone)}`);
      return res.patients.length > 0 ? res.patients[0] : null;
    } catch {
      return null;
    }
  },

  async getAgents() {
    return request<{
      agents: Array<{ agent_id: string; agent_name?: string; voice_id?: string; status?: string; updated_at?: string }>;
      total: number;
      source: "api" | "mock";
    }>("/agents");
  },

  async getAgent(id: string) {
    return request<unknown>(`/agents/${id}`);
  },

  /**
   * Push a new prompt (and optionally other fields) to a Retell agent.
   * Backend forwards to retellService.updateAgent which calls Retell's
   * PATCH /update-agent/{agent_id}. Response.source === 'mock' means
   * Retell rejected the update and we fell back to a simulated response —
   * surface that to the user honestly.
   */
  async publishAgent(
    id: string,
    updates: { prompt?: string; agent_name?: string }
  ) {
    return request<{
      agent_id: string;
      prompt?: string;
      updated_at?: string;
      source: "api" | "mock";
      [key: string]: unknown;
    }>(`/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
  },

  // ---------------------------------------------------------------------------
  // Admin endpoints
  // ---------------------------------------------------------------------------

  async getAdminHealth(): Promise<AdminHealthData> {
    return request<AdminHealthData>("/admin/health");
  },

  async getAdminConfig(): Promise<{ success: boolean; config: AdminConfigData }> {
    return request<{ success: boolean; config: AdminConfigData }>("/admin/config");
  },

  async getAdminCosts(): Promise<{ success: boolean; costs: AdminCostsData }> {
    return request<{ success: boolean; costs: AdminCostsData }>("/admin/costs");
  },

  async getAdminSyncStatus() {
    return request<{ success: boolean; sync: Record<string, unknown>; scraper: Record<string, unknown> }>("/admin/sync-status");
  },

  async testConnection(service: string) {
    return request<{ success: boolean; message: string }>("/admin/test-connection", {
      method: "POST",
      body: JSON.stringify({ service }),
    });
  },

  async triggerMangoSync() {
    return request<{ success: boolean; message: string }>("/admin/sync/run", { method: "POST" });
  },

  async getAdminSyncHistory(): Promise<{ success: boolean; history: SyncHistoryEntry[] }> {
    return request<{ success: boolean; history: SyncHistoryEntry[] }>("/admin/sync/history");
  },

  async startMangoScheduler(): Promise<{ success: boolean; message: string }> {
    return request<{ success: boolean; message: string }>("/admin/sync/start", { method: "POST" });
  },

  async stopMangoScheduler(): Promise<{ success: boolean; message: string }> {
    return request<{ success: boolean; message: string }>("/admin/sync/stop", { method: "POST" });
  },

  async getAdminQueues(): Promise<{ success: boolean; queues: AdminQueuesData }> {
    return request<{ success: boolean; queues: AdminQueuesData }>("/admin/queues");
  },

  async getAdminErrors(): Promise<{ success: boolean; errors: AdminErrorEntry[] }> {
    return request<{ success: boolean; errors: AdminErrorEntry[] }>("/admin/errors");
  },

  async getNotificationsConfig(): Promise<NotificationsConfig> {
    const res = await request<{ success: boolean; config: NotificationsConfig }>("/notifications-config");
    return res.config;
  },

  async saveNotificationsConfig(config: Omit<NotificationsConfig, "lastSaved">): Promise<NotificationsConfig> {
    const res = await request<{ success: boolean; config: NotificationsConfig }>(
      "/notifications-config",
      { method: "PUT", body: JSON.stringify(config) }
    );
    return res.config;
  },

  // ---------------------------------------------------------------------------
  // Analytics endpoints
  // ---------------------------------------------------------------------------

  async getAnalyticsSummary(params?: { days?: number; office_id?: string }) {
    return request<{
      success: boolean;
      period: { days: number; startDate: string; endDate: string };
      kpis: {
        totalCalls: number;
        aiHandled: number;
        staffHandled: number;
        aiHandledPct: number;
        avgDurationSec: number;
        emergencyCalls: number;
        missedCalls: number;
      };
      callVolume: Array<{ date: string; retell: number; mango: number }>;
      intentBreakdown: Array<{ name: string; value: number }>;
      sentimentTrend: Array<{ date: string; positive: number; neutral: number; negative: number }>;
      hourlyVolume: Array<{ hour: string; calls: number }>;
    }>("/analytics/summary", {
      params: params as Record<string, string | number | boolean | undefined>,
    });
  },

  // ---------------------------------------------------------------------------
  // Scheduling endpoints (for calendar open slots)
  // ---------------------------------------------------------------------------

  async findAvailableSlots(params: {
    appointmentData: { duration: number; providerId?: number; operatoryId?: number };
    startDate?: string;
    endDate?: string;
    preferredTimes?: string[];
    maxResults?: number;
  }) {
    return request<{ slots: Array<{ date: string; time: string; providerId?: number; operatoryId?: number }> }>(
      "/opendental/appointments/find-slots",
      { method: "POST", body: JSON.stringify(params) }
    );
  },

  // ---------------------------------------------------------------------------
  // Agent Builder config (knowledge base + system prompt)
  //
  // Backed by `data/agent-config.json` on the server. Replaces the previous
  // localStorage-only flow so every staff device sees the same config and
  // browser-cache clears don't wipe the practice's knowledge base.
  // ---------------------------------------------------------------------------

  async getAgentConfig(): Promise<AgentConfig> {
    const res = await request<{ success: boolean; config: AgentConfig }>(
      "/agent-config"
    );
    return res.config;
  },

  async saveAgentConfig(config: AgentConfig): Promise<AgentConfig> {
    const res = await request<{ success: boolean; config: AgentConfig }>(
      "/agent-config",
      { method: "PUT", body: JSON.stringify(config) }
    );
    return res.config;
  },

  // ---------------------------------------------------------------------------
  // Retell tools per-tool enable/disable config
  //
  // Backed by `data/retell-tools-config.json` on the server. Used by the
  // Agent Tools card on the Agent Builder page. The save shape omits
  // `lastSaved` because the server stamps it on every PUT.
  // ---------------------------------------------------------------------------

  async getRetellToolsConfig(): Promise<RetellToolsConfig> {
    const res = await request<{ success: boolean; config: RetellToolsConfig }>(
      "/retell-tools-config"
    );
    return res.config;
  },

  async saveRetellToolsConfig(
    config: Omit<RetellToolsConfig, "lastSaved">
  ): Promise<RetellToolsConfig> {
    const res = await request<{ success: boolean; config: RetellToolsConfig }>(
      "/retell-tools-config",
      { method: "PUT", body: JSON.stringify(config) }
    );
    return res.config;
  },

  async getScheduleOverview(params?: { date?: string; providerId?: number }) {
    return request<{
      appointments: unknown[];
      providers: unknown[];
      operatories: unknown[];
      metrics: {
        totalAppointments: number;
        totalSlots: number;
        bookedSlots: number;
        availabilityPercentage: number;
        hasAvailability: boolean;
      };
    }>("/opendental/ai/schedule-overview", {
      params: params as Record<string, string | number | boolean | undefined>,
    });
  },
};

export default api;

// ---------------------------------------------------------------------------
// CareIN Call Dashboard — direct API client
//
// These methods call the new CareIN ingestion server (default port 3000).
// They are completely separate from the existing `api` object above and do
// NOT affect any existing functionality.
//
// In dev: start the CareIN server with `npx tsx server/index.ts` from the
// new-dashboard directory. In production both are served from the same origin.
// ---------------------------------------------------------------------------

// In dev: CareIN server runs on port 3000 alongside Vite (3005).
// In prod: the built dashboard is served by the CareIN Express server itself,
// so /api is same-origin. Use window.location.origin to avoid baking a host
// into the bundle (lets the team hit it by LAN IP or hostname).
const CAREIN_BASE =
  (import.meta.env.VITE_CAREIN_API_URL as string | undefined) ??
  (import.meta.env.PROD
    ? `${window.location.origin}/api`
    : "http://localhost:3000/api");

async function careInRequest<T>(
  path: string,
  options?: RequestInit & { params?: Record<string, string | undefined> }
): Promise<T> {
  const { params, ...init } = options ?? {};
  const url = new URL(`${CAREIN_BASE}${path.startsWith("/") ? "" : "/"}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    });
  }
  const res = await fetch(url.toString(), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// CareIN call record shape (mirrors server/lib/types.ts Call)
// ---------------------------------------------------------------------------

export type CareInCommlogStatus = "pending" | "written" | "failed";
export type CareInSentiment = "positive" | "neutral" | "negative";

export interface CareInCall {
  id: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  callerNumber: string;
  callerName: string;
  office: string;
  toNumber: string;
  tag: string;
  routedTo: string;
  transcript: string;
  transcriptObject: Array<{ role: string; content: string }>;
  summary: string;
  outcome: string;
  sentiment: CareInSentiment;
  qualityScore: number;
  recordingUrl: string;
  isEmergency: boolean;
  commlogStatus: CareInCommlogStatus;
  commlogWrittenAt: string | null;
  commlogError: string | null;
  retellCallId: string | null;
  ingestedAt: string;
}

export interface CareInAnalytics {
  period: { startDate: string; endDate: string; days: number };
  totalCalls: number;
  byTag: Array<{ tag: string; count: number }>;
  byOutcome: Array<{ outcome: string; count: number }>;
  byOffice: Record<string, number>;
  dailyVolume: Array<{
    date: string;
    total: number;
    byOffice: Record<string, number>;
    byTag: Record<string, number>;
  }>;
  sentiment: { positive: number; neutral: number; negative: number };
  avgQualityScore: number;
  commlogStats: { written: number; pending: number; failed: number };
  avgDurationSeconds: number;
}

// ---------------------------------------------------------------------------
// API methods
// ---------------------------------------------------------------------------

export const careInApi = {
  /**
   * List CareIN calls with optional filters.
   * Returns the calls array, total count, and available offices/tags for filters.
   */
  async getCalls(params?: {
    office?: string;
    start_date?: string;
    end_date?: string;
    tag?: string;
    outcome?: string;
    commlog_status?: CareInCommlogStatus;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ calls: CareInCall[]; total: number; offices: string[]; tags: string[] }> {
    return careInRequest<{ calls: CareInCall[]; total: number; offices: string[]; tags: string[] }>(
      "/calls",
      {
        params: params
          ? Object.fromEntries(
              Object.entries(params).map(([k, v]) => [k, v != null ? String(v) : undefined])
            ) as Record<string, string | undefined>
          : undefined,
      }
    );
  },

  /** Get a single CareIN call by ID. */
  async getCall(id: string): Promise<CareInCall> {
    return careInRequest<CareInCall>(`/calls/${encodeURIComponent(id)}`);
  },

  /** Retry the commlog write for a failed or pending call. */
  async retryCommlog(id: string): Promise<{ success: boolean; call: CareInCall; error?: string }> {
    return careInRequest<{ success: boolean; call: CareInCall; error?: string }>(
      `/calls/${encodeURIComponent(id)}/retry-commlog`,
      { method: "POST" }
    );
  },

  /** Fetch analytics aggregations. */
  async getAnalytics(params?: {
    days?: number;
    office?: string;
  }): Promise<CareInAnalytics> {
    return careInRequest<{ success: boolean } & CareInAnalytics>("/analytics/calls", {
      params: params
        ? Object.fromEntries(
            Object.entries(params).map(([k, v]) => [k, v != null ? String(v) : undefined])
          ) as Record<string, string | undefined>
        : undefined,
    });
  },
};
