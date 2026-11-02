/**
 * The Pipeline's Open Dental sync (CO-4b) — one function per route in
 * backend/routes/tc/odSync.js, every answer parsed, so a server that drifted is
 * a loud error here rather than a quiet blank.
 */
import { z } from "zod";

import { tcRequest, TcApiError } from "@/features/tc/api";
import type { OfficeId } from "@shared/tc/contract";

export const OdSyncActionKind = z.enum(["completed", "unscheduled", "rescheduled"]);
export type OdSyncActionKind = z.infer<typeof OdSyncActionKind>;

export const OdSyncFlagReason = z.enum(["missing", "status", "patient", "multiple"]);
export type OdSyncFlagReason = z.infer<typeof OdSyncFlagReason>;

/** An automatic change that still stands (the badge + Undo). */
export const OdSyncAction = z.object({
  kind: OdSyncActionKind,
  at: z.string(),
  aptNum: z.number(),
  fromStatus: z.string(),
  toStatus: z.string(),
  fromDateTime: z.string(),
  toDateTime: z.string(),
});
export type OdSyncAction = z.infer<typeof OdSyncAction>;

/** "Open Dental no longer matches — check". */
export const OdSyncFlag = z.object({
  reason: OdSyncFlagReason,
  at: z.string(),
  aptStatus: z.string().nullable(),
});
export type OdSyncFlag = z.infer<typeof OdSyncFlag>;

/** What a pipeline card carries (the case list's `odSync`). */
export const OdSyncCardState = z.object({
  action: OdSyncAction.nullable(),
  flag: OdSyncFlag.nullable(),
});
export type OdSyncCardState = z.infer<typeof OdSyncCardState>;

export const OdSyncSummary = z.object({
  checked: z.number(),
  completed: z.number(),
  unscheduled: z.number(),
  rescheduled: z.number(),
  flagged: z.number(),
  unchanged: z.number(),
  heldByUndo: z.number(),
  raced: z.number(),
  unanchored: z.number(),
  tracked: z.number(),
  deferred: z.number(),
});
export type OdSyncSummary = z.infer<typeof OdSyncSummary>;

export const OdSyncRun = z.object({
  runId: z.string(),
  trigger: z.enum(["manual", "nightly"]),
  requestedBy: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  status: z.enum(["running", "ok", "failed", "interrupted"]),
  summary: OdSyncSummary.nullable(),
  errorCode: z.string().nullable(),
});
export type OdSyncRun = z.infer<typeof OdSyncRun>;

const PanelCase = z.object({ caseId: z.string(), patientName: z.string(), status: z.string() });

export const OdSyncStatus = z.object({
  success: z.literal(true),
  office: z.enum(["roland", "valley"]),
  enabled: z.boolean(),
  running: z.boolean(),
  lastRun: OdSyncRun.nullable(),
  nextAllowedAt: z.string().nullable(),
  unanchoredCount: z.number(),
  changes: z.array(PanelCase.extend({ action: OdSyncAction })),
  flagged: z.array(PanelCase.extend({ flag: OdSyncFlag })),
});
export type OdSyncStatus = z.infer<typeof OdSyncStatus>;

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new TcApiError("The Open Dental sync answer could not be read", 0, "CONTRACT_MISMATCH", null, []);
  }
  return parsed.data;
}

export async function getOdSyncStatus(office: OfficeId): Promise<OdSyncStatus> {
  return parse(OdSyncStatus, await tcRequest<unknown>("/tc/od-sync/status", { office }));
}

/** "Sync now": starts a sweep and answers at once; poll getOdSyncStatus until it is done. */
export async function startOdSync(office: OfficeId): Promise<string> {
  const res = parse(
    z.object({ success: z.literal(true), runId: z.string() }),
    await tcRequest<unknown>("/tc/od-sync/run", { office, method: "POST" }),
  );
  return res.runId;
}

export async function undoOdSync(office: OfficeId, caseId: string): Promise<void> {
  await tcRequest<unknown>(`/tc/od-sync/cases/${caseId}/undo`, { office, method: "POST" });
}

// ── Words (pure) ────────────────────────────────────────────────────────────

/** "3 completed, 1 moved, 2 flagged" — what the last run did. */
export function odSyncSummaryText(s: OdSyncSummary): string {
  const parts = [
    s.completed ? `${s.completed} completed` : "",
    s.unscheduled ? `${s.unscheduled} moved` : "",
    s.rescheduled ? `${s.rescheduled} rescheduled` : "",
    s.flagged ? `${s.flagged} flagged` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no changes";
}

/** What the sync did to a case, in a few words. */
export function odSyncActionText(a: OdSyncAction): string {
  if (a.kind === "completed") return "Completed in Open Dental";
  if (a.kind === "unscheduled") return "Broken or unscheduled in Open Dental — moved to Pending Patient";
  return `Rescheduled in Open Dental: ${a.fromDateTime.slice(0, 16)} → ${a.toDateTime.slice(0, 16)}`;
}

const FLAG_WORDS: Record<OdSyncFlagReason, string> = {
  missing: "the appointment is gone from Open Dental",
  status: "the appointment has a status the sync does not act on",
  patient: "the appointment now belongs to a different patient",
  multiple: "more than one appointment is linked",
};

export function odSyncFlagText(f: OdSyncFlag): string {
  const detail = f.reason === "status" && f.aptStatus ? ` (${f.aptStatus})` : "";
  return `Open Dental no longer matches — check: ${FLAG_WORDS[f.reason]}${detail}`;
}

/** "Oct 30, 2:31 AM" in the viewer's zone. */
export function odSyncWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
