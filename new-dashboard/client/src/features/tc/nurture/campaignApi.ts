/**
 * /api/tc/nurture client — nurture campaigns v1 (queue item 47). Responses are
 * PARSED with the shared contract, so a server shape drift is a loud error
 * here, not a blank outbox.
 *
 * There is no office in any request BODY: the server takes the office from the
 * case. The `office` argument is the `?office=` every TC call carries, which
 * the server treats as an assertion that can only refuse.
 *
 * Nothing here sends. Approving a HAND-WRITTEN draft is messagingApi.sendMessage
 * — the ordinary Send click on that one draft. (EL-2c) Approving a LIBRARY
 * campaign email is approveNurtureEmail: it marks the text approved and leaves
 * it waiting for its planned time. Nothing sends an approved email yet.
 */
import { z } from "zod";
import type { OfficeId } from "@shared/tc/contract";
import { TcMessage } from "@shared/tc/messaging";
import {
  NurtureApproveAllResponse,
  NurtureCampaignResponse,
  NurtureCaseResponse,
  NurtureConfigResponse,
  NurtureOutboxResponse,
  NurtureRescheduleBody,
  TcNurtureEnrollment,
  type NurtureLibraryVariant,
  type NurtureTrackKey,
} from "@shared/tc/nurture";
import { tcRequest } from "../api";

const EnrollmentResponse = z.object({ enrollment: TcNurtureEnrollment });
const MessageResponse = z.object({ message: TcMessage });

/** A case's enrollments and which tracks it can start right now. */
export async function getCaseNurture(office: OfficeId, caseId: string): Promise<NurtureCaseResponse> {
  const res = await tcRequest<unknown>("/tc/nurture/enrollments", { office, params: { case_id: caseId } });
  return NurtureCaseResponse.parse(res);
}

/** EL-2: start the track from the patient email library: this procedure, in this tone. */
export interface LibraryChoice {
  procedureId: string;
  variant: NurtureLibraryVariant;
}

export async function startNurture(
  office: OfficeId,
  caseId: string,
  trackKey: NurtureTrackKey,
  library: LibraryChoice | null = null,
): Promise<TcNurtureEnrollment> {
  const res = await tcRequest<unknown>("/tc/nurture/enrollments", {
    office,
    method: "POST",
    body: library
      ? { case_id: caseId, track_key: trackKey, procedure_id: library.procedureId, variant: library.variant }
      : { case_id: caseId, track_key: trackKey },
  });
  return EnrollmentResponse.parse(res).enrollment;
}

export async function pauseNurture(office: OfficeId, enrollmentId: string): Promise<TcNurtureEnrollment> {
  const res = await tcRequest<unknown>(`/tc/nurture/enrollments/${enrollmentId}/pause`, {
    office,
    method: "POST",
    body: {},
  });
  return EnrollmentResponse.parse(res).enrollment;
}

export async function resumeNurture(office: OfficeId, enrollmentId: string): Promise<TcNurtureEnrollment> {
  const res = await tcRequest<unknown>(`/tc/nurture/enrollments/${enrollmentId}/resume`, {
    office,
    method: "POST",
    body: {},
  });
  return EnrollmentResponse.parse(res).enrollment;
}

export async function stopNurture(office: OfficeId, enrollmentId: string, reason: string): Promise<TcNurtureEnrollment> {
  const res = await tcRequest<unknown>(`/tc/nurture/enrollments/${enrollmentId}/stop`, {
    office,
    method: "POST",
    body: { reason },
  });
  return EnrollmentResponse.parse(res).enrollment;
}

/** The office's nurture drafts, grouped by track, plus whether each channel can send. */
export async function getNurtureOutbox(office: OfficeId): Promise<NurtureOutboxResponse> {
  const res = await tcRequest<unknown>("/tc/nurture/outbox", { office });
  return NurtureOutboxResponse.parse(res);
}

/** A human chose not to send this draft. Nothing else moves. */
export async function skipNurtureDraft(office: OfficeId, messageId: string): Promise<TcMessage> {
  const res = await tcRequest<unknown>(`/tc/nurture/outbox/${messageId}/skip`, { office, method: "POST", body: {} });
  return MessageResponse.parse(res).message;
}

// ── EL-2c: approve up front (library campaigns). NONE of these sends. ──────

/** A library campaign's emails, in sequence order, for the Review campaign screen. */
export async function getNurtureCampaign(office: OfficeId, enrollmentId: string): Promise<NurtureCampaignResponse> {
  const res = await tcRequest<unknown>(`/tc/nurture/enrollments/${enrollmentId}/campaign`, { office });
  return NurtureCampaignResponse.parse(res);
}

const ApproveResponse = z.object({ message: TcMessage, replanned: z.number().int().min(0) });

/** Approve ONE email word for word: draft → approved, waiting for its planned time. Sends nothing. */
export async function approveNurtureEmail(
  office: OfficeId,
  messageId: string,
): Promise<{ message: TcMessage; replanned: number }> {
  const res = await tcRequest<unknown>(`/tc/nurture/messages/${messageId}/approve`, { office, method: "POST", body: {} });
  return ApproveResponse.parse(res);
}

/** Approved → draft again (so it can be edited, or sent by hand). */
export async function unapproveNurtureEmail(office: OfficeId, messageId: string): Promise<TcMessage> {
  const res = await tcRequest<unknown>(`/tc/nurture/messages/${messageId}/unapprove`, { office, method: "POST", body: {} });
  return MessageResponse.parse(res).message;
}

/** A new planned date and time, in OFFICE time ("2026-12-09", "11:30"). */
export async function rescheduleNurtureEmail(office: OfficeId, messageId: string, when: NurtureRescheduleBody): Promise<TcMessage> {
  const res = await tcRequest<unknown>(`/tc/nurture/messages/${messageId}/reschedule`, {
    office,
    method: "POST",
    body: NurtureRescheduleBody.parse(when),
  });
  return MessageResponse.parse(res).message;
}

/** Approve every remaining draft of one campaign, all or nothing. */
export async function approveAllNurtureEmails(office: OfficeId, enrollmentId: string): Promise<NurtureApproveAllResponse> {
  const res = await tcRequest<unknown>(`/tc/nurture/enrollments/${enrollmentId}/approve-all`, {
    office,
    method: "POST",
    body: {},
  });
  return NurtureApproveAllResponse.parse(res);
}

/** A person records that the patient replied: the campaign pauses; nothing is cancelled. */
export async function markPatientReplied(office: OfficeId, enrollmentId: string): Promise<TcNurtureEnrollment> {
  const res = await tcRequest<unknown>(`/tc/nurture/enrollments/${enrollmentId}/replied`, {
    office,
    method: "POST",
    body: {},
  });
  return EnrollmentResponse.parse(res).enrollment;
}

export async function getNurtureConfig(office: OfficeId): Promise<NurtureConfigResponse> {
  const res = await tcRequest<unknown>("/tc/nurture/config", { office });
  return NurtureConfigResponse.parse(res);
}
