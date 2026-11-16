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

/** AT-2: the server's answer to "may this item be charted?" — a named reason when not. */
export const ActivityChartable = z.object({
  eligible: z.boolean(),
  code: z.string().nullable(),
  reason: z.string().nullable(),
});
export type ActivityChartable = z.infer<typeof ActivityChartable>;

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
    // "tc" (AT-2): written from this feed with "Log to chart".
    via: z.enum(["voice", "referral", "hygiene", "tc"]).nullable(),
    commLogNum: z.number().optional(),
  }),
  completeness: z.enum(["full", "current_value_only"]),
  /**
   * AT-2: may "Log to chart" write this item? The server's rule
   * (routes/tc/activityChartable.js); the write route re-checks it. Optional
   * so an older server reads as "no button".
   */
  chartable: ActivityChartable.optional(),
});
export type TcActivityItem = z.infer<typeof TcActivityItem>;

/** AT-2: can this office take a TC chart note right now (writes on, type configured)? */
export const ActivityChartWrite = z.object({
  available: z.boolean(),
  code: z.string().nullable(),
  message: z.string().nullable(),
});
export type ActivityChartWrite = z.infer<typeof ActivityChartWrite>;

export const TcActivityPage = z.object({
  items: z.array(TcActivityItem),
  nextCursor: z.string().nullable(),
  chartWrite: ActivityChartWrite.optional(),
});
export type TcActivityPage = z.infer<typeof TcActivityPage>;

/** AT-2: GET …/activity/:itemId/chart — what the "Log to chart" dialog opens with. */
export const TcActivityChartPreview = z.object({
  itemId: z.string(),
  chartable: ActivityChartable,
  defaultText: z.string().nullable(),
  maxLength: z.number().int().positive(),
  office: z.object({ id: z.string(), name: z.string() }),
  commType: z.object({ name: z.string() }),
  hasPatient: z.boolean(),
  availability: ActivityChartWrite,
  onChart: z
    .object({ commLogNum: z.number(), writtenBy: z.string(), writtenAt: z.string().nullable() })
    .nullable(),
});
export type TcActivityChartPreview = z.infer<typeof TcActivityChartPreview>;

/** AT-2: POST …/activity/:itemId/chart → 201. */
export const TcActivityChartWritten = z.object({
  itemId: z.string(),
  commLogNum: z.number(),
  writtenAt: z.string(),
  chart: z.object({ onChart: z.literal(true), via: z.literal("tc"), commLogNum: z.number() }),
});
export type TcActivityChartWritten = z.infer<typeof TcActivityChartWritten>;

/**
 * The exact text a write will store, as the server composes it: the approved
 * text, plus "[Conversation date: MM/DD/YYYY]" on its own line only when a date
 * was given (routes/tc/activityChart.js finalNoteText). Pure.
 */
export function activityChartFinalText(text: string, conversationDate: string | null): string {
  if (!conversationDate) return text;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(conversationDate);
  return m ? `${text}\n[Conversation date: ${m[2]}/${m[3]}/${m[1]}]` : text;
}
