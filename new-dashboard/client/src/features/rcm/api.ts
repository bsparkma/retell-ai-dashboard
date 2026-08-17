/**
 * RCM module API client — the ONLY way RCM pages talk to /api/rcm.
 *
 * Same shape and same reasons as features/tc/api.ts:
 *  - /api/rcm errors carry `{ success:false, error, code }` (the `error` key,
 *    not `message`), so the generic lib/api.ts wrapper would surface
 *    "HTTP 403" where the useful answer is MODULE_NOT_ENTITLED. RcmApiError
 *    preserves status + code.
 *  - Every endpoint requires `?office=roland|valley` — never "all", never a
 *    header — which is enforced here by typing office as RcmOfficeId.
 *  - Money is integer cents end to end. Nothing in this file divides by 100;
 *    formatting is the component's job.
 */
import { handleUnauthorized } from "@/lib/api";

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:5000/api";

/**
 * The frozen office keys the rcm_* CHECK constraints accept. Mirrors
 * backend/routes/rcm/helpers.js — a third office is a migration, not an edit.
 */
export const RCM_OFFICE_IDS = ["roland", "valley"] as const;
export type RcmOfficeId = (typeof RCM_OFFICE_IDS)[number];

export function isRcmOfficeId(value: unknown): value is RcmOfficeId {
  return typeof value === "string" && (RCM_OFFICE_IDS as readonly string[]).includes(value);
}

/** Short labels for badges (roster display names are too long for a chip). */
export const RCM_OFFICE_LABELS: Record<RcmOfficeId, string> = {
  roland: "Roland",
  valley: "Valley",
};

export class RcmApiError extends Error {
  readonly status: number;
  /** The server's structured code, e.g. MODULE_NOT_ENTITLED or INVALID_OFFICE. */
  readonly code: string | null;

  /**
   * The rest of the error body, verbatim.
   *
   * Some refusals carry the answer, not just the reason: a duplicate ERA upload
   * returns the remittances it already holds, and telling the operator "you
   * uploaded this on the 2nd, it became batch X" is the difference between a
   * useful refusal and a dead end.
   */
  readonly details: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code: string | null,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RcmApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** This exact remittance has already been processed for this office. */
  get alreadyProcessed(): boolean {
    return this.code === "REMITTANCE_ALREADY_PROCESSED";
  }

  /** The remittances a duplicate upload collided with, if any. */
  get duplicateRemittances(): DuplicateRemittance[] {
    const raw = this.details.remittances;
    return Array.isArray(raw) ? (raw as DuplicateRemittance[]) : [];
  }

  /** This practice is not entitled to the RCM module. */
  get notEntitled(): boolean {
    return this.code === "MODULE_NOT_ENTITLED";
  }

  /** This user's role does not hold rcm.read. */
  get forbidden(): boolean {
    return this.status === 403 && this.code === "FORBIDDEN";
  }
}

/** Counts keyed by the status vocabulary of one rcm_* table. */
export type StatusCounts = Record<string, number>;

export interface RcmSummary {
  office: RcmOfficeId;
  claims: { byStatus: StatusCounts; total: number };
  batches: { byStatus: StatusCounts; total: number };
  /** `depth` counts only the queue rows that still owe work. */
  queue: { byStatus: StatusCounts; total: number; depth: number };
}

export interface RcmClaim {
  claimId: string;
  officeId: RcmOfficeId;
  claimNumber: string;
  checkNumber: string | null;
  patientName: string;
  odPatientId: number | null;
  payer: string;
  serviceDate: string | null;
  receivedDate: string | null;
  status: string;
  paymentStatus: string;
  insuranceType: string;
  totalBilledCents: number;
  totalPaidCents: number;
  patientBalanceCents: number;
  needsReviewReasons: string[];
  createdAt: string | null;
}

