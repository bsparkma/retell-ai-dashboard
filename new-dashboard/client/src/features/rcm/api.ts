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
    "This check has already been posted, so this claim cannot join it. Post this one by hand in Open Dental — CareIN cannot start a second run for the same check yet.",
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

async function mutate<T>(
  method: "POST" | "PUT",
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
      method,
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

/**
 * The two mutating verbs this module uses, over one implementation.
 *
 * PUT exists for exactly one route — the shadow gate's switch — and it shares
 * `mutate` rather than getting its own copy of the abort/401/error handling,
 * because a second copy is a second place for "not signed in" to be handled
 * differently.
 */
function post<T>(
  path: string,
  params: Record<string, string | number>,
  body: unknown = {},
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  return mutate<T>("POST", path, params, body, opts);
}

function put<T>(
  path: string,
  params: Record<string, string | number>,
  body: unknown = {},
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  return mutate<T>("PUT", path, params, body, opts);
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
  /**
   * What Open Dental ESTIMATES insurance will pay on this line, or `null` when
   * it has not calculated one.
   *
   * `null` IS NOT ZERO. Open Dental writes -1 into `InsEstTotal` to mean "not
   * calculated", so a screen printing $0.00 for it would state a number nobody
   * computed. Rendered as "not calculated".
   */
  insEstCents: number | null;
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
    /**
     * THE TWO IDENTITY FACTS, from the patient row the match already fetched.
     *
     * Both `null` when Open Dental did not send them, and that is load-bearing
     * rather than defensive: a missing identity fact must read as "not recorded"
     * and never as a value somebody could compare against an EOB. A fabricated
     * subscriber id on a verification screen is the worst failure this module
     * has.
     *
     * `patientBirthdate` is the DATE PART ONLY — Open Dental returns a birthdate
     * as a day or as a midnight instant depending on the resource, and an
     * instant would print the wrong day for anybody east of UTC, in the one
     * place where being a day out means the wrong person.
     */
    patientBirthdate: string | null;
    subscriberId: string | null;
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
  /**
   * THE CARRIER'S ARITHMETIC, computed once on the server.
   *
   * `contractualWriteOffCents` is billed − allowed: the carrier's own figure,
   * always accepted, never a choice. `patientRemainderCents` is allowed − paid:
   * what the EOB says the patient owes on this line, and the ONLY thing the
   * decision below is about.
   *
   * Not derived here. Two subtractions done in two languages are two places for
   * a rounding habit to make this screen disagree with the gate about money.
   */
  contractualWriteOffCents: number;
  patientRemainderCents: number;
  /** `null` = nobody has said. Reads as `bill_patient` for the money. */
  decision: LineDecision | null;
  /** A canned reason slug. Present exactly when the decision is a write-off. */
  decisionReason: string | null;
  /** Who decided, by name. Null when nobody has. */
  decidedBy: string | null;
  decidedAt: string | null;
}

/**
 * What a biller can decide about one line's patient remainder.
 *
 * TWO stored values, not three. The screen renders the accepted contractual
 * write-off beside them — which reads as three things — but the carrier's figure
 * is a FACT this slice always accepts, never an option, so there is nothing to
 * store about it.
 *
 * There is no amount anywhere: a line is written off whole or billed whole.
 */
export const LINE_DECISIONS = ["bill_patient", "office_writeoff"] as const;
export type LineDecision = (typeof LINE_DECISIONS)[number];

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
  /**
   * THE PATIENT-RESPONSIBILITY VERDICT THIS CLAIM WAS JUDGED ON (Stage B1).
   *
   * The gate carries `verdictFor()`'s whole result out per claim
   * (`routes/rcm/approvalGate.js`), so every screen reading this list prints the
   * gate's own numbers rather than a second computation of them. The check's
   * triage table (§4) and the approve page's roll-up (§6) both read it from
   * here, which is what makes them one statement rather than three that agree
   * today.
   *
   * OPTIONAL, because a claim judged from a snapshot in an older shape carries
   * none — exactly as `matchSnapshot` can be absent. A screen must render that
   * as "not judged", never as zero: see `features/rcm/rollup.ts`.
   */
  verdict?: ClaimVerdict;
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

  /**
   * SAVED FOR TOMORROW — a biller's own note to herself.
   *
   * Parking changes NOTHING about whether this check needs attention; it is
   * still counted, still in every queue it was in. The only thing it does is let
   * Today lead with "where you left off". Null means not parked, never "parked
   * by nobody".
   */
  parkedAt: string | null;
  parkedBy: string | null;
  /** Her own line, optional by design. PHI-capable — never logged, never audited. */
  parkedNote: string | null;

  /**
   * SET ASIDE — a check nobody is coming back to.
   *
   * The server's attention predicate returns early for one of these, so it is
   * out of `needsAttention` and out of every work-state count. It is NOT out of
   * the data: it stays under `view=all`, has its own `view=set_aside`, and can
   * be put back in one click.
   *
   * Not the same as a RETIRED posting (`withdrawnReason` on a posting row),
   * which is terminal, irreversible, and about money rather than about a
   * worklist.
   */
  setAsideAt: string | null;
  setAsideBy: string | null;
  /** A SLUG the client renders copy from — see SET_ASIDE_COPY. */
  setAsideReason: SetAsideReason | string | null;
  setAsideNote: string | null;

  /**
   * DID THE APP GET THIS CHECK RIGHT? — the shadow-mode comparison (C-2).
   *
   * Null means NOBODY HAS ANSWERED, never "no difference found". The panel
   * renders the question on a null and the recorded answer on anything else.
   *
   * `comparisonRevision` is how many times it has been answered: 0 never, 1
   * once, 2+ changed. An answer is changeable until the check posts, and the
   * count is what stops a change from being a silent overwrite.
   */
  comparisonVerdict: ComparisonVerdict | string | null;
  /** A SLUG the client renders copy from — see COMPARISON_COPY. */
  comparisonReason: ComparisonReason | string | null;
  /** Her own line. Required by the server whenever the verdict is `differed`. */
  comparisonNote: string | null;
  comparisonAt: string | null;
  comparisonBy: string | null;
  comparisonRevision: number;

  /**
   * WHEN SOMEBODY LAST DECIDED A WRITE-OFF ON THIS CHECK, AND WHO.
   *
   * §15.2's ninth finding — the per-user touch stamp "where you left off" never
   * had. Parking and pressing Approve were the two facts it worked from, and
   * neither is what a biller means by leaving off: that is the check she was
   * reading when the phone rang, which she neither parked nor tried to approve.
   *
   * Null throughout means nobody has decided anything here — NOT "decided by
   * nobody".
   */
  lastDecidedAt: string | null;
  lastDecidedBy: string | null;

  upload: RemittanceUpload | null;
}

