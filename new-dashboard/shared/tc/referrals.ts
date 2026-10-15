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
