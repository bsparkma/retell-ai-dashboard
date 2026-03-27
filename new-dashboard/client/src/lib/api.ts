/**
 * CareIn Dashboard API client
 * Connects to the existing backend at VITE_API_URL (default http://localhost:5000/api)
 */

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:5000/api";

async function request<T>(
  path: string,
  options?: RequestInit & { params?: Record<string, string | number | boolean | undefined> }
): Promise<T> {
  const { params, ...init } = options ?? {};
  const url = new URL(path.startsWith("http") ? path : `${BASE}${path.startsWith("/") ? "" : "/"}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    });
  }
  const res = await fetch(url.toString(), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
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
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Normalizers: map backend shape to UI-friendly shape (mock-compatible)
// ---------------------------------------------------------------------------

function extractNameFromText(transcript?: string, summary?: string): string | null {
  // Try summary first
  if (summary) {
    const summaryPatterns = [
      /patient\s+(?:named?\s+)?([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
      /caller\s+(?:named?\s+)?([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
      /([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+called/i,
      /(?:Mr|Mrs|Ms)\.?\s+([A-Z][a-zA-Z]+)/i,
      /([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+is\s+(?:calling|requesting|asking)/i,
    ];
    const exclude = new Set(["patient", "caller", "person", "user", "someone", "individual", "the", "unknown"]);
    for (const pat of summaryPatterns) {
      const m = summary.match(pat);
      if (m?.[1] && !exclude.has(m[1].toLowerCase())) return m[1].trim();
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
    isEmergency: (c.metadata as Record<string, boolean> | undefined)?.is_emergency ?? false,
    transcript: c.transcript,
    transcript_object: c.transcript_object,
    recording_url: c.recording_url,
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
    status: (c.status as "pending" | "in-progress" | "completed") ?? "pending",
    dueDate: (c.due_at ?? c.dueDate) ?? "",
    attempts: c.attempts ?? 0,
    lastAttempt: c.last_attempt,
    notes: c.notes,
    linkedCallId: c.linked_call_id,
    completedAt: c.completed_at,
    assignedTo: c.assigned_to,
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
  }) {
    const data = await request<{ calls: BackendUnifiedCall[]; total?: number; stats?: unknown }>(
      "/unified-calls",
      { params: params as Record<string, string | number | boolean | undefined> }
    );
    return {
      calls: (data.calls ?? []).map(normalizeUnifiedCall),
      total: data.total ?? data.calls?.length ?? 0,
      stats: data.stats,
    };
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

  async logCallbackAttempt(id: string) {
    await request(`/callbacks/${id}/attempt`, { method: "POST" });
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
  async getOpenDentalPatient(patientId: number) {
    return request<Record<string, unknown>>(`/opendental/patients/${patientId}`);
  },

  async getAgents() {
    return request<unknown[]>("/agents");
  },

  async getAgent(id: string) {
    return request<unknown>(`/agents/${id}`);
  },

  // ---------------------------------------------------------------------------
  // Admin endpoints
  // ---------------------------------------------------------------------------

  async getAdminHealth() {
    return request<{ status: string; timestamp: string; services: Record<string, unknown> }>("/admin/health");
  },

  async getAdminConfig() {
    return request<{ success: boolean; config: Record<string, unknown> }>("/admin/config");
  },

  async getAdminCosts() {
    return request<{ success: boolean; costs: Record<string, unknown> }>("/admin/costs");
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
