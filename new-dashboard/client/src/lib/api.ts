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

/**
 * One authenticated fetch, returning the RAW Response. Base-URL resolution, the SSO
 * cookie and the bearer token live here so every caller gets them — including the few
 * (M4's transcribe) that need to read a typed body on a non-2xx status rather than have
 * it collapsed into an Error.
 */
async function apiFetch(
  path: string,
  options?: RequestInit & { params?: Record<string, string | number | boolean | undefined> }
): Promise<Response> {
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
  if (res.status === 401) handleUnauthorized();
  return res;
}

/** Set by the app shell so this module can toast without importing the UI. */
let onUnauthorized: (() => void) | null = null;

/**
 * Register the app's 401 reaction (Roles PR B).
 *
 * Injected rather than imported so `lib/api` stays free of `sonner` and
 * `window` — the pure-node tests import this module and must not drag a toast
 * library or a DOM in with it.
 */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/**
 * The 8-hour SSO session expires, or the container restarts and drops the
 * signing key. Before this, every in-flight call turned into an unexplained
 * red toast and the page just stopped working until someone thought to reload.
 *
 * ONLY 401 — "we do not know who you are". A 403 means we know exactly who you
 * are and the answer is no; signing a user out for it would be both wrong and
 * infuriating, so 403s stay ordinary errors that pages render as permission
 * states.
 *
 * Guarded so a page firing six parallel requests against a dead session
 * produces one sign-out, not six.
 */
let unauthorizedFired = false;
export function handleUnauthorized(): void {
  if (unauthorizedFired) return;
  unauthorizedFired = true;
  if (onUnauthorized) onUnauthorized();
}

/** Test seam — lets a test observe a second 401 after asserting the first. */
export function _resetUnauthorizedLatch(): void {
  unauthorizedFired = false;
}

