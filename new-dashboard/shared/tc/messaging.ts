/**
 * TC messaging — the shared contract for patient messages (queue item 38).
 *
 * THE INVIOLABLE SHAPE: review-then-send. A patient message is like a chart
 * write — nothing ever sends without a human clicking Send on THAT message.
 * No auto-send, no scheduled send, no bulk send. Draft → (optional edit) →
 * human clicks Send → channel adapter.
 *
 * Every enum below mirrors a CHECK constraint written INLINE in
 * backend/migrations-tenant/1790300000000_tc_messaging.js. The two are pinned
 * against each other by backend/test/tcMessagingMigration.test.js — a value the
 * contract accepts and the database refuses is a 500 in front of a TC; the
 * reverse is a row nothing can render.
 *
 * PHI: a message's address and body are PHI. Neither is ever logged or written
 * to an audit row (audit rows carry the message id only).
 */
import { z } from "zod";
import { OfficeId, Uuid } from "./contract";

const IsoTimestamp = z.string().datetime({ offset: true });

// ── Vocabularies (mirror the tc_messages / tc_contact_consent CHECKs) ───────

export const MessageDirection = z.enum(["outbound", "inbound"]);
export type MessageDirection = z.infer<typeof MessageDirection>;

export const MessageChannel = z.enum(["sms", "email"]);
export type MessageChannel = z.infer<typeof MessageChannel>;

/**
 * Lifecycle. Honest states:
 *   draft      written, not sent. The ONLY state Send accepts.
 *   queued     the provider accepted the hand-off and will deliver (item 39+)
 *   sending    Send was clicked; the adapter has not answered yet
 *   sent       the adapter CONFIRMED the hand-off
 *   delivered  the provider reported delivery (status callback, item 39+)
 *   failed     the adapter refused or threw; `error` carries why. Terminal —
 *              never retried silently.
 *   received   an inbound message
 */
export const MessageStatus = z.enum([
  "draft",
  "queued",
  "sending",
  "sent",
  "delivered",
  "failed",
  "received",
]);
export type MessageStatus = z.infer<typeof MessageStatus>;

/** The one state a Send click can start from. */
export const SENDABLE_MESSAGE_STATUSES = ["draft"] as const satisfies readonly MessageStatus[];

export const ConsentState = z.enum(["opted_in", "opted_out", "unknown"]);
export type ConsentState = z.infer<typeof ConsentState>;

export const ConsentSource = z.enum(["od", "stop_keyword", "manual", "unsubscribe_link"]);
export type ConsentSource = z.infer<typeof ConsentSource>;

/**
 * What Open Dental's patient TxtMsgOk said, as the consent gate read it.
 *   yes / no / unknown   the field's three values (OD's YN: Yes / No / ??)
 *   unavailable          the patient is linked but OD could not be read, or
 *                        answered a value we do not recognise. FAILS CLOSED.
 *   not_linked           the case has no Open Dental patient; nothing to read
 *   not_checked          the gate stopped before reading OD (opted out), or
 *                        the channel is not SMS
 */
export const OdTextConsent = z.enum([
  "yes",
  "no",
  "unknown",
  "unavailable",
  "not_linked",
  "not_checked",
]);
export type OdTextConsent = z.infer<typeof OdTextConsent>;

/**
 * Every refusal the send path can return, each distinct so the UI renders an
 * honest sentence rather than "something went wrong". A closed set: adding a
 * code without a sentence in the UI's copy map is a compile error.
 */
export const MessageBlockCode = z.enum([
  // consent gate (server-side, fail closed; every one is audited)
  "CONSENT_OPTED_OUT",
  "OD_TEXT_CONSENT_NO",
  "OD_CONSENT_UNAVAILABLE",
  "QUIET_HOURS",
]);
export type MessageBlockCode = z.infer<typeof MessageBlockCode>;

// ── Entities ────────────────────────────────────────────────────────────────

export const TcMessage = z.object({
  messageId: Uuid,
  officeId: OfficeId,
  caseId: Uuid.nullable(),
  direction: MessageDirection,
  channel: MessageChannel,
  toAddress: z.string().max(320).nullable(), // PHI
  fromAddress: z.string().max(320).nullable(), // PHI on inbound
  body: z.string().max(8000), // PHI
  subject: z.string().max(300).nullable(), // email only
  templateId: z.string().max(120).nullable(),
  status: MessageStatus,
  provider: z.string().max(60).nullable(),
  providerMessageId: z.string().max(200).nullable(),
  error: z.string().max(2000).nullable(),
  createdBy: z.string().max(320).nullable(),
  sentBy: z.string().max(320).nullable(),
  createdAt: IsoTimestamp,
  sentAt: IsoTimestamp.nullable(),
  /**
   * (item 40) Email only: this draft was built from a template in the email
   * template library, so it is sent with that template's layout (a snapshot
   * taken when the draft was written). Its body text is then a read-only
   * plain-text view of that layout; only the subject can be edited.
   */
  emailTemplated: z.boolean().default(false),
});
export type TcMessage = z.infer<typeof TcMessage>;

