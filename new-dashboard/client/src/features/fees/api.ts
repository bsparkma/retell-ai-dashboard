/**
 * Fee Schedule module API client — the ONLY way /fees pages talk to /api/fees.
 *
 * Same shape and same reasons as features/hyg/api.ts and features/rcm/api.ts:
 *  - /api/fees errors carry `{ success:false, error, code }` (the `error` key,
 *    not `message`), so the generic lib/api.ts wrapper would surface "HTTP 422"
 *    where the useful answer is CSV_AMBIGUOUS_COLUMNS and the sentence naming
 *    the three columns it could not choose between. `FeesApiError` preserves
 *    status + code + the whole body.
 *  - Every endpoint requires `?office=roland|valley` — never "all", never a
 *    header — enforced here by typing office as `FeesOfficeId`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A REFUSAL HERE CAN CARRY THE ANSWER
 * ─────────────────────────────────────────────────────────────────────────────
 * A 422 parse failure is not a dead end: the server STORES the failed batch and
 * returns it on the refusal, so the page can link to what it recorded instead of
 * telling somebody their upload vanished. That is why `details` is kept whole
 * and why `FeesApiError.batch` exists — dropping everything but the sentence
 * would throw away the half of the response that is actionable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO OPEN DENTAL, ANYWHERE
 * ─────────────────────────────────────────────────────────────────────────────
 * There is nothing to reach for. The whole module is three endpoints that read
 * and write this platform's own Postgres; the backend guard
 * (backend/routes/fees/feesNoOdAccess.test.js) proves it server-side, and this
 * client has no counterpart to prove because it has no Open Dental call to make.
 */

import { handleUnauthorized } from "@/lib/api";

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:5000/api";

/**
 * The two frozen office keys, mirroring backend/routes/fees/helpers.js.
 *
 * 'unknown' is deliberately absent: officeAgents carries it as a bucket for
 * unmapped Mango lines, it names no real practice, and the server refuses it.
 * A payer contract filed under no office at all is the thing this type exists
 * to make unrepresentable.
 */
export const FEES_OFFICE_IDS = ["roland", "valley"] as const;
export type FeesOfficeId = (typeof FEES_OFFICE_IDS)[number];

export function isFeesOfficeId(value: unknown): value is FeesOfficeId {
  return typeof value === "string" && (FEES_OFFICE_IDS as readonly string[]).includes(value);
}

/** Short labels for chips — roster display names are too long for one. */
export const FEES_OFFICE_LABELS: Record<FeesOfficeId, string> = {
  roland: "Roland",
  valley: "Riley",
};

/** The two formats the parser has lanes for. */
export const FEES_SOURCE_TYPES = ["pdf", "csv"] as const;
export type FeesSourceType = (typeof FEES_SOURCE_TYPES)[number];

/** The two states a batch can hold — the `status` CHECK, straight from the schema. */
export type FeesBatchStatus = "parsed" | "failed";

/**
 * One parse warning.
 *
 * `code` is a stable machine token the UI switches on; `message` is one
 * sentence an office manager reads. Neither ever carries anything but procedure
 * codes, amounts and the file's own text — a fee schedule has no patient on it.
 */
export interface FeesWarning {
  code: string;
  message: string;
}

/** An import batch, exactly as importStore.toBatch() builds it. */
export interface FeesImportBatch {
  batchId: string;
  office: FeesOfficeId;
  filename: string;
  fileSha256: string;
  fileSizeBytes: number;
  sourceType: FeesSourceType;
  status: FeesBatchStatus;
  rowCount: number;
  /** Every warning anywhere in the parse — the file's own PLUS every row's. */
  warningCount: number;
  /** FILE-level warnings only. Row-level ones live on the row that earned them. */
  warnings: FeesWarning[];
  /** Present and null on a parsed batch, never absent. */
  failureReason: string | null;
  failureCode: string | null;
  createdBy: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** One parsed fee, exactly as importStore.toRow() builds it. */
export interface FeesImportRow {
  rowId: string;
  /** Normalised: D + four digits. The column CHECK enforces it server-side. */
  procCode: string;
  /** INTEGER CENTS. Never dollars, never a float — see formatFeeCents. */
  feeCents: number;
  /** The source line this row was read out of, verbatim. */
  rawLine: string;
  warnings: FeesWarning[];
  rowOrder: number;
}

export interface FeesImportDetailResponse {
  success: true;
  batch: FeesImportBatch;
  rows: FeesImportRow[];
}

export interface FeesImportListResponse {
  success: true;
  office: FeesOfficeId;
  batches: FeesImportBatch[];
  limit: number;
  offset: number;
}

export class FeesApiError extends Error {
  readonly status: number;
  /** The server's structured code, e.g. CSV_AMBIGUOUS_COLUMNS or FILE_TOO_LARGE. */
  readonly code: string | null;
  /** The rest of the error body, verbatim — including a stored failed `batch`. */
  readonly details: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code: string | null,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FeesApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** This practice is not entitled to the Fee Schedules module. */
  get notEntitled(): boolean {
    return this.code === "MODULE_NOT_ENTITLED";
  }

