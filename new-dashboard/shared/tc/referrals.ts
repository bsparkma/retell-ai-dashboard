/**
 * Referrals (queue items 52–55): the shared vocabulary and request/response
 * shapes, used by the backend (via the bundled contract) and the dashboard.
 *
 * R1 (this file's first slice) ships the directory, the settings and the
 * referral record's vocabulary. Nothing sends; nothing reads or writes Open
 * Dental.
 */
import { z } from "zod";

/**
 * Where a referral stands. The DB CHECK (1791800000000_tc_referrals.js) carries
 * exactly these nine, inline; a migration test pins them equal.
 *
 *   draft            being written
 *   pending_signoff  waiting on the doctor's sign-off (R2)
 *   approved         signed off; ready to send (sending is a later update)
 *   sent             sent to the specialist (later update)
 *   acknowledged     the specialist's office confirmed receipt
 *   patient_seen     the specialist saw the patient
 *   closed           finished
 *   declined         the doctor declined it, with a reason
 *   cancelled        withdrawn
 */
export const TcReferralStatus = z.enum([
  "draft",
  "pending_signoff",
  "approved",
  "sent",
  "acknowledged",
  "patient_seen",
  "closed",
  "declined",
  "cancelled",
]);
export type TcReferralStatus = z.infer<typeof TcReferralStatus>;

export const TC_REFERRAL_STATUS_LABELS: Record<TcReferralStatus, string> = {
  draft: "Draft",
  pending_signoff: "Pending Dr. sign-off",
  approved: "Approved",
  sent: "Sent",
  acknowledged: "Acknowledged",
  patient_seen: "Patient seen",
  closed: "Closed",
  declined: "Declined",
  cancelled: "Cancelled",
};

/** How soon the patient should be seen. The DB CHECK carries the same three. */
export const TcReferralUrgency = z.enum(["routine", "soon", "urgent"]);
export type TcReferralUrgency = z.infer<typeof TcReferralUrgency>;

export const TC_REFERRAL_URGENCY_LABELS: Record<TcReferralUrgency, string> = {
  routine: "Routine",
  soon: "Soon",
  urgent: "Urgent",
};

/** Attachment types R4 accepts (images + PDF). The DB CHECK carries the same five. */
export const TC_REFERRAL_ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
] as const;
export const TC_REFERRAL_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const TC_REFERRAL_ATTACHMENT_MAX_FILES = 5;

// ── The directory ───────────────────────────────────────────────────────────

/**
 * An email, or empty. The same rule as the DB CHECK
 * (`^[^@\s]+@[^@\s]+\.[^@\s]+$`): something@something.something, no spaces.
 * Deliberately loose — the front desk is typing a specialist's office address,
 * and the point is to catch a typo, not to be RFC 5322.
 */
export const DIRECTORY_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const Field = (max: number) => z.string().trim().max(max);

/** POST / PUT /api/tc/referrals/directory[/:id] — what the form sends. */
export const TcReferralDirectoryInput = z
  .object({
    practiceName: z.string().trim().min(1, "Practice name is required").max(200),
    specialistName: Field(200).default(""),
    specialty: Field(120).default(""),
    contactPerson: Field(200).default(""),
    email: Field(200)
      .default("")
      .refine((v) => v === "" || DIRECTORY_EMAIL_RE.test(v), "That email address does not look right"),
    phone: Field(40).default(""),
    fax: Field(40).default(""),
    notes: Field(2000).default(""),
    preferredFormatNotes: Field(2000).default(""),
    active: z.boolean().default(true),
  })
  .strict();
export type TcReferralDirectoryInput = z.infer<typeof TcReferralDirectoryInput>;

