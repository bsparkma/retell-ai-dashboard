/**
 * /api/tc/nurture client — nurture campaigns v1 (queue item 47). Responses are
 * PARSED with the shared contract, so a server shape drift is a loud error
 * here, not a blank outbox.
 *
 * There is no office in any request BODY: the server takes the office from the
 * case. The `office` argument is the `?office=` every TC call carries, which
 * the server treats as an assertion that can only refuse.
 *
 * Nothing here sends. Approving a draft is messagingApi.sendMessage — the
 * ordinary Send click on that one draft.
 */
import { z } from "zod";
import type { OfficeId } from "@shared/tc/contract";
import { TcMessage } from "@shared/tc/messaging";
import {
  NurtureCaseResponse,
  NurtureConfigResponse,
  NurtureOutboxResponse,
  TcNurtureEnrollment,
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

export async function startNurture(
  office: OfficeId,
  caseId: string,
  trackKey: NurtureTrackKey,
): Promise<TcNurtureEnrollment> {
  const res = await tcRequest<unknown>("/tc/nurture/enrollments", {
    office,
    method: "POST",
    body: { case_id: caseId, track_key: trackKey },
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

export async function getNurtureConfig(office: OfficeId): Promise<NurtureConfigResponse> {
  const res = await tcRequest<unknown>("/tc/nurture/config", { office });
  return NurtureConfigResponse.parse(res);
}