/**
 * Why a check was set aside. A closed set, enforced by a CHECK constraint —
 * currently `migrations-tenant/1787800000000_rcm_set_aside_sent_in_error.js`,
 * which widened the one `1787500000000` created.
 *
 * `sent_in_error` is Stage C's addition and the only change to the vocabulary:
 * the other five slugs are exactly what they were, `target_gone` included. Their
 * LABELS were reworded; a stored slug is a machine name and Stage C changes none.
 *
 * The wire type is widened to `string` on `Remittance.setAsideReason` on
 * purpose: a slug added server-side must render as an ugly string rather than
 * crash a screen, exactly as every other vocabulary in this module fails.
 */
export const SET_ASIDE_REASONS = [
  "target_gone",
  "duplicate",
  "posted_by_hand",
  "not_ours",
  "sent_in_error",
  "other",
] as const;
export type SetAsideReason = (typeof SET_ASIDE_REASONS)[number];

/**
 * What each reason means, in the words a biller would use to say it out loud.
 *
 * `note` on `other` is REQUIRED by the server (400 SET_ASIDE_NOTE_REQUIRED), so
 * the dialog demands it too rather than letting somebody discover the rule by
 * being refused.
 */
export const SET_ASIDE_COPY: Record<SetAsideReason, { label: string; hint: string }> = {
  /*
   * THE CASE THE WHOLE FEATURE WAS BUILT FOR, and the label now says so.
   *
   * Two checks sat in staging's attention queue permanently — both matched, both
   * checked over, both pointing at claims a walk's unwind deleted — because
   * nothing in the product could retire them (RCM_POSTING §15.2 finding 5). The
   * slug is untouched; only the words a person reads changed.
   */
  target_gone: {
    label: "The claims aren't in Open Dental any more",
    hint: "Nothing on this check can ever be tied to a chart claim, so nothing on it can be posted.",
  },
  duplicate: {
    label: "The same money came in twice",
    hint: "There is another copy of this check, and that is the one being worked.",
  },
  posted_by_hand: {
    label: "Somebody already posted it in Open Dental",
    hint: "The money is on the chart. CareIN had no part in putting it there and must not add it again.",
  },
  not_ours: {
    label: "It isn't this practice's money",
    hint: "It belongs to another practice, or to a payer this practice does not bill.",
  },
  sent_in_error: {
    label: "The carrier sent it in error",
    hint: "It should never have arrived — the wrong practice's file, a run they reversed, a test. There is no other copy to work.",
  },
  other: {
    label: "Something else",
    hint: "Say in a line what it is. This one needs your own words, because the slug alone would tell the next person nothing.",
  },
};

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SHADOW-MODE COMPARISON (Stage C-2)
 * ═════════════════════════════════════════════════════════════════════════════
 * While posting is switched off, the practice puts the same money into Open
 * Dental by hand. The one question that period exists to answer is whether what
 * this app worked out matches what she would have done — and the answer used to
 * live in a hand-kept spreadsheet, which is the first thing that gets dropped at
 * 9pm.
 *
 * Two answers, and deliberately no third. A "not sure" is an answer nobody can
 * count, and the thing this feeds is a run of checks that came out the same.
 * Somebody genuinely unsure leaves it unanswered, which the null already says.
 *
 * Widened to `string` on the wire type for the same reason every other
 * vocabulary here is: a slug added server-side must render as an ugly string
 * rather than crash a screen.
 */
