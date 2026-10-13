/**
 * Every sentence the nurture-campaign UI shows (queue item 47). Each map is a
 * Record over a CLOSED contract enum, so a new reason, hint or status in
 * shared/tc/nurture.ts without a sentence here is a compile error.
 */
import { MessageBlockCode } from "@shared/tc/messaging";
import type {
  NurtureConsentHint,
  NurtureEnrollmentStatus,
  NurtureIntensity,
  NurtureTrackUnavailableReason,
} from "@shared/tc/nurture";
import { TcApiError, tcErrorMessage } from "../api";
import { BLOCK_COPY, SEND_ERROR_COPY } from "../messaging/copy";

export const INTENSITY_LABEL: Record<NurtureIntensity, string> = {
  gentle: "Gentle",
  standard: "Standard",
  assertive: "Assertive",
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

/** "Oct 14" — a due date, in the viewer's zone. */
export function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
