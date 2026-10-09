/**
 * Every sentence the Messages tab shows for a status, a block, or a consent
 * fact. Each map is a Record over a CLOSED contract enum, so a new value in
 * shared/tc/messaging.ts that has no sentence here is a compile error, not a
 * silent "something went wrong".
 */
import type {
  ConsentState,
  MessageBlockCode,
  MessageChannel,
  MessageStatus,
  OdTextConsent,
} from "@shared/tc/messaging";

export const CHANNEL_LABEL: Record<MessageChannel, string> = {
  sms: "Text",
  email: "Email",
};

export const STATUS_LABEL: Record<MessageStatus, string> = {
  draft: "Draft — not sent",
  queued: "Accepted by provider",
  sending: "Sending…",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Not sent",
  received: "Received",
};

/** Tone for the status chip. */
export const STATUS_TONE: Record<MessageStatus, "muted" | "info" | "ok" | "bad"> = {
  draft: "muted",
  queued: "info",
  sending: "info",
  sent: "ok",
  delivered: "ok",
  failed: "bad",
  received: "info",
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
  FEATURE_DISABLED: "Sending isn't connected yet. The draft is saved; nothing was sent.",
  MESSAGE_NOT_SENDABLE: "Only a draft can be sent.",
  ADDRESS_CHANGED: "The case's contact info changed after this draft was written. Discard it and draft again.",
  NO_ADDRESS: "This case has no usable address for that channel.",
};
