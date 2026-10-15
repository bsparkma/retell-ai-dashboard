/**
 * Referrals api (queue item 52, R1). One function per route in
 * backend/routes/tc/referrals.js; every answer is parsed through the shared
 * contract, so a server that drifted is a loud error here, not a quiet blank.
 */
import { z } from "zod";

import { tcRequest, TcApiError } from "@/features/tc/api";
import {
  TcReferralDirectoryEntry,
  TcReferralSettingsResponse,
  TcReferralsStatus,
  type TcReferralDirectoryInput,
} from "@shared/tc/referrals";
import type { OfficeId } from "@shared/tc/contract";

/** Parse, or throw the mismatch in words. */
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new TcApiError("The referrals answer could not be read", 0, "CONTRACT_MISMATCH", null, []);
  }
  return parsed.data;
}

const ListResponse = z.object({ success: z.literal(true), entries: z.array(TcReferralDirectoryEntry) });
const OneResponse = z.object({ success: z.literal(true), entry: TcReferralDirectoryEntry });

/** Is referrals switched on for this office? Never refused by the server. */
export async function getReferralsStatus(office: OfficeId): Promise<TcReferralsStatus> {
  return parse(TcReferralsStatus, await tcRequest<unknown>("/tc/referrals/status", { office }));
}

export async function listDirectory(office: OfficeId, includeInactive: boolean): Promise<TcReferralDirectoryEntry[]> {
  const res = parse(
    ListResponse,
    await tcRequest<unknown>("/tc/referrals/directory", {
      office,
      params: includeInactive ? { includeInactive: "true" } : {},
    }),
  );
  return res.entries;
}

export async function createDirectoryEntry(
  office: OfficeId,
  input: TcReferralDirectoryInput,
): Promise<TcReferralDirectoryEntry> {
  const res = parse(
    OneResponse,
    await tcRequest<unknown>("/tc/referrals/directory", { office, method: "POST", body: input }),
  );
  return res.entry;
}

export async function updateDirectoryEntry(
  office: OfficeId,
  entryId: string,
  input: TcReferralDirectoryInput,
): Promise<TcReferralDirectoryEntry> {
  const res = parse(
    OneResponse,
    await tcRequest<unknown>(`/tc/referrals/directory/${entryId}`, { office, method: "PUT", body: input }),
  );
  return res.entry;
}

export async function deleteDirectoryEntry(office: OfficeId, entryId: string): Promise<void> {
  await tcRequest<unknown>(`/tc/referrals/directory/${entryId}`, { office, method: "DELETE" });
}

export async function getReferralSettings(office: OfficeId): Promise<TcReferralSettingsResponse> {
  return parse(TcReferralSettingsResponse, await tcRequest<unknown>("/tc/referrals/settings", { office }));
}

export async function updateReferralSettings(
  office: OfficeId,
  change: { signoffRequired?: boolean; autosendOnApproval?: boolean },
): Promise<TcReferralSettingsResponse> {
  return parse(
    TcReferralSettingsResponse,
    await tcRequest<unknown>("/tc/referrals/settings", { office, method: "PUT", body: change }),
  );
}
