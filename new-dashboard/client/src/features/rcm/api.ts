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

  /**
   * This user may read the workbench but not approve a posting.
   *
   * TWO codes, one meaning. `POST /remittances/:id/approve` is deliberately NOT
   * exempt from the mount's rcm.read/rcm.write pair, so the platform gate
   * refuses a `reviewer` first with the generic FORBIDDEN — carrying the action
   * that failed. The route's own APPROVE_REQUIRES_WRITE check sits behind it as
   * defence in depth. The screen says the same sentence either way.
   */
  get approveForbidden(): boolean {
    if (this.status !== 403) return false;
    return this.code === "APPROVE_REQUIRES_WRITE" || this.details.action === "rcm.write";
  }

  /** The per-claim checklist a gate refusal carries, if it carries one. */
  get refusedClaims(): ApprovalClaim[] {
    const raw = this.details.claims;
    return Array.isArray(raw) ? (raw as ApprovalClaim[]) : [];
  }

  /**
   * A remittance gets exactly ONE posting plan (Slice 6c), and this one has
   * already been through the drain.
   *
   * TWO codes, and the difference is real rather than cosmetic:
   * `QUEUE_ALREADY_RUNNING` means a drain holds the plan RIGHT NOW — waiting is
   * genuinely the answer. `QUEUE_ALREADY_RAN` means it has been and gone, and
   * waiting will never help: this claim posts by hand in Open Dental until a
   * later slice adds a follow-on plan.
   *
   * Until 6c both said "already under way", which read as "try again in a
   * minute" about a plan that had finished hours earlier.
   */
  get queueAlreadyRan(): boolean {
    return this.code === "QUEUE_ALREADY_RAN";
  }

  /** A drain owns this remittance's plan at this moment. Waiting IS the answer. */
  get queueRunningNow(): boolean {
    return this.code === "QUEUE_ALREADY_RUNNING";
  }

  /**
   * Which state the existing plan is in, for the two codes above.
   *
   * The server's sentence already differs per status; this is what lets a screen
   * link somewhere useful — the Posting queue for a plan that can still be
   * drained, nowhere for one that has finished — without parsing prose.
   */
  get queuePlanStatus(): string | null {
    const raw = this.details.queueStatus;
    return typeof raw === "string" ? raw : null;
  }
}

/**
 * Fallback copy for the two queue-collision refusals.
 *
 * The panel renders the SERVER's sentence, which varies by plan status and is
 * therefore always the better one. These exist so a refusal that somehow arrives
 * without a message still says something true — and so `rcm-labels.test.ts` has
 * something to check the backend's codes against. A code the backend can throw
 * and the client has never heard of would otherwise reach a biller as a blank
 * toast.
 */
export const QUEUE_COLLISION_COPY: Record<string, string> = {
  QUEUE_ALREADY_RUNNING:
    "A posting run for this remittance is under way. Wait for it to finish, then look at what it left.",
  QUEUE_ALREADY_RAN:
    "This remittance's posting plan has already been through the drain, so this claim cannot join it. Post this one by hand in Open Dental — CareIN cannot start a second run for the same check yet.",
};

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

/**
 * The batch match's own budget, above the server's.
 *
 * The server bounds one batch run to `RCM_OD_BATCH_MATCH_BUDGET_MS` (90s by
 * default) and reports what it did not reach, rather than holding the request
 * open for the minutes a 25-claim remittance would otherwise take at >=1.2s per
 * Open Dental CALL. This sits above that so the amber "it may still be running"
 * notice is the EXCEPTION rather than the normal outcome — which is what it was
 * at 120s against an unbounded run.
 *
 * The right long-term shape is a job the page polls (PR #87's bounded-poll
 * rules); that needs run state this slice has no table for, so it is 6b's.
 */
const BATCH_TIMEOUT_MS = 150_000;

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

