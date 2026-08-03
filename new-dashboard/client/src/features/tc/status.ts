/**
 * TC status vocabulary — display metadata + transition rules for the 14 case
 * statuses and 7 preauth statuses frozen in shared/tc/contract.ts.
 *
 * The legacy app duplicated labels/colors in 7 files and allowed free-form
 * transitions. Here there is ONE metadata table, and the only transition rule
 * the backend enforces (lost requires lostReason; lostReason only on lost) is
 * mirrored client-side so dialogs can validate before POSTing.
 */
import { CaseStatus, LostReason, PreauthStatus, Urgency } from "@shared/tc/contract";
import { z } from "zod";

export type CaseStatusId = z.infer<typeof CaseStatus>;
export type PreauthStatusId = z.infer<typeof PreauthStatus>;
export type UrgencyId = z.infer<typeof Urgency>;
export type LostReasonId = z.infer<typeof LostReason>;

export interface StatusMeta {
  id: CaseStatusId;
  label: string;
  /** Tailwind badge classes — light bg + strong text, dark-mode aware. */
  badgeClass: string;
  /** Board column index; null = not a pipeline board column. */
  boardOrder: number | null;
}

export const CASE_STATUSES: Record<CaseStatusId, StatusMeta> = {
  hygiene_review: {
    id: "hygiene_review",
    label: "Hygiene Review",
    badgeClass: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
    boardOrder: null, // lives in the Hygiene Inbox until claimed
  },
  diagnosed: {
    id: "diagnosed",
    label: "Diagnosed",
    badgeClass: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
    boardOrder: 0,
  },
  pending_tc: {
    id: "pending_tc",
    label: "Pending TC",
    badgeClass: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    boardOrder: 1,
  },
  pending_pt: {
    id: "pending_pt",
    label: "Pending Patient",
    badgeClass: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
    boardOrder: 2,
  },
  presented: {
    id: "presented",
    label: "Presented",
    badgeClass: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
    boardOrder: 3,
  },
  considering: {
    id: "considering",
    label: "Considering",
    badgeClass: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    boardOrder: 4,
  },
  financing_pending: {
    id: "financing_pending",
    label: "Financing Pending",
    badgeClass: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
    boardOrder: 5,
  },
  accepted: {
    id: "accepted",
    label: "Accepted",
    badgeClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    boardOrder: 6,
  },
  partially_accepted: {
    id: "partially_accepted",
    label: "Partially Accepted",
    badgeClass: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
    boardOrder: 7,
  },
  scheduled: {
    id: "scheduled",
    label: "Scheduled",
    badgeClass: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    boardOrder: 8,
  },
  started: {
    id: "started",
    label: "Started",
    badgeClass: "bg-lime-100 text-lime-700 dark:bg-lime-950 dark:text-lime-300",
    boardOrder: null,
  },
  completed: {
    id: "completed",
    label: "Completed",
    badgeClass: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    boardOrder: null,
  },
  lost: {
    id: "lost",
    label: "Lost",
    badgeClass: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    boardOrder: null,
  },
  nurture: {
    id: "nurture",
    label: "Nurture",
    badgeClass: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
    boardOrder: null,
  },
};

export const ALL_CASE_STATUSES: CaseStatusId[] = CaseStatus.options;

/** Pipeline board columns, in order (the legacy 9-stage kanban). */
export const BOARD_STATUSES: CaseStatusId[] = ALL_CASE_STATUSES
  .filter((s) => CASE_STATUSES[s].boardOrder !== null)
  .sort((a, b) => (CASE_STATUSES[a].boardOrder ?? 0) - (CASE_STATUSES[b].boardOrder ?? 0));

export function caseStatusLabel(status: CaseStatusId): string {
  return CASE_STATUSES[status].label;
}

/** Mirror of the backend transition guards (cases.js POST /:caseId/status). */
export function validateTransition(
  status: CaseStatusId,
  lostReason: LostReasonId | null,
): { ok: true } | { ok: false; message: string } {
  if (status === "lost" && !lostReason) {
    return { ok: false, message: "A lost reason is required when marking a case lost." };
  }
  if (status !== "lost" && lostReason) {
    return { ok: false, message: "Lost reason only applies to the Lost status." };
  }
  return { ok: true };
}

export const LOST_REASON_LABELS: Record<LostReasonId, string> = {
  moved: "Moved away",
  chose_another_provider: "Chose another provider",
  declined_permanently: "Declined permanently",
  unresponsive: "Unresponsive",
  other: "Other",
};

export const URGENCY_LABELS: Record<UrgencyId, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  elective: "Elective",
};

export const URGENCY_BADGE: Record<UrgencyId, string> = {
  high: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  low: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  elective: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

export interface PreauthStatusMeta {
  id: PreauthStatusId;
  label: string;
  badgeClass: string;
  boardOrder: number;
}

export const PREAUTH_STATUSES: Record<PreauthStatusId, PreauthStatusMeta> = {
  pending: { id: "pending", label: "Pending", badgeClass: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300", boardOrder: 0 },
  submitted: { id: "submitted", label: "Submitted", badgeClass: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300", boardOrder: 1 },
  in_review: { id: "in_review", label: "In Review", badgeClass: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300", boardOrder: 2 },
  approved: { id: "approved", label: "Approved", badgeClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300", boardOrder: 3 },
  denied: { id: "denied", label: "Denied", badgeClass: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300", boardOrder: 4 },
  appealing: { id: "appealing", label: "Appealing", badgeClass: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300", boardOrder: 5 },
  expired: { id: "expired", label: "Expired", badgeClass: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400", boardOrder: 6 },
};

export const PREAUTH_BOARD_STATUSES: PreauthStatusId[] = PreauthStatus.options
  .slice()
  .sort((a, b) => PREAUTH_STATUSES[a].boardOrder - PREAUTH_STATUSES[b].boardOrder);
