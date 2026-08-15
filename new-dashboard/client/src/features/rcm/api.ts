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

/** One remittance a duplicate upload collided with. */
export interface DuplicateRemittance {
  index: number;
  remittanceKey: string;
  /** 'posted' = finished. 'pending' = a run is in flight, or died mid-flight. */
  status: "posted" | "pending";
  batchId: string | null;
  processedAt: string | null;
}

/** Turn a non-2xx response into an RcmApiError, preserving the whole body. */
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

// ─── ERA (835) upload — Slice 5 ─────────────────────────────────────────────

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
 * The FILE ITSELF is the body — this route takes raw bytes rather than
 * multipart, because the backend has no multipart middleware and adding one for
 * a single endpoint is a larger change than the endpoint. The name travels in
 * `X-RCM-Filename`, and the office in the query string, never the body: a body
 * field could not be the office, because office is a correctness boundary the
 * server validates rather than something the client asserts.
 *
 * A duplicate throws `RcmApiError` with `alreadyProcessed === true` and the
 * colliding remittances on `duplicateRemittances`. There is deliberately no
 * force/override parameter to pass.
 */
export async function uploadEra(office: RcmOfficeId, file: File): Promise<EraUploadResult> {
  const res = await fetch(`${BASE}/rcm/era?office=${encodeURIComponent(office)}`, {
    method: "POST",
    credentials: "include",
    headers: {
      // The browser's guess for a .edi is usually '' — say what it is.
      "Content-Type": file.type || "application/edi-x12",
      // Percent-encoded: a header value must be Latin-1, and `fetch` throws on
      // an accented character in a filename rather than sending it.
      "X-RCM-Filename": encodeURIComponent(file.name),
    },
    body: file,
  });

  if (res.status === 401) {
    handleUnauthorized();
    throw new RcmApiError("Not signed in", 401, null);
  }
  if (!res.ok) throw await toError(res);

  return (await res.json()) as EraUploadResult;
}
