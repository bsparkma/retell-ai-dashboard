/**
 * In-app notification preferences for TC (queue item 51).
 *
 * Two events today, three levels. The effective level for one person in one
 * office is: their own override ?? the office default ?? `banner`.
 *
 * IN-APP ONLY: a badge, a toast, and optionally a short chime from the open
 * tab. No web push, no service worker, nothing that leaves the browser.
 *
 * The DB CHECKs in 1791600000000_tc_notification_prefs.js carry the same
 * literals; test/notificationPrefsMigration.test.js pins them equal.
 */
import { z } from "zod";

export const TcNotificationEvent = z.enum(["checkout_handoff", "referral_signoff"]);
export type TcNotificationEvent = z.infer<typeof TcNotificationEvent>;

export const TC_NOTIFICATION_EVENT_LABELS: Record<TcNotificationEvent, string> = {
  checkout_handoff: "A patient is headed to checkout",
  referral_signoff: "A referral is waiting for the doctor's sign-off",
};

export const TcNotificationLevel = z.enum(["silent", "banner", "sound_banner"]);
export type TcNotificationLevel = z.infer<typeof TcNotificationLevel>;

export const TC_NOTIFICATION_LEVEL_LABELS: Record<TcNotificationLevel, string> = {
  silent: "Badge only",
  banner: "Banner",
  sound_banner: "Sound + banner",
};

/** The built-in default when neither the person nor the office has chosen. */
export const DEFAULT_NOTIFICATION_LEVEL: TcNotificationLevel = "banner";

/** Where an effective level came from. */
export const TcNotificationSource = z.enum(["user", "office", "default"]);
export type TcNotificationSource = z.infer<typeof TcNotificationSource>;

/** The resolution rule, as one pure function both ends use. */
export function resolveNotificationLevel(
  mine: TcNotificationLevel | null,
  officeDefault: TcNotificationLevel | null,
): { level: TcNotificationLevel; source: TcNotificationSource } {
  if (mine) return { level: mine, source: "user" };
  if (officeDefault) return { level: officeDefault, source: "office" };
  return { level: DEFAULT_NOTIFICATION_LEVEL, source: "default" };
}

/** One event's row in GET /api/tc/notification-prefs. */
export const TcNotificationPrefRow = z.object({
  event: TcNotificationEvent,
  level: TcNotificationLevel,
  source: TcNotificationSource,
  mine: TcNotificationLevel.nullable(),
  officeDefault: TcNotificationLevel.nullable(),
});
export type TcNotificationPrefRow = z.infer<typeof TcNotificationPrefRow>;

export const TcNotificationPrefsResponse = z.object({
  success: z.literal(true),
  office: z.enum(["roland", "valley"]),
  /** Whether the caller may change the office default (admin). */
  canEditOffice: z.boolean(),
  events: z.array(TcNotificationPrefRow),
});
export type TcNotificationPrefsResponse = z.infer<typeof TcNotificationPrefsResponse>;

/** PUT /mine/:event — null clears the override (back to the office default). */
export const TcNotificationMineRequest = z.object({ level: TcNotificationLevel.nullable() }).strict();
/** PUT /office/:event — null clears the office default (back to `banner`). */
export const TcNotificationOfficeRequest = z.object({ level: TcNotificationLevel.nullable() }).strict();
