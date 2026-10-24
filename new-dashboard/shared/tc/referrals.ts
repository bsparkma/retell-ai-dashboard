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

/**
 * R5: why referral email cannot go out from this office right now, or null
 * when it can. `switched_off` is the transport's own kill switch
 * (tc_email_enabled); the rest name a missing setting.
 */
export const TcReferralEmailUnavailable = z.enum([
  "switched_off",
  "not_configured",
  "office_not_configured",
]);
export type TcReferralEmailUnavailable = z.infer<typeof TcReferralEmailUnavailable>;

/**
 * R5c: which office detail is missing behind `office_not_configured`. The
 * sending address is the platform's to set up; the reply-to is the office's
 * own (Settings → Email identity) — different people fix them.
 */
export const TcReferralEmailMissing = z.enum(["sending_address", "reply_to"]);
export type TcReferralEmailMissing = z.infer<typeof TcReferralEmailMissing>;

/** GET /api/tc/referrals/status — is the feature on here? Never refused. */
export const TcReferralsStatus = z.object({
  success: z.literal(true),
  office: z.enum(["roland", "valley"]),
  enabled: z.boolean(),
  /**
   * R5: referral email. `enabled` is the per-office dark-launch switch
   * (tc_referral_email_enabled) — off means no send UI at all. `unavailable`
   * says why an enabled office still cannot send. Absent from an older server
   * = off. `missing` (R5c) rides only with `office_not_configured` and names
   * which detail; absent = the generic sentence.
   */
  emailSend: z
    .object({
      enabled: z.boolean(),
      unavailable: TcReferralEmailUnavailable.nullable(),
      missing: z.array(TcReferralEmailMissing).optional(),
    })
    .optional(),
});
export type TcReferralsStatus = z.infer<typeof TcReferralsStatus>;

// ── R2 (item 53): the referral record, its lifecycle, and the sign-off queue ─

/**
 * The four kinds item 53's CHECK (1791900000000) was written with. Kept as its
 * own list because that migration is history and its test pins THIS list;
 * the live vocabulary is TcReferralSourceKind below.
 */
export const TC_REFERRAL_SOURCE_KINDS_R2 = ["case", "checkout", "hyg_visit", "call"] as const;

/**
 * Where a referral was started. R6.2 adds `manual`: started by hand (from the
 * Referrals hub) for a patient looked up in this office's Open Dental, with no
 * case, checkout, visit or call behind it; source_ref is ''. The DB CHECK
 * (1792300000000) carries exactly these five; that migration's test pins it.
 */
export const TcReferralSourceKind = z.enum([...TC_REFERRAL_SOURCE_KINDS_R2, "manual"]);
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

/**
 * POST /api/tc/referrals — start one FROM a case or a checkout, or (R6.2) by
 * hand for a patient picked from this office's Open Dental search. For the
 * last, the PatNum is only WHICH patient: the server re-reads it from this
 * office's Open Dental and takes the name from there. Strict: an office, a
 * name or any other extra field is a 400.
 */
