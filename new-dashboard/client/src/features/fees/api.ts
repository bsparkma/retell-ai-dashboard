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

/**
 * Every state a batch can hold — the `status` CHECK, straight from the schema.
 *
 * Slice 1 had two. `FeesPostStatus` below is the full vocabulary and this is an
 * alias for it, kept so slice 1 and 2's call sites still read naturally. The
 * union is deliberately closed: a status the server adds is a compile error
 * here rather than a screen that silently renders nothing.
 */
export type FeesBatchStatus = FeesPostStatus;

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
  /**
   * What a human decided about this row (slice 3).
   *
   * A CLEAN row stays `pending` forever and that is correct — the posting gate
   * is warned-AND-pending, not a checklist, so a row with no warnings never
   * needs a decision and never blocks anything.
   */
  decision: FeesRowDecision;
  decidedBy: string | null;
  decidedAt: string | null;
  /**
   * What a person typed when the parsed value was not the fee they hold.
   *
   * NULL on every row nobody has edited — the database's pair CHECK guarantees
   * the override is cleared by any other decision, so a reader never has to
   * work out whether an override on an `accepted` row counts. `fee_cents`
   * beside it still says what the FILE said, which is what lets this screen
   * render "edited from $1,150.00".
   */
  editedFeeCents: number | null;
  /** Present ⇒ this row is in Open Dental. The resume key, and what rollback deletes. */
  odFeeNum: number | null;
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

/**
 * The fee that will actually be written, in integer cents.
 *
 * MIRRORS backend/services/fees/effectiveFee.js, which is the authority — the
 * job writes by that function and the totals are summed by its SQL twin. This
 * copy exists because the preview has to render the same number BEFORE the post
 * exists to be asked, and a screen that showed the parsed value where the job
 * would write the edited one is the disagreement this whole feature is built to
 * avoid.
 *
 * Kept deliberately trivial for that reason: the rule is one line, so the two
 * languages can hold the same one line. Anything more complex belongs on the
 * server, with the client reading the answer off the wire.
 */
export function effectiveFeeCents(row: FeesImportRow): number {
  return row.decision === "edited" && row.editedFeeCents !== null
    ? row.editedFeeCents
    : row.feeCents;
}

/** True when a person typed this row's fee, rather than the parser reading it. */
export function isEdited(row: FeesImportRow): boolean {
  return row.decision === "edited" && row.editedFeeCents !== null;
}

/**
 * The largest fee the parser admits, in cents ($20,000,000.00).
 *
 * Mirrors MAX_FEE_CENTS in backend/services/fees/feeValues.js. The server
 * refuses anything past it and the column CHECK refuses it again; this is the
 * courtesy that keeps a typo from making a round trip.
 */
export const MAX_FEE_CENTS = 2_000_000_000;

/**
 * What somebody typed into the fee box → integer cents, or null.
 *
 * Accepts what a person actually types when copying a number off a payer PDF:
 * `920`, `920.00`, `$920`, `$1,150.00`, with surrounding spaces. Everything
 * else is null, and the input shows the refusal rather than guessing.
 *
 * TWO THINGS IT DELIBERATELY REFUSES:
 *
 *  - More than two decimal places. `92.005` is not a fee; rounding it would
 *    silently store a number nobody typed, and this module already carries one
 *    documented defect from an importer that rounded quietly.
 *  - A bare `-`. Negative is not a fee, and the server refuses it too.
 *
 * ONE THING IT DELIBERATELY ACCEPTS: `0`, and `0.00`. In a fee schedule zero
 * means not covered, bundled, or no charge — a fact the office needs to be able
 * to state. The reference importer dropped every zero with a `> 0` guard, and
 * this module has spent three slices not repeating that.
 */
export function parseFeeInput(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (cleaned === "") return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = Number(match[1]);
  // `padEnd`, not `Number("5")`: `.5` is fifty cents, not five.
  const frac = Number((match[2] ?? "0").padEnd(2, "0"));
  const cents = whole * 100 + frac;
  if (!Number.isSafeInteger(cents) || cents > MAX_FEE_CENTS) return null;
  return cents;
}

/**
 * Integer cents → what the edit box starts with.
 *
 * Plain digits and a decimal point, with no `$` and no thousands separators, so
 * the field round-trips through `parseFeeInput` unchanged and a person editing
 * $1,150.00 does not have to delete punctuation before typing.
 */
