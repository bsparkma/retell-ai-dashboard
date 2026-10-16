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
  TcReferral,
  TcReferralSignoffSummary,
  type TcReferralDirectoryInput,
  type TcReferralInput,
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

// ── R2 (item 53): referrals and the sign-off queue ──────────────────────────

const ReferralResponse = z.object({ success: z.literal(true), referral: TcReferral });
const ReferralListResponse = z.object({ success: z.literal(true), referrals: z.array(TcReferral) });

/** A case's referrals, or a checkout's. Newest first. */
export async function listReferrals(
  office: OfficeId,
  filter: { caseId: string } | { handoffId: string } | { callId: string },
): Promise<TcReferral[]> {
  const res = parse(ReferralListResponse, await tcRequest<unknown>("/tc/referrals", { office, params: filter }));
  return res.referrals;
}

/** Start a referral FROM a case or a checkout; the server derives the patient. */
export async function createReferral(
  office: OfficeId,
  source: { caseId: string } | { handoffId: string },
  referral: TcReferralInput,
): Promise<TcReferral> {
  const res = parse(
    ReferralResponse,
    await tcRequest<unknown>("/tc/referrals", { office, method: "POST", body: { source, referral } }),
  );
  return res.referral;
}

export async function getReferral(office: OfficeId, referralId: string): Promise<TcReferral> {
  return parse(ReferralResponse, await tcRequest<unknown>(`/tc/referrals/${referralId}`, { office })).referral;
}

export async function updateReferral(office: OfficeId, referralId: string, referral: TcReferralInput): Promise<TcReferral> {
  return parse(
    ReferralResponse,
    await tcRequest<unknown>(`/tc/referrals/${referralId}`, { office, method: "PUT", body: referral }),
  ).referral;
}

/** submit / withdraw / cancel — the TC side's verbs. */
export async function referralVerb(
  office: OfficeId,
  referralId: string,
  verb: "submit" | "withdraw" | "cancel",
): Promise<TcReferral> {
  return parse(
    ReferralResponse,
    await tcRequest<unknown>(`/tc/referrals/${referralId}/${verb}`, { office, method: "POST", body: {} }),
  ).referral;
}

// The doctor's side (tc.referral_signoff).

export async function getSignoffSummary(office: OfficeId): Promise<TcReferralSignoffSummary> {
  return parse(TcReferralSignoffSummary, await tcRequest<unknown>("/tc/referrals/signoff/summary", { office }));
}

export async function listSignoffQueue(office: OfficeId): Promise<TcReferral[]> {
  return parse(ReferralListResponse, await tcRequest<unknown>("/tc/referrals/signoff/queue", { office })).referrals;
}

export async function getSignoffReferral(office: OfficeId, referralId: string): Promise<TcReferral> {
  return parse(ReferralResponse, await tcRequest<unknown>(`/tc/referrals/signoff/${referralId}`, { office })).referral;
}

export async function approveReferral(office: OfficeId, referralId: string): Promise<TcReferral> {
  return parse(
    ReferralResponse,
    await tcRequest<unknown>(`/tc/referrals/signoff/${referralId}/approve`, { office, method: "POST", body: {} }),
  ).referral;
}

export async function declineReferral(office: OfficeId, referralId: string, reason: string): Promise<TcReferral> {
  return parse(
    ReferralResponse,
    await tcRequest<unknown>(`/tc/referrals/signoff/${referralId}/decline`, {
      office,
      method: "POST",
      body: { reason },
    }),
  ).referral;
}
