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
 * The chip's words for one message. A `failed` row that Twilio had accepted
 * (it has a provider id) DID leave — the carrier then refused it — so it reads
 * "Not delivered", not "Not sent".
 */
export function statusLabel(m: Pick<TcMessage, "status" | "providerMessageId">): string {
  if (m.status === "failed" && m.providerMessageId) return "Not delivered";
  return STATUS_LABEL[m.status];
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
};
