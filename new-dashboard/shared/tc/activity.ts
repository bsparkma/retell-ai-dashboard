/**
 * AT-1: the wire shape of GET /api/tc/cases/:caseId/activity — one merged,
 * keyset-paged feed of every note / communication source for a case.
 *
 * The server builds every field (including `title`); the client only renders.
 * `completeness: "current_value_only"` marks a source that is overwritten in
 * place (the notes box, a pre-auth record, a consent row): it is what the
 * record says NOW, never a history, and the UI must say so.
 *
 * Not part of the bundled TC contract (backend/tc/contract.gen.cjs): the
 * backend builds these items itself and the client validates them here.
 */
import { z } from "zod";

export const ActivitySource = z.enum([
  "case_event",
  "case_notes",
  "objection",
  "followup",
  "hygiene_intake",
  "checkout",
  "message",
  "email_log",
  "referral_event",
  "preauth",
  "voice_call",
  "consent",
]);
export type ActivitySource = z.infer<typeof ActivitySource>;

export const ActivityAudience = z.enum(["internal", "patient_facing", "external"]);
export type ActivityAudience = z.infer<typeof ActivityAudience>;

export const ActivityScope = z.enum(["case", "patient"]);
export type ActivityScope = z.infer<typeof ActivityScope>;

export const TcActivityItem = z.object({
  id: z.string().min(3),
  source: ActivitySource,
  kind: z.string().min(1),
  at: z.string().min(1),
  actor: z.object({
    display: z.string(),
    email: z.string().nullable(),
    system: z.boolean(),
  }),
  audience: ActivityAudience,
  direction: z.enum(["inbound", "outbound"]).optional(),
  title: z.string(),
  body: z.string().nullable(),
  scope: ActivityScope,
  links: z.object({
    referralId: z.string().optional(),
    messageId: z.string().optional(),
    callId: z.string().optional(),
    handoffId: z.string().optional(),
    preauthId: z.string().optional(),
  }),
  chart: z.object({
    onChart: z.boolean(),
    via: z.enum(["voice", "referral", "hygiene"]).nullable(),
    commLogNum: z.number().optional(),
  }),
  completeness: z.enum(["full", "current_value_only"]),
});
export type TcActivityItem = z.infer<typeof TcActivityItem>;

export const TcActivityPage = z.object({
  items: z.array(TcActivityItem),
  nextCursor: z.string().nullable(),
});
export type TcActivityPage = z.infer<typeof TcActivityPage>;
