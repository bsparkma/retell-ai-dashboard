/**
 * /api/tc/messages client (queue item 38). Responses are PARSED with the shared
 * contract, so a server shape drift is a loud error here, not a blank thread.
 *
 * There is no `toAddress` anywhere in these request types: the server
 * assembles the address from the case row.
 */
import { z } from "zod";
import type { OfficeId } from "@shared/tc/contract";
import {
  ChannelReadiness,
  TcContactConsent,
  TcMessage,
  type DraftMessageBody,
  type EditDraftBody,
  type MessageChannel,
} from "@shared/tc/messaging";
import { tcRequest } from "../api";

const MessagesResponse = z.object({ messages: z.array(TcMessage) });
const MessageResponse = z.object({ message: TcMessage });
const ReadinessResponse = z.object({ channels: z.array(ChannelReadiness) });
const ConsentResponse = z.object({ consent: TcContactConsent });

export async function listCaseMessages(office: OfficeId, caseId: string): Promise<TcMessage[]> {
  const res = await tcRequest<unknown>("/tc/messages", { office, params: { caseId } });
  return MessagesResponse.parse(res).messages;
}

export async function listInbox(office: OfficeId): Promise<TcMessage[]> {
  const res = await tcRequest<unknown>("/tc/messages/inbox", { office });
  return MessagesResponse.parse(res).messages;
}

export async function getChannelReadiness(office: OfficeId, caseId: string): Promise<ChannelReadiness[]> {
  const res = await tcRequest<unknown>("/tc/messages/consent", { office, params: { caseId } });
  return ReadinessResponse.parse(res).channels;
}

export async function createDraft(office: OfficeId, body: DraftMessageBody): Promise<TcMessage> {
  const res = await tcRequest<unknown>("/tc/messages/draft", { office, method: "POST", body });
  return MessageResponse.parse(res).message;
}

export async function editDraft(office: OfficeId, messageId: string, body: EditDraftBody): Promise<TcMessage> {
  const res = await tcRequest<unknown>(`/tc/messages/${messageId}`, { office, method: "PUT", body });
  return MessageResponse.parse(res).message;
}

/** THE approval click. Sends exactly this one stored draft. */
export async function sendMessage(office: OfficeId, messageId: string): Promise<TcMessage> {
  const res = await tcRequest<unknown>(`/tc/messages/${messageId}/send`, { office, method: "POST", body: {} });
  return MessageResponse.parse(res).message;
}

export async function discardDraft(office: OfficeId, messageId: string): Promise<void> {
  await tcRequest<unknown>(`/tc/messages/${messageId}/discard`, { office, method: "POST", body: {} });
}

export async function recordOptOut(
  office: OfficeId,
  caseId: string,
  channel: MessageChannel,
  note?: string,
): Promise<TcContactConsent> {
  const res = await tcRequest<unknown>("/tc/messages/consent", {
    office,
    method: "POST",
    body: { caseId, channel, ...(note ? { note } : {}) },
  });
  return ConsentResponse.parse(res).consent;
}

// ── Item 39: the "new texts" count and the seen marker ─────────────────────

const UnseenCountResponse = z.object({ count: z.number().int().nonnegative(), capped: z.boolean() });
const MarkedResponse = z.object({ marked: z.number().int().nonnegative() });

/** How many received texts nobody has opened yet in this office (a count, no content). */
export async function getUnseenCount(office: OfficeId): Promise<{ count: number; capped: boolean }> {
  const res = await tcRequest<unknown>("/tc/messages/unseen-count", { office });
  return UnseenCountResponse.parse(res);
}

/** Unseen received texts that matched a case, newest first. */
export async function listUnseenOnCases(office: OfficeId): Promise<TcMessage[]> {
  const res = await tcRequest<unknown>("/tc/messages/unseen", { office });
  return MessagesResponse.parse(res).messages;
}

/** Mark a case's received texts seen — or, with null, every unlinked inbox text. */
export async function markSeen(office: OfficeId, caseId: string | null): Promise<number> {
  const res = await tcRequest<unknown>("/tc/messages/seen", { office, method: "POST", body: { caseId } });
  return MarkedResponse.parse(res).marked;
}

/**
 * The nav badge's number across every office in scope. Any office failing
 * makes the whole answer unknown (a throw) rather than a silently low count.
 */
export async function getUnseenTotal(offices: readonly OfficeId[]): Promise<{ count: number; capped: boolean }> {
  const parts = await Promise.all(offices.map((o) => getUnseenCount(o)));
  return {
    count: parts.reduce((n, p) => n + p.count, 0),
    capped: parts.some((p) => p.capped),
  };
}
