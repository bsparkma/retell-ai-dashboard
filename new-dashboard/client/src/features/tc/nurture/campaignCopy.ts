/**
 * Every sentence the nurture-campaign UI shows (queue item 47). Each map is a
 * Record over a CLOSED contract enum, so a new reason, hint or status in
 * shared/tc/nurture.ts without a sentence here is a compile error.
 */
import { MessageBlockCode, type MessageSkipReason, type MessageStatus, type TcMessage } from "@shared/tc/messaging";
import type {
  NurtureConsentHint,
  NurtureEnrollmentStatus,
  NurtureIntensity,
  NurtureLibraryVariant,
  NurtureTrackUnavailableReason,
} from "@shared/tc/nurture";
import { TcApiError, tcErrorMessage } from "../api";
import { BLOCK_COPY, SEND_ERROR_COPY } from "../messaging/copy";

export const INTENSITY_LABEL: Record<NurtureIntensity, string> = {
  gentle: "Gentle",
  standard: "Standard",
  assertive: "Assertive",
};

/** EL-2: the library tone, as the picker offers it and the strip / outbox show it. */
export const LIBRARY_TONE_LABEL: Record<NurtureLibraryVariant, string> = {
  A: "Warm",
  B: "Direct",
  C: "Educational",
};

export const UNAVAILABLE_COPY: Record<NurtureTrackUnavailableReason, string> = {
  switched_off: "Nurture campaigns are switched off for this office.",
  case_terminal: "This case is no longer open TC work.",
  already_enrolled: "This case already has a campaign running or paused.",
  no_address: "This case has no phone or email this campaign can use.",
};

/** The outbox's advisory badge. Advisory: Send still makes the real decision. */
export const HINT_COPY: Record<NurtureConsentHint, string> = {
  opted_out: "Opted out — Send will refuse this",
  email_unsubscribed: "Unsubscribed from nurture email — Send will refuse this",
  no_address: "No usable address on the case — can't be sent",
};

export const ENROLLMENT_STATUS_LABEL: Record<NurtureEnrollmentStatus, string> = {
  active: "Running",
  paused: "Paused",
  completed: "Completed",
  stopped: "Stopped",
};

/** Codes the nurture routes return, in words. */
const NURTURE_ERROR_COPY: Record<string, string> = {
  OFFICE_MISMATCH: "That case belongs to the other office. Switch offices to work on it.",
  CASE_TERMINAL: "This case is no longer open TC work, so it can't be in a campaign.",
  ALREADY_ENROLLED: "This case already has a campaign running or paused.",
  NO_ADDRESS: "This case has no phone or email this campaign can use.",
  ENROLLMENT_NOT_IN_STATE: "That campaign changed in the meantime. Refresh and try again.",
  FEATURE_DISABLED: "Nurture campaigns are switched off for this office.",
};

export function nurtureErrorText(e: unknown): string {
  if (e instanceof TcApiError && e.code && NURTURE_ERROR_COPY[e.code]) return NURTURE_ERROR_COPY[e.code];
  return tcErrorMessage(e);
}

/** A failed Approve (= Send) in words — consent blocks first, then the send path's codes. */
export function approveErrorText(e: unknown): string {
  if (e instanceof TcApiError && e.code) {
    const block = MessageBlockCode.safeParse(e.code);
    if (block.success) return BLOCK_COPY[block.data];
    const known = SEND_ERROR_COPY[e.code];
    if (known) return known;
  }
  return tcErrorMessage(e);
}

// ── EL-2c: approve up front ─────────────────────────────────────────────────

/** The office's zone: planned send times are office time, whoever is looking. */
export const OFFICE_TIME_ZONE = "America/Chicago";

/** Why an email was skipped, after "Skipped: ". A Record over the closed enum. */
export const SKIP_REASON_LABEL: Record<MessageSkipReason, string> = {
  manual: "by a person",
  case_terminal: "the case closed",
  opted_out: "the patient opted out",
  stopped_by_user: "the campaign was stopped",
};

/** The Review campaign chip's tone, per message status (closed: a new status is a compile error). */
export const REVIEW_CHIP_TONE: Record<MessageStatus, "attention" | "approved" | "done" | "muted" | "bad"> = {
  draft: "attention",
  scheduled: "approved",
  queued: "done",
  sending: "done",
  sent: "done",
  delivered: "done",
  failed: "bad",
  received: "muted",
  skipped: "muted",
};

/** "Tue, Dec 1 · 10:00 AM" in office time. */
export function plannedLabel(iso: string | null): string {
  if (!iso) return "Not planned yet";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: OFFICE_TIME_ZONE });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: OFFICE_TIME_ZONE });
  return `${day} · ${time}`;
}

/** "Dec 1" in office time. */
export function officeShortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: OFFICE_TIME_ZONE });
}

/** The words on a Review campaign chip. */
export function reviewChipText(m: Pick<TcMessage, "status" | "scheduledFor" | "skipReason">): string {
  switch (m.status) {
    case "draft":
      return "Needs approval";
    case "scheduled":
      return `Approved, sends ${officeShortDate(m.scheduledFor)}`;
    case "skipped":
      return m.skipReason ? `Skipped: ${SKIP_REASON_LABEL[m.skipReason]}` : "Skipped";
    case "failed":
      return "Not sent";
    case "sending":
      return "Sending…";
    case "queued":
    case "sent":
    case "delivered":
      return "Sent";
    case "received":
      return "Received";
  }
}

/** 'YYYY-MM-DD' and 'HH:MM' of an instant, in office time (for the Change date inputs). */
export function officeDateTimeParts(iso: string | null): { date: string; time: string } {
  const d = iso ? new Date(iso) : new Date();
  const date = d.toLocaleDateString("en-CA", { timeZone: OFFICE_TIME_ZONE });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: OFFICE_TIME_ZONE });
  return { date, time };
}

/** "Oct 14" — a due date, in the viewer's zone. */
export function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