export interface RcmClaimPage {
  office: RcmOfficeId;
  claims: RcmClaim[];
  total: number;
  limit: number;
  offset: number;
}

interface ErrorBody {
  error?: unknown;
  code?: unknown;
}

/** One remittance a duplicate ERA upload collided with. */
export interface DuplicateRemittance {
  index: number;
  remittanceKey: string;
  /** 'posted' = finished. 'pending' = a run is in flight, or died mid-flight. */
  status: "posted" | "pending";
  batchId: string | null;
  processedAt: string | null;
}

/**
 * Turn a non-2xx response into an RcmApiError, preserving the WHOLE body.
 *
 * One place, because a refusal that carries data (the duplicate remittances)
 * is useless if the transport drops everything but `error` and `code`.
 */
async function toError(res: Response): Promise<RcmApiError> {
  let body: ErrorBody & Record<string, unknown> = {};
  try {
    body = (await res.json()) as ErrorBody & Record<string, unknown>;
  } catch {
    /* non-JSON error body */
  }
  const message = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
  const code = typeof body.code === "string" ? body.code : null;
  // MODULE_NOT_ENTITLED arrives in `error`, not `code` — the platform's
  // existing denial shape. Normalize it into `code` so callers have one
  // place to look.
  return new RcmApiError(
    message,
    res.status,
    code ?? (message === "MODULE_NOT_ENTITLED" ? message : null),
    body,
  );
}

/**
 * POST a JSON body to /api/rcm and read a JSON response.
 *
 * Separate from `get` rather than a mode of it, because these are the calls
 * that CHANGE something and the difference should be visible at the call site.
 * Every one of them needs `rcm.write`, which the server enforces at the mount
 * by HTTP method — no page has to know that to render.
 */
/**
 * How long the client waits before it stops waiting.
 *
 * A batch match is a paced, sequential run against Open Dental — 25 claims at
 * ≥1.2s per CALL is minutes, not seconds — and it is held open on one HTTP
 * request. Without a timeout a hung connection leaves the button spinning
 * "Matching…" forever with no way back; with one, the page can say what it
 * knows ("this may still be running") instead of pretending to still be
 * connected. The server keeps going either way, which is why the copy tells the
 * operator to refresh rather than retry.
 */
const REQUEST_TIMEOUT_MS = 120_000;

