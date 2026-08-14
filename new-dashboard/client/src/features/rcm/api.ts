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

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "RcmApiError";
    this.status = status;
    this.code = code;
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

  if (!res.ok) {
    let body: ErrorBody = {};
    try {
      body = (await res.json()) as ErrorBody;
    } catch {
      /* non-JSON error body */
    }
    const message = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    const code = typeof body.code === "string" ? body.code : null;
    // MODULE_NOT_ENTITLED arrives in `error`, not `code` — the platform's
    // existing denial shape. Normalize it into `code` so callers have one
    // place to look.
    throw new RcmApiError(message, res.status, code ?? (message === "MODULE_NOT_ENTITLED" ? message : null));
  }

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