/**
 * A non-2xx API response, with the parts a caller needs to react precisely:
 * the HTTP `status` and the backend's structured `code`. Still an Error, so the
 * many `err instanceof Error ? err.message` call sites keep working unchanged.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** Seconds the server asked us to wait, from `Retry-After` (429 only). */
  readonly retryAfter: number | null;
  constructor(
    message: string,
    status: number,
    code: string | null,
    retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * Is this "the server is throttling us" rather than "the server is unreachable"?
 *
 * The difference matters to whoever is looking at the screen: throttled means wait a
 * moment and it will come back on its own; offline means something is broken and their
 * work may not be saving. The dashboard rendered both as "Backend is offline", which
 * sent people to reload a backend that was answering perfectly well.
 */
export function isRateLimited(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 429;
}

async function request<T>(
  path: string,
  options?: RequestInit & { params?: Record<string, string | number | boolean | undefined> }
): Promise<T> {
  const res = await apiFetch(path, options);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as {
      message?: string; error?: string; code?: string; retryAfter?: number;
    };
    // Prefer the header (the HTTP contract) and fall back to the body. Optional-chained
    // because not every Response-shaped thing carries headers — a bare `{ ok, json }`
    // stub is a perfectly reasonable thing for a caller or a test to hand us, and a
    // missing header must not turn an ordinary error into a TypeError.
    const headerRetry = Number.parseInt(res.headers?.get?.("retry-after") ?? "", 10);
    const retryAfter = Number.isFinite(headerRetry)
      ? headerRetry
      : typeof err.retryAfter === "number" ? err.retryAfter : null;
    throw new ApiError(
      err.message ?? err.error ?? res.statusText ?? `HTTP ${res.status}`,
      res.status,
      err.code ?? null,
      retryAfter,
    );
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Backend response types (minimal)
// ---------------------------------------------------------------------------

// --- tenant user management (Roles PR B) ------------------------------------

export type TenantUserRole = "admin" | "office" | "tc" | "hygiene" | "reviewer";
export type TenantUserStatus = "active" | "disabled";

/** One row of the tenant's `app_user` table, as /api/users renders it. */
export interface TenantUser {
  email: string;
  role: TenantUserRole;
  status: TenantUserStatus;
  /** null until the person has actually signed in at least once. */
  lastLoginAt: string | null;
  /**
   * The office this person usually works at, or null for none.
   *
   * A DEFAULT for their office picker — it grants and denies nothing, and every
   * office stays reachable. null is a real answer, not a gap: shared accounts
   * (temp@) are meant to have none.
   */
  homeOffice: string | null;
}

export interface TenantUsersResponse {
  users: TenantUser[];
  /** The server's role vocabulary — the picker's options come from here. */
  roles: TenantUserRole[];
  /**
   * The offices a home office may be set to, from the server's config. The
   * page must not carry its own copy: opening an office is a config change,
   * and a hardcoded list would silently omit the new one.
   */
  offices: { officeId: string; officeName: string }[];
  /** The signed-in admin's own address, so the UI can mark their row. */
  actor: string;
}

// --- platform console (PR C, /api/platform) ---------------------------------

/**
 * A module namespace. Mirrors `backend/config/modules.js`, which mirrors the
 * tenant_module CHECK constraint — a union rather than `string` so a namespace
 * the database would refuse cannot be typed into a request here either.
 */
export type ModuleName = "voice" | "tc" | "rcm" | "hyg" | "scheduling";

/** One module's state for one practice, with the copy the console renders. */
export interface PracticeModule {
  module: ModuleName;
  label: string;
  blurb: string;
  enabled: boolean;
}

/** One row of the tenant catalog. */
export interface Practice {
  tenantId: string;
  slug: string;
  displayName: string;
  status: string;
  createdAt: string | null;
  /** Every app_user row, active and disabled — the roster size. */
  userCount: number;
  /** Always all four namespaces; one with no DB row reads as `enabled: false`. */
  modules: PracticeModule[];
}

/** One practice's roster. READ-ONLY here — writes live on /admin/users. */
export interface PracticeUsersResponse {
  users: TenantUser[];
  roles: TenantUserRole[];
  /** Where the writes actually are, so this page can link rather than fork. */
  manageAt: string;
}

/** The vocabularies audit_log's CHECK constraints admit. */
export type AuditAction = "READ" | "CREATE" | "UPDATE" | "DELETE";
export type AuditResult = "SUCCESS" | "UNAUTHORIZED" | "ERROR";

/** One audit row. IDs and actors only — this table never holds a PHI value. */
export interface AuditEntry {
  auditId: string;
  ts: string | null;
  actor: string | null;
  action: AuditAction;
  resourceType: string;
  resourceId: string | null;
  ip: string | null;
  result: AuditResult;
  endpoint: string | null;
  office: string | null;
  sourceRef: string | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Total matching the CURRENT filters, not the table size. */
  total: number;
  limit: number;
  offset: number;
}

export interface AuditFilters {
  action?: AuditAction;
  result?: AuditResult;
  resourceType?: string;
  resourceId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/**
 * Where the effective retention window came from.
 *
 * `db` a super_admin chose it · `env` CALL_RETENTION_DAYS is set and no row
 * exists · `default` neither. The console shows this because "30 because nobody
 * has chosen" and "30 because somebody chose it" are different facts.
 */
export type RetentionSource = "db" | "env" | "default";

export interface RetentionPolicy {
  days: number;
  source: RetentionSource;
  enabled: boolean;
  /**
   * False when the control plane has never been readable since boot. The
   * nightly prune SKIPS in that state rather than falling back to the
   * environment — see docs/PLATFORM_CONSOLE.md.
   */
  policyKnown: boolean;
  dbDays: number | null;
  envDays: number;
  envDaysIsSet: boolean;
  /** The windows a click may choose. Rendered from here, never hardcoded. */
  options: number[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface RetentionSchedulerStatus {
  running: boolean;
  schedule: string;
  timezone: string;
  retentionDays: number;
  enabled: boolean;
  source: RetentionSource;
  policyKnown: boolean;
  lastRun: { at?: string; stubbed?: number; scanned?: number; skipped?: string } | null;
}

export interface RetentionState {
  policy: RetentionPolicy;
  scheduler: RetentionSchedulerStatus;
  store: { totalCalls: number; liveCalls: number; prunedCalls: number };
  /** Non-null when the control plane could not be read on this request. */
  controlPlaneError?: string | null;
}

/** What shortening (or extending) to `days` would cost, computed server-side. */
export interface RetentionImpact {
  days: number;
  currentDays: number;
  shortening: boolean;
  /** Live calls that would fall outside the proposed window at the next run. */
  wouldPrune: number;
  alreadyPruned: number;
}

/** The nightly prune's result, from POST /api/admin/call-store/prune. */
export interface PruneResult {
  scanned?: number;
  stubbed?: number;
  alreadyStubbed?: number;
  cutoff?: string | null;
  durationMs?: number;
  skipped?: string;
}

/** The legacy purge's result. Counts and ids only — never a caller name. */
export interface PurgeResult {
  dryRun: boolean;
  count: number;
  bySource?: Record<string, number>;
  ids: string[];
  skippedTwinned: string[];
  deleted: number;
  /** Where the pre-delete backup landed. Null on a dry run. */
  backupPath: string | null;
}

// --- Slice B: triage worklist + patient review queue ------------------------

/** Who performed a triage/resolve action (from the SSO session). */
export interface CallActor {
  name: string | null;
  email: string | null;
}

export type TriageStatus = "new" | "needs_action" | "done";
export type TriageOutcome =
  | "called_back" | "scheduled" | "left_voicemail" | "no_answer" | "no_action_needed";
export type NotAPatientReason = "spam" | "solicitor" | "vendor" | "lab" | "wrong_number" | "other";

// --- Call dispositions + internal notes -------------------------------------

/**
 * WHAT KIND of call this was, for the calls that need neither a chart note nor a
 * TC case — a lab confirming a case, a supply vendor, a pharmacy. Closed union on
 * purpose: the backend validates against the same seven values
 * (backend/utils/callDispositions.js), so a value added there has to be added
 * here too, and that is a compile error rather than a chip that never renders.
 *
 * Distinct from NotAPatientReason despite the overlap: that one answers "is the
 * caller a patient?" and gates the review queue.
 */
export type CallDisposition =
  | "lab" | "vendor" | "pharmacy" | "insurance" | "personal" | "spam" | "other";

/** One internal note on a call. Append-only — there is no edit route. */
export interface CallNote {
  id: string;
  text: string;
  /** From the SSO session at write time; null only on a dev box with no session. */
  author: CallActor | null;
  createdAt: string;
}

/** The wire shape of a note (the store speaks snake_case). */
export interface BackendCallNote {
  id: string;
  text: string;
  author?: CallActor | null;
  created_at?: string;
}

/**
 * Worklist behaviour for Mango staff calls (PRD D1, backend-owned via MANGO_WORKLIST_MODE).
 * 'all' = every Mango call demands attention like a Retell call; 'flagged' = only
 * emergency / appointment-requested / callback-needed Mango calls demand attention.
 */
export type MangoWorklistMode = "all" | "flagged";

// --- Sync now: one button, both sources -------------------------------------

/** How long the client waits for a manual sync before giving up (both sources, one pull). */
const SYNC_NOW_TIMEOUT_MS = 90_000;

/**
 * What happened to ONE source in a manual sync. 'off' and 'already_running' are honest
 * states, NOT errors — the UI must never render them red. Switching on this union means
 * a new state added by the backend becomes a compile error here rather than a shrug.
 */
export type SyncSourceResult =
  | { status: "ok"; added?: number; fetched?: number; found?: number; imported?: number }
  | { status: "off" }
  | { status: "already_running" }
  | { status: "error"; message?: string };

/** The sync-now response body (HTTP 200, or 502 when BOTH sources failed). */
export interface SyncNowResponse {
  retell: SyncSourceResult;
  mango: SyncSourceResult;
  lastSyncedAt: string | null;
  nextAutoSync: string | null;
}

/** The 429 body: a sync ran moments ago, try again in `retryAfter` seconds. */
export interface SyncCooldown {
  retryAfter: number;
  lastSyncedAt: string | null;
}

/** `syncNow()` returns the refusal as data — a cooldown is not an error. */
export type SyncNowResult =
  | ({ kind: "result" } & SyncNowResponse)
  | ({ kind: "cooldown" } & SyncCooldown);

/** How Mango ingestion is configured in THIS environment (staging runs it dark). */
export type MangoIngestMode = "api" | "off" | "disabled";

/** GET /unified-calls/sync-status — everything the freshness caption needs. */
export interface SyncStatus {
  lastSyncedAt: string | null;
  nextAutoSync: string | null;
  mangoMode: MangoIngestMode;
}

// --- Slice M4: on-demand transcription --------------------------------------

/**
 * Every outcome POST /api/mango/calls/:id/transcribe can return. The UI switches on this,
 * not on the HTTP status, so a new outcome is a compile error here rather than a silent
 * "something went wrong" toast.
 */
export type TranscribeStatus =
  | "completed"               // transcribed + summarized + saved
  | "exists"                  // already had a transcript — dedup guard, zero spend
  | "in_progress"             // another click for this call is still running
  | "recording_not_ready"     // Mango hasn't published the recording yet
  | "recording_unavailable"   // Mango no longer serves a recording for this call
  | "no_speech"               // Azure Speech heard nothing
  | "budget_exhausted"        // daily audio-minute breaker is spent
  | "unavailable"             // Azure Speech isn't configured in this environment
  | "not_found"
  | "error";

/** The transcribe endpoint's response body. Fields beyond `status` are per-outcome. */
export interface TranscribeResult {
  status: TranscribeStatus;
  transcript?: string | null;
  summary?: string | null;
  /** Audio minutes billed by this run (completed only). */
  minutesUsed?: number;
  /** ISO instant the daily budget rolls over (budget_exhausted only). */
  resetsAt?: string;
  usedMinutes?: number;
  capMinutes?: number;
  /** How long until the recording should be published (recording_not_ready only). */
  retryAfterMinutes?: number;
  /**
   * This attempt SPENT BUDGET and produced nothing (no_speech only). The client must
   * require an explicit confirmation before charging for the same recording again.
   */
  alreadyBilled?: boolean;
  error?: string;
  detail?: string;
}

/**
 * Open Dental commlog sync state. 'matched' = auto-matched, ready for a human to
 * send (Slice B.1). 'office_not_connected' = this call's office has no Open Dental
 * connection, so it was never matched against ANY practice — the honest state that
 * replaced quietly matching it against whichever database happened to be wired.
 */
export type OdSyncStatus =
  | "synced" | "matched" | "needs_review" | "pending_match" | "pending" | "error"
  | "unlinked" | "office_not_connected" | null;

/** A stored patient match candidate for the Pick Patient modal ({ id, name }). */
export interface OdMatchCandidate {
  id: number;
  name: string;
}

/**
 * How a probe failed, when one did. `timeout` is the eConnector-down
 * signature — the practice's on-premises connector stopped answering.
 */
export type OdHealthFailureKind =
  | "timeout"
  | "network"
  | "auth"
  | "rate_limited"
  | "server_error"
  | "unexpected_response"
  | "not_configured";

/**
 * Whether an office's Open Dental can be REACHED right now, as last observed by
 * the backend's per-office health check (one cheap read every few minutes).
 *
 * `"unknown"` is a real state and must render as unknown, never as up: it means
 * nobody has asked yet, which is what a checker that failed to start also looks
 * like. Showing that as healthy is the exact failure this replaced.
 */
export interface OdOfficeHealth {
  officeKey: string;
  officeName: string;
  status: "up" | "down" | "unknown";
  /** Is the office OD-configured at all, and therefore worth probing? */
  eligible: boolean;
  ineligibleReason: string | null;
  lastCheckedAt: string | null;
  lastOkAt: string | null;
  /** When `status` last changed — how long an outage has been running. */
  lastTransitionAt: string | null;
  consecutiveFailures: number;
  lastFailureKind: OdHealthFailureKind | null;
  lastFailureDetail: string | null;
  lastLatencyMs: number | null;
  probes: number;
  /** OD server version, read from the probe itself. */
  serverVersion: string | null;
}

/** One office in the worklist selector (from the real agent→office config). */
export interface OfficeConfig {
  officeId: string;
  officeName: string;
  /**
   * EFFECTIVE Open Dental connectivity: the office is switched on AND its
   * credentials are present. An office switched on without its customer key
   * reports false here, so the UI never offers actions that would fail.
   *
   * This is a CONFIGURATION fact and is deliberately separate from `odHealth`
   * below: a five-minute network blip must not silently take away a practice's
   * ability to file chart notes.
   */
  odConnected: boolean;
  /** Why OD is unavailable for this office, in words a human can act on. */
  odBlockedReason?: string | null;
  /**
   * Whether OD is REACHABLE, observed rather than configured. Optional so an
   * older backend (or a payload built before this shipped) renders as "we don't
   * know" instead of as healthy.
   */
  odHealth?: OdOfficeHealth | null;
}

/** One chart-note type an office offers, from that office's own Open Dental. */
export interface CommlogTypeOption {
  defNum: number;
  name: string;
}

/**
 * The chart-note types available at the send step, for ONE office.
 *
 * A `defNum` is only meaningful inside the practice it came from — 486 is
 * "CareIN AI Call" in Roland and does not exist in Riley, while 401 is a valid
 * type in both and names a different thing in each. So this always travels next
 * to the office it belongs to and is never cached across offices client-side.
 *
 * `available: false` is a normal state, not an error: the office may not be
 * OD-connected, or Open Dental may simply not have answered. The dialog then
 * offers the default alone and Send stays fully usable — a chart write must
 * never depend on a definitions lookup.
 */
export interface CommlogTypeCatalogue {
  available: boolean;
  options: CommlogTypeOption[];
  /** What a send with no explicit choice writes. Null when the office has no OD. */
  defaultDefNum: number | null;
  /** The default's name in this office, or null when it isn't in the list. */
  defaultName: string | null;
  /** The list is a served-stale copy — Open Dental didn't answer the refresh. */
  stale: boolean;
}

/**
 * Which leg of a twinned conversation a call row is (slice M7).
 *
 *  - `primary`         the Retell row. It owns the transcript, the analysis and the agent.
 *  - `duplicate_leg`   the Mango row of a call the AI handled END TO END. Nothing on it
 *                      that the primary doesn't already have, so it drops out of the
 *                      default worklist view (it is never deleted — retention owns that).
 *  - `transferred_leg` the Mango row of a call the AI handed to a human. Its recording is
 *                      the human half of the conversation, which the AI's transcript does
 *                      NOT contain, so it stays in the worklist like any other staff call.
 */
export type CallLinkRole = "primary" | "duplicate_leg" | "transferred_leg";

/**
 * One thing somebody did to a call, as it survives on the audit stub.
 *
 * The action and the actor and the time — never what the call was ABOUT. A note
 * contributes `note_added` with its author; its text is gone.
 */
export interface BackendRetentionAction {
  action:
    | "transcribed" | "triaged" | "sent_to_chart" | "sent_to_tc"
    | "dispositioned" | "resolved" | "note_added";
  actor: CallActor | null;
  at: string;
}

/**
 * Is this a full call record, or the thin audit stub left behind after the
 * 30-day retention window?
 *
 * A closed union on purpose, exactly like TranscribeStatus: a third kind of
 * record should be a compile error here, not a row that renders as blank.
 */
export type CallRecordKind = "call" | "stub";

export interface BackendUnifiedCall {
  id: string;
  /**
   * Absent on every row written before retention shipped, which is why the
   * normalizer treats "missing" as "call" rather than as unknown.
   */
  record_kind?: CallRecordKind;
  /** When the record was reduced to a stub. Only present on a stub. */
  pruned_at?: string | null;
  /** What was done to the call while it still had content. Only on a stub. */
  actions?: BackendRetentionAction[];
  source?: "retell" | "mango";
  caller_number?: string;
  // The office line the caller dialed (Mango DID). Present on Mango staff calls.
  called_number?: string;
  // Mango call id — lets the UI request a fresh recording stream (item 6).
  mango_call_id?: string | null;
  // Server-resolved office ('roland' | 'valley' | 'unknown'). 'unknown' = the Mango
  // called line isn't mapped yet; the UI shows an "Unmapped line" affordance.
  office_id?: string;
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
  appointment_requested?: boolean | null;
  callback_required?: boolean | null;
  dental_insurance?: boolean | null;
  // Slice A — Open Dental sync state
  od_sync_status?: OdSyncStatus;
  od_patient_id?: number | string | null;
  od_patient_name?: string | null;
  /**
   * Which practice's database od_patient_id belongs to. PatNum numbering restarts
   * per Open Dental database, so the number alone does not identify a person —
   * PatNum 7115 is a different patient in each of the two connected practices.
   */
  od_patient_office?: string | null;
  /** Why this call's office has no Open Dental connection (when it doesn't). */
  od_office_blocked_reason?: string | null;
  /** Full office descriptor, present on the single-call fetch. */
  office?: OfficeConfig;
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
  // Call disposition + internal notes. A disposition finishes a call without
  // touching Open Dental or TC; notes are append-only free text.
  disposition?: CallDisposition | null;
  disposition_by?: CallActor | null;
  disposition_at?: string | null;
  notes?: BackendCallNote[] | null;
  // Slice B.1 — who sent the chart note + when
  sent_by?: CallActor | null;
  sent_at?: string | null;
  // Slice M4 — the last on-demand transcription attempt. 'no_speech' means it SPENT
  // budget and produced nothing, so the next click must be confirmed.
  transcribe_last_outcome?: TranscribeStatus | null;
  transcribe_last_attempt_at?: string | null;
  transcribed_by?: CallActor | null;
  transcribed_at?: string | null;
  // Slice M6 — cross-module handoff. Set once this call has been handed to the
  // Treatment Coordinator module; tc_case_id present = "already in TC".
  tc_case_id?: string | null;
  tc_case_url?: string | null;
  tc_sent_at?: string | null;
  tc_sent_by?: CallActor | null;
  // Slice M7 — Mango↔Retell twin linkage. The same conversation logged twice, once by the
  // PBX and once by the AI that answered it. `linked_call_id` is the OTHER leg's id (set on
  // both rows); `link_role` says which leg this is.
  linked_call_id?: string | null;
  link_role?: CallLinkRole | null;
  disconnection_reason?: string | null;
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

/** One office's on-demand transcription tallies for today (M4 ledger). */
export interface MangoOnDemandOfficeCounts {
  attempts: number;
  minutes: number;
  completed: number;
  exists: number;
  in_progress: number;
  budget_exhausted: number;
  recording_not_ready: number;
  recording_unavailable: number;
  no_speech: number;
  unavailable: number;
  error: number;
}

/**
 * (M4) What Mango transcription actually costs, the way the office spends it: today's
 * audio minutes against the daily breaker, who transcribed what, and the month to date.
 */
export interface MangoTranscriptionCosts {
  /** Whether the hourly sync still transcribes automatically (MANGO_AUTO_TRANSCRIBE). */
  auto_transcribe: boolean;
  daily_budget: {
    day_key: string | null;
    timezone: string;
    used_minutes: number;
    budget_minutes: number;
    remaining_minutes: number | null;
    persisted: boolean;
    resets_at: string;
  };
  on_demand_today: {
    day_key: string;
    timezone: string;
    total: number;
    completed: number;
    minutes: number;
    by_office: Record<string, MangoOnDemandOfficeCounts>;
  };
  on_demand_month: {
    month_key: string;
    transcriptions: number;
    minutes: number;
    speech_cost: number;
    summary_cost: number;
    estimated_cost: number;
  };
  rates: { speech: string; summary: string };
}

export interface AdminCostsData {
  transcription?: {
    provider: string;
    total_minutes: number;
    total_transcriptions: number;
    estimated_cost: number;
    rate: string;
  };
  mango_transcription?: MangoTranscriptionCosts;
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

/**
 * Notes, newest FIRST — the order they are read in. The store keeps them in the
 * order they were written (append-only), so the display order is this mapper's
 * job rather than every consumer's.
 */
export function normalizeCallNotes(notes: BackendCallNote[] | null | undefined): CallNote[] {
  if (!Array.isArray(notes)) return [];
  return notes
    .filter((n): n is BackendCallNote => Boolean(n && typeof n.id === "string" && typeof n.text === "string"))
    .map((n) => ({
      id: n.id,
      text: n.text,
      author: n.author ?? null,
      createdAt: n.created_at ?? "",
    }))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function normalizeUnifiedCall(c: BackendUnifiedCall) {
  const date = c.call_date ?? (c as unknown as { start_timestamp?: string }).start_timestamp ?? new Date().toISOString();
  const duration = c.duration_seconds ?? (c.duration as number) ?? 0;
  const summary = c.call_summary ?? c.call_analysis?.call_summary ?? c.summary ?? "";

  /**
   * Past the retention window this call's content is gone and only its audit
   * stub remains. Rows written before retention shipped carry no `record_kind`
   * at all, so ABSENT means "call" — a missing marker must not turn the whole
   * back-catalogue into stubs.
   */
  const recordKind: CallRecordKind = c.record_kind === "stub" ? "stub" : "call";
  const isPruned = recordKind === "stub";

  return {
    id: c.id,
    recordKind,
    isPruned,
    prunedAt: c.pruned_at ?? null,
    retentionActions: (c.actions ?? []) as BackendRetentionAction[],
    source: (c.source === "mango" ? "mango" : "retell") as "retell" | "mango",
    agentName: c.source === "mango" ? "Staff" : "Rover",
    // A stub has no caller number, and the "Unknown" fallback would read as a data
    // bug rather than as a retention outcome. Empty means "there is nothing here",
    // which is the truth, and the row renders its pruned state instead.
    fromNumber: isPruned ? "" : (c.caller_number ?? "Unknown"),
    // Server-resolved office; 'unknown' → the dialed line isn't mapped yet. On a
    // stub this is the office FROZEN at prune time, not a re-derivation.
    officeId: (c.office_id as string | undefined) ?? null,
    calledNumber: (c.called_number as string | undefined) ?? null,
    mangoCallId: (c.mango_call_id as string | undefined) ?? null,
    patientName: isPruned
      ? ""
      : (c.caller_name as string) || extractNameFromText(c.transcript, c.call_summary ?? c.call_analysis?.call_summary ?? c.summary) || c.caller_number || "Unknown",
    patientId: (c.metadata as Record<string, string> | undefined)?.patient_id ?? "",
    duration,
    status: (c.metadata as Record<string, string> | undefined)?.call_status ?? "completed",
    intent: "",
    sentiment: (c.sentiment as "positive" | "neutral" | "negative") ?? "neutral",
    outcome: "",
    date,
    hasRecording: !isPruned && Boolean(c.recording_url),
    hasTranscript: !isPruned && Boolean(c.transcript || (c.transcript_object && c.transcript_object.length > 0)),
    summary: isPruned ? "" : summary,
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
    // The office that PatNum belongs to, and (when OD is unavailable) why.
    odPatientOffice: c.od_patient_office ?? null,
    odOfficeBlockedReason: c.od_office_blocked_reason ?? null,
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
    sentBy: (c.sent_by ?? null) as CallActor | null,
    sentAt: c.sent_at ?? null,

    // Call disposition + notes. `disposition` non-null = somebody decided what this
    // call was and finished it, with no OD or TC write involved.
    disposition: (c.disposition ?? null) as CallDisposition | null,
    dispositionBy: (c.disposition_by ?? null) as CallActor | null,
    dispositionAt: c.disposition_at ?? null,
    notes: normalizeCallNotes(c.notes),

    // Slice M4 — on-demand transcription. transcribeLastOutcome === 'no_speech' means the
    // last attempt billed Azure Speech and found nothing, so the button must confirm
    // before spending on the same recording again.
    transcribeLastOutcome: (c.transcribe_last_outcome ?? null) as TranscribeStatus | null,
    transcribedBy: (c.transcribed_by ?? null) as CallActor | null,
    transcribedAt: c.transcribed_at ?? null,

    // Slice M6 — TC handoff. tcCaseId present means this call already lives on a
    // TC case, so the UI shows a passive "In TC" link instead of a send button.
    tcCaseId: c.tc_case_id ?? null,
    tcCaseUrl: c.tc_case_url ?? null,
    tcSentAt: c.tc_sent_at ?? null,
    tcSentBy: (c.tc_sent_by ?? null) as CallActor | null,

    // Disposition signals for MANGO_WORKLIST_MODE='flagged' (PRD D1). On Retell calls
    // these are usually absent (defaults false) — Retell attention is unaffected by mode.
    appointmentRequested: c.appointment_requested ?? false,
    callbackRequested: c.callback_required ?? false,

    // Slice M7 — twin linkage. `linkedCallId` is the other leg's id, so a row can link
    // straight to its twin; `linkRole` decides how this row behaves in the worklist.
    linkedCallId: c.linked_call_id ?? null,
    linkRole: (c.link_role ?? null) as CallLinkRole | null,
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
      mango_worklist_mode?: MangoWorklistMode;
    }>("/unified-calls", { params: params as Record<string, string | number | boolean | undefined> });
    return {
      calls: (data.calls ?? []).map(normalizeUnifiedCall),
      total: data.total ?? data.calls?.length ?? 0,
      stats: data.stats,
      offices: data.offices ?? [],
      mangoWorklistMode: (data.mango_worklist_mode ?? "all") as MangoWorklistMode,
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
   * Set (or clear, with `null`) a call's disposition. Author + timestamp come from
   * the session server-side — there is nothing to send but the value.
   *
   * Writes NOTHING to Open Dental or TC. Returns the updated raw call record.
   */
  async setCallDisposition(id: string, disposition: CallDisposition | null): Promise<BackendUnifiedCall> {
    return request<BackendUnifiedCall>(`/unified-calls/${encodeURIComponent(id)}/disposition`, {
      method: "PUT",
      body: JSON.stringify({ disposition }),
    });
  },

  /** Append one internal note to a call. The author is the session user. */
  async addCallNote(id: string, text: string): Promise<{ note: BackendCallNote; call: BackendUnifiedCall }> {
    return request<{ success: boolean; note: BackendCallNote; call: BackendUnifiedCall }>(
      `/unified-calls/${encodeURIComponent(id)}/notes`,
      { method: "POST", body: JSON.stringify({ text }) },
    );
  },

  /**
   * Delete one note. The server allows this for the note's author or an admin and
   * 403s otherwise — the UI hides the button in the same cases, but the refusal is
   * the source of truth.
   */
  async deleteCallNote(id: string, noteId: string): Promise<{ call: BackendUnifiedCall }> {
    return request<{ success: boolean; call: BackendUnifiedCall }>(
      `/unified-calls/${encodeURIComponent(id)}/notes/${encodeURIComponent(noteId)}`,
      { method: "DELETE" },
    );
  },

  /**
   * Resolve a needs-review call. Three shapes:
   *
   *  - `{ patientId, linkOnly: true }` — LINK ONLY. Establishes the match and
   *    writes NOTHING to any chart. The call lands in 'matched', where "Send to
   *    chart" and "Send to TC" stand as independent actions.
   *  - `{ patientId, note?, content_type? }` — link AND write the CareIN commlog
   *    via the idempotent Slice-A path.
   *  - `{ notAPatient, reason }` — close it out, no OD write.
   *
   * office_id is which office the UI BELIEVES this call belongs to. The server
   * resolves the real office from the call itself and refuses on a mismatch —
   * this can only cause a refusal, never redirect a write to another practice.
   *
   * commTypeDefNum is the chart-note type picked at the send step. Omit it and
   * the office's default is written, exactly as before the picker existed. The
   * server checks it against that office's OWN commlog types and 400s on
   * anything else — including the other practice's perfectly valid DefNum.
   */
  async resolvePatient(
    id: string,
    body:
      | { patientId: number; linkOnly: true; office_id?: string; target_office?: string }
      // content_type (item 4): 'summary' (default compact block) | 'transcript' (full note).
      | { patientId: number; note?: string; content_type?: "summary" | "transcript"; commTypeDefNum?: number; office_id?: string; target_office?: string }
      | { notAPatient: true; reason: NotAPatientReason }
  ): Promise<{
    success: boolean;
    linked?: boolean;
    alreadySynced?: boolean;
    commLogNum?: number | null;
    /** The office whose chart was written / the patient was verified in (the TARGET). */
    office?: OfficeConfig;
    /** The office the call itself rang at (the ORIGIN) — unchanged by any of this. */
    callOffice?: OfficeConfig;
    /** The two above disagree: a deliberate cross-office chart action. */
    crossOffice?: boolean;
    call?: BackendUnifiedCall;
  }> {
    return request(`/unified-calls/${encodeURIComponent(id)}/resolve-patient`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /**
   * Hand a matched call to the Treatment Coordinator module (slice M6).
   *
   * The server assembles the whole payload from the stored call — the patient, the
   * office, the summary snapshot. `office_id` is only an assertion of which office
   * this screen believes it is acting on; the server refuses on a mismatch, so a
   * stale tab can never file a case under the wrong practice.
   *
   * `attached: true` = the call joined the patient's existing open case;
   * `attached: false` = a new case was created. `alreadySent` = this call was
   * already in TC, so the same case comes back untouched.
   */
  async sendCallToTc(
    id: string,
    body: { office_id?: string } = {},
  ): Promise<{
    success: boolean;
    alreadySent?: boolean;
    caseId: string;
    url: string | null;
    attached: boolean | null;
    office?: OfficeConfig;
    call?: BackendUnifiedCall;
  }> {
    return request(`/unified-calls/${encodeURIComponent(id)}/send-to-tc`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** Office roster for the global office selector (agent→office config + odConnected). */
  async getOffices(): Promise<OfficeConfig[]> {
    const data = await request<{ offices?: OfficeConfig[] }>("/unified-calls/offices");
    return data.offices ?? [];
  },

  /**
   * The exact chart note "Send to chart" will write, for the confirm-preview dialog.
   * Same formatter/options as the send path, so preview === what gets written.
   */
  async getCommlogPreview(
    id: string,
    contentType: "summary" | "transcript" = "summary",
    /**
     * Which practice's chart to preview against. Omitted, the server picks: the
     * office the call's linked patient is in, else the call's own. Named, it must
     * be one of this practice group's offices or the request is refused — the
     * client can ask, it can never make one up.
     */
    targetOffice?: string,
  ): Promise<{
    note: string;
    patientId: number | null;
    patientName: string | null;
    /** The office whose chart this note is headed for (the TARGET). */
    office?: OfficeConfig;
    /** The office the call rang at (the ORIGIN). Immutable; shown next to the target. */
    callOffice?: OfficeConfig;
    /** Target ≠ origin — the dialog says so in words before anything is sent. */
    crossOffice?: boolean;
    /**
     * The chart-note types the TARGET office offers. Rides the preview rather than
     * having its own endpoint because the office resolution — including validating
     * a chosen target against the registry — happens server-side here; a bare
     * /commlog-types?office_id=… would have let the client name any office it liked.
     */
    commlogTypes?: CommlogTypeCatalogue;
  }> {
    const params = new URLSearchParams();
    if (contentType === "transcript") params.set("content_type", "transcript");
    if (targetOffice) params.set("target_office", targetOffice);
    const q = params.toString();
    return request(`/unified-calls/${encodeURIComponent(id)}/commlog-preview${q ? `?${q}` : ""}`);
  },

  /**
   * Search Open Dental patients for the Pick Patient modal, always in the context
   * of THE CALL being resolved.
   *
   * Still call-scoped rather than a bare patient search: the call is what fixes the
   * origin office and puts the look through a practice's records in the audit trail
   * next to the call that prompted it.
   *
   * `targetOffice` chooses WHICH practice's list to search. Omitted, it is the
   * call's own office — the ordinary case. Named, the server validates it against
   * the office registry and refuses anything it does not recognise, so the client
   * picks from a list, it does not invent an office. The front desk at one practice
   * really does take calls about the other's patients, and searching only the call's
   * office left those calls impossible to chart at all.
   *
   * The response names the office searched so the modal can show whose patient list
   * is on screen.
   */
  async searchPatientsForCall(
    callId: string,
    q: string,
    targetOffice?: string,
  ): Promise<{ patients: OdPatient[]; office: OfficeConfig | null; error?: string }> {
    if (!q || q.trim().length < 2) return { patients: [], office: null };
    try {
      const params = new URLSearchParams({ q: q.trim() });
      if (targetOffice) params.set("target_office", targetOffice);
      const res = await request<{ patients: OdPatient[]; office: OfficeConfig; error?: string }>(
        `/unified-calls/${encodeURIComponent(callId)}/patient-search?${params.toString()}`
      );
      return { patients: res.patients ?? [], office: res.office ?? null };
    } catch (err) {
      // A failed search must never look like "no such patient" — the modal renders
      // the difference, so surface it rather than swallowing it into an empty list.
      return {
        patients: [],
        office: null,
        error: err instanceof Error ? err.message : "Patient search failed",
      };
    }
  },

  /**
   * (M4) Transcribe + summarize ONE Mango call, because a human asked for it.
   *
   * Deliberately does NOT throw on a refusal: budget spent, recording not published yet,
   * already running — those are answers, not errors, and each gets its own message. Only a
   * network/parse failure throws, and the caller renders that as the generic error state.
   */
  async transcribeMangoCall(id: string): Promise<TranscribeResult> {
    const res = await apiFetch(`/mango/calls/${encodeURIComponent(id)}/transcribe`, { method: "POST" });
    const body = (await res.json().catch(() => null)) as TranscribeResult | null;
    if (body && typeof body.status === "string") return body;
    // A response with no usable body is a real failure — never report it as success.
    return { status: "error", error: `HTTP ${res.status}` };
  },

  async getUnifiedCall(id: string) {
    const c = await request<BackendUnifiedCall>(`/unified-calls/${encodeURIComponent(id)}`);
    return normalizeUnifiedCall(c);
  },

  async getUnifiedStats() {
    return request<{ bySource?: Record<string, number>; lastSync?: Record<string, string> }>("/unified-calls/stats");
  },

  /**
   * @deprecated Superseded by `syncNow()`, which pulls Mango as well and reports each
   * source honestly. The endpoint still exists this release; nothing in the UI calls this.
   */
  async syncRetell(options?: { limit?: number; offset?: number }) {
    return request<{ message?: string; added?: number }>("/unified-calls/sync-retell", {
      method: "POST",
      body: JSON.stringify(options ?? {}),
    });
  },

  /**
   * Pull BOTH call sources on demand.
   *
   * Never throws on a per-source refusal — "Mango ingestion is off here" and "the hourly
   * autosync already has it" are answers the caller renders differently, not failures.
   * The cooldown (429) is returned as data too, so a button-mash produces a countdown
   * rather than a red toast. Only a transport/parse failure throws.
   *
   * A full Retell page walk plus a Mango pull can legitimately take a while, so the
   * request gets 90s before the client gives up on it.
   */
  async syncNow(): Promise<SyncNowResult> {
    let res: Response;
    try {
      res = await apiFetch("/unified-calls/sync-now", {
        method: "POST",
        signal: AbortSignal.timeout(SYNC_NOW_TIMEOUT_MS),
      });
    } catch (err) {
      // The abort surfaces as a DOMException whose message ("signal timed out") means
      // nothing at a front desk. Say what actually happened, and that the sync may well
      // still be finishing on the server.
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new ApiError("Sync is taking longer than usual — check back in a minute", 0, "SYNC_TIMEOUT");
      }
      throw err;
    }
    const body = (await res.json().catch(() => null)) as Partial<SyncNowResponse & SyncCooldown> | null;

    if (res.status === 429) {
      return {
        kind: "cooldown",
        retryAfter: typeof body?.retryAfter === "number" ? body.retryAfter : 60,
        lastSyncedAt: body?.lastSyncedAt ?? null,
      };
    }
    // A 502 still carries per-source detail (both failed, and why) — surface it as a
    // result so the toast can name the sources instead of saying "something went wrong".
    if (body && body.retell && body.mango) {
      return {
        kind: "result",
        retell: body.retell,
        mango: body.mango,
        lastSyncedAt: body.lastSyncedAt ?? null,
        nextAutoSync: body.nextAutoSync ?? null,
      };
    }
    throw new ApiError(`Sync failed (HTTP ${res.status})`, res.status, null);
  },

  /** Freshness caption data: when the list last refreshed and when it next will. */
  async getSyncStatus(): Promise<SyncStatus> {
    return request<SyncStatus>("/unified-calls/sync-status");
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

  /**
   * Unprivileged liveness probe — also what the offline banner polls.
   *
   * Deliberately `/api/health`, NOT `/api/admin/health`:
   *  - it needs no permission, so it answers "can I reach the backend?" for every user.
   *    The admin endpoint is behind `admin.all`, so for a hygienist it returned 403 on
   *    every poll and pinned the offline banner on permanently;
   *  - it is exempt from rate limiting, so a throttled window cannot make a healthy
   *    backend look dead — which is exactly what happened on 2026-08-12.
   */
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

  // --- tenant user management (Roles PR B, /api/users) ----------------------

  /** List this tenant's users. Server-gated `admin.all`. */
  async listUsers(): Promise<TenantUsersResponse> {
    return request<TenantUsersResponse>("/users");
  },

  /** Pre-provision a user. Entra still authenticates them; this grants the role. */
  async createUser(email: string, role: TenantUserRole): Promise<TenantUser> {
    const data = await request<{ user: TenantUser }>("/users", {
      method: "POST",
      body: JSON.stringify({ email, role }),
    });
    return data.user;
  },

  /**
   * Change a user's role, status and/or home office. Server enforces every
   * guard. `homeOffice: null` CLEARS it — an explicit null, not an omitted key.
   */
  async updateUser(
    email: string,
    patch: { role?: TenantUserRole; status?: TenantUserStatus; homeOffice?: string | null },
  ): Promise<TenantUser> {
    const data = await request<{ user: TenantUser }>(`/users/${encodeURIComponent(email)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return data.user;
  },

  // --- platform console (PR C, /api/platform) -------------------------------
  // Every one of these 403s for anyone who is not a platform super_admin. The
  // page hides them from everyone else, but that is courtesy: the refusal is
  // the boundary.

  /** The tenant catalog, with each practice's module state and roster size. */
  async listPractices(): Promise<Practice[]> {
    const data = await request<{ practices: Practice[] }>("/platform/practices");
    return data.practices;
  },

  /**
   * Turn one module on or off for one practice.
   *
   * Returns the practice's modules AS THE DATABASE NOW HAS THEM, not the value
   * sent — the console renders the readback so a write that silently did
   * nothing cannot look like a success.
   */
  async setPracticeModule(
    tenantId: string,
    module: ModuleName,
    enabled: boolean,
  ): Promise<PracticeModule[]> {
    const data = await request<{ modules: PracticeModule[] }>(
      `/platform/practices/${encodeURIComponent(tenantId)}/modules/${encodeURIComponent(module)}`,
      { method: "PUT", body: JSON.stringify({ enabled }) },
    );
    return data.modules;
  },

  /** One practice's roster. Read-only; `manageAt` says where the writes live. */
  async listPracticeUsers(tenantId: string): Promise<PracticeUsersResponse> {
    return request<PracticeUsersResponse>(
      `/platform/practices/${encodeURIComponent(tenantId)}/users`,
    );
  },

  /** A page of one practice's audit log, newest first. Paginated server-side. */
  async listPracticeAudit(tenantId: string, filters: AuditFilters = {}): Promise<AuditPage> {
    // Empty strings are dropped rather than sent: the server treats an absent
    // filter as "no filter", and `?action=` would otherwise read as one.
    const params: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(filters)) {
      if (v === undefined || v === null || v === "") continue;
      params[k] = v as string | number;
    }
    return request<AuditPage>(
      `/platform/practices/${encodeURIComponent(tenantId)}/audit`,
      { params },
    );
  },

  /** The call-store retention window, where it came from, and the store counts. */
  async getRetention(): Promise<RetentionState> {
    return request<RetentionState>("/platform/retention");
  },

  /** Store a new window (30 | 60 | 90). Takes effect at the next nightly run. */
  async setRetentionDays(days: number): Promise<RetentionState> {
    return request<RetentionState>("/platform/retention", {
      method: "PUT",
      body: JSON.stringify({ days }),
    });
  },

  /**
   * How many live calls a proposed window would prune. Server-computed with the
   * pruner's own selector, so the number shown before you confirm is the number
   * that will actually happen.
   */
  async getRetentionImpact(days: number): Promise<RetentionImpact> {
    return request<RetentionImpact>("/platform/retention/impact", { params: { days } });
  },

  // --- call-store jobs (existing /api/admin endpoints, super_admin-gated) ----
  // Deliberately NOT re-homed under /api/platform: forking a job that destroys
  // records would mean two copies of its safety rules.

  /** Run the nightly prune now. Idempotent. */
  async runCallStorePrune(): Promise<PruneResult> {
    return request<PruneResult>("/admin/call-store/prune", { method: "POST" });
  },

  /**
   * The one-shot legacy purge of unmapped-office Mango rows.
   *
   * DRY RUN BY DEFAULT. A live run needs `dryRun: false` AND `confirm: 'DELETE'`,
   * and the server refuses to start without writing a backup first — those rules
   * are enforced server-side, not by this signature.
   */
  async purgeLegacyCalls(opts: { dryRun: boolean; confirm?: string }): Promise<PurgeResult> {
    return request<PurgeResult>("/admin/call-store/purge-legacy", {
      method: "POST",
      body: JSON.stringify({ dryRun: opts.dryRun, confirm: opts.confirm ?? null }),
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
