/**
 * Hygiene module API client — the ONLY way /hyg pages talk to /api/hyg.
 *
 * Same shape and same reasons as features/rcm/api.ts and features/tc/api.ts:
 *  - /api/hyg errors carry `{ success:false, error, code }` (the `error` key,
 *    not `message`), so the generic lib/api.ts wrapper would surface "HTTP 403"
 *    where the useful answer is MODULE_NOT_ENTITLED. `HygApiError` preserves
 *    status + code + the rest of the body.
 *  - Every endpoint requires `?office=roland|valley` — never "all", never a
 *    header — enforced here by typing office as `OfficeId`.
 *
 * ONE THING THIS CLIENT DOES THAT THE OTHERS DO NOT: it PARSES the success
 * body through the shared zod schema before returning it. The backend is
 * CommonJS with no build step and does not execute those schemas (see
 * shared/hyg/contract.ts for why slice 1 does not ship a second esbuild
 * bundle), so this parse is the one place the wire contract is actually
 * enforced. A backend that drifts fails loudly here, at the boundary, instead
 * of as an `undefined` three components deep.
 */
import { handleUnauthorized } from "@/lib/api";
import {
  HygDayResponseSchema,
  type HygDayResponse,
  type OfficeId,
} from "@shared/hyg/contract";

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:5000/api";

/** Short labels for chips — roster display names are too long for one. */
export const HYG_OFFICE_LABELS: Record<OfficeId, string> = {
  roland: "Roland",
  valley: "Riley",
};

export class HygApiError extends Error {
  readonly status: number;
  /** The server's structured code, e.g. OFFICE_NOT_READY or OD_READ_FAILED. */
  readonly code: string | null;
  /** The rest of the error body — `reason`, `office`, `date`. */
  readonly details: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code: string | null,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HygApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** This practice is not entitled to the Hygiene module. */
  get notEntitled(): boolean {
    return this.code === "MODULE_NOT_ENTITLED";
  }

  /** This user's role does not hold hyg.read. */
  get forbidden(): boolean {
    return this.status === 403 && !this.notEntitled;
  }

  /**
   * This OFFICE cannot serve a hygiene day yet — switched off, or switched on
   * without credentials. Distinct from an outage: waiting will not help, and
   * the fix is a setting rather than a retry.
   */
  get officeNotReady(): boolean {
    return this.code === "OFFICE_NOT_READY";
  }

  /** The precise odOffices reason behind an officeNotReady. */
  get officeReason(): string | null {
    const raw = this.details.reason;
    return typeof raw === "string" ? raw : null;
  }

  /**
   * Open Dental did not answer, or answered with something that was not a day.
   * The one refusal where retrying is genuinely the right thing to offer.
   */
  get odUnavailable(): boolean {
    return this.code === "OD_READ_FAILED";
  }
}

interface ErrorBody {
  error?: unknown;
  code?: unknown;
}

/**
 * Turn a non-2xx response into a HygApiError, preserving the WHOLE body.
 *
 * One place, because a refusal that carries data (`reason`, which says WHICH of
 * the four office problems it was) is useless if the transport drops everything
 * but the sentence.
 */
async function toError(res: Response): Promise<HygApiError> {
  let body: ErrorBody & Record<string, unknown> = {};
  try {
    body = (await res.json()) as ErrorBody & Record<string, unknown>;
  } catch {
    /* non-JSON error body */
  }
  const message = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
  const code = typeof body.code === "string" ? body.code : null;
  // MODULE_NOT_ENTITLED arrives in `error`, not `code` — the platform's
  // existing denial shape. Normalise it into `code` so callers have one place
  // to look. (RCM's client does the same; the shape is the platform's, not
  // either module's.)
  return new HygApiError(
    message,
    res.status,
    code ?? (message === "MODULE_NOT_ENTITLED" ? message : null),
    body,
  );
}

/**
 * How long the client waits before it stops waiting.
 *
 * A day pull is one paged schedule read plus one identity read per distinct
 * patient, sequential on a throttled per-credential slot — a 30-patient day is
 * seconds, not milliseconds, and it queues behind whatever RCM or the voice
 * side is doing. 45s is generous enough that a normal busy day never trips it
 * and short enough that a hung connection does not leave a hygienist watching a
 * spinner with no way back.
 */
const REQUEST_TIMEOUT_MS = 45_000;

async function get<T>(
  path: string,
  params: Record<string, string>,
  parse: (raw: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  const qs = new URLSearchParams(params).toString();

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  // A caller's own abort (a page unmounting, a date changed twice quickly) must
  // still cancel the request; without this the fetch outlives the component.
  const onCallerAbort = () => abort.abort();
  signal?.addEventListener("abort", onCallerAbort);

  let res: Response;
  try {
    res = await fetch(`${BASE}/hyg${path}?${qs}`, {
      credentials: "include",
      signal: abort.signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (abort.signal.aborted) {
      throw new HygApiError(
        "The schedule took too long to load and the page stopped waiting",
        0,
        "TIMEOUT",
      );
    }
    throw new HygApiError(
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

  const raw: unknown = await res.json();
  return parse(raw);
}

/**
 * One office's whole hygiene day.
 *
 * A rejection is never an empty day: the server refuses with a code for each
 * way of not knowing, and this throws every one of them. The only way to get
 * `appointments: []` back is for nobody to be booked.
 */
export async function fetchDay(
  office: OfficeId,
  date: string,
  signal?: AbortSignal,
): Promise<HygDayResponse> {
  return get(
    "/day",
    { office, date },
    (raw) => {
      const parsed = HygDayResponseSchema.safeParse(raw);
      if (!parsed.success) {
        // A shape we did not expect is a REFUSAL, not a partial render. Half a
        // day whose missing half is a silent `undefined` is exactly the class
        // of failure this module is written against, and the backend cannot
        // catch it for us — it does not run these schemas.
        throw new HygApiError(
          "CareIN returned a schedule this page could not read",
          0,
          "CONTRACT_MISMATCH",
          { issues: parsed.error.issues.slice(0, 5) },
        );
      }
      return parsed.data;
    },
    signal,
  );
}