export const COMPARISON_VERDICTS = ["same", "differed"] as const;
export type ComparisonVerdict = (typeof COMPARISON_VERDICTS)[number];

/**
 * The posting states that CLOSE the question, mirrored from the server's own
 * `COMPARISON_CLOSED_STATUSES` (`routes/rcm/remittances.js`).
 *
 * Money has reached the chart, so the hand-posting this was a comparison against
 * is over. `failed`, `blocked` and retired are deliberately absent: nothing
 * reached a chart in any of them, so the question is still live.
 *
 * Mirrored rather than fetched because it decides whether a BUTTON renders, and
 * a screen that had to ask the server what its own control does would show the
 * wrong thing for one round trip. The server is the authority — it refuses with
 * COMPARISON_CLOSED regardless of what this list says.
 */
export const COMPARISON_CLOSED_STATUSES: readonly string[] = ["posted", "partially_posted"];

/**
 * What was off. A closed set, enforced by a CHECK constraint —
 * `migrations-tenant/1787900000000_rcm_shadow_comparison.js`.
 *
 * Four of the five name a figure the app works out; the fifth is the case where
 * it was looking at the wrong thing entirely. The note is required on ALL of
 * them, not only on `other`: "the payment amount" without the two figures is a
 * report nobody can act on three weeks later.
 */
export const COMPARISON_REASONS = [
  "payment_amount",
  "write_off",
  "patient_portion",
  "wrong_target",
  "other",
] as const;
export type ComparisonReason = (typeof COMPARISON_REASONS)[number];

/**
 * What each one means, in the words a biller would use to say it out loud.
 *
 * No "error", no "mistake", no "inaccurate". She is reporting what the software
 * did, and the software is the thing under examination here — copy that framed
 * it as fault-finding would make the honest answer feel like a complaint.
 */
export const COMPARISON_COPY: Record<ComparisonReason, { label: string; hint: string }> = {
  payment_amount: {
    label: "The payment amount",
    hint: "What the app had the insurance paying was not what you put in.",
  },
  write_off: {
    label: "A write-off",
    hint: "The amount the office absorbed, or whether there was one at all.",
  },
  patient_portion: {
    label: "The patient's number",
    hint: "What the app said the patient would end up owing.",
  },
  wrong_target: {
    label: "The wrong claim or the wrong patient",
    hint: "The figures may have been fine; they were going to the wrong place.",
  },
  other: {
    label: "Something else",
    hint: "Anything the four above do not cover.",
  },
};

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
  /**
   * The same whole-office population, counted for the two states this slice
   * adds — so Today's "3 saved for tomorrow" and the tab that then shows 3 are
   * one statement about one population.
   */
  parkedCount: number;
  setAsideCount: number;
  /** How many rows the current view holds — what limit/offset page. */
  matchingCount: number;
  limit: number;
  offset: number;
}

/**
 * Which population the list endpoint pages, server-side, over the WHOLE office.
 *
 * The three work-state tabs (`match`, `review`, `approve`) are NOT here: they
 * are applied in the browser to whatever page came back, and the screens say so.
 * See `features/rcm/worklist.ts`.
 */
export type RemittanceView = "attention" | "parked" | "set_aside" | "all";

