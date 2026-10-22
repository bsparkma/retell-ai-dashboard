/**
 * Referrals api (queue item 52, R1). One function per route in
 * backend/routes/tc/referrals.js; every answer is parsed through the shared
 * contract, so a server that drifted is a loud error here, not a quiet blank.
 */
import { z } from "zod";

import { tcFetchObjectUrl, tcRequest, tcUpload, TcApiError } from "@/features/tc/api";
import {
  TcReferralDirectoryEntry,
  TcReferralSettingsResponse,
  TcReferralsStatus,
  TcReferral,
  TcReferralSignoffSummary,
  TcReferralAttachment,
  TcReferralSendOutcome,
  type TcReferralDirectoryInput,
  type TcReferralDoctorEdit,
  type TcReferralFieldsEdit,
  type TcReferralHubQuery,
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

// ── R6 (item 56): the hub, edits, return, the manual marks ──────────────────

/** Every referral for the office (tc.full), narrowed by the hub's filters. Audited. */
export async function listHub(office: OfficeId, filter: TcReferralHubQuery = {}): Promise<TcReferral[]> {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== "") params[k] = String(v);
  return parse(ReferralListResponse, await tcRequest<unknown>("/tc/referrals/hub", { office, params })).referrals;
}

/** Staff field edit — a draft or one awaiting sign-off. */
export async function editReferralFields(
  office: OfficeId,
  referralId: string,
  fields: TcReferralFieldsEdit,
): Promise<TcReferral> {
  return parse(
    ReferralResponse,
    await tcRequest<unknown>(`/tc/referrals/${referralId}/fields`, { office, method: "PATCH", body: fields }),
  ).referral;
}

/** Approved → back to sign-off, with the edit in the same step. */
export async function reopenReferral(
  office: OfficeId,
  referralId: string,
  fields?: TcReferralFieldsEdit,
): Promise<TcReferral> {
  return parse(
    ReferralResponse,
    await tcRequest<unknown>(`/tc/referrals/${referralId}/reopen`, {
      office,
      method: "POST",
      body: fields ? { fields } : {},
    }),
  ).referral;
}

/** The marks: a person's record of what happened OUTSIDE the app. They send nothing. */
export type ReferralMark = "mark_sent" | "mark_acknowledged" | "mark_patient_seen" | "close";
const MARK_PATHS: Record<ReferralMark, string> = {
  mark_sent: "mark-sent",
  mark_acknowledged: "mark-acknowledged",
  mark_patient_seen: "mark-patient-seen",
  close: "close",
};

export async function markReferral(
  office: OfficeId,
  referralId: string,
  mark: ReferralMark,
  text: string,
): Promise<TcReferral> {
  const body = mark === "mark_sent" ? { how: text } : text.trim() ? { note: text } : {};
  return parse(
    ReferralResponse,
    await tcRequest<unknown>(`/tc/referrals/${referralId}/${MARK_PATHS[mark]}`, { office, method: "POST", body }),
  ).referral;
}

// ── R5: email it to the specialist ──────────────────────────────────────────

const SendResponse = z.object({ success: z.literal(true), referral: TcReferral, outcome: TcReferralSendOutcome });

/**
 * Email an approved referral to its specialist. No body: the server derives
 * the office, the recipient and the letter. Resolves only once ACS accepted it
 * and the referral reads `sent`; anything else throws with the server's
 * sentence (a 409 REFERRAL_EMAIL_CONFLICT says the email went out anyway).
 */
export async function sendReferralEmail(
  office: OfficeId,
  referralId: string,
): Promise<{ referral: TcReferral; outcome: TcReferralSendOutcome }> {
  const res = parse(
    SendResponse,
    await tcRequest<unknown>(`/tc/referrals/${referralId}/send-email`, { office, method: "POST", body: {} }),
  );
  return { referral: res.referral, outcome: res.outcome };
}

/** The doctor's view of the office's active specialists (the directory itself is tc.full). */
export async function listSignoffDirectory(office: OfficeId): Promise<TcReferralDirectoryEntry[]> {
  return parse(ListResponse, await tcRequest<unknown>("/tc/referrals/signoff/directory", { office })).entries;
}

/** The doctor edits at sign-off. */
export async function doctorEditReferral(
  office: OfficeId,
  referralId: string,
  fields: TcReferralDoctorEdit,
): Promise<TcReferral> {
  return parse(
    ReferralResponse,
    await tcRequest<unknown>(`/tc/referrals/signoff/${referralId}/fields`, { office, method: "PATCH", body: fields }),
  ).referral;
}

/** Send it back to the submitter with a question (required). */
export async function returnReferral(office: OfficeId, referralId: string, comment: string): Promise<TcReferral> {
  return parse(
    ReferralResponse,
    await tcRequest<unknown>(`/tc/referrals/signoff/${referralId}/return`, {
      office,
      method: "POST",
      body: { comment },
    }),
  ).referral;
}

// ── R4 (item 55): attachments ───────────────────────────────────────────────

const AttachmentResponse = z.object({ success: z.literal(true), attachment: TcReferralAttachment });
const AttachmentListResponse = z.object({ success: z.literal(true), attachments: z.array(TcReferralAttachment) });

/** One file onto a referral (TC side). The server decides the type from the bytes. */
export async function uploadReferralAttachment(
  office: OfficeId,
  referralId: string,
  file: File,
): Promise<TcReferralAttachment> {
  return parse(AttachmentResponse, await tcUpload<unknown>(`/tc/referrals/${referralId}/attachments`, office, file))
    .attachment;
}

/** A referral's files. `signoff` reads them through the doctor's route. */
export async function listReferralAttachments(
  office: OfficeId,
  referralId: string,
  signoff = false,
): Promise<TcReferralAttachment[]> {
  const base = signoff ? "/tc/referrals/signoff" : "/tc/referrals";
  return parse(AttachmentListResponse, await tcRequest<unknown>(`${base}/${referralId}/attachments`, { office }))
    .attachments;
}

/** Open one file (an audited view on the server) as an object URL. */
export async function openReferralAttachment(
  office: OfficeId,
  referralId: string,
  attachmentId: string,
  signoff = false,
): Promise<string> {
  const base = signoff ? "/tc/referrals/signoff" : "/tc/referrals";
  return tcFetchObjectUrl(`${base}/${referralId}/attachments/${attachmentId}`, office);
}