export function feeInputValue(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
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

// ─── Slice 3: posting ───────────────────────────────────────────────────────

/**
 * The batch state machine.
 *
 *   parsed ──► ready ──► posting ──► posted
 *                           └──────► post_failed ──► rolled_back
 *                              posted ─────────────► rolled_back
 *
 * `failed` is slice 1's PARSE failure and is unrelated: a file that never
 * parsed can never be posted. Widening this union is how the UI finds out a
 * status was added — the compiler refuses an unhandled one rather than the
 * screen quietly rendering nothing.
 */
export type FeesPostStatus =
  | "parsed"
  | "failed"
  | "ready"
  | "posting"
  | "posted"
  | "post_failed"
  | "rolled_back";

/**
 * What a human decided about one warned row. Clean rows stay `pending`.
 *
 * `edited` carries a value — `editedFeeCents` — and every other decision
 * clears it. That is a database CHECK, not a convention here.
 */
export type FeesRowDecision = "pending" | "accepted" | "excluded" | "edited";

/** One of the office's Open Dental fee schedules. */
export interface FeeSchedule {
  feeSchedNum: number;
  description: string;
  feeSchedType: string;
  /** Hidden schedules are LISTED, not filtered — a rolled-back batch's is hidden. */
  isHidden: boolean;
  isGlobal: boolean;
}

export interface FeesPostTarget {
  feeSchedNum: number | null;
  description: string | null;
  /** True when this batch would CREATE the schedule. Decides which rollback applies. */
  isNew: boolean;
}

export interface FeesBackupState {
  odFeeSchedNum: number;
  isNewSchedule: boolean;
  rowCount: number;
  takenAt: string;
  restoredAt: string | null;
  restoreNote: string | null;
}

/**
 * What the progress endpoint returns.
 *
 * `rowsWritten` IS PRESENT IN EVERY STATE, including `post_failed`. That is the
 * point of it: a post that died at row 300 of 500 put 299 fees into a real
 * practice's database, and a screen that shows only "failed" invites somebody
 * to assume nothing happened and post again.
 */
export interface FeesPostProgress {
  batchId: string;
  office: FeesOfficeId;
  filename: string;
  status: FeesPostStatus;
  rowCount: number;
  rowsWritten: number;
  writableCount: number;
  excludedCount: number;
  /** Fees a person typed by hand. The confirm dialog names this number. */
  editedCount: number;
  /** Warned AND undecided. Non-zero means the Post button must refuse. */
  blockingCount: number;
  totalCents: number;
  target: FeesPostTarget | null;
  postError: string | null;
  /**
   * Who pressed Post.
   *
   * The ONLY attribution a `posting` or `post_failed` run has — `postedBy` is
   * necessarily null in both, because it is half of a pair the schema only
   * lets land on completion. Writing it early is what broke the first real
   * post; see docs/reports/fix-fees-post-attribution.md.
   */
  requestedBy: string | null;
  postingStartedAt: string | null;
  postedAt: string | null;
  postedBy: string | null;
  rolledBackAt: string | null;
  rolledBackBy: string | null;
  backup: FeesBackupState | null;
  /** Advisory: the server process is working on it right now. */
  running: boolean;
}

export interface FeesRollbackResult {
  success: true;
  deleted: number;
  restored: number;
  problems: string[];
  /** The honest sentence, including the bit about a new schedule's shell. */
  note: string;
}

async function send<T>(
  path: string,
  method: "POST" | "PUT" | "PATCH",
  office: FeesOfficeId,
  body: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/fees${path}?office=${encodeURIComponent(office)}`, {
      method,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
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
  return (await res.json()) as T;
}

/** The office's fee schedules, for the target picker. */
export async function listFeeSchedules(
  office: FeesOfficeId,
  signal?: AbortSignal,
): Promise<{ success: true; office: FeesOfficeId; schedules: FeeSchedule[] }> {
  return get("/feescheds", { office }, signal);
}

/**
 * What a human can say about one warned row.
 *
 * `edited` is the only one that carries a value, and it is modelled as a
 * discriminated union rather than an optional `feeCents` so that "edited with
 * no amount" and "accepted with an amount" are both unrepresentable. The server
 * refuses either; this makes the compiler refuse them first.
 */
export type FeesRowVerdict =
  | { decision: "accepted" | "excluded" | "reset" }
  | { decision: "edited"; feeCents: number };

export interface FeesDecideResponse {
  success: true;
  row: {
    rowId: string;
    decision: FeesRowDecision;
    feeCents?: number;
    editedFeeCents?: number | null;
  };
  status: FeesPostStatus;
  counts: {
    total: number;
    writable: number;
    excluded: number;
    accepted: number;
    edited: number;
    blocking: number;
    totalCents: number;
  };
}

/**
 * Record a decision about one warned row. `reset` returns it to undecided.
 *
 * CENTS GO OVER THE WIRE, never dollars. Dollars are a display format, and
 * parsing them is where rounding gets invented; the server refuses a
 * non-integer outright.
 */
export async function decideRow(
  office: FeesOfficeId,
  batchId: string,
  rowId: string,
  verdict: FeesRowVerdict,
): Promise<FeesDecideResponse> {
  return send(
    `/imports/${encodeURIComponent(batchId)}/rows/${encodeURIComponent(rowId)}`,
    "PATCH",
    office,
    verdict,
  );
}

/**
 * Choose where this batch posts.
 *
 * A NEW schedule is NOT created by this call — the server creates it on the
 * Post click, so that pressing Post is the only act that changes anything in
 * Open Dental. Naming one here is a decision, not a write.
 */
export async function setTarget(
  office: FeesOfficeId,
  batchId: string,
  target: { feeSchedNum: number } | { newScheduleName: string },
): Promise<{ success: true; target: FeesPostTarget }> {
  return send(`/imports/${encodeURIComponent(batchId)}/target`, "PUT", office, target);
}

/**
 * THE HUMAN ACTION.
 *
 * Resolves with 202 — the server ACCEPTED a job that runs for minutes against a
 * throttled credential. It is not a report that anything has been written; the
 * progress endpoint is.
 */
export async function postImport(
  office: FeesOfficeId,
  batchId: string,
): Promise<{ success: true; accepted: true; batchId: string; target: FeesPostTarget }> {
  return send(`/imports/${encodeURIComponent(batchId)}/post`, "POST", office, {});
}

/** What the UI polls while a post runs. */
export async function getProgress(
  office: FeesOfficeId,
  batchId: string,
  signal?: AbortSignal,
): Promise<{ success: true; progress: FeesPostProgress }> {
  return get(`/imports/${encodeURIComponent(batchId)}/progress`, { office }, signal);
}

/** Undo a post. Synchronous on the server — bounded by what this batch wrote. */
export async function rollbackImport(
  office: FeesOfficeId,
  batchId: string,
): Promise<FeesRollbackResult> {
  return send(`/imports/${encodeURIComponent(batchId)}/rollback`, "POST", office, {});
}

/**
 * Is this status one the UI should keep polling?
 *
 * Only `posting`. Everything else is terminal for the purposes of a poll, and a
 * screen that kept polling a `posted` batch would hammer the endpoint forever
 * for an answer that cannot change.
 */
export function isInFlight(status: FeesPostStatus): boolean {
  return status === "posting";
}

/**
 * Can this batch be posted, and if not, WHY?
 *
 * Returns the reason rather than a boolean, because the button shows it. A
 * disabled control with no explanation is the thing people file tickets about,
 * and the server refuses with the same facts — this is the courtesy, not the
 * guard.
 */
export function postBlockedReason(
  progress: FeesPostProgress,
  canWrite: boolean,
): string | null {
  if (!canWrite) return "You do not have permission to post fee schedules.";
  if (progress.status === "posting") return "A post is already running.";
  if (progress.status === "posted") {
    return "This import has already been posted. Roll it back first if you need to post it again.";
  }
  if (progress.status === "failed") return "This file never parsed, so there is nothing to post.";
  if (progress.status === "rolled_back") return "This import was rolled back.";
  if (progress.blockingCount > 0) {
    // Both halves agree in number. "1 row still need a decision" reads as a
    // typo, and a sentence that reads as a typo is one people stop reading.
    return progress.blockingCount === 1
      ? "1 row still needs a decision."
      : `${progress.blockingCount} rows still need a decision.`;
  }
  if (progress.writableCount === 0) return "Every row is excluded, so there is nothing to write.";
  if (progress.target === null || (progress.target.feeSchedNum === null && !progress.target.isNew)) {
    return "Choose which fee schedule this posts into.";
  }
  return null;
}
