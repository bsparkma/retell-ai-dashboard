/**
 * Every sentence the nurture-campaign UI shows (queue item 47). Each map is a
 * Record over a CLOSED contract enum, so a new reason, hint or status in
 * shared/tc/nurture.ts without a sentence here is a compile error.
 */
import { MessageBlockCode, type MessageSkipReason, type MessageStatus, type TcMessage } from "@shared/tc/messaging";
import {
  NURTURE_SEND_WINDOW,
  type NurtureConsentHint,
  type NurtureEnrollmentStatus,
  type NurtureIntensity,
  type NurtureLibraryVariant,
  type NurtureTrackUnavailableReason,
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

// ── Change date: what the person picked, before they save ──────────────────

const WEEKDAY_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** 600 → "10:00 AM". Minutes after local midnight. */
function minuteWords(minute: number): string {
  const h = Math.floor(minute / 60);
  const mm = String(minute % 60).padStart(2, "0");
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

/** ISO weekday (1 = Mon … 7 = Sun) → its name. */
function isoWeekdayName(iso: number): string {
  return WEEKDAY_NAME[iso % 7];
}

/**
 * "Monday to Friday, 9:00 AM to 4:00 PM office time", read off the SAME
 * constants the server's window check uses (shared/tc/nurture.ts), so the
 * numbers live in one place.
 */
export function sendWindowWords(): string {
  const days = NURTURE_SEND_WINDOW.weekdays;
  return `${isoWeekdayName(days[0])} to ${isoWeekdayName(days[days.length - 1])}, ${minuteWords(
    NURTURE_SEND_WINDOW.startMinute,
  )} to ${minuteWords(NURTURE_SEND_WINDOW.endMinute)} office time`;
}

/** A calendar day, with no time zone in it: 'YYYY-MM-DD' parsed as UTC noon. */
function calendarDay(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? d : null;
}

function dayWords(d: Date): string {
  return `${WEEKDAY_NAME[d.getUTCDay()]}, ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** ISO weekday (1 = Mon … 7 = Sun) of a calendar day. */
function isoWeekday(d: Date): number {
  return d.getUTCDay() === 0 ? 7 : d.getUTCDay();
}

function sendDay(d: Date): boolean {
  return (NURTURE_SEND_WINDOW.weekdays as readonly number[]).includes(isoWeekday(d));
}

export interface PickedTimeCheck {
  /** "Sunday, Nov 29, 10:00 AM" — the pick in words, office time. Null when the inputs are incomplete. */
  words: string | null;
  /** True when the pick is inside the send window (the server still decides order, caps and "not in the past"). */
  inWindow: boolean;
  /** The inline line when it isn't: the window in words and the next allowed time. */
  problem: string | null;
}

/**
 * What a Change date pick means, before it is saved. PURE: the date and time
 * are already OFFICE time (the inputs are labelled so), so this is calendar
 * arithmetic with no time zone and no clock. It checks only the send window;
 * the server stays authoritative and still refuses out-of-order, over-cap and
 * past times, which the form shows inline.
 *
 * The next allowed time follows the server's rule for a window move: before
 * the window on a send day → that day at the window's start; after it, or on
 * a day with no sending → the next send day at the window's start.
 */
export function checkPickedTime(date: string, time: string): PickedTimeCheck {
  const day = calendarDay(date);
  const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!day || !t) return { words: null, inWindow: false, problem: null };
  const minute = Number(t[1]) * 60 + Number(t[2]);
  const words = `${dayWords(day)}, ${minuteWords(minute)}`;
  const { startMinute, endMinute } = NURTURE_SEND_WINDOW;
  if (sendDay(day) && minute >= startMinute && minute <= endMinute) return { words, inWindow: true, problem: null };

  let next = day;
  if (!sendDay(day) || minute > endMinute) {
    next = new Date(day.getTime() + 86_400_000);
    while (!sendDay(next)) next = new Date(next.getTime() + 86_400_000);
  }
  return {
    words,
    inWindow: false,
    problem: `Emails go out ${sendWindowWords()}. The next allowed time is ${dayWords(next)}, ${minuteWords(startMinute)}.`,
  };
}
