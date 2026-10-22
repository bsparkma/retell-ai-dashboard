/**
 * /api/tc/email-identity (R5c). Answers are parsed through the shared
 * contract, so a drifted server is a loud error rather than a form that shows
 * values nobody saved.
 */
import { tcRequest, TcApiError } from "@/features/tc/api";
import {
  TcEmailIdentityResponse,
  type TcEmailIdentityRequest,
} from "@shared/tc/emailIdentity";
import type { OfficeId } from "@shared/tc/contract";

function parse(raw: unknown): TcEmailIdentityResponse {
  const parsed = TcEmailIdentityResponse.safeParse(raw);
  if (!parsed.success) {
    throw new TcApiError("The email identity could not be read", 0, "CONTRACT_MISMATCH", null, []);
  }
  return parsed.data;
}

export async function getEmailIdentity(office: OfficeId): Promise<TcEmailIdentityResponse> {
  return parse(await tcRequest<unknown>("/tc/email-identity", { office }));
}

/** Save the office's whole identity; null clears a field back to the app setting. */
export async function saveEmailIdentity(
  office: OfficeId,
  body: TcEmailIdentityRequest,
): Promise<TcEmailIdentityResponse> {
  return parse(await tcRequest<unknown>("/tc/email-identity", { office, method: "PUT", body }));
}