export const TcContactConsent = z.object({
  consentId: Uuid,
  officeId: OfficeId,
  channel: MessageChannel,
  address: z.string().max(320), // PHI
  state: ConsentState,
  source: ConsentSource,
  note: z.string().max(2000).nullable(),
  updatedBy: z.string().max(320).nullable(),
  updatedAt: IsoTimestamp,
});
export type TcContactConsent = z.infer<typeof TcContactConsent>;

/**
 * Why a channel's provider is not connected for this office (item 39).
 *   switched_off           the kill switch (platform_setting tc_sms_enabled) is off
 *   not_configured         the provider account is not configured on this deployment
 *   office_not_configured  the account is, but THIS office has no sender of its own
 */
export const ChannelUnavailableReason = z.enum(["switched_off", "not_configured", "office_not_configured"]);
export type ChannelUnavailableReason = z.infer<typeof ChannelUnavailableReason>;

/** One channel's answer for the compose box (GET /api/tc/messages/consent). */
export const ChannelReadiness = z.object({
  channel: MessageChannel,
  /** The case has a usable address for this channel (server-normalized). */
  address: z.string().max(320).nullable(), // PHI
  /** Is a provider adapter connected for this channel IN THIS OFFICE? (per office since item 39) */
  adapterEnabled: z.boolean(),
  /** Why not, when adapterEnabled is false; null when connected. (item 39) */
  adapterReason: ChannelUnavailableReason.nullable().default(null),
  consentState: ConsentState,
  odTextConsent: OdTextConsent,
  /** SMS only: inside 21:00–08:00 America/Chicago right now. */
  quietHours: z.boolean(),
  /** The block a Send would hit right now, or null if the gate would pass. */
  blockCode: MessageBlockCode.nullable(),
});
export type ChannelReadiness = z.infer<typeof ChannelReadiness>;

// ── Request bodies (strict: an unknown key is a 400) ────────────────────────

/**
 * POST /api/tc/messages/draft. NO address field — the server assembles
 * `to_address` from the case row. `followupId` without a body asks the server
 * to fill the follow-up template (no AI in this slice).
 */
export const DraftMessageBody = z
  .object({
    caseId: Uuid,
    channel: MessageChannel,
    body: z.string().trim().min(1).max(8000).optional(),
    subject: z.string().trim().min(1).max(300).optional(),
    followupId: Uuid.optional(),
    /**
     * (item 40) Email only: build the draft from this email-library template
     * (tc_email_templates, same office). The server snapshots the template's
     * blocks and subject, filled with the patient's first name and the
     * practice's details only. A body sent alongside is refused.
     */
    emailTemplateId: Uuid.optional(),
  })
  .strict();
export type DraftMessageBody = z.infer<typeof DraftMessageBody>;

/** PUT /api/tc/messages/:id — edit a DRAFT's text. Address never editable. */
export const EditDraftBody = z
  .object({
    body: z.string().trim().min(1).max(8000),
    subject: z.string().trim().min(1).max(300).nullable().optional(),
  })
  .strict();
export type EditDraftBody = z.infer<typeof EditDraftBody>;

/**
 * POST /api/tc/messages/consent — record a MANUAL opt-out ("patient asked us
 * not to text"). Opt-IN is deliberately not accepted: opt-out beats everything
 * and has no override, so no button may undo one.
 */
export const RecordOptOutBody = z
  .object({
    caseId: Uuid,
    channel: MessageChannel,
    note: z.string().trim().max(2000).optional(),
  })
  .strict();
export type RecordOptOutBody = z.infer<typeof RecordOptOutBody>;

// ── Email rendering + the legacy send route (item 40) ───────────────────────

/**
 * POST /api/tc/communications/render. Either an existing email DRAFT (renders
 * exactly what Send would send, with the unsubscribe link left inert), or a
 * library template for a case (what a draft from it would look like). Both
 * are office-scoped by `?office=`, like every TC route.
 */
export const RenderEmailBody = z.union([
  z.object({ messageId: Uuid }).strict(),
  z.object({ caseId: Uuid, templateId: Uuid }).strict(),
]);
export type RenderEmailBody = z.infer<typeof RenderEmailBody>;

/** The rendered email. `html` is a complete document for a sandboxed iframe. */
export const RenderedEmailResult = z.object({
  subject: z.string().max(300),
  html: z.string(),
  text: z.string(),
});
export type RenderedEmailResult = z.infer<typeof RenderedEmailResult>;

/**
 * POST /api/tc/communications/send, the legacy direct-send route. ONE case,
 * ONE template, ONE message: the server creates a tc_messages draft from the
 * template and sends it through the same service function as
 * POST /api/tc/messages/:id/send. No address field and no list of anything.
 */
export const CommunicationSendBody = z
  .object({
    caseId: Uuid,
    templateId: Uuid,
    subject: z.string().trim().min(1).max(300).optional(),
  })
  .strict();
export type CommunicationSendBody = z.infer<typeof CommunicationSendBody>;
