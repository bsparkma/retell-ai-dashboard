/**
 * /api/tc/notification-prefs (queue item 51). Answers are parsed through the
 * shared contract, so a drifted server is a loud error rather than a silently
 * wrong alert level.
 */
import { tcRequest, TcApiError } from "@/features/tc/api";
import {
  TcNotificationPrefsResponse,
  type TcNotificationEvent,
  type TcNotificationLevel,
} from "@shared/tc/notifications";
import type { OfficeId } from "@shared/tc/contract";

function parse(raw: unknown): TcNotificationPrefsResponse {
  const parsed = TcNotificationPrefsResponse.safeParse(raw);
  if (!parsed.success) {
    throw new TcApiError("The alert preferences could not be read", 0, "CONTRACT_MISMATCH", null, []);
  }
  return parsed.data;
}

export async function getNotificationPrefs(office: OfficeId): Promise<TcNotificationPrefsResponse> {
  return parse(await tcRequest<unknown>("/tc/notification-prefs", { office }));
}

/** Set (or, with null, clear) MY override for one event. */
export async function setMyNotificationLevel(
  office: OfficeId,
  event: TcNotificationEvent,
  level: TcNotificationLevel | null,
): Promise<TcNotificationPrefsResponse> {
  return parse(
    await tcRequest<unknown>(`/tc/notification-prefs/mine/${event}`, { office, method: "PUT", body: { level } }),
  );
}

/** Set (or, with null, clear) the OFFICE default for one event. Admin only. */
export async function setOfficeNotificationLevel(
  office: OfficeId,
  event: TcNotificationEvent,
  level: TcNotificationLevel | null,
): Promise<TcNotificationPrefsResponse> {
  return parse(
    await tcRequest<unknown>(`/tc/notification-prefs/office/${event}`, { office, method: "PUT", body: { level } }),
  );
}