  /** This user's role does not hold fees.read / fees.write. */
  get forbidden(): boolean {
    return this.status === 403 && !this.notEntitled;
  }

  /**
   * The failed batch the server STORED before refusing, when there is one.
   *
   * A 422 parse failure is recorded — with the reason, the filename, the hash
   * and who uploaded it — precisely so "I uploaded it and nothing happened"
   * cannot be the outcome. This getter is what lets the page show it.
   *
   * Narrowed structurally rather than cast: the body is somebody else's JSON,
   * and an `as FeesImportBatch` on it would turn a backend change into an
   * `undefined` three components deep instead of a null here.
   */
  get batch(): FeesImportBatch | null {
    const raw = this.details.batch;
    if (raw === null || typeof raw !== "object") return null;
    const candidate = raw as Partial<FeesImportBatch>;
    return typeof candidate.batchId === "string" && typeof candidate.status === "string"
      ? (raw as FeesImportBatch)
      : null;
  }
}

interface ErrorBody {
  error?: unknown;
  code?: unknown;
}

/**
 * Turn a non-2xx response into a FeesApiError, preserving the WHOLE body.
 *
 * One place, because a refusal that carries data (the stored `batch`) is
 * useless if the transport drops everything but the sentence.
 */
async function toError(res: Response): Promise<FeesApiError> {
  let body: ErrorBody & Record<string, unknown> = {};
  try {
    body = (await res.json()) as ErrorBody & Record<string, unknown>;
  } catch {
    /* non-JSON error body */
  }
  const message = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
  const code = typeof body.code === "string" ? body.code : null;
  // MODULE_NOT_ENTITLED arrives in `error`, not `code` — the platform's existing
  // denial shape. Normalise it into `code` so callers have one place to look.
  // (The hyg and RCM clients do the same; the shape is the platform's.)
  return new FeesApiError(
    message,
    res.status,
    code ?? (message === "MODULE_NOT_ENTITLED" ? message : null),
    body,
  );
}

/**
 * How long the client waits before it stops waiting.
 *
 * A 40-page payer PDF goes through pdf.js on the server; that is seconds, not
 * milliseconds, and it queues behind whatever else the container is doing. 60s
 * is generous enough that a real schedule never trips it and short enough that
 * a hung connection does not leave somebody watching a spinner with no way back.
 */
const REQUEST_TIMEOUT_MS = 60_000;

async function get<T>(
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const qs = new URLSearchParams(params).toString();

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  // A caller's own abort (a page unmounting, an office changed twice quickly)
  // must still cancel the request; without this the fetch outlives the component.
  const onCallerAbort = () => abort.abort();
  signal?.addEventListener("abort", onCallerAbort);

  let res: Response;
  try {
    res = await fetch(`${BASE}/fees${path}?${qs}`, {
      credentials: "include",
      signal: abort.signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (abort.signal.aborted) {
      throw new FeesApiError("The request took too long and the page stopped waiting", 0, "TIMEOUT");
    }
    throw new FeesApiError(
      err instanceof Error ? err.message : "Could not reach CareIN",
      0,
      "NETWORK",
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }

  if (res.status === 401) handleUnauthorized();
  if (!res.ok) throw await toError(res);

  return (await res.json()) as T;
}

/** One office's import batches, newest first. Counts, not rows. */
export async function listImports(
  office: FeesOfficeId,
  signal?: AbortSignal,
): Promise<FeesImportListResponse> {
  return get<FeesImportListResponse>("/imports", { office }, signal);
}

/** One import and every row parsed out of it, in the file's own order. */
export async function getImport(
  office: FeesOfficeId,
  batchId: string,
  signal?: AbortSignal,
): Promise<FeesImportDetailResponse> {
  return get<FeesImportDetailResponse>(
    `/imports/${encodeURIComponent(batchId)}`,
    { office },
    signal,
  );
}

/**
 * Upload one fee schedule.
 *
 * multipart/form-data with the file in a field named `file` — and NO explicit
 * Content-Type header, because the browser must set the multipart boundary
 * itself. Setting it by hand is the classic way to make this 400.
 *
 * A parse failure REJECTS with a FeesApiError carrying the stored failed batch,
 * rather than resolving with a zero-row success. The distinction is the point:
 * a 200 whose body says `rowCount: 0` reads as "your schedule has no fees in
 * it", which is a different and false fact.
 */
export async function uploadImport(
  office: FeesOfficeId,
  file: File,
): Promise<FeesImportDetailResponse> {
  const body = new FormData();
  body.append("file", file);

  let res: Response;
  try {
    res = await fetch(`${BASE}/fees/imports?office=${encodeURIComponent(office)}`, {
      method: "POST",
      credentials: "include",
      body,
    });
  } catch (err) {
    throw new FeesApiError(
      err instanceof Error ? err.message : "Could not reach CareIN",
      0,
      "NETWORK",
    );
  }

  if (res.status === 401) {
    handleUnauthorized();
    throw new FeesApiError("Not signed in", 401, null);
  }
  if (!res.ok) throw await toError(res);

  return (await res.json()) as FeesImportDetailResponse;
}

// ─── Presentation helpers (pure, so they are directly unit-testable) ─────────

/**
 * Integer cents → the dollars a person reads.
 *
 * `$0.00` RENDERS AS `$0.00`. Never blank, never an em dash, never "—". In a
 * fee schedule zero means *not covered*, *bundled* or *no fee*, which is a fact
 * the office needs; the reference importer discarded every zero with a `> 0`
 * guard and this module exists partly to stop doing that. A UI that then drew
 * the zero as an empty cell would put the defect back one layer up.
 */
export function formatFeeCents(cents: number): string {
  if (!Number.isFinite(cents)) return "$0.00";
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** Bytes → a size an office reads. Used on the failed-batch card. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The source type implied by a filename, or null.
 *
 * Extension only, mirroring the server's own `sourceTypeFromFilename`. A
 * browser's Content-Type for a .csv is variously text/csv,
 * application/vnd.ms-excel and application/octet-stream depending on whether
 * Excel is installed, so it is not a usable signal on either side.
 *
 * This is a COURTESY check so the page can refuse an .xlsx without a round
 * trip. The server refuses it too, with 415 UNSUPPORTED_FILE_TYPE, and that
 * refusal is the real one.
 */
export function sourceTypeFromFilename(filename: string): FeesSourceType | null {
  const ext = /\.([a-z0-9]+)$/.exec(filename.toLowerCase());
  if (!ext) return null;
  if (ext[1] === "pdf") return "pdf";
  if (ext[1] === "csv") return "csv";
  return null;
}

/**
 * Group a batch's rows by procedure code, keeping file order.
 *
 * DUPLICATES ARE THE REASON THIS EXISTS. A payer schedule really does list
 * D2740 twice at two fees — a base page and an amendment page — and the
 * reference importer kept the first and discarded the second in silence. The
 * parser now stores both and flags them; this puts the two fees SIDE BY SIDE so
 * the reader sees the disagreement rather than scrolling past it.
 *
 * Returns groups in the order each code FIRST appears, so the preview still
 * reads as the file reads.
 */
export interface FeesRowGroup {
  procCode: string;
  rows: FeesImportRow[];
  /** More than one row, and they do not all carry the same fee. */
  conflicting: boolean;
}

export function groupRowsByCode(rows: readonly FeesImportRow[]): FeesRowGroup[] {
  // First-appearance order is tracked in an array rather than read back off the
  // Map, so this compiles under the repo's ES target without downlevelIteration
  // — and so the ordering guarantee is explicit rather than resting on Map's
  // insertion-order behaviour being remembered by the next reader.
  const order: string[] = [];
  const byCode: Record<string, FeesImportRow[]> = {};

  for (const row of rows) {
    const existing = byCode[row.procCode];
    if (existing) {
      existing.push(row);
    } else {
      byCode[row.procCode] = [row];
      order.push(row.procCode);
    }
  }

  return order.map((procCode) => {
    const grouped = byCode[procCode];
    const distinctFees = new Set(grouped.map((row: FeesImportRow) => row.feeCents));
    return {
      procCode,
      rows: grouped,
      conflicting: grouped.length > 1 && distinctFees.size > 1,
    };
  });
}