async function post<T>(
  path: string,
  params: Record<string, string | number>,
  body: unknown = {},
  { timeoutMs = REQUEST_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<T> {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${BASE}/rcm${path}?${qs}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (err) {
    // A timeout is NOT a failure of the operation — the server may well still
    // be working. It gets its own code so the UI can say that rather than
    // inviting a second run on top of the first.
    if (abort.signal.aborted) {
      throw new RcmApiError("The request took too long and the page stopped waiting", 0, "TIMEOUT");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    handleUnauthorized();
    throw new RcmApiError("Not signed in", 401, null);
  }
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

async function get<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();

  const res = await fetch(`${BASE}/rcm${path}?${qs}`, { credentials: "include" });

  if (res.status === 401) {
    // Session expired — the shared handler bounces to sign-in rather than
    // leaving the page in a permanent spinner.
    handleUnauthorized();
    throw new RcmApiError("Not signed in", 401, null);
  }

  if (!res.ok) throw await toError(res);

  return (await res.json()) as T;
}

/** Per-office counts across claims, payment batches, and the posting queue. */
export function getRcmSummary(office: RcmOfficeId): Promise<RcmSummary> {
  return get<RcmSummary>("/summary", { office });
}

/** One page of the office's claims, newest first. */
export function listRcmClaims(
  office: RcmOfficeId,
  opts: { limit?: number; offset?: number; status?: string } = {},
): Promise<RcmClaimPage> {
  const params: Record<string, string | number> = { office };
  if (opts.limit !== undefined) params.limit = opts.limit;
  if (opts.offset !== undefined) params.offset = opts.offset;
  if (opts.status) params.status = opts.status;
  return get<RcmClaimPage>("/claims", params);
}

// ─── EOB ingestion (Slice 4) ─────────────────────────────────────────────────

/**
 * The four states rcm_eob_uploads.status can hold, straight from the CHECK
 * constraint. A closed union on purpose, the same way TranscribeStatus is on
 * the voice side: adding a fifth state server-side becomes a compile error
 * here, not a chip that silently renders as nothing.
 */
export const EOB_UPLOAD_STATUSES = ["uploaded", "processing", "extracted", "failed"] as const;
export type EobUploadStatus = (typeof EOB_UPLOAD_STATUSES)[number];

export interface EobUpload {
  uploadId: string;
  officeId: RcmOfficeId;
  /** The name as uploaded. PHI — EOB filenames routinely carry patient names. */
  filename: string;
  fileSizeBytes: number | null;
  status: EobUploadStatus;
  /**
   * On `failed`, why it failed. On `uploaded`, why extraction has not STARTED
   * (cost cap reached, or no LLM configured in this environment). Read it
   * together with `status` — the same field means different things either side
   * of that line, and the server documents it the same way.
   */
  message: string | null;
  resultClaimId: string | null;
  resultBatchId: string | null;
  uploadedAt: string | null;
  processedAt: string | null;
}

/** The daily extraction cost breaker, as the server reports it. */
export interface EobExtractionState {
  /** True = the daily cap is spent. Uploads still succeed; extraction waits. */
  paused: boolean;
  usedCents: number;
  capCents: number;
  /** null when the cap is configured as unlimited. */
  remainingCents: number | null;
  /** ISO-8601 instant the cap next resets (local midnight in `timezone`). */
  resetsAt: string;
  timezone: string;
  /** False = the counter is memory-only, so a restart would forget the spend. */
  persisted: boolean;
  queue?: { pending: number; deferred: number; running: boolean };
}

export interface EobUploadPage {
  office: RcmOfficeId;
  uploads: EobUpload[];
  total: number;
  limit: number;
  offset: number;
  extraction: EobExtractionState;
}

export interface EobUploadResult {
  office: RcmOfficeId;
  /** True when these exact bytes were already on file for this office. */
  duplicate: boolean;
  /** True when a previously-stuck upload was put back on the queue. */
  requeued?: boolean;
  upload: EobUpload;
  extraction?: EobExtractionState;
}

/** This office's EOB uploads, newest first, plus the cost-breaker state. */
export function listEobUploads(
  office: RcmOfficeId,
  opts: { limit?: number; offset?: number } = {},
): Promise<EobUploadPage> {
  const params: Record<string, string | number> = { office };
  if (opts.limit !== undefined) params.limit = opts.limit;
  if (opts.offset !== undefined) params.offset = opts.offset;
  return get<EobUploadPage>("/eob", params);
}

/**
 * Upload one EOB PDF.
 *
 * multipart/form-data with the file in a field named `file` — and NO explicit
 * Content-Type header, because the browser must set the multipart boundary
 * itself. Setting it by hand is the classic way to make this 400.
 */
export async function uploadEob(office: RcmOfficeId, file: File): Promise<EobUploadResult> {
  const body = new FormData();
  body.append("file", file);

  const res = await fetch(`${BASE}/rcm/eob?office=${encodeURIComponent(office)}`, {
    method: "POST",
    credentials: "include",
    body,
  });

  if (res.status === 401) {
    handleUnauthorized();
    throw new RcmApiError("Not signed in", 401, null);
  }

  if (!res.ok) throw await toError(res);

  return (await res.json()) as EobUploadResult;
}

// ─── ERA (835) upload — Slice 5 ──────────────────────────────────────────────

/**
 * A batch produced by one ST/BPR transaction in an uploaded file.
 *
 * `status` is the BATCH's readiness. `dedupeStatus` is the remittance key's,
 * and they answer different questions: "can a person act on this?" versus
 * "will a re-upload of this file be refused?".
 */
export interface EraRemittance {
  batchId: string;
  checkNumber: string | null;
  eftNumber: string | null;
  traceNumber: string | null;
  paymentMethod: "check" | "eft" | null;
  payer: string;
  paymentDate: string | null;
  totalAmountCents: number;
  plbTotalCents: number;
  claimCount: number;
  /** 'ready' only when nothing on the batch needs a human first. */
  status: string;
  notes: string;
  remittanceKey: string | null;
  dedupeStatus: string | null;
}

export interface EraUpload {
  uploadId: string;
  /** PHI — 835 filenames routinely carry a patient and a payer. */
  filename: string;
  fileHash: string | null;
  fileSizeBytes: number | null;
  contentType: string | null;
  status: string;
  uploadedAt: string | null;
  processedAt: string | null;
  remittances: EraRemittance[];
}

export interface EraUploadPage {
  office: RcmOfficeId;
  uploads: EraUpload[];
  total: number;
  limit: number;
  offset: number;
}

/** One claim proposed by an upload. Never a payment — a record of what the file said. */
export interface EraCreatedClaim {
  claimId: string;
  claimNumber: string;
  /** PHI. */
  patientName: string;
  totalPaidCents: number;
  lineCount: number;
  /** Machine-readable reasons this claim is held for a human. Empty = clean. */
  needsReviewReasons: string[];
}

export interface EraCreatedRemittance {
  index: number;
  batchId: string;
  status: string;
  remittanceKey: string;
  checkNumber: string;
  traceNumber: string;
  payer: string;
  paymentDate: string | null;
  paymentMethod: "check" | "eft" | null;
  totalAmountCents: number;
  plbTotalCents: number;
  /** Structures we parsed and will NOT act on — reversals, PLB, mismatches. */
  flags: string[];
  claims: EraCreatedClaim[];
}

export interface EraUploadResult {
  office: RcmOfficeId;
  upload: {
    uploadId: string;
    filename: string;
    fileKey: string;
    fileHash: string;
    fileSizeBytes: number;
  };
  remittances: EraCreatedRemittance[];
  counts: { batches: number; claims: number; lines: number; adjustments: number };
}

/** What this office has uploaded, newest first, with dedupe status. */
export function listEraUploads(
  office: RcmOfficeId,
  opts: { limit?: number; offset?: number } = {},
): Promise<EraUploadPage> {
  const params: Record<string, string | number> = { office };
  if (opts.limit !== undefined) params.limit = opts.limit;
  if (opts.offset !== undefined) params.offset = opts.offset;
  return get<EraUploadPage>("/era", params);
}

/**
 * Upload one 835.
 *
 * Same transport as `uploadEob` — multipart/form-data, file in a field named
 * `file`, and NO explicit Content-Type header so the browser sets the boundary
 * itself. Two upload endpoints in one module with two different transports
 * would be a wart, and the office travels in the query string either way:
 * office is a correctness boundary the server validates, never something the
 * client asserts in a body.
 *
 * A duplicate throws `RcmApiError` with `alreadyProcessed === true` and the
 * colliding remittances on `duplicateRemittances`. There is deliberately no
 * force/override parameter to pass.
 */
export async function uploadEra(office: RcmOfficeId, file: File): Promise<EraUploadResult> {
  const body = new FormData();
  body.append("file", file);

  const res = await fetch(`${BASE}/rcm/era?office=${encodeURIComponent(office)}`, {
    method: "POST",
    credentials: "include",
    body,
  });

  if (res.status === 401) {
    handleUnauthorized();
    throw new RcmApiError("Not signed in", 401, null);
  }
  if (!res.ok) throw await toError(res);

  return (await res.json()) as EraUploadResult;
}

// ─── The review workbench — Slice 6a ─────────────────────────────────────────

/**
 * The four honest states of a claim's Open Dental linkage, straight from the
 * CHECK constraint. A closed union on purpose, the same way `TranscribeStatus`
 * is on the voice side: a fifth state added server-side becomes a compile error
 * here, not a chip that silently renders as nothing.
 *
 * `not_run` and `no_candidate` are DIFFERENT facts. "Nobody has checked" and
 * "we checked and Open Dental has nothing" lead a biller to different actions,
 * and a nullable claim number cannot tell them apart.
 */
export const OD_MATCH_STATUSES = ["not_run", "candidates", "no_candidate", "confirmed"] as const;
export type OdMatchStatus = (typeof OD_MATCH_STATUSES)[number];

/** The scorer's bands. HIGH is an argument, never a decision. */
export type MatchConfidence = "HIGH" | "MEDIUM" | "LOW";

/** One reason a candidate scored the way it did. Weights can be negative. */
export interface MatchEvidence {
  tag: string;
  weight: number;
  label: string;
  detail: string;
  /** The specific number or name behind the tag, when there is one. */
  note?: string;
}

/** A pre-flight fact about the Open Dental claim that Slice 6c will act on. */
export interface MatchBlocker {
  code: string;
  /** True = 6c cannot post this at all. False = read it, but it is not a wall. */
  blocking: boolean;
  label: string;
  detail: string;
  count?: number;
}

/** One Open Dental claimproc as it read at match time. */
export interface OdLineFacts {
  claimProcNum: number;
  procNum: number | null;
  code: string;
  status: string;
  feeBilledCents: number;
  insPayAmtCents: number;
  writeOffCents: number;
  dedAppliedCents: number;
  isTransfer: boolean;
  /** Non-null ⇒ a check is attached and InsPayAmt is locked. */
  claimPaymentNum: number | null;
  /** OD's DELETE is a SOFT delete; these are excluded from every total. */
  deleted: boolean;
  blockedStatus: boolean;
}

/** Which chart line each of our lines would adjudicate, if this candidate wins. */
export interface LinePair {
  lineId: string | null;
  position: number | null;
  code: string;
  odClaimProcNum: number | null;
  odCode: string | null;
  billedDeltaCents: number | null;
  /** Why nothing was paired. Null when it was. */
  reason: string | null;
}

export interface MatchCandidate {
  odClaimNum: number;
  odPatNum: number | null;
  score: number;
  confidence: MatchConfidence;
  evidence: MatchEvidence[];
  blockers: MatchBlocker[];
  od: {
    claimStatus: string;
    dateService: string | null;
    claimFeeCents: number;
    insPaidCents: number;
    writeOffCents: number;
    patientName: string | null;
    lines: OdLineFacts[];
    deletedLineCount: number;
  };
  linePairs: LinePair[];
}

/**
 * What a match run observed. A record of a past observation, never a cache to
 * serve current dollar figures from — Slice 6c re-verifies against it at drain
 * time, which is the whole reason `fetchedAt` is on it.
 */
export interface MatchSnapshot {
  version: number;
  fetchedAt: string;
  office: RcmOfficeId;
  officeName: string;
  odCalls: number;
  /** A cap was hit. Some candidates were NOT examined. */
  truncated: boolean;
  /** Limits and oddities worth saying out loud, in the server's words. */
  notes: string[];
  patientsConsidered: { patNum: number; name: string }[];
  /** The top two are too close to read as an ordering. Displayed, not resolved. */
  ambiguous: boolean;
  margin: number | null;
  candidates: MatchCandidate[];
  confirmed: {
    odClaimNum: number;
    odPatNum: number | null;
    confirmedAt: string;
    confirmedBy: string;
    linePairs: LinePair[];
    odAmountsAsRead: {
      claimFeeCents: number;
      insPaidCents: number;
      writeOffCents: number;
      claimStatus: string;
    };
  } | null;
}

/** One CARC/RARC adjustment, resolved into plain English by the server. */
export interface ClaimAdjustment {
  adjustmentId: string;
  amountCents: number;
  quantity: number;
  groupCode: string;
  groupLabel: string;
  groupDescription: string | null;
  reasonCode: string;
  /** Null when the code is not in the published list — rendered bare, not guessed. */
  reasonDescription: string | null;
  remarkCode: string | null;
  remarkDescription: string | null;
}

export interface ClaimLine {
  lineId: string;
  position: number;
  billedCode: string;
  /** Set only when the carrier downcoded; both codes are kept. */
  paidCode: string | null;
  code: string;
  description: string;
  billedCents: number;
  allowedCents: number;
  deductibleCents: number;
  copayCents: number;
  paidCents: number;
  adjustmentCents: number;
  patientRespCents: number;
  writeOffCents: number;
  adjustmentReason: string | null;
  isDowncoded: boolean;
  isBundled: boolean;
  isDenied: boolean;
  flags: string[];
  odClaimProcNum: number | null;
  adjustments: ClaimAdjustment[];
}

export interface WorkbenchClaim {
  claimId: string;
  officeId: RcmOfficeId;
  claimNumber: string;
  checkNumber: string | null;
  patientName: string;
  odPatientId: number | null;
  /** Meaningful ONLY when odMatchStatus is 'confirmed' — a DB CHECK enforces it. */
  odClaimNum: number | null;
  payer: string;
  serviceDate: string | null;
  receivedDate: string | null;
  status: string;
  paymentStatus: string;
  insuranceType: string;
  totalBilledCents: number;
  totalAllowedCents: number;
  totalPaidCents: number;
  totalDeductibleCents: number;
  patientBalanceCents: number;
  needsReviewReasons: string[];
  /** The EXTRACTOR's 0-100 confidence. Not the Open Dental match confidence. */
  extractionConfidence: number;
  odMatchStatus: OdMatchStatus;
  odMatchAt: string | null;
  odMatchConfirmedAt: string | null;
  odMatchedBy: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  createdAt: string | null;
  lines: ClaimLine[];
  matchSnapshot?: MatchSnapshot | null;
}

/** A claim as the remittance detail lists it (no snapshot — the panel loads that). */
export type RemittanceClaim = Omit<WorkbenchClaim, "matchSnapshot">;

export interface RemittanceUpload {
  uploadId: string;
  /** PHI — remittance filenames routinely carry a patient and a payer. */
  filename: string;
  uploadedAt: string | null;
  /** Null means NOT RECORDED (uploaded before D-5), never "the system did it". */
  uploadedBy: string | null;
  documentUrl?: string;
}

export interface Remittance {
  batchId: string;
  officeId: RcmOfficeId;
  payer: string;
  checkNumber: string | null;
  eftNumber: string | null;
  traceNumber: string | null;
  paymentMethod: "check" | "eft" | null;
  depositDate: string | null;
  totalAmountCents: number;
  postedAmountCents: number;
  plbTotalCents: number;
  claimCount: number;
  status: string;
  /** '835' = parsed, and can only be malformed. 'eob' = READ by a model, and can be WRONG. */
  source: "835" | "eob" | null;
  notes: string;
  createdAt: string | null;
  createdBy: string | null;
  /** Computed server-side so the list and the detail cannot disagree. */
  balance: {
    batchTotalCents: number;
    claimTotalCents: number;
    differenceCents: number;
    plbTotalCents: number;
    balanced: boolean;
  };
  needsAttention: boolean;
  attentionReasons: string[];
  reviewReasonCount: number;
  unmatchedClaimCount: number;
  upload: RemittanceUpload | null;
}

export interface RemittanceListPage {
  office: RcmOfficeId;
  remittances: Remittance[];
  total: number;
  limit: number;
  offset: number;
  needsAttentionCount: number;
}

export interface RemittanceDetail {
  office: RcmOfficeId;
  remittance: Remittance & {
    /** Provider-level money, belonging to no single claim. Detect-and-flag only. */
    plbAdjustments: unknown[];
  };
  claims: RemittanceClaim[];
}

/** The tolerances the scores were actually produced with. */
export interface MatchRules {
  amountNearCents: number;
  dateNearDays: number;
  ambiguityMargin: number;
  bands: { band: MatchConfidence; min: number }[];
}

export interface ClaimDetailResponse {
  office: RcmOfficeId;
  claim: WorkbenchClaim;
  matchRules: MatchRules;
}

export interface MatchRunResponse {
  office: RcmOfficeId;
  claimId: string;
  status: OdMatchStatus;
  snapshot: MatchSnapshot;
}

export interface BatchMatchResponse {
  office: RcmOfficeId;
  batchId: string;
  matched: {
    claimId: string;
    status: OdMatchStatus | "already_confirmed" | "failed";
    candidateCount?: number;
    ambiguous?: boolean;
    error?: string;
  }[];
  odCalls: number;
  pacingMs: number;
  /** Claims a cap left unmatched. Stated, never silent. */
  skipped: number;
  note?: string;
}

/** Every payment batch for this office, needs-attention count included. */
export function listRemittances(
  office: RcmOfficeId,
  opts: { limit?: number; offset?: number } = {},
): Promise<RemittanceListPage> {
  const params: Record<string, string | number> = { office };
  if (opts.limit !== undefined) params.limit = opts.limit;
  if (opts.offset !== undefined) params.offset = opts.offset;
  return get<RemittanceListPage>("/remittances", params);
}

/** One remittance: header, balance check, and every claim with its lines. */
export function getRemittance(office: RcmOfficeId, batchId: string): Promise<RemittanceDetail> {
  return get<RemittanceDetail>(`/remittances/${encodeURIComponent(batchId)}`, { office });
}

/** One claim: lines, adjustments, and the last match snapshot if there is one. */
export function getClaim(office: RcmOfficeId, claimId: string): Promise<ClaimDetailResponse> {
  return get<ClaimDetailResponse>(`/claims/${encodeURIComponent(claimId)}`, { office });
}

/**
 * Read Open Dental and rank candidates for one claim.
 *
 * A POST because it WRITES TO OUR ROWS — the snapshot, the status, the instant
 * we looked. Nothing is written to a chart. `force` re-runs over a confirmed
 * match, which the server otherwise refuses so a stray double-click cannot
 * discard somebody's decision.
 */
export function matchClaim(
  office: RcmOfficeId,
  claimId: string,
  opts: { force?: boolean } = {},
): Promise<MatchRunResponse> {
  return post<MatchRunResponse>(`/claims/${encodeURIComponent(claimId)}/match`, { office }, opts);
}

/**
 * Confirm one candidate as THE Open Dental claim. Attributed to the signed-in
 * user, and the only thing that sets `odClaimNum`.
 */
export function confirmClaimMatch(
  office: RcmOfficeId,
  claimId: string,
  odClaimNum: number,
): Promise<{ claimId: string; odClaimNum: number; confirmedAt: string }> {
  return post(`/claims/${encodeURIComponent(claimId)}/confirm-match`, { office }, { odClaimNum });
}

/** Mark a claim reviewed, with an optional note. No Open Dental effect at all. */
export function reviewClaim(
  office: RcmOfficeId,
  claimId: string,
  note: string,
): Promise<{ claimId: string }> {
  return post(`/claims/${encodeURIComponent(claimId)}/review`, { office }, { note });
}

/** Match every claim on a remittance. Sequential and paced, server-side. */
export function matchRemittance(office: RcmOfficeId, batchId: string): Promise<BatchMatchResponse> {
  return post<BatchMatchResponse>(`/remittances/${encodeURIComponent(batchId)}/match`, { office });
}
