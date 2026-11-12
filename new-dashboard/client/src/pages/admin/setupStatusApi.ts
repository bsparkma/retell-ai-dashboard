/**
 * GET /api/admin/setup-status — the "Practice setup" card's one read (OB-1).
 *
 * Its own small fetcher on purpose, rather than a method on `api` in
 * lib/api.ts: the card is a self-contained read, and keeping it out of the
 * shared client means a page test that replaces `api` wholesale cannot turn
 * this card into a crash. A failed read is an ERROR the card says out loud —
 * it never renders as green.
 *
 * The answer is validated with zod before the card trusts a single field: an
 * unexpected shape is an error, not a half-drawn card.
 */
import { z } from "zod";
import { handleUnauthorized } from "@/lib/api";

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:5000/api";
const DASHBOARD_TOKEN = (import.meta.env.VITE_DASHBOARD_API_TOKEN ?? "").trim();

export const SetupStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  required: z.boolean(),
  status: z.enum(["done", "needs_attention"]),
  detail: z.string(),
  link: z.string(),
});
export type SetupStep = z.infer<typeof SetupStepSchema>;

export const SetupStatusSchema = z.object({
  success: z.literal(true),
  office: z.string(),
  officeName: z.string().optional(),
  offices: z.array(z.object({ officeId: z.string(), officeName: z.string() })).optional(),
  steps: z.array(SetupStepSchema),
  doneRequired: z.number().int().nonnegative(),
  totalRequired: z.number().int().nonnegative(),
});
export type SetupStatus = z.infer<typeof SetupStatusSchema>;

export class SetupStatusError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "SetupStatusError";
    this.status = status;
    this.code = code;
  }
}

/** One office's setup status. Throws SetupStatusError on any failure. */
export async function fetchSetupStatus(office: string): Promise<SetupStatus> {
  const url = new URL(`${BASE}/admin/setup-status`, window.location.origin);
  url.searchParams.set("office", office);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      credentials: "include",
      headers: DASHBOARD_TOKEN ? { Authorization: `Bearer ${DASHBOARD_TOKEN}` } : {},
    });
  } catch {
    throw new SetupStatusError("Could not reach the server.", 0, null);
  }
  if (res.status === 401) {
    try {
      handleUnauthorized();
    } catch {
      // The sign-out reaction is best-effort here; the error below still shows.
    }
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (body && typeof body === "object" ? body : {}) as { error?: unknown; code?: unknown };
    throw new SetupStatusError(
      typeof err.error === "string" ? err.error : `HTTP ${res.status}`,
      res.status,
      typeof err.code === "string" ? err.code : null,
    );
  }
  const parsed = SetupStatusSchema.safeParse(body);
  if (!parsed.success) throw new SetupStatusError("The server sent an answer this page does not understand.", res.status, "BAD_RESPONSE");
  return parsed.data;
}