export const TcReferralCreateRequest = z
  .object({
    source: z.union([
      z.object({ caseId: z.string().uuid() }).strict(),
      z.object({ handoffId: z.string().uuid() }).strict(),
      z.object({ patNum: z.number().int().positive() }).strict(),
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

/**
 * What an event row records (R6, item 56). The DB CHECK on
 * tc_referral_events.verb (1792000000000) carries exactly these; a migration
 * test pins them equal. NULL on rows written before R6.
 *
 *   create        the referral was started (from_status NULL)
 *   edit          staff changed fields; the status did not move (from = to)
 *   doctor_edit   the doctor changed fields at sign-off (from = to)
 *   …and every TcReferralVerb below, for a status move.
 */
export const TC_REFERRAL_EVENT_VERBS = [
  "create",
  "edit",
  "doctor_edit",
  "submit",
  "withdraw",
  "cancel",
  "approve",
  "decline",
  "reopen",
  "return",
  "mark_sent",
  "mark_acknowledged",
  "mark_patient_seen",
  "close",
] as const;
/**
 * R5 (referral email send): the event verbs sending adds. The CHECK on
 * tc_referral_events.verb (1792100000000) carries TC_REFERRAL_EVENT_VERBS
 * followed by exactly these; that migration's test pins the equality.
 *
 *   send           the app emailed it and ACS accepted it: approved → sent
 *   send_failed    an email was attempted and did not go out; nothing moved
 *                  (from = to = approved). The hub offers a retry.
 *   send_conflict  ACS ACCEPTED the email but the referral could not be marked
 *                  sent (it moved meanwhile, or the audit write failed). The
 *                  email is out; this row says so instead of hiding it.
 *
 * Kept as their own list (not appended above) because R6's migration test
 * pins ITS CHECK to TC_REFERRAL_EVENT_VERBS, and that migration is history.
 */
export const TC_REFERRAL_SEND_EVENT_VERBS = ["send", "send_failed", "send_conflict"] as const;

/**
 * The verbs R5's CHECK (1792100000000) was written with: R6's, then the three
 * send verbs. Frozen, because that migration is history and its test pins
 * THIS list; the live vocabulary is TC_REFERRAL_ALL_EVENT_VERBS below.
 */
export const TC_REFERRAL_R5_EVENT_VERBS = [...TC_REFERRAL_EVENT_VERBS, ...TC_REFERRAL_SEND_EVENT_VERBS] as const;

/**
 * R5b (closing the loop): the event verbs the links and the patient email
 * add. None of them moves a status (from = to). The CHECK on
 * tc_referral_events.verb (1792500000000) carries TC_REFERRAL_R5_EVENT_VERBS
 * followed by exactly these; that migration's test pins the equality.
 *
 *   patient_scheduled      the specialist's office, or the patient, said the
 *                          patient is scheduled (from the link in their email),
 *                          with the date when they gave one
 *   patient_email_sent     the patient's notification email went out (ACS
 *                          accepted it); carries the ACS id, the address and
 *                          its unsubscribe link's hash, like `send`
 *   patient_email_skipped  no patient email was attempted, and why — no email
 *                          on file, unsubscribed, Open Dental unreadable
 *   patient_email_failed   it was attempted and did not go out
 *
 * "We received this referral" from the specialist's link is NOT here: it is
 * the existing `mark_acknowledged` move (sent → acknowledged), attributed to
 * the link instead of a person.
 */
export const TC_REFERRAL_LINK_EVENT_VERBS = [
  "patient_scheduled",
  "patient_email_sent",
  "patient_email_skipped",
  "patient_email_failed",
] as const;

/**
 * R5b: who a click on a link is attributed to — never a person. The actor on
 * the history row (and audit row) a link writes.
 */
export const REFERRAL_LINK_ACTORS = {
  specialist: "system:specialist-link",
  patient: "system:patient-link",
} as const;

/** Every event verb, in CHECK order: what tc_referral_events.verb may hold today. */
export const TC_REFERRAL_ALL_EVENT_VERBS = [...TC_REFERRAL_R5_EVENT_VERBS, ...TC_REFERRAL_LINK_EVENT_VERBS] as const;

export const TcReferralEventVerb = z.enum(TC_REFERRAL_ALL_EVENT_VERBS);
export type TcReferralEventVerb = z.infer<typeof TcReferralEventVerb>;

/** One transition (or, since R6, one edit), as the referral's history shows it. */
export const TcReferralEvent = z.object({
  eventId: z.string().uuid(),
  fromStatus: TcReferralStatus.nullable(),
  toStatus: TcReferralStatus,
  actor: z.string(),
  at: z.string(),
  note: z.string(),
  /** R6: what happened. null on rows written before R6. */
  verb: TcReferralEventVerb.nullable().optional(),
});
export type TcReferralEvent = z.infer<typeof TcReferralEvent>;

/** The specialist's receipt, as a list read carries it (see TcReferral.received). */
export const TcReferralReceived = z.object({
  at: z.string(),
  via: z.enum(["link", "staff"]),
});
export type TcReferralReceived = z.infer<typeof TcReferralReceived>;

/** The patient email's outcome, as a list read carries it (see TcReferral.patientEmail). */
export const TcReferralPatientEmailRecord = z.object({
  status: z.enum(["sent", "skipped", "failed"]),
  /** The history row's own words ("Patient not emailed: ..."). No address, no PHI. */
  note: z.string(),
  at: z.string(),
});
export type TcReferralPatientEmailRecord = z.infer<typeof TcReferralPatientEmailRecord>;

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
  /** R6: the doctor's own note, written at sign-off. null when none. */
  doctorNote: z.string().nullable().optional(),
  /**
   * The reason in plain words, for the PATIENT's email only (see
   * TC_REFERRAL_PATIENT_REASON_MAX). null when none was written.
   */
  patientReason: z.string().nullable().optional(),
  /** R6: only on the hub list — how many files are attached. */
  attachmentCount: z.number().int().nonnegative().optional(),
  /**
   * R6: set while a draft's latest STATUS MOVE is the doctor's `return` — the
   * question the submitter must answer. null otherwise. On list and detail reads.
   */
  returned: z.object({ note: z.string(), actor: z.string(), at: z.string() }).nullable().optional(),
  /**
   * R5: the chosen specialist's email as the directory holds it NOW, when it is
   * a usable address; null when there is none. On list and detail reads. The
   * send always re-reads the directory row; this is only for the button.
   */
  specialistEmail: z.string().nullable().optional(),
  /**
   * R5: while it is approved, the last email attempt that did not end in
   * `sent` — a failure (retry allowed) or a conflict (the email went out but
   * the referral was not marked sent; no retry). null otherwise.
   */
  sendProblem: z
    .object({ kind: z.enum(["failed", "conflict"]), note: z.string(), actor: z.string(), at: z.string() })
    .nullable()
    .optional(),
  /**
   * R5b: the appointment date the specialist's office or the patient gave from
   * the link in their email ("YYYY-MM-DD"), the latest one given. null when
   * nobody gave a date. The history row says who and when.
   */
  scheduledDate: z.string().nullable().optional(),
  /**
   * The specialist confirmed receipt since the referral was last sent: the
   * `mark_acknowledged` move, from their email link (`via: "link"`) or marked
   * by staff (`via: "staff"`). null when nobody has. On list reads.
   */
  received: TcReferralReceived.nullable().optional(),
  /**
   * What happened to the patient's notification email after the latest send:
   * sent, skipped (the note names why), or failed. null when none was
   * recorded. On list reads.
   */
  patientEmail: TcReferralPatientEmailRecord.nullable().optional(),
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
 * R6 (item 56) adds:
 *   reopen             approved → pending_signoff, to edit before it goes out;
 *                      it needs the doctor's sign-off again           (tc.full)
 *   return             pending_signoff → draft, with the doctor's question
 *                      (a comment is required)             (tc.referral_signoff)
 *   mark_sent          approved → sent          ┐ HUMAN ATTESTATIONS of things
 *   mark_acknowledged  sent → acknowledged      │ that happened OUTSIDE the app,
 *   mark_patient_seen  acknowledged → patient_seen │ for the world before
 *   close              patient_seen → closed    ┘ sending exists     (tc.full)
 *
 * The four marks record what a person says happened; none of them emails,
 * faxes or triggers anything.
 *
 * R5 adds ONE more move, `send` (approved → sent), below as TcReferralSendVerb
 * rather than in this enum: these are the verbs a person SAYS, recorded as
 * they say them, while `send` is the app's own act — it happens only after
 * ACS has accepted the email, and only the send code may perform it. Keeping
 * it out of this enum keeps every route that takes "a verb" from being able to
 * claim a send that never happened.
 */
export const TcReferralVerb = z.enum([
  "submit",
  "withdraw",
  "cancel",
  "approve",
  "decline",
  "reopen",
  "return",
  "mark_sent",
  "mark_acknowledged",
  "mark_patient_seen",
  "close",
]);
export type TcReferralVerb = z.infer<typeof TcReferralVerb>;

/** R5: the app emailed it and ACS accepted it (see TcReferralVerb's note). */
export const TcReferralSendVerb = z.literal("send");
export type TcReferralSendVerb = z.infer<typeof TcReferralSendVerb>;

/** Every verb that moves a status: what a person says, and the app's send. */
export type TcReferralMoveVerb = TcReferralVerb | TcReferralSendVerb;

/**
 * THE transition table. Pure; the server enforces it, the client uses it only
 * to decide which buttons to draw. null = not allowed from here.
 */
export function referralNextStatus(
  from: TcReferralStatus,
  verb: TcReferralMoveVerb,
  opts: { signoffRequired: boolean },
): TcReferralStatus | null {
  switch (verb) {
    // R5: only from approved, and only once ACS has accepted the email. The
    // same edge as mark_sent; the event's verb says which one happened.
    case "send":
      return from === "approved" ? "sent" : null;
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
    // Back to sign-off even when this office does not require it: an approved
    // referral that changes is re-read by a doctor before it goes anywhere.
    case "reopen":
      return from === "approved" ? "pending_signoff" : null;
    case "return":
      return from === "pending_signoff" ? "draft" : null;
    case "mark_sent":
      return from === "approved" ? "sent" : null;
    case "mark_acknowledged":
      return from === "sent" ? "acknowledged" : null;
    case "mark_patient_seen":
      return from === "acknowledged" ? "patient_seen" : null;
    case "close":
      return from === "patient_seen" ? "closed" : null;
  }
}

/** Only a draft can be edited through the full form (PUT): a doctor signs off what they read. */
export const REFERRAL_EDITABLE_STATUSES: readonly TcReferralStatus[] = ["draft"];

// ── R6 (item 56): the hub, field edits, the doctor's edits, the marks ──────

/**
 * Where staff may change the four sign-off fields without moving the status
 * (PATCH /:id/fields). Approved needs `reopen` first; sent and beyond never.
 */
export const REFERRAL_FIELD_EDITABLE_STATUSES: readonly TcReferralStatus[] = ["draft", "pending_signoff"];

/** Where the doctor may edit at sign-off (PATCH /signoff/:id/fields). */
export const REFERRAL_DOCTOR_EDITABLE_STATUSES: readonly TcReferralStatus[] = ["pending_signoff"];

export const TC_REFERRAL_DOCTOR_NOTE_MAX = 4000;

/**
 * The reason in plain words: what the PATIENT's email says the visit is for
 * ("an evaluation of a sore tooth"), in place of the generic "a specialist
 * consultation". Staff- and doctor-editable; blank = the generic phrase. Never
 * the clinical `reason`, which is written for the specialist. The DB CHECK
 * (1792600000000) carries the same cap.
 */
export const TC_REFERRAL_PATIENT_REASON_MAX = 200;

/** The fields both edit surfaces share. At least one must be present. */
const fieldShape = {
  directoryEntryId: z.string().uuid().nullable().optional(),
  urgency: TcReferralUrgency.optional(),
  reason: z.string().trim().min(1, "Say why you are referring").max(2000).optional(),
  teeth: TcReferralTeeth.optional(),
  patientReason: z
    .string()
    .trim()
    .max(TC_REFERRAL_PATIENT_REASON_MAX, `Keep the reason in plain words under ${TC_REFERRAL_PATIENT_REASON_MAX} characters`)
    .nullable()
    .optional(),
};
const hasAnyField = (v: Record<string, unknown>) => Object.values(v).some((x) => x !== undefined);

/** PATCH /api/tc/referrals/:id/fields — staff (tc.full), draft or awaiting sign-off. */
export const TcReferralFieldsEdit = z.object(fieldShape).strict().refine(hasAnyField, "Nothing to change");
export type TcReferralFieldsEdit = z.infer<typeof TcReferralFieldsEdit>;

/** PATCH /api/tc/referrals/signoff/:id/fields — the doctor, at sign-off. */
export const TcReferralDoctorEdit = z
  .object({
    ...fieldShape,
    doctorNote: z.string().trim().max(TC_REFERRAL_DOCTOR_NOTE_MAX).nullable().optional(),
  })
  .strict()
  .refine(hasAnyField, "Nothing to change");
export type TcReferralDoctorEdit = z.infer<typeof TcReferralDoctorEdit>;

/** POST /api/tc/referrals/:id/reopen — back to sign-off, with the edit in the same step. */
export const TcReferralReopenRequest = z
  .object({ fields: TcReferralFieldsEdit.optional() })
  .strict();
export type TcReferralReopenRequest = z.infer<typeof TcReferralReopenRequest>;

/** POST /api/tc/referrals/signoff/:id/return — the doctor's question is required. */
export const TcReferralReturnRequest = z
  .object({ comment: z.string().trim().min(1, "Say what you need").max(1000) })
  .strict();
export type TcReferralReturnRequest = z.infer<typeof TcReferralReturnRequest>;

/** POST /api/tc/referrals/:id/mark-sent — how / where it went, in a few words. */
export const TcReferralMarkSentRequest = z
  .object({ how: z.string().trim().min(1, "Say how it was sent").max(300) })
  .strict();
export type TcReferralMarkSentRequest = z.infer<typeof TcReferralMarkSentRequest>;

/** POST mark-acknowledged / mark-patient-seen / close — an optional note. */
export const TcReferralMarkRequest = z.object({ note: z.string().trim().max(300).optional() }).strict();
export type TcReferralMarkRequest = z.infer<typeof TcReferralMarkRequest>;

/** The hub's groups, in the order the page draws them. */
export type TcReferralHubGroup = "drafts" | "signoff" | "ready" | "sent" | "seen" | "done";

export const TC_REFERRAL_HUB_GROUPS: readonly { key: TcReferralHubGroup; label: string; statuses: readonly TcReferralStatus[] }[] = [
  { key: "drafts", label: "Drafts", statuses: ["draft"] },
  { key: "signoff", label: "Awaiting sign-off", statuses: ["pending_signoff"] },
  { key: "ready", label: "Ready to send", statuses: ["approved"] },
  { key: "sent", label: "Sent", statuses: ["sent", "acknowledged"] },
  { key: "seen", label: "Patient seen", statuses: ["patient_seen"] },
  { key: "done", label: "Closed / declined / cancelled", statuses: ["closed", "declined", "cancelled"] },
];

/** Which hub group a status belongs to. Pure. */
export function referralHubGroup(status: TcReferralStatus): TcReferralHubGroup {
  const g = TC_REFERRAL_HUB_GROUPS.find((x) => x.statuses.includes(status));
  return g ? g.key : "done";
}

/** GET /api/tc/referrals/hub — query filters (all optional). */
export const TcReferralHubQuery = z
  .object({
    status: TcReferralStatus.optional(),
    directoryEntryId: z.string().uuid().optional(),
    sourceKind: TcReferralSourceKind.optional(),
    /** Only referrals that have sat in their status at least this many days. */
    minAgeDays: z.coerce.number().int().min(0).max(3650).optional(),
  })
  .strict();
export type TcReferralHubQuery = z.infer<typeof TcReferralHubQuery>;

/** "in sign-off 3d" — how long a referral has sat where it is. Pure. */
export function referralStatusAge(status: TcReferralStatus, statusChangedAt: string, now: Date): string {
  const ms = now.getTime() - new Date(statusChangedAt).getTime();
  const days = Math.max(0, Math.floor(ms / 86_400_000));
  const where: Record<TcReferralStatus, string> = {
    draft: "draft",
    pending_signoff: "in sign-off",
    approved: "ready",
    sent: "sent",
    acknowledged: "acknowledged",
    patient_seen: "seen",
    closed: "closed",
    declined: "declined",
    cancelled: "cancelled",
  };
  return `${where[status]} ${days < 1 ? "<1d" : `${days}d`}`;
}

/**
 * The manual marks' honest labels — these record what a person says happened
 * outside the app; they send nothing.
 */
export const REFERRAL_MARK_LABELS = {
  mark_sent: "Mark sent outside the app",
  mark_acknowledged: "Specialist acknowledged (outside the app)",
  mark_patient_seen: "Patient seen by specialist",
  close: "Close referral",
} as const;

/**
 * The doctor's open question on a referral they sent back: present while the
 * latest STATUS MOVE is the return (edits since then do not hide it; a
 * resubmit, withdraw or cancel does). Events are oldest first. Pure.
 */
export function referralLastReturn(
  events: readonly TcReferralEvent[] | undefined,
): { note: string; actor: string; at: string } | null {
  const moves = (events ?? []).filter(isStatusMove);
  const last = moves[moves.length - 1];
  if (!last || last.verb !== "return") return null;
  return { note: last.note, actor: last.actor, at: last.at };
}

/** The event verbs that record something WITHOUT moving the status. */
const NON_MOVE_VERBS: readonly TcReferralEventVerb[] = [
  "create",
  "edit",
  "doctor_edit",
  "send_failed",
  "send_conflict",
  ...TC_REFERRAL_LINK_EVENT_VERBS,
];

/** Did this history row move the status? (Pre-R6 rows carry no verb and always did.) */
function isStatusMove(e: TcReferralEvent): boolean {
  return !e.verb || !NON_MOVE_VERBS.includes(e.verb);
}

/**
 * R5: the email trouble since the referral last MOVED (so a reopen and
 * re-approval starts clean). A conflict wins over a failure: it means the
 * email already went out, and sending again would send it twice. Events are
 * oldest first. Pure; the server uses it to refuse a second send, the client
 * to draw the retry or the warning.
 */
export function referralLastSendProblem(
  events: readonly TcReferralEvent[] | undefined,
): { kind: "failed" | "conflict"; note: string; actor: string; at: string } | null {
  const list = events ?? [];
  let start = 0;
  for (let i = 0; i < list.length; i += 1) if (isStatusMove(list[i])) start = i + 1;
  const since = list.slice(start);
  const conflict = [...since].reverse().find((e) => e.verb === "send_conflict");
  if (conflict) return { kind: "conflict", note: conflict.note, actor: conflict.actor, at: conflict.at };
  const failed = [...since].reverse().find((e) => e.verb === "send_failed");
  if (failed) return { kind: "failed", note: failed.note, actor: failed.actor, at: failed.at };
  return null;
}

/** The moves that put a referral in `sent`: the app's send, or staff marking it sent. */
const SENT_VERBS: readonly TcReferralEventVerb[] = ["send", "mark_sent"];

/**
 * The responses a referral has collected since it was LAST sent (a reopen and
 * re-send starts clean): the specialist's receipt and the patient email's
 * outcome. Events are oldest first. Rows written before R6 carry no verb; for
 * them a move sent -> acknowledged is the receipt. Pure; the server derives
 * the list fields with it.
 */
export function referralResponses(events: readonly TcReferralEvent[] | undefined): {
  received: TcReferralReceived | null;
  patientEmail: TcReferralPatientEmailRecord | null;
} {
  const list = events ?? [];
  let start = 0;
  list.forEach((e, i) => {
    const intoSent = e.verb ? SENT_VERBS.includes(e.verb) : e.toStatus === "sent" && e.fromStatus !== "sent";
    if (intoSent) start = i;
  });
  const since = list.slice(start).reverse();
  const ack = since.find((e) =>
    e.verb ? e.verb === "mark_acknowledged" : e.toStatus === "acknowledged" && e.fromStatus === "sent",
  );
  const mail = since.find(
    (e) => e.verb === "patient_email_sent" || e.verb === "patient_email_skipped" || e.verb === "patient_email_failed",
  );
  return {
    received: ack ? { at: ack.at, via: ack.actor === REFERRAL_LINK_ACTORS.specialist ? "link" : "staff" } : null,
    patientEmail: mail
      ? {
          status: mail.verb === "patient_email_sent" ? "sent" : mail.verb === "patient_email_skipped" ? "skipped" : "failed",
          note: mail.note,
          at: mail.at,
        }
      : null,
  };
}

/** "Tue, Nov 3, 2026" for a 'YYYY-MM-DD'; the raw value if it does not parse. Pure. */
export function referralDateLabel(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

/**
 * What a referral's card says about the responses, without opening it — two
 * badges and one quiet line, each null when there is nothing to say:
 *   received       "Received": the specialist confirmed (link or staff)
 *   scheduled      "Patient scheduled <date>": a scheduled_date exists,
 *                  whoever gave it
 *   patientEmail   the patient email's outcome, in the history's own words
 * Pure.
 */
export function referralResponseBadges(r: {
  received?: TcReferralReceived | null;
  scheduledDate?: string | null;
  patientEmail?: TcReferralPatientEmailRecord | null;
}): { received: string | null; receivedTitle: string | null; scheduled: string | null; patientEmail: string | null } {
  const received = r.received ?? null;
  const mail = r.patientEmail ?? null;
  return {
    received: received ? "Received" : null,
    receivedTitle: received
      ? received.via === "link"
        ? "The specialist's office confirmed it from the email link"
        : "Marked received by staff"
      : null,
    scheduled: r.scheduledDate ? `Patient scheduled ${referralDateLabel(r.scheduledDate)}` : null,
    patientEmail: mail ? (mail.status === "sent" ? "Patient emailed." : mail.note) : null,
  };
}

/** The submitter's line for a referral the doctor sent back. Pure. */
export function referralReturnedLine(returned: { note: string } | null | undefined): string | null {
  return returned ? `Returned by Dr. — ${returned.note}` : null;
}

/** The fields an edit changed, in words for the history ("specialist, how soon"). Pure. */
export function referralEditSummary(
  before: {
    directoryEntryId: string | null;
    urgency: TcReferralUrgency;
    reason: string;
    teeth: TcReferralTeeth;
    doctorNote?: string | null;
    patientReason?: string | null;
  },
  change: {
    directoryEntryId?: string | null;
    urgency?: TcReferralUrgency;
    reason?: string;
    teeth?: TcReferralTeeth;
    doctorNote?: string | null;
    patientReason?: string | null;
  },
): string[] {
  const out: string[] = [];
  if (change.directoryEntryId !== undefined && change.directoryEntryId !== before.directoryEntryId) out.push("specialist");
  if (change.urgency !== undefined && change.urgency !== before.urgency) {
    out.push(`how soon (${TC_REFERRAL_URGENCY_LABELS[before.urgency]} → ${TC_REFERRAL_URGENCY_LABELS[change.urgency]})`);
  }
  if (change.reason !== undefined && change.reason !== before.reason) out.push("reason");
  if (change.teeth !== undefined && JSON.stringify(change.teeth) !== JSON.stringify(before.teeth)) out.push("teeth");
  if (change.doctorNote !== undefined && (change.doctorNote || null) !== (before.doctorNote ?? null)) {
    out.push("doctor's note");
  }
  if (change.patientReason !== undefined && (change.patientReason || null) !== (before.patientReason ?? null)) {
    out.push("reason in plain words");
  }
  return out;
}

/**
 * The checkout sidebar's chip (item 50's placeholder goes live): what this
 * checkout's referral, if any, is waiting on. Cancelled ones do not count.
 */
export type TcReferralChip =
  | "none"
  | "staged"
  | "pending_signoff"
  | "approved"
  | "sent"
  | "acknowledged"
  | "patient_seen"
  | "closed"
  | "declined";

export const TC_REFERRAL_CHIP_LABELS: Record<TcReferralChip, string> = {
  none: "None",
  staged: "Staged",
  pending_signoff: "Pending Dr. sign-off",
  approved: "Approved",
  sent: TC_REFERRAL_STATUS_LABELS.sent,
  acknowledged: TC_REFERRAL_STATUS_LABELS.acknowledged,
  patient_seen: TC_REFERRAL_STATUS_LABELS.patient_seen,
  closed: TC_REFERRAL_STATUS_LABELS.closed,
  declined: "Declined",
};

/**
 * The newest live referral and its chip, so a compact surface can show the
 * same received / scheduled signals beside it. null when there is none. The
 * chip names the REAL status: everything past approval used to read
 * "Approved", so a referral the specialist had already received looked
 * unsent. Pure.
 */
export function referralChipTop<R extends { status: TcReferralStatus; createdAt: string }>(
  referrals: readonly R[],
): { chip: Exclude<TcReferralChip, "none">; referral: R } | null {
  const live = referrals
    .filter((r) => r.status !== "cancelled")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const top = live[0];
  if (!top || top.status === "cancelled") return null;
  return { chip: top.status === "draft" ? "staged" : top.status, referral: top };
}

/** The chip for a set of referrals (newest wins). Pure. */
export function referralChipFor(
  referrals: readonly { status: TcReferralStatus; createdAt: string }[],
): TcReferralChip {
  return referralChipTop(referrals)?.chip ?? "none";
}

/** The honest line under an approved referral, until sending exists. */
export const REFERRAL_READY_TO_SEND_COPY = "Ready to send — sending ships in a later update.";

// ── R5: referral email send ─────────────────────────────────────────────────

/** POST /api/tc/referrals/:id/send — no body. Everything is derived server-side. */
export const TcReferralSendRequest = z.object({}).strict();
export type TcReferralSendRequest = z.infer<typeof TcReferralSendRequest>;

/**
 * R5b: what happened to the patient's notification email, once the letter
 * went out. Never changes what the send reports: the specialist send is the
 * send, and this rides beside it.
 */
export const TcReferralPatientEmailOutcome = z.object({
  status: z.enum(["sent", "skipped", "failed"]),
  message: z.string(),
});
export type TcReferralPatientEmailOutcome = z.infer<typeof TcReferralPatientEmailOutcome>;

/** What a send (or the auto-send after an approval) did. */
export const TcReferralSendOutcome = z.object({
  status: z.enum(["sent", "failed", "conflict", "skipped"]),
  /** The honest sentence: why it failed, or where it went. */
  message: z.string(),
  code: z.string().nullable(),
  /** R5b: only on a `sent` outcome. Absent from an older server. */
  patientEmail: TcReferralPatientEmailOutcome.optional(),
});
export type TcReferralSendOutcome = z.infer<typeof TcReferralSendOutcome>;

/** The line under an approved referral once email is switched on for the office. */
export const REFERRAL_READY_TO_EMAIL_COPY = "Approved — ready to email to the specialist.";

/** Why the Send button is disabled when the directory row has no email. Exactly as the PM wrote it. */
export const REFERRAL_NO_EMAIL_COPY =
  "No email on file — add it in Settings → Referrals, or mark sent outside the app";

/** The disabled-button sentence for each reason email cannot go out. */
export const REFERRAL_EMAIL_UNAVAILABLE_COPY: Record<TcReferralEmailUnavailable, string> = {
  switched_off: "Email sending is switched off for the practice right now.",
  not_configured: "Email sending is not connected yet.",
  office_not_configured: "This office has no referral sending address set up yet.",
};

/** R5c: the `office_not_configured` sentence once the server says which detail is missing. */
export const REFERRAL_EMAIL_MISSING_COPY: Record<TcReferralEmailMissing, string> = {
  reply_to:
    "This office has no reply-to address for referral email yet — an admin or office manager can set one in Settings → Email identity.",
  sending_address: "This office has no referral sending address set up yet (the platform sets that up).",
};

function unavailableCopy(email: {
  unavailable: TcReferralEmailUnavailable;
  missing?: TcReferralEmailMissing[];
}): string {
  const missing = email.missing;
  if (email.unavailable !== "office_not_configured" || !missing || missing.length === 0) {
    return REFERRAL_EMAIL_UNAVAILABLE_COPY[email.unavailable];
  }
  // Sending address first: the platform's gap, and the reply-to is moot without it.
  return TcReferralEmailMissing.options
    .filter((k) => missing.includes(k))
    .map((k) => REFERRAL_EMAIL_MISSING_COPY[k])
    .join(" ");
}

/**
 * Should this approved referral offer Send, and if not, why not? Pure — the
 * server re-checks everything at the click.
 */
export function referralSendBlocker(
  r: Pick<TcReferral, "status" | "specialistEmail" | "sendProblem">,
  email:
    | { enabled: boolean; unavailable: TcReferralEmailUnavailable | null; missing?: TcReferralEmailMissing[] }
    | null
    | undefined,
): string | null {
  if (r.status !== "approved") return "Only an approved referral can be emailed.";
  if (!email || !email.enabled) return "Referral email is not switched on for this office.";
  if (r.sendProblem && r.sendProblem.kind === "conflict") {
    return "This referral was already emailed but could not be marked sent. Check with the specialist, then mark it sent.";
  }
  if (email.unavailable) return unavailableCopy({ unavailable: email.unavailable, missing: email.missing });
  if (!r.specialistEmail) return REFERRAL_NO_EMAIL_COPY;
  return null;
}

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

// ── R4 (item 55): attachments ───────────────────────────────────────────────

/** One attached file, as the API returns it. The storage key never leaves the server. */
export const TcReferralAttachment = z.object({
  attachmentId: z.string().uuid(),
  referralId: z.string().uuid(),
  fileName: z.string(),
  contentType: z.enum(TC_REFERRAL_ATTACHMENT_TYPES),
  sizeBytes: z.number().int().positive(),
  uploadedBy: z.string(),
  uploadedAt: z.string(),
});
export type TcReferralAttachment = z.infer<typeof TcReferralAttachment>;

/** The helper text under the upload zone — exactly as the PM specified. */
export const REFERRAL_ATTACHMENT_HINT = "Press Win+Shift+S to snip the X-ray, then drag it here.";

/**
 * The client's courtesy pre-check — the SERVER decides (by the bytes). Says
 * why a file will not be accepted, or null. Pure.
 */
export function attachmentProblem(
  file: { type: string; size: number; name: string },
  alreadyChosen: number,
): string | null {
  if (alreadyChosen >= TC_REFERRAL_ATTACHMENT_MAX_FILES) {
    return `A referral can carry at most ${TC_REFERRAL_ATTACHMENT_MAX_FILES} files.`;
  }
  if (!(TC_REFERRAL_ATTACHMENT_TYPES as readonly string[]).includes(file.type)) {
    return `${file.name || "That file"} isn't an image or a PDF.`;
  }
  if (file.size <= 0) return `${file.name || "That file"} is empty.`;
  if (file.size > TC_REFERRAL_ATTACHMENT_MAX_BYTES) {
    return `${file.name || "That file"} is larger than ${TC_REFERRAL_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB.`;
  }
  return null;
}
