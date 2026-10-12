/**
 * Every sentence the Messages tab shows for a status, a block, or a consent
 * fact. Each map is a Record over a CLOSED contract enum, so a new value in
 * shared/tc/messaging.ts that has no sentence here is a compile error, not a
 * silent "something went wrong".
 */
import type {
  ChannelUnavailableReason,
  ConsentState,
  MessageBlockCode,
  MessageChannel,
  MessageStatus,
  OdTextConsent,
  TcMessage,
} from "@shared/tc/messaging";

export const CHANNEL_LABEL: Record<MessageChannel, string> = {
  sms: "Text",
  email: "Email",
};

/**
 * Honest delivery states (item 39): "sent" is NOT "delivered". Only a carrier
 * delivery report earns the green "Delivered".
 */
export const STATUS_LABEL: Record<MessageStatus, string> = {
  draft: "Draft — not sent",
  queued: "Queued — not delivered yet",
  sending: "Sending…",
  sent: "Sent — delivery not confirmed",
  delivered: "Delivered",
  failed: "Not sent",
  received: "Received",
};

/** Tone for the status chip. Only `delivered` is green. */
export const STATUS_TONE: Record<MessageStatus, "muted" | "info" | "ok" | "bad"> = {
  draft: "muted",
  queued: "info",
  sending: "info",
  sent: "info",
  delivered: "ok",
  failed: "bad",
  received: "info",
};

/**
 * Email's words where they differ (item 40). Azure Communication Services in
 * its basic setup reports whether it SENT an email, never whether it was
 * DELIVERED, so an email never reaches "delivered" and its "sent" says so.
 */
const EMAIL_STATUS_LABEL: Partial<Record<MessageStatus, string>> = {
  queued: "Accepted — still sending when we last checked",
  sent: "Sent — delivery not tracked",
};

/**
 * The chip's words for one message. A `failed` TEXT that Twilio had accepted
 * (it has a provider id) DID leave — the carrier then refused it — so it reads
 * "Not delivered", not "Not sent". An email is never "Not delivered": ACS
 * refusing it means it did not go out.
 */
export function statusLabel(
  m: Pick<TcMessage, "status" | "providerMessageId"> & { channel?: MessageChannel },
): string {
  if (m.channel === "email") return EMAIL_STATUS_LABEL[m.status] ?? STATUS_LABEL[m.status];
  if (m.status === "failed" && m.providerMessageId) return "Not delivered";
  return STATUS_LABEL[m.status];
}

/** The chip's tooltip, where there is more to say than fits in the chip. */
export function statusTooltip(m: Pick<TcMessage, "status" | "channel">): string | undefined {
  if (m.channel === "email" && m.status === "sent") {
    return "The email service accepted and sent this email. Email delivery is not tracked, so it will never show Delivered.";
  }
  if (m.channel === "email" && m.status === "queued") {
    return "The email service accepted this email but had not finished sending it when we stopped checking. Delivery is not tracked.";
  }
  if (m.channel === "sms" && m.status === "sent") {
    return "Twilio sent this text. It turns green only when the carrier confirms delivery.";
  }
  return undefined;
}

/** Why a channel cannot send for this office (item 39), as a sentence. */
export const ADAPTER_REASON_COPY: Record<ChannelUnavailableReason, string> = {
  switched_off: "Texting is switched off right now — drafts are saved, nothing goes out.",
  not_configured: "Sending isn't connected yet — drafts are saved, nothing goes out.",
  office_not_configured: "This office has no texting number set up yet — drafts are saved, nothing goes out.",
};

/** The short label under the channel picker. */
export const ADAPTER_REASON_SHORT: Record<ChannelUnavailableReason, string> = {
  switched_off: "Switched off",
  not_configured: "Not connected yet",
  office_not_configured: "No number for this office",
};

/** Email's sentences for the same closed reasons (item 40). */
export const EMAIL_ADAPTER_REASON_COPY: Record<ChannelUnavailableReason, string> = {
  switched_off: "Email sending is switched off right now — drafts are saved, nothing goes out.",
  not_configured: "Email sending isn't connected yet — drafts are saved, nothing goes out.",
  office_not_configured: "This office has no sending address set up yet — drafts are saved, nothing goes out.",
};

export const EMAIL_ADAPTER_REASON_SHORT: Record<ChannelUnavailableReason, string> = {
  switched_off: "Switched off",
  not_configured: "Not connected yet",
  office_not_configured: "No sending address for this office",
};

/** The reason sentence for a channel. */
export function adapterReasonCopy(channel: MessageChannel, reason: ChannelUnavailableReason): string {
  return channel === "email" ? EMAIL_ADAPTER_REASON_COPY[reason] : ADAPTER_REASON_COPY[reason];
}

/** The short reason label for a channel. */
export function adapterReasonShort(channel: MessageChannel, reason: ChannelUnavailableReason): string {
  return channel === "email" ? EMAIL_ADAPTER_REASON_SHORT[reason] : ADAPTER_REASON_SHORT[reason];
}

export const BLOCK_COPY: Record<MessageBlockCode, string> = {
  CONSENT_OPTED_OUT: "Opted out — this contact asked not to get messages this way. It can't be sent.",
  OD_TEXT_CONSENT_NO: "Open Dental says this patient does not accept texts.",
  OD_CONSENT_UNAVAILABLE: "Couldn't read text consent from Open Dental, so texting is blocked for now.",
  QUIET_HOURS: "Quiet hours — texts can't go out between 9 PM and 8 AM Central.",
};

/** The consent badge's words, or null when there is nothing to say. */
export function consentBadge(state: ConsentState, od: OdTextConsent): string | null {
  if (state === "opted_out") return "Opted out";
  if (od === "no") return "OD: no texts";
  if (od === "unavailable") return "OD consent unreadable";
  if (od === "unknown") return "No OD text consent on file";
  if (od === "not_linked") return "Not linked to Open Dental — no text consent on file";
  if (od === "yes") return "OD: texts OK";
  return null;
}

/** Codes from the send path that are not consent blocks. */
export const SEND_ERROR_COPY: Record<string, string> = {
  FEATURE_DISABLED: "Sending isn't available for this office right now. The draft is saved; nothing was sent.",
  MESSAGE_NOT_SENDABLE: "Only a draft can be sent.",
  ADDRESS_CHANGED: "The case's contact info changed after this draft was written. Discard it and draft again.",
  NO_ADDRESS: "This case has no usable address for that channel.",
  // item 40 (email)
  SUBJECT_REQUIRED: "An email needs a subject. Edit the draft and add one.",
  EMAIL_TEMPLATE_INVALID: "That template can only start an email, with the message box left empty.",
  EMAIL_TEMPLATE_NOT_FOUND: "That template isn't in this office's library any more.",
  MESSAGE_NOT_EDITABLE: "This draft can't be changed that way. Discard it and draft again.",
};
