/**
 * NEXT TOUCH — "none of my patients fall through the cracks."
 *
 * Every OPEN case has exactly one visible next touch: a date and an owner.
 * There is no parallel concept and no stored "next touch" column. The next
 * touch IS the case's earliest pending tc_followups row (either kind,
 * `followup` or `nurture`). An open case with no pending row has no next step,
 * and that is shown as a flag, never filled in with a guess.
 *
 * "Open" is the contract's existing OPEN_CASE_STATUSES (contract.ts), which is
 * the working statuses only. Every terminal status (accepted,
 * partially_accepted, scheduled, started, completed, lost) is excluded.
 * `scheduled` is terminal on purpose: its next touch is the Open Dental
 * appointment. No vocabulary is added here.
 *
 * ONE implementation, used by both the server (bundled into contract.gen.cjs)
 * and the dashboard, so the pipeline card, the Follow-ups page and the case
 * view can never disagree about which row is "the" next touch.
 */
import { z } from "zod";
import { FollowupChannel, OPEN_CASE_STATUSES } from "./contract";

const OPEN = new Set<string>(OPEN_CASE_STATUSES);

/** Is this status open TC work (so it must carry a next touch)? */
export function isOpenCaseStatus(status: string): boolean {
  return OPEN.has(status);
}

/** The fields the derivation reads. Both TcFollowup and queue rows satisfy it. */
export interface NextTouchCandidate {
  followupId: string;
  dueDate: string;
  status: string;
}

/**
 * The next touch among a case's follow-ups: the EARLIEST pending row. Ties on
 * the same due date break on followupId, which is arbitrary but STABLE, so
 * every surface picks the same row. Completed or skipped rows never count.
 */
export function pickNextTouch<T extends NextTouchCandidate>(followups: readonly T[]): T | null {
  let best: T | null = null;
  for (const f of followups) {
    if (f.status !== "pending") continue;
    if (
      best === null ||
      f.dueDate < best.dueDate ||
      (f.dueDate === best.dueDate && f.followupId < best.followupId)
    ) {
      best = f;
    }
  }
  return best;
}

/** pickNextTouch per case, for a batch of rows spanning many cases. */
export function nextTouchByCase<T extends NextTouchCandidate & { caseId: string }>(
  followups: readonly T[],
): Map<string, T> {
  const grouped = new Map<string, T[]>();
  for (const f of followups) {
    const list = grouped.get(f.caseId);
    if (list) list.push(f);
    else grouped.set(f.caseId, [f]);
  }
  const out = new Map<string, T>();
  grouped.forEach((list, caseId) => {
    const picked = pickNextTouch<T>(list);
    if (picked) out.set(caseId, picked);
  });
  return out;
}

/** Overdue (red), due today (amber), or upcoming. Dates are YYYY-MM-DD. */
export type NextTouchState = "overdue" | "today" | "upcoming";

export function nextTouchState(dueDate: string, today: string): NextTouchState {
  if (dueDate < today) return "overdue";
  if (dueDate === today) return "today";
  return "upcoming";
}

function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

function formatIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * `n` business days after `iso` (Mon–Fri. No holiday calendar, because the
 * practice has none in the system). Friday + 2 is Tuesday; Saturday + 2 is
 * Tuesday.
 */
export function addBusinessDays(iso: string, n: number): string {
  const d = parseIsoDate(iso);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return formatIsoDate(d);
}

/** Default next-touch date: two business days from today. */
export function defaultNextTouchDate(today: string): string {
  return addBusinessDays(today, 2);
}

/**
 * Two-letter initials for an owner identity. A name ("Alex Owner") gives
 * first + last initials. An email ("alex.owner@x") uses its local part, split
 * on . _ -. A single token gives its first two letters. No owner → "?".
 */
export function ownerInitials(owner: string | null | undefined): string {
  const raw = (owner ?? "").trim();
  if (raw === "") return "?";
  const base = raw.includes("@") ? raw.slice(0, raw.indexOf("@")) : raw;
  const parts = base.split(/[\s._-]+/).filter((p) => p !== "");
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

/**
 * The next touch a person sets while moving a case into an open status
 * (POST /api/tc/cases/:id/status `nextTouch`). Date and owner are required;
 * channel and talking point have defaults so the dialog stays two fields.
 */
export const NextTouchInput = z
  .object({
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
    owner: z.string().trim().min(1, "An owner is required").max(200),
    channel: FollowupChannel.default("phone_call"),
    talkingPoint: z.string().max(8000).default(""),
  })
  .strict();
export type NextTouchInput = z.infer<typeof NextTouchInput>;

/** The refusal code when a human move into an open status names no next touch. */
export const NEXT_TOUCH_REQUIRED = "NEXT_TOUCH_REQUIRED";