export interface RemittanceDetail {
  office: RcmOfficeId;
  remittance: Remittance & {
    /** Provider-level money, belonging to no single claim. Detect-and-flag only. */
    plbAdjustments: unknown[];
    /**
     * THIS CHECK'S OWN POSTINGS — ids and states, nothing else.
     *
     * The one fact that lets Post to Open Dental live on the check's page: the
     * server's posting route has taken an optional `queueId` since 6c and
     * narrows on it inside the same office-scoped, status-filtered query, so
     * naming one here can never reach anything the office-wide press would not
     * have posted.
     *
     * An ARRAY because the table permits more than one; today the
     * `(office_id, remittance_key)` unique index means at most one, and the
     * screen reads the first.
     */
    plans: { queueId: string; status: PostingQueueStatus }[];
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

/**
 * The verdict on one claim's patient responsibility (Stage B1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CLIENT DOES NOT COMPUTE THIS AND MUST NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * `sentence` arrives already written and already formatted, for exactly the
 * reason the takeback's typed phrase does: a client that formats cents itself is
 * a client that can display `$54.8` while the server means `$54.08`. The same
 * server function produces the approval gate's "The patient's number matches the
 * EOB" check, so this screen and that checklist cannot disagree.
 *
 * TWO REGISTERS, and the copy says which one it is. Before posting the verdict
 * is a PROJECTION — *"will owe … once posted"*. After a real post it is
 * recomputed from what Open Dental was read back as holding and says
 * *"owes … — confirmed in Open Dental"*. A projection worded as a confirmation
 * is the honest-states rule failing in the most expensive place there is.
 */
export type VerdictState = "green" | "amber" | "red";

export interface ClaimVerdict {
  state: VerdictState;
  register: "projection" | "confirmed";
  /** What the EOB says the patient owes — the sum of every line's remainder. */
  eobPatientCents: number;
  /** What they will owe once this posts: the lines the office is billing them for. */
  projectedPatientCents: number;
  /** What the office decided to absorb. Zero on a green verdict. */
  decidedWriteOffCents: number;
  /** The carrier's own write-off. A fact, shown, never decided about. */
  contractualWriteOffCents: number;
  decisions: {
    lineId: string | null;
    code: string;
    amountCents: number;
    reason: string | null;
    reasonLabel: string | null;
    decidedBy: string | null;
    decidedAt: string | null;
  }[];
  /** Why it is red. Empty on green and amber. Every entry names a line. */
  problems: { kind: string; code: string; lineId: string | null; detail: string }[];
  /** The whole verdict as one sentence, in the biller's register. Rendered verbatim. */
  sentence: string;
}

/**
 * Is this the patient on the EOB?
 *
 * Name and date of birth BLOCK an approval when they disagree; a subscriber id
 * is reported and does not, because carriers reformat member numbers constantly
 * and the two names plus a birthday are what identify a person.
 *
 * `unknown` is a third state and never blocks. Open Dental sends no subscriber
 * id on some rows, and comparing against a value nobody holds would manufacture
 * a disagreement out of an absence.
 */
export interface ClaimIdentity {
  matched: boolean;
  blocking: boolean;
  fields: {
    field: "name" | "dob" | "subscriber";
    label: string;
    eob: string | null;
    od: string | null;
    status: "agrees" | "differs" | "unknown";
    blocking: boolean;
  }[];
}

/**
 * What Open Dental held for the confirmed claim, AS READ at match time.
 *
 * Read out of the snapshot, so `fetchedAt` is on it and the screen says so. The
 * drain re-verifies against the live chart at post time; this is what a biller
 * compares by eye, and labelling it is the difference between a comparison and a
 * claim about now.
 */
export interface ClaimChart {
  odClaimNum: number | null;
  claimStatus: string | null;
  fetchedAt: string | null;
  billedCents: number | null;
  insPaidCents: number | null;
  writeOffCents: number | null;
  lines: {
    odClaimProcNum: number;
    code: string;
    status: string;
    feeBilledCents: number;
    /** `null` = Open Dental has not calculated one. Never printed as $0. */
    insEstCents: number | null;
    insPayAmtCents: number;
    writeOffCents: number;
  }[];
}

export interface ClaimDetailResponse {
  office: RcmOfficeId;
  /**
   * `provenance` lives HERE rather than on `WorkbenchClaim` because the claim
   * shape is also what the remittance list and detail return, and there it comes
   * from the batch's own upload row. One fact, resolved once per screen, rather
   * than the same join repeated per claim in a table.
   */
  claim: WorkbenchClaim & {
    /**
     * How this claim's numbers became text, and WHICH document they came from.
     *
     * `uploadId` is what the "Open the EOB" link addresses — the blob key is
     * never in a response body (Slice 4: "a key in a response is a key in a
     * browser cache"), so the id is the only handle a client ever holds.
     */
    provenance: (DocumentProvenance & { uploadId: string }) | null;
    /** PHI, detail-read only — the list deliberately does not select them. */
    patientDob: string | null;
    subscriberId: string | null;
    /** Stage B1. Absent on a stale-shaped snapshot, like `matchSnapshot`. */
    verdict?: ClaimVerdict;
    identity?: ClaimIdentity;
    chart?: ClaimChart | null;
    /**
     * When this claim's chart was read back after posting (B2), or null.
     *
     * Its presence is also what tells you which register `verdict` is in — the
     * server sends the CONFIRMED verdict once there is one, and the projection
     * until then. The screen reads `verdict.register` rather than inferring it
     * from this, because a sentence's tense is the server's to decide.
     */
    confirmedAt?: string | null;
  };
  /**
   * The reasons a line may be written off, FROM THE SERVER.
   *
   * Not a constant here, for the same reason `matchRules` is not: the screen
   * explains itself with the list that actually governs, and the day this
   * becomes per-office editable every screen already renders whatever comes
   * back.
   */
  writeoffReasons: { slug: string; label: string }[];
  matchRules: MatchRules;
}

/** What `PUT /claims/:id/lines/:lineId/decision` sends back. */
export interface LineDecisionResponse {
  office: RcmOfficeId;
  claimId: string;
  lineId: string;
  decision: LineDecision;
  reason: string | null;
  /**
   * The RECOMPUTED verdict for the whole claim, and the lines behind it.
   *
   * Returned so the screen never has to do this arithmetic to update itself. One
   * function on the server, and the client is not the second copy of it.
   */
  verdict: ClaimVerdict | null;
  lines: ClaimLine[];
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

/**
 * Record the decision about one line's patient remainder (Stage B1).
 *
 * PUT because the decision is single-valued: pressing the same choice twice is
 * the same state, and a retry after a dropped connection cannot produce two
 * decisions. `reason` is required by the server for `office_writeoff` and
 * refused for anything else.
 */
export function setLineDecision(
  office: RcmOfficeId,
  claimId: string,
  lineId: string,
  decision: LineDecision,
  reason?: string | null,
): Promise<LineDecisionResponse> {
  return put<LineDecisionResponse>(
    `/claims/${encodeURIComponent(claimId)}/lines/${encodeURIComponent(lineId)}/decision`,
    { office },
    { decision, reason: reason ?? null },
  );
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
  /**
   * TERMINAL, and the only state a plan can reach without a run.
   *
   * Deliberately not a `blockedReason`: `blocked` promises a way out and is
   * re-drainable, while a plan whose Open Dental claim was deleted has none —
   * a ClaimNum is never reissued. A withdrawn plan cannot be pressed at all.
   */
  "withdrawn",
] as const;
export type PostingQueueStatus = (typeof POSTING_QUEUE_STATUSES)[number];

/** What the screen calls each stored state. */
export type PostingQueueLabel =
  | "queued"
  | "running"
  | "posted"
  | "partially_posted"
  | "failed"
  | "blocked"
  | "withdrawn";

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
  /*
   * B2's two. `office_writeoffs` runs only where a practice books its own
   * write-offs as a ledger adjustment; `confirm_patient` runs on every plan and
   * is the last thing between a chart write and calling this finished — it
   * reads each claim back and asks whether the patient owes what the screen
   * promised.
   */
  "office_writeoffs",
  "recoupment",
  "confirm_patient",
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
  /**
   * Why a plan was retired, as a slug. `target_removed` is the drain's own —
   * it asked Open Dental and the claim is gone. `manual` is a person's.
   */
  withdrawnReason: "target_removed" | "manual" | null;
  /**
   * The sentence a person typed. Separate from the slug because a biller
   * retiring a plan knows something the machine does not — and because for a
   * `manual` withdrawal this is the ONLY record of why.
   */
  withdrawnNote: string | null;
  withdrawnAt: string | null;
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
  /**
   * WHAT THE OFFICE ITSELF DECIDED TO ABSORB on this line, frozen at approve.
   *
   * `null` — never 0 — when nobody decided anything. The three decision fields
   * are frozen together or not at all, so a reason without an amount is a shape
   * the database refuses.
   *
   * Kept SEPARATE from `intendedWriteOffCents`, which is the CARRIER's
   * contractual figure. Adding them together is what the drain does at the
   * moment it writes; a screen that showed only the sum would be showing a
   * number nobody decided.
   */
  decidedWriteOffCents: number | null;
  decidedReason: string | null;
  decidedBy: string | null;
  /**
   * What the approve PROMISED the patient would owe on this line (B2).
   *
   * The confirmation measures the chart against this rather than against a
   * figure re-derived from a fee somebody can edit. `null` on a plan approved
   * before B2 — the screen states the weaker guarantee rather than hiding it.
   */
  intendedPatientCents: number | null;
  /** Where a ledger concession landed, under `adjustment_by_name`. */
  odWriteoffAdjustmentNum: number | null;
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
  /**
   * THE SHADOW GATE. Whether an administrator has switched posting ON for this
   * practice — deliberately a separate field from `postingEnabled`.
   *
   * They are different facts with different remedies. `postingEnabled: false`
   * means the practice has never been validated and the fix is a code change
   * with evidence; `drainEnabled: false` means nobody has flipped the switch
   * yet and the fix is one toggle on the Admin page. One sentence for both
   * would send a biller to the wrong person.
   */
  drainEnabled: boolean;
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
  /** The shadow gate — see `PostingQueuePage.drainEnabled`. */
  drainEnabled: boolean;
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
 * ASK OPEN DENTAL AGAIN WHETHER THE PATIENT OWES WHAT THIS CHECK PROMISED.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, AND STRUCTURALLY SO
 * ─────────────────────────────────────────────────────────────────────────────
 * `POST /api/rcm/posting/:id/recheck` re-runs the confirmation against the
 * plan's existing lines and writes NOTHING — not to a chart, not to the plan's
 * status, not to CareIN's own record of the verdict. The two Open Dental calls
 * behind it are both GETs and both audited as reads.
 *
 * It exists so a biller who has corrected something in Open Dental can ask
 * whether it is right now, WITHOUT pressing the one button in this product that
 * writes to a chart. "Press Post again to find out whether it posted" is the
 * kind of sentence this project keeps deleting.
 *
 * A POST rather than a GET because it spends real calls against a rate-limited
 * credential the voice side shares, and a GET is a thing browsers and link
 * previews fire without being asked.
 *
 * Refuses with 409 `NOTHING_POSTED_YET` on a plan that has not posted: there is
 * nothing in the chart to read back, and a confirmation over that would be a
 * projection wearing a confirmation's words.
 */
export function recheckPosting(
  office: RcmOfficeId,
  queueId: string,
): Promise<PostingRecheck> {
  return post<PostingRecheck>(`/posting/${encodeURIComponent(queueId)}/recheck`, { office }, {});
}

export interface PostingRecheck {
  office: RcmOfficeId;
  queueId: string;
  /** The plan's status, UNCHANGED by this call. */
  status: PostingQueueStatus;
  claims: {
    claimId: string | null;
    odClaimNum: number;
    /** `verdictFor`'s CONFIRMED register — measured, never re-derived. */
    verdict: ClaimVerdict;
  }[];
  /**
   * True when every claim now reads back as promised.
   *
   * It does NOT move the plan. A person who has corrected the chart still
   * presses Post to Open Dental to finish it off; this only says whether that
   * press will land.
   */
  agreed: boolean;
  checkedAt: string;
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
/**
 * Retire a plan that must never run.
 *
 * TERMINAL and NOT a delete: the plan, its lines and its approval all stay, and
 * the remittance keeps its record. It simply leaves `DRAINABLE_STATUSES`, so it
 * can never be pressed again.
 *
 * The note is required by the server, not merely by the form. It is the only
 * account of why money that was approved is not going to post — nothing else on
 * the row will ever explain it.
 *
 * Refused with 409 for a plan that has already put money in a chart.
 */
export function withdrawPostingPlan(
  office: RcmOfficeId,
  queueId: string,
  note: string,
): Promise<{ queueId: string; status: "withdrawn"; withdrawnReason: "manual" }> {
  return post(`/posting/queue/${encodeURIComponent(queueId)}/withdraw`, { office }, { note });
}

/**
 * The shadow gate, as an administrator sees it.
 *
 * Both conditions in one shape, because an admin flipping the switch on a
 * practice the code ceiling still refuses would otherwise be left looking at a
 * toggle that does nothing.
 */
export interface RcmOfficeSettings {
  office: RcmOfficeId;
  /** The switch an admin owns. */
  drainEnabled: boolean;
  /** When it was last moved. Null means nobody ever has. */
  updatedAt: string | null;
  /** The crosswalk key of whoever last moved it. Null likewise. */
  updatedBy: string | null;
  /** D-7's code ceiling — NOT flippable from here, and the screen says so. */
  postingEnabled: boolean;
  /** No settings row at all: migrations have not run. The switch reads off. */
  rowMissing: boolean;
  /**
   * HOW THIS PRACTICE BOOKS A WRITE-OFF IT CHOSE TO MAKE (Stage B1).
   *
   * Roland books one into the claimproc's own WriteOff field plus a note and
   * uses no adjustment type; other practices book the same decision as a ledger
   * adjustment. Both are correct bookkeeping and they are not the same Open
   * Dental call, so it is a fact about the practice.
   */
  writeoffMode: WriteoffMode;
  /**
   * The adjustment type's NAME, never a definition number (D-13).
   *
   * Definition numbers differ between practices, so a number copied from one
   * would write the wrong type into the other's chart. The name is resolved live
   * against that office's own definitions when it posts, and a name that
   * resolves to nothing there refuses the claim rather than falling back.
   */
  writeoffAdjTypeName: string | null;
  /** The list the server accepts, so the screen renders its options and not ours. */
  writeoffModes: WriteoffMode[];
}

export const WRITEOFF_MODES = ["writeoff_field", "adjustment_by_name"] as const;
export type WriteoffMode = (typeof WRITEOFF_MODES)[number];

/** Admin only (`rcm.settings`). A non-admin gets 403 and renders nothing. */
export function getRcmOfficeSettings(office: RcmOfficeId): Promise<RcmOfficeSettings> {
  return get<{ settings: RcmOfficeSettings }>(
    `/office-settings/${encodeURIComponent(office)}`,
    { office },
  ).then((r) => r.settings);
}

/**
 * Flip the shadow gate. Admin only.
 *
 * The office is in the path AND in the query, and the server refuses if they
 * disagree — an assertion that can only cause a refusal, never redirect the
 * write to the other practice.
 */
export function setRcmOfficeSettings(
  office: RcmOfficeId,
  drainEnabled: boolean,
): Promise<RcmOfficeSettings> {
  return put<{ settings: RcmOfficeSettings }>(
    `/office-settings/${encodeURIComponent(office)}`,
    { office },
    { drainEnabled },
  ).then((r) => r.settings);
}

/**
 * A direct link to the document a claim's numbers were read from.
 *
 * A URL rather than a fetch, deliberately: the browser opens a PDF or an image
 * in its own viewer, and pulling the bytes through `fetch` only to hand them
 * back as a blob URL would put the whole document in this tab's memory to
 * achieve exactly that.
 *
 * It relies on the SESSION COOKIE, which a top-level navigation sends — the same
 * credential every other call on this screen uses (`credentials: "include"`).
 * The route audits the read before a byte is served and scopes the row by
 * office, so the link is not the capability; the session is.
 *
 * Null when nothing is known about where the numbers came from, which is the
 * case for an 835 that arrived as a parse rather than as a document.
 */
export function documentHref(office: RcmOfficeId, uploadId: string | null | undefined): string | null {
  if (!uploadId) return null;
  return `${BASE}/rcm/uploads/${encodeURIComponent(uploadId)}/document?office=${encodeURIComponent(office)}`;
}

/**
 * Set how this practice books a write-off it chose to make. Admin only.
 *
 * A SEPARATE route from the shadow-gate flip above, deliberately: that body
 * takes `{ drainEnabled }` and nothing else, so a typo in one setting cannot
 * arrive alongside a flip of the other, and the switch's own timestamp keeps
 * meaning "when was posting last switched".
 */
export function setRcmWriteoffMode(
  office: RcmOfficeId,
  writeoffMode: WriteoffMode,
  writeoffAdjTypeName?: string | null,
): Promise<RcmOfficeSettings> {
  return put<{ settings: RcmOfficeSettings }>(
    `/office-settings/${encodeURIComponent(office)}/writeoff-mode`,
    { office },
    { writeoffMode, writeoffAdjTypeName: writeoffAdjTypeName ?? null },
  ).then((r) => r.settings);
}

/**
 * ── THE TWO WORKLIST STATES ──────────────────────────────────────────────────
 *
 * All four run on `rcm.queue` — the tier that marks a claim reviewed. None of
 * them touches Open Dental, a posting, or money; they decide which queue a check
 * shows up in and nothing else. All four are reversible.
 */

/**
 * "Save this for tomorrow." Optionally with a line about why.
 *
 * Re-parking MOVES the stamp rather than refusing: somebody who puts the same
 * check down twice is telling you about the second time.
 */
export function parkRemittance(
  office: RcmOfficeId,
  batchId: string,
  note?: string,
): Promise<{ batchId: string; parked: boolean }> {
  return post(
    `/remittances/${encodeURIComponent(batchId)}/park`,
    { office },
    note ? { note } : {},
  );
}

/**
 * Put it back on the ordinary pile.
 *
 * Fired by the check's own page ON OPEN as well as by a press — a note saying
 * "come back to this" has done its job the moment she is looking at it. The
 * server is idempotent over an un-parked check for exactly that reason, so an
 * ordinary visit is a 200 rather than a refusal nobody can act on.
 */
export function unparkRemittance(
  office: RcmOfficeId,
  batchId: string,
): Promise<{ batchId: string; parked: boolean; wasParked: boolean }> {
  return post(`/remittances/${encodeURIComponent(batchId)}/unpark`, { office }, {});
}

/**
 * "Nobody is coming back to this." Reason required; `other` requires the note.
 *
 * NOT the same act as retiring a posting. This takes a CHECK out of one
 * worklist and can be undone by anybody who could do it; retiring decides that
 * money will never post through CareIN and cannot be undone at all.
 */
export function setAsideRemittance(
  office: RcmOfficeId,
  batchId: string,
  reason: SetAsideReason,
  note?: string,
): Promise<{ batchId: string; setAside: boolean; reason: string }> {
  return post(
    `/remittances/${encodeURIComponent(batchId)}/set-aside`,
    { office },
    note ? { reason, note } : { reason },
  );
}

/** Put a set-aside check back in the queue. The half that makes it safe to press. */
export function restoreRemittance(
  office: RcmOfficeId,
  batchId: string,
): Promise<{ batchId: string; setAside: boolean; wasSetAside: boolean }> {
  return post(`/remittances/${encodeURIComponent(batchId)}/restore`, { office }, {});
}

/**
 * "DID THE APP GET THIS CHECK RIGHT?" — the shadow-mode comparison (C-2).
 *
 * `differed` carries both a reason and a line in her own words; `same` carries
 * neither, and the server refuses a `same` that arrives with either rather than
 * quietly dropping them.
 *
 * Changeable until the check posts. Re-sending the SAME answer is a 200 that
 * writes nothing (`recorded: false`), so a double-click cannot inflate the
 * count of how many times a check was answered.
 *
 * It reaches no chart, moves no money and changes no posting state — it is on
 * the `rcm.queue` tier, beside marking a claim checked over.
 */
export function recordComparison(
  office: RcmOfficeId,
  batchId: string,
  answer:
    | { verdict: "same" }
    | { verdict: "differed"; reason: ComparisonReason; note: string },
): Promise<{
  batchId: string;
  verdict: ComparisonVerdict;
  reason: string | null;
  revision: number;
  recorded: boolean;
}> {
  return post(`/remittances/${encodeURIComponent(batchId)}/comparison`, { office }, answer);
}

/**
 * The running count under the ask.
 *
 * Counts and one date — no notes and no per-check rows. `matchedRun` is how many
 * of the most recent answers in a row came out the same, which is the number the
 * decision to switch posting on is actually made from.
 */
export interface ComparisonTally {
  office: RcmOfficeId;
  compared: number;
  same: number;
  differed: number;
  matchedRun: number;
  /** The newest check that did not match, or null when none has. */
  latestDifference: { reason: ComparisonReason | string | null; at: string | null } | null;
}

export function getComparisonTally(office: RcmOfficeId): Promise<ComparisonTally> {
  return get("/comparison/tally", { office });
}

/**
 * The whole picture, for whoever is deciding to switch posting on.
 *
 * `rcm.settings` — admin only, the same tier as the switch itself, so the read
 * is absent rather than greyed for everybody else.
 *
 * `from` and `to` are inclusive `YYYY-MM-DD` in the office's own timezone and
 * bound `compared`/`same`/`differed`/`differences`. `matchedRun` and
 * `comparedAllTime` deliberately do NOT respect them: a run of matching checks
 * that a start date happens to cut in half is not a run.
 */
export interface ComparisonSummary {
  office: RcmOfficeId;
  from: string | null;
  to: string | null;
  compared: number;
  same: number;
  differed: number;
  matchedRun: number;
  comparedAllTime: number;
  differences: {
    batchId: string;
    checkNumber: string | null;
    payer: string | null;
    depositDate: string | null;
    reason: ComparisonReason | string | null;
    note: string | null;
    answeredAt: string | null;
    answeredBy: string | null;
    /** Above 1 means the answer on this check was changed after it was first given. */
    revision: number;
  }[];
}

export function getComparisonSummary(
  office: RcmOfficeId,
  range: { from?: string; to?: string } = {},
): Promise<ComparisonSummary> {
  const params: Record<string, string> = { office };
  if (range.from) params.from = range.from;
  if (range.to) params.to = range.to;
  return get("/comparison/summary", params);
}

/**
 * POST TO OPEN DENTAL.
 *
 * `queueId` narrows the run to ONE check — the same server function, the same
 * office scope, the same status filter, the same two-condition gate. It is an
 * extra `AND queue_id = $3`, so it can only ever reach a subset of what the
 * office-wide press would have reached. There is no second write path.
 */
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