async function get<T>(
  path: string,
  params: Record<string, string | number>,
  { timeoutMs = REQUEST_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<T> {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();

  // Reads got no timeout at all until this review round, so the initial
  // remittance load could hang forever on a stalled connection and leave the
  // page in a spinner with no way back — the same failure the POST timeout was
  // added to prevent, on the path a user hits first.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${BASE}/rcm${path}?${qs}`, {
      credentials: "include",
      signal: abort.signal,
    });
  } catch (err) {
    if (abort.signal.aborted) {
      throw new RcmApiError("The request took too long and the page stopped waiting", 0, "TIMEOUT");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

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

/**
 * How a document became text — `rcm_eob_uploads.text_source`.
 *
 * A closed union, like `EobUploadStatus` and `TranscribeStatus`: a third source
 * added server-side becomes a compile error here rather than a chip that
 * silently renders as nothing.
 */
export const TEXT_SOURCES = ["text_layer", "ocr"] as const;
export type TextSource = (typeof TEXT_SOURCES)[number];

/**
 * WHERE THE NUMBERS ON A PROPOSAL CAME FROM.
 *
 * Not the same question as `confidence` on a claim, which is the extraction
 * model's confidence in its reading of a STRING. This is about how that string
 * was obtained: parsed out of a PDF's own text layer, or read by OCR off a
 * picture of a fax. A biller checking a $4,000 check decides how hard to look
 * from this, so it is carried all the way to the screen rather than inferred.
 *
 * `textSource: null` genuinely means WE DO NOT KNOW — an 835 (parsed, never
 * read), or an EOB extracted before the OCR slice. The screen shows nothing at
 * all in that case; it never guesses "text layer".
 */
export interface DocumentProvenance {
  textSource: TextSource | null;
  /** Pages Azure Document Intelligence read and billed. null off the OCR path. */
  ocrPageCount: number | null;
  /**
   * 0–1, word-count weighted. null = the reader did not report one, which is a
   * different fact from "the reader was certain" and renders differently.
   */
  ocrMeanConfidence: number | null;
}

export interface EobUpload extends DocumentProvenance {
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

/**
 * A daily cost breaker, as the server reports it.
 *
 * There are TWO, on separate resources with separate meters: Azure OpenAI tokens
 * (`extraction`) and Azure Document Intelligence pages (`ocr`). They share this
 * shape because a screen should render them the same way, and they are never
 * merged because a biller who is stopped has to be told WHICH cap stopped her
 * and when THAT one resets.
 */
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
  /**
   * Which rail this is. Present on the OCR breaker and absent on the extraction
   * one, so a component handed a breaker can always say which cap it is showing
   * rather than depending on which key it was read from.
   */
  rail?: "ocr";
  /** OCR only: pages read today, and the price the cap is denominated in. */
  pagesRead?: number;
  centsPerKPage?: number;
}

export interface EobUploadPage {
  office: RcmOfficeId;
  uploads: EobUpload[];
  total: number;
  limit: number;
  offset: number;
  extraction: EobExtractionState;
  /** The OCR rail. Optional so a client can talk to a server that predates it. */
  ocr?: EobExtractionState;
}

export interface EobUploadResult {
  office: RcmOfficeId;
  /** True when these exact bytes were already on file for this office. */
  duplicate: boolean;
  /** True when a previously-stuck upload was put back on the queue. */
  requeued?: boolean;
  upload: EobUpload;
  extraction?: EobExtractionState;
  ocr?: EobExtractionState;
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
  /**
   * TRI-STATE, and the third state is the one that matters.
   *
   * `true` = ProcStatus "D". `false` = the procedure row says it is live.
   * `'unknown'` = the procedure row could not be READ, and because OD's DELETE
   * is a SOFT delete a deleted procedure is indistinguishable from a live one
   * without it. Unknown lines are out of every total and cannot be paired.
   */
  deleted: boolean | "unknown";
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
    /**
     * The claim HEADER's total, verbatim and CONTAMINATED: `ClaimFee` still
     * counts soft-deleted procedures. Kept because it is what the chart shows;
     * never the figure to compare against.
     */
    claimHeaderFeeCents: number;
    /** The LIVE lines' FeeBilled — the figure the billed evidence used. */
    billedCents: number;
    insPaidCents: number;
    writeOffCents: number;
    patientName: string | null;
    lines: OdLineFacts[];
    deletedLineCount: number;
    /** Lines whose procedure could not be read. Excluded from every total. */
    unknownDeletedLineCount: number;
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
  /**
   * Examined and NOT offered.
   *
   * Without these, an empty `candidates` list is ambiguous in the worst way: a
   * search that found three claims and disqualified all three looks exactly
   * like one that found none, and `no_candidate` then tells a biller the chart
   * has no such claim. The panel renders the two differently.
   */
  rejectedCandidates: number;
  rejectedReasons: { nameMismatch: number; belowScore: number };
  /** The score below which a candidate is not offered at all. */
  minScore: number;
  /** False ⇒ the patient was already linked, so the name rule was off. */
  nameRuleApplied: boolean;
  candidates: MatchCandidate[];
  confirmed: MatchConfirmation | null;
  /** The confirmation a FORCED re-run replaced. Null on an ordinary run. */
  supersededConfirmation: MatchConfirmation | null;
}

/** What a human committed, and what Slice 6c re-verifies against at drain time. */
export interface MatchConfirmation {
  odClaimNum: number;
  odPatNum: number | null;
  confirmedAt: string;
  confirmedBy: string;
  linePairs: LinePair[];
  odAmountsAsRead: {
    /** Line-derived, deleted and unknown lines excluded. The one to compare. */
    billedCents: number;
    /** The raw claim header, which still counts soft-deleted procedures. */
    claimHeaderFeeCents: number;
    insPaidCents: number;
    writeOffCents: number;
    claimStatus: string;
  };
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
  /**
   * Examined by the last match and NOT offered — 0 when none were, or when no
   * match has run.
   *
   * A PROJECTION of the snapshot, present on list rows that carry no snapshot
   * at all, because the remittance's claim list has to be able to tell "Open
   * Dental had nothing" from "Open Dental had things and none could be
   * offered". `matchStatusLabel()` is what turns it into words.
   */
  rejectedCandidates: number;
  odMatchAt: string | null;
  odMatchConfirmedAt: string | null;
  odMatchedBy: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  /**
   * Non-null ⇒ a human approved this claim into a posting plan (Slice 6b).
   *
   * A cheap scalar, deliberately: the screen needs to know THAT the claim was
   * approved, never what the plan contains. It is also the claim-level
   * idempotency guard — single-valued, so a claim can belong to one plan.
   */
  postingQueueId: string | null;
  approvedAt: string | null;
  createdAt: string | null;
  lines: ClaimLine[];
  matchSnapshot?: MatchSnapshot | null;
  /**
   * A match HAS run, but under an older snapshot shape — so its contents are
   * not readable by this build and `matchSnapshot` is null.
   *
   * Kept as a separate flag rather than a nullable union so the panel can say
   * "there is a record here and it is from an earlier version" instead of
   * "nobody has looked", which are different facts.
   */
  matchSnapshotStale?: boolean;
}

/** A claim as the remittance detail lists it (no snapshot — the panel loads that). */
export type RemittanceClaim = Omit<WorkbenchClaim, "matchSnapshot">;

// ─── The approval gate (Slice 6b) ────────────────────────────────────────────

/**
 * One pre-flight condition, as the server evaluated it.
 *
 * `fix` is the server's own copy about what to DO — held there rather than in
 * the client so a screen cannot invent an instruction the gate does not agree
 * with. `detail` is the specific number or reason behind a failure.
 */
export interface ApprovalCheck {
  code: string;
  label: string;
  passed: boolean;
  detail: string | null;
  fix: string;
}

export interface ApprovalClaim {
  claimId: string;
  claimNumber: string;
  /** PHI — the checklist names patients, which is why reading it is audited. */
  patientName: string;
  postable: boolean;
  /** An earlier approval already took this claim. */
  alreadyQueued: boolean;
  checks: ApprovalCheck[];
  /** The codes that failed, in the order they were evaluated. */
  failed: string[];
}

/** What WOULD happen, computed by the same function the button runs. */
export interface ApprovalPreview {
  office: RcmOfficeId;
  batchId: string;
  /** May THIS user press it? The server's answer, not a role name. */
  canApprove: boolean;
  /** The permission a colleague would need. */
  approveRequires: string;
  claims: ApprovalClaim[];
  postableCount: number;
  withheldCount: number;
  queuedCount: number;
  /** The batch's own arithmetic. False holds the WHOLE approve. */
  balanced: boolean;
  differenceCents: number;
}

export interface QueuedClaim {
  claimId: string;
  claimNumber: string;
  patientName: string;
  odClaimNum: number;
  lines: number;
  totalCents: number;
}

export interface WithheldClaim {
  claimId: string;
  claimNumber: string;
  patientName: string;
  reasons: string[];
  checks: ApprovalCheck[];
}

export interface ApprovalResult {
  office: RcmOfficeId;
  batchId: string;
  queueId: string;
  approvedBy: string;
  /** What this press enqueued. Partial success is real success. */
  queued: QueuedClaim[];
  /** What it did not, per claim, with every failing condition. */
  withheld: WithheldClaim[];
  /** What an earlier press had already taken. */
  alreadyQueued: { claimId: string; claimNumber: string; patientName: string }[];
  intendedTotalCents: number;
  /**
   * The server's own sentence, and the literal current truth. It stops being
   * true the day Slice 6c ships — which is why the screen prints the server's
   * words rather than its own.
   */
  note: string;
}

export interface RemittanceUpload extends DocumentProvenance {
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
  /**
   * Slice 5.5's remittance-level facts, as a vocabulary rather than as prose.
   * Coloured by the D-11 split: a BLOCKING flag withholds every claim on this
   * check, an annotating one does not. Both are always shown.
   */
  flags: string[];
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
  /**
   * Does a human still owe an ACTION on this remittance?
   *
   * Computed from `attentionReasons` alone. Facts about the file — a downcode
   * that held the batch `open`, a claim Open Dental has no match for — are
   * `attentionObservations` and never put a row in the queue: a biller who has
   * done everything the screen lets her do must not be told she still owes
   * something, or the true alarms stop being read.
   */
  needsAttention: boolean;
  /** Outstanding ACTIONS. Today there is one: `claims_unreviewed`. */
  attentionReasons: string[];
  /** FACTS worth reading, shown beside the reasons and never driving them. */
  attentionObservations: string[];
  reviewReasonCount: number;
  unmatchedClaimCount: number;
  /** How many claims a human has already approved into a posting plan. */
  queuedClaimCount: number;
  /**
   * When somebody last pressed Approve, whatever came of it.
   *
   * Null means nobody has — which is the difference between a claim that is
   * "not ready" and one that was WITHHELD. A wholly-refused approve rolls back
   * and leaves no plan, so this stamp is the only thing that survives it, and it
   * is what keeps the remittance in the needs-attention view afterwards.
   */
  approvalAttemptedAt: string | null;
  approvalAttemptedBy: string | null;
  upload: RemittanceUpload | null;
}

export interface RemittanceListPage {
  office: RcmOfficeId;
  /** Which population `remittances` was paged out of. */
  view: RemittanceView;
  remittances: Remittance[];
  /** Every remittance this office holds — NOT the page, and NOT the filter. */
  total: number;
  /**
   * How many of that same population need attention, computed server-side over
   * the whole set. "12 needing attention · 640 total" is now one statement about
   * one population; in Slice 6a it was two statements about two.
   */
  needsAttentionCount: number;
  /** How many rows the current view holds — what limit/offset page. */
  matchingCount: number;
  limit: number;
  offset: number;
}

/** Which population the list endpoint pages. */
export type RemittanceView = "attention" | "all";

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
  /**
   * `provenance` lives HERE rather than on `WorkbenchClaim` because the claim
   * shape is also what the remittance list and detail return, and there it comes
   * from the batch's own upload row. One fact, resolved once per screen, rather
   * than the same join repeated per claim in a table.
   */
  claim: WorkbenchClaim & { provenance: DocumentProvenance | null };
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
  /** The wall-clock budget one run may spend before it stops and reports. */
  budgetMs: number;
  /** True when the CLOCK stopped the run rather than the claim cap. */
  outOfTime: boolean;
  /** Claims a cap or the budget left unmatched. Stated, never silent. */
  skipped: number;
  note?: string;
}

/**
 * Every payment batch for this office, with BOTH counts.
 *
 * `view` is applied server-side, over the whole office rather than over a page.
 * Slice 6a filtered a 100-row page in the browser while the header counted
 * everything, so the two numbers described two different populations and a
 * remittance older than the hundredth newest was invisible AND uncounted.
 */
export function listRemittances(
  office: RcmOfficeId,
  opts: { limit?: number; offset?: number; view?: RemittanceView } = {},
): Promise<RemittanceListPage> {
  const params: Record<string, string | number> = { office };
  if (opts.limit !== undefined) params.limit = opts.limit;
  if (opts.offset !== undefined) params.offset = opts.offset;
  if (opts.view !== undefined) params.view = opts.view;
  return get<RemittanceListPage>("/remittances", params);
}

/**
 * The pre-flight checklist: per claim, every condition, with pass/fail.
 *
 * A READ, on `rcm.read`, so the person who did the reviewing can see the
 * consequences of her own work even though she cannot approve it. It is
 * computed by the same function the button runs, so the screen cannot predict
 * an outcome the button then contradicts.
 */
export function getApprovalPreview(
  office: RcmOfficeId,
  batchId: string,
): Promise<ApprovalPreview> {
  return get<ApprovalPreview>(`/remittances/${encodeURIComponent(batchId)}/approval`, { office });
}

/**
 * Approve a remittance for posting. Needs `rcm.write`.
 *
 * The body is EMPTY, and that is the design: the gate re-reads every condition
 * from the database and trusts nothing the client sent. There is no force flag,
 * no override and no claim selection to pass — the only way a withheld claim
 * becomes postable is for a human to fix what withheld it.
 *
 * Nothing is written to Open Dental. This creates rows describing an INTENT;
 * Slice 6c is what acts on them.
 */
export function approveRemittance(
  office: RcmOfficeId,
  batchId: string,
): Promise<ApprovalResult> {
  return post<ApprovalResult>(`/remittances/${encodeURIComponent(batchId)}/approve`, { office }, {});
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
  return post<BatchMatchResponse>(
    `/remittances/${encodeURIComponent(batchId)}/match`,
    { office },
    {},
    { timeoutMs: BATCH_TIMEOUT_MS },
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Slice 6c — the posting queue and the drain
// ───────────────────────────────────────────────────────────────────────────

/**
 * The stored state vocabulary of `rcm_posting_queue`, mirrored from the CHECK
 * constraint in `migrations-tenant/1787120000000_rcm_posting_drain.js`.
 *
 * `approved` and `posting` are Slice 1's words for what the 6c brief calls
 * `queued` and `running` — the stored words were not renamed (a data migration
 * on a shipped table, bought for a synonym), so the server ships BOTH: the raw
 * `status` and the screen's `statusLabel`. Nothing in this client reverses the
 * mapping; it renders what the server said.
 */
export const POSTING_QUEUE_STATUSES = [
  "approved",
  "posting",
  "posted",
  "partially_posted",
  "failed",
  "blocked",
] as const;
export type PostingQueueStatus = (typeof POSTING_QUEUE_STATUSES)[number];

/** What the screen calls each stored state. */
export type PostingQueueLabel =
  | "queued"
  | "running"
  | "posted"
  | "partially_posted"
  | "failed"
  | "blocked";

/**
 * The per-line vocabulary. `skipped_already_posted` is resume's word: Open
 * Dental already showed this line Received with our exact amounts, so there was
 * nothing to write. It is deliberately NOT the same as `skipped` — "we chose not
 * to" and "it was already done" are different facts about money, and only the
 * second one proves a resume did not double-post.
 */
export const POSTING_LINE_STATUSES = [
  "pending",
  "claimproc_written",
  "claim_received",
  "paid",
  // 6d. A takeback that landed, and a separate word from `paid` on purpose: one
  // is money the carrier sent and the other is money it took back. Collapsing
  // them would make the queue unable to answer what the practice received.
  "recouped",
  "failed",
  "skipped",
  "skipped_already_posted",
] as const;
export type PostingLineStatus = (typeof POSTING_LINE_STATUSES)[number];

/**
 * The steps of the forced Open Dental call sequence, in order.
 *
 * `recoupment` and `document_attach` are 6d's and both are now implemented.
 * They come last, and in that order, for two different reasons: a takeback runs
 * after the positive side is complete and proven, so a failure there leaves a
 * legible chart; and the document runs after everything because a document
 * failure is retryable and never a financial error.
 */
export const POSTING_STEPS = [
  "resolve_config",
  "read_od_truth",
  "claimproc_writes",
  "claim_receipts",
  "check",
  "reconcile",
  "recoupment",
  "document_attach",
] as const;
export type PostingStep = (typeof POSTING_STEPS)[number];

/**
 * What a read-back compared, kept rather than recomputed.
 *
 * Open Dental returns `200 OK` on writes it silently ignores, so a status code
 * proves nothing and the comparison is the only evidence a write took. Money
 * fields only — no patient identity ever lands in this column.
 */
export interface PostingReadback {
  step: string;
  agreed: boolean;
  sent?: Record<string, unknown>;
  read?: Record<string, unknown>;
  mismatches?: { field: string; sent: unknown; read: unknown }[];
}

export interface PostingQueueRow {
  queueId: string;
  office: RcmOfficeId;
  batchId: string;
  status: PostingQueueStatus;
  statusLabel: PostingQueueLabel;
  /** The machine reason a plan is blocked. The client renders copy from it. */
  blockedReason: string | null;
  step: PostingStep | null;
  isRecoupment: boolean;
  /** 6d: the EOB filing, on its own axis. See PostingDocumentAttach.status. */
  documentAttachStatus: "none" | "attached" | "partial" | "failed" | null;
  carrierEobDate: string | null;
  intendedTotalCents: number;
  postedTotalCents: number;
  /** THE PROOF THE MONEY LANDED. Null until a check exists in Open Dental. */
  odClaimPaymentNum: number | null;
  /**
   * When `GET /claimprocs?ClaimPaymentNum=` returned exactly this plan's lines.
   * A `posted` row cannot exist without it — the database refuses — so the
   * screen may state "verified by read-back" as a fact rather than a hope.
   */
  reconciledAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  drainAttemptAt: string | null;
  drainedBy: string | null;
  attemptCount: number;
  lastError: string | null;
  checkNumber: string | null;
  payer: string | null;
}

export interface PostingQueueLine {
  queueLineId: string;
  position: number;
  odClaimNum: number | null;
  odClaimProcNum: number;
  status: PostingLineStatus;
  skipReason: string | null;
  intendedInsPayAmtCents: number;
  intendedWriteOffCents: number;
  intendedDedAppliedCents: number;
  isSupplemental: boolean;
  /**
   * 6d. Which takeback path this line was AUTHORISED for, and what it left in
   * the chart. The two ids are separate because one can be undone and one
   * cannot — `adjustment` is reversible by an offsetting adjustment (there is no
   * DELETE /adjustments), and `supplemental` cannot be reverted or deleted at
   * all and permanently pins its claim and procedure.
   */
  recoupmentPath: RecoupmentPath | null;
  odAdjustmentNum: number | null;
  odSupplementalClaimProcNum: number | null;
  claimprocWrittenAt: string | null;
  claimReceivedAt: string | null;
  paidAt: string | null;
  odClaimPaymentNum: number | null;
  readback: PostingReadback | null;
  readbackAt: string | null;
  lastError: string | null;
}

export interface PostingQueuePage {
  office: RcmOfficeId;
  rows: PostingQueueRow[];
  /** Zero-filled over the whole vocabulary — a missing state is a measured 0. */
  byStatus: Record<PostingQueueStatus, number>;
  total: number;
  limit: number;
  offset: number;
  /** May THIS caller press Drain? The server's answer, not a role name. */
  canDrain: boolean;
  drainRequires: string;
  /** D-7: whether this practice may be posted to at all yet. */
  postingEnabled: boolean;
}

export interface PostingQueueDetail {
  office: RcmOfficeId;
  plan: PostingQueueRow;
  lines: PostingQueueLine[];
  claims: {
    claimId: string;
    claimNumber: string | null;
    patientName: string | null;
    odClaimNum: number | null;
  }[];
  canDrain: boolean;
  drainRequires: string;
  postingEnabled: boolean;
  /**
   * The EOB filing, on its OWN axis — never folded into `plan.status`. A plan
   * whose money is correct and proven stays `posted` whether or not a PDF
   * reached the chart.
   */
  documentAttach: PostingDocumentAttach;
}

/** The two ways a takeback may be written. Only one of them can be undone. */
export type RecoupmentPath = "adjustment" | "supplemental";

/** How the EOB filing went for one patient on the plan. */
export interface PostingDocument {
  odPatientId: number;
  /** The DocNum, read back from the patient's own document list. */
  odDocNum: number | null;
  description: string | null;
  status: "pending" | "attached" | "failed";
  error: string | null;
  attachedAt: string | null;
}

export interface PostingDocumentAttach {
  implemented: boolean;
  /**
   * ─────────────────────────────────────────────────────────────────────────
   * `null` AND `none` ARE DIFFERENT, AND THE DIFFERENCE IS OUTSTANDING WORK
   * ─────────────────────────────────────────────────────────────────────────
   *   `null`      not attempted. On a POSTED plan that means the attach never
   *               ran — most likely the process died between the two — so it is
   *               work somebody still owes, and the screen offers the retry
   *               exactly as it does for `failed`.
   *   `none`      examined, and there is genuinely nothing to file: an 835 that
   *               arrived with no document. No retry — there is nothing behind
   *               the button.
   *   `partial`   some patients filed and some did not.
   *
   * Collapsing the first two is what would let a plan sit green with an EOB
   * silently missing from a chart.
   */
  status: "none" | "attached" | "partial" | "failed" | null;
  error: string | null;
  at: string | null;
  documents: PostingDocument[];
  canRetry: boolean;
  retryRequires: string;
}

export interface DrainOutcome {
  queueId: string;
  status: PostingQueueStatus | "not_found";
  reason?: string;
  detail?: string;
  odClaimPaymentNum?: number | null;
}

export interface DrainResult {
  office: RcmOfficeId;
  outcomes: DrainOutcome[];
  ran: number;
  /** The run hit its wall-clock budget and stopped BETWEEN plans. */
  outOfTime: boolean;
  remaining: number;
  /**
   * The per-office DefNums this run resolved from THIS practice's own Open
   * Dental. Configuration, not patient data — and what makes "the numbers never
   * cross" checkable by the person who owns both practices.
   */
  config: {
    officeKey: string;
    resolvedAt: string;
    payTypes: { defNum: number; name: string }[];
    adjTypeCount: number;
    docCategoryCount: number;
    prefs: { claimPaymentBatchOnly: boolean | null; showAutoDeposit: boolean | null };
    filterHonored: { payTypes: boolean; adjTypes: boolean; docCategories: boolean };
  } | null;
  postingEnabled: boolean;
}

/** The plans for this office, with per-state counts over the whole office. */
export function listPostingQueue(
  office: RcmOfficeId,
  opts: { limit?: number; offset?: number } = {},
): Promise<PostingQueuePage> {
  const params: Record<string, string | number> = { office };
  if (opts.limit !== undefined) params.limit = opts.limit;
  if (opts.offset !== undefined) params.offset = opts.offset;
  return get<PostingQueuePage>("/posting/queue", params);
}

/** One plan: every line, its progress, and the read-back that verified it. */
export function getPostingPlan(
  office: RcmOfficeId,
  queueId: string,
): Promise<PostingQueueDetail> {
  return get<PostingQueueDetail>(`/posting/queue/${encodeURIComponent(queueId)}`, { office });
}

/**
 * DRAIN — write approved plans to Open Dental. Needs `rcm.write`.
 *
 * The only call in this client that changes a patient's chart.
 *
 * The body carries nothing but an optional `queueId` NARROWING. There is no
 * claim list, no amounts, no force flag and no office in the body: the office is
 * the validated query param and everything else is read from the plan the gate
 * wrote. Nothing a request can say changes which chart is written or what is
 * written to it.
 *
 * A held request with a long timeout, like the batch matcher: at ≥1.2 s per Open
 * Dental call a large plan is minutes. When the server's own budget runs out it
 * returns `outOfTime` with how many plans are left, and the button is pressed
 * again.
 */

/**
 * What a takeback approve WOULD do, and the exact phrase to type back (6d).
 *
 * `typedTotalExpected` is RENDERED VERBATIM and never re-derived from cents.
 * D-6's friction is that a person reads an amount and types it; that only works
 * if the amount on the screen and the amount the server demands come from one
 * formatter, and the server's is the one that decides.
 */
export interface RecoupmentChecklist {
  office: RcmOfficeId;
  batchId: string;
  claims: ApprovalClaim[];
  /** Zero is a real answer: nothing on this remittance is a takeback. */
  recoupmentClaims: number;
  recoupmentTotalCents: number;
  /** Type this, exactly. */
  typedTotalExpected: string;
  paths: RecoupmentPath[];
  /** Stated by the server so a client cannot pre-select the irreversible one. */
  defaultPath: RecoupmentPath;
  balanced: boolean;
  differenceCents: number;
  canApprove: boolean;
  approveRequires: string;
}

export interface RecoupmentApprovalResult extends ApprovalResult {
  recoupmentPath: RecoupmentPath;
  recoupmentTotalCents: number;
  note: string;
}

/** The takeback checklist. A READ — `reviewer` may look without authorising. */
export function getRecoupmentChecklist(
  office: RcmOfficeId,
  batchId: string,
): Promise<RecoupmentChecklist> {
  return get<RecoupmentChecklist>(
    `/remittances/${encodeURIComponent(batchId)}/recoupment`,
    { office },
  );
}

/**
 * D-6. Approve a takeback, having typed its amount.
 *
 * The server re-validates `typedTotal` against a total it computes itself, so
 * this call cannot be made to skip the confirmation by a client that simply
 * does not render the dialog. A mismatch is 422 `RECOUPMENT_CONFIRM_MISMATCH`
 * and nothing is recorded.
 */
export function approveRecoupment(
  office: RcmOfficeId,
  batchId: string,
  body: { typedTotal: string; path: RecoupmentPath },
): Promise<RecoupmentApprovalResult> {
  return post<RecoupmentApprovalResult>(
    `/remittances/${encodeURIComponent(batchId)}/approve-recoupment`,
    { office },
    body,
  );
}

/**
 * Re-file an EOB that did not file (6d).
 *
 * Cannot move a cent: the server refuses any plan that is not already `posted`,
 * and the only Open Dental verb it can reach is the document upload. Pressing it
 * twice is safe — the attach adopts a document already carrying this plan's
 * description rather than filing a second copy.
 */
export function retryDocumentAttach(
  office: RcmOfficeId,
  queueId: string,
): Promise<{ office: RcmOfficeId; queueId: string; documentAttach: PostingDocumentAttach }> {
  return post(
    `/posting/queue/${encodeURIComponent(queueId)}/attach-document`,
    { office },
    {},
    { timeoutMs: BATCH_TIMEOUT_MS },
  );
}
export function drainPostingQueue(
  office: RcmOfficeId,
  opts: { queueId?: string } = {},
): Promise<DrainResult> {
  return post<DrainResult>(
    "/posting/drain",
    { office },
    opts.queueId ? { queueId: opts.queueId } : {},
    { timeoutMs: BATCH_TIMEOUT_MS },
  );
}