/** One directory entry, as the API returns it. */
export const TcReferralDirectoryEntry = z.object({
  entryId: z.string().uuid(),
  officeId: z.enum(["roland", "valley"]),
  practiceName: z.string(),
  specialistName: z.string(),
  specialty: z.string(),
  contactPerson: z.string(),
  email: z.string(),
  phone: z.string(),
  fax: z.string(),
  notes: z.string(),
  preferredFormatNotes: z.string(),
  active: z.boolean(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type TcReferralDirectoryEntry = z.infer<typeof TcReferralDirectoryEntry>;

// ── Settings ────────────────────────────────────────────────────────────────

/**
 * The two per-office referral policies. Absent row = the defaults (sign-off
 * required, no auto-send). `source` says which layer answered: `env` when a
 * safety override pins the safe value, `office` when the office chose, and
 * `default` otherwise.
 */
export const TcReferralPolicy = z.object({
  value: z.boolean(),
  source: z.enum(["env", "office", "default"]),
});
export type TcReferralPolicy = z.infer<typeof TcReferralPolicy>;

/** GET /api/tc/referrals/settings */
export const TcReferralSettingsResponse = z.object({
  success: z.literal(true),
  office: z.enum(["roland", "valley"]),
  signoffRequired: TcReferralPolicy,
  autosendOnApproval: TcReferralPolicy,
  /** Admin-only for now: may this user change the two policies? */
  canEdit: z.boolean(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type TcReferralSettingsResponse = z.infer<typeof TcReferralSettingsResponse>;

/** PUT /api/tc/referrals/settings — either or both. */
export const TcReferralSettingsRequest = z
  .object({
    signoffRequired: z.boolean().optional(),
    autosendOnApproval: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.signoffRequired !== undefined || v.autosendOnApproval !== undefined, "Nothing to change");
export type TcReferralSettingsRequest = z.infer<typeof TcReferralSettingsRequest>;

/** GET /api/tc/referrals/status — is the feature on here? Never refused. */
export const TcReferralsStatus = z.object({
  success: z.literal(true),
  office: z.enum(["roland", "valley"]),
  enabled: z.boolean(),
});
export type TcReferralsStatus = z.infer<typeof TcReferralsStatus>;

// ── R2 (item 53): the referral record, its lifecycle, and the sign-off queue ─

/** Where a referral was started. The DB CHECK (1791900000000) carries the same four. */
export const TcReferralSourceKind = z.enum(["case", "checkout", "hyg_visit", "call"]);
export type TcReferralSourceKind = z.infer<typeof TcReferralSourceKind>;

/** Universal tooth numbers, or "mouth" — the checkout procedure's shape. */
export const TcReferralTeeth = z.union([
  z.array(z.number().int().min(1).max(32)).max(32),
  z.literal("mouth"),
]);
export type TcReferralTeeth = z.infer<typeof TcReferralTeeth>;

/**
 * The editable part of a referral — what the form sends on create and edit.
 * The PATIENT is never here: the server derives office + PatNum + name from
 * the source (a case or a checkout), never from a request.
 */
export const TcReferralInput = z
  .object({
    directoryEntryId: z.string().uuid().nullable().default(null),
    referringProvider: z.string().trim().max(200).default(""),
    specialty: z.string().trim().max(120).default(""),
    reason: z.string().trim().min(1, "Say why you are referring").max(2000),
    teeth: TcReferralTeeth.default([]),
    urgency: TcReferralUrgency.default("routine"),
    narrative: z.string().trim().max(8000).default(""),
  })
  .strict();
export type TcReferralInput = z.infer<typeof TcReferralInput>;

/** POST /api/tc/referrals — start one FROM a case or a checkout. */
export const TcReferralCreateRequest = z
  .object({
    source: z.union([
      z.object({ caseId: z.string().uuid() }).strict(),
      z.object({ handoffId: z.string().uuid() }).strict(),
    ]),
    referral: TcReferralInput,
  })
  .strict();
export type TcReferralCreateRequest = z.infer<typeof TcReferralCreateRequest>;

/** POST /api/tc/referrals/signoff/:id/decline — a reason is required. */
export const TcReferralDeclineRequest = z
  .object({ reason: z.string().trim().min(1, "Say why").max(500) })
  .strict();
export type TcReferralDeclineRequest = z.infer<typeof TcReferralDeclineRequest>;

/** One transition, as the referral's history shows it. */
export const TcReferralEvent = z.object({
  eventId: z.string().uuid(),
  fromStatus: TcReferralStatus.nullable(),
  toStatus: TcReferralStatus,
  actor: z.string(),
  at: z.string(),
  note: z.string(),
});
export type TcReferralEvent = z.infer<typeof TcReferralEvent>;

/** A referral, as the API returns it. */
export const TcReferral = z.object({
  referralId: z.string().uuid(),
  officeId: z.enum(["roland", "valley"]),
  odPatientId: z.number().int().positive(),
  patientName: z.string(),
  tcCaseId: z.string().uuid().nullable(),
  sourceKind: TcReferralSourceKind,
  sourceRef: z.string(),
  referringProvider: z.string(),
  directoryEntryId: z.string().uuid().nullable(),
  /** The directory entry's current name, for display; null when none is chosen. */
  practiceName: z.string().nullable(),
  specialty: z.string(),
  reason: z.string(),
  teeth: TcReferralTeeth,
  urgency: TcReferralUrgency,
  narrative: z.string(),
  status: TcReferralStatus,
  statusChangedAt: z.string(),
  statusChangedBy: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Only on the detail read. */
  events: z.array(TcReferralEvent).optional(),
});
export type TcReferral = z.infer<typeof TcReferral>;

/**
 * The verbs that move a referral, and who may say them:
 *   submit    draft → pending_signoff, or → approved when this office does not
 *             require the doctor's sign-off                       (tc.full)
 *   withdraw  pending_signoff → draft, to fix something           (tc.full)
 *   cancel    draft | pending_signoff → cancelled                 (tc.full)
 *   approve   pending_signoff → approved                (tc.referral_signoff)
 *   decline   pending_signoff → declined, with a reason (tc.referral_signoff)
 *
 * NOTHING SENDS. `approved`, `declined` and `cancelled` are terminal in R2;
 * sent / acknowledged / patient_seen / closed arrive with sending (R5).
 */
export const TcReferralVerb = z.enum(["submit", "withdraw", "cancel", "approve", "decline"]);
export type TcReferralVerb = z.infer<typeof TcReferralVerb>;

/**
 * THE transition table. Pure; the server enforces it, the client uses it only
 * to decide which buttons to draw. null = not allowed from here.
 */
export function referralNextStatus(
  from: TcReferralStatus,
  verb: TcReferralVerb,
  opts: { signoffRequired: boolean },
): TcReferralStatus | null {
  switch (verb) {
    case "submit":
      return from === "draft" ? (opts.signoffRequired ? "pending_signoff" : "approved") : null;
    case "withdraw":
      return from === "pending_signoff" ? "draft" : null;
    case "cancel":
      return from === "draft" || from === "pending_signoff" ? "cancelled" : null;
    case "approve":
      return from === "pending_signoff" ? "approved" : null;
    case "decline":
      return from === "pending_signoff" ? "declined" : null;
  }
}

/** Only a draft can be edited: a doctor signs off what they read. */
export const REFERRAL_EDITABLE_STATUSES: readonly TcReferralStatus[] = ["draft"];

/**
 * The checkout sidebar's chip (item 50's placeholder goes live): what this
 * checkout's referral, if any, is waiting on. Cancelled ones do not count.
 */
export type TcReferralChip = "none" | "staged" | "pending_signoff" | "approved" | "declined";

export const TC_REFERRAL_CHIP_LABELS: Record<TcReferralChip, string> = {
  none: "None",
  staged: "Staged",
  pending_signoff: "Pending Dr. sign-off",
  approved: "Approved",
  declined: "Declined",
};

/** The chip for a set of referrals (newest wins). Pure. */
export function referralChipFor(
  referrals: readonly { status: TcReferralStatus; createdAt: string }[],
): TcReferralChip {
  const live = referrals
    .filter((r) => r.status !== "cancelled")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const top = live[0];
  if (!top) return "none";
  if (top.status === "draft") return "staged";
  if (top.status === "pending_signoff") return "pending_signoff";
  if (top.status === "declined") return "declined";
  return "approved";
}

/** The honest line under an approved referral, until sending exists. */
export const REFERRAL_READY_TO_SEND_COPY = "Ready to send — sending ships in a later update.";

/** GET /api/tc/referrals/signoff/summary — the nav badge and the arrival alert. */
export const TcReferralSignoffSummary = z.object({
  success: z.literal(true),
  office: z.enum(["roland", "valley"]),
  enabled: z.boolean(),
  waiting: z.number().int().nonnegative(),
  newest: z
    .object({ referralId: z.string().uuid(), patientName: z.string(), at: z.string() })
    .nullable(),
});
export type TcReferralSignoffSummary = z.infer<typeof TcReferralSignoffSummary>;
