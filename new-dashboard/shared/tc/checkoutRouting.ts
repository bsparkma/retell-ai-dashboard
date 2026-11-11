/**
 * CO-6 — "Route to…" from a checkout card, and CO-7 — the ask-hygiene thread.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * CO-6: FOUR DESTINATIONS, NO NEW VOCABULARY
 * ═════════════════════════════════════════════════════════════════════════════
 * `POST /api/tc/checkout/:id/route` sends the card's patient somewhere else in
 * TC. The body names only WHERE and the person's own words; the office is the
 * request's (`?office=`), and the patient, PatNum, name and doctor are the
 * STORED card's — never the request's.
 *
 *   preauth   a pre-authorization for this patient (the existing pre-auth
 *             create path), prefilled from the card, linked to the case the
 *             card is on or the patient's open case when there is one.
 *   pipeline  the patient's case — the card's, the open one, or a new one —
 *             set to the chosen status by the existing status transition.
 *   followup  a follow-up on that case (tc_followups): due date and talking
 *             point required.
 *   inbox     the TC Inbox: an unowned `hygiene_review` case with its intake,
 *             for a coordinator to claim later.
 *
 * Every destination writes case events of EXISTING types only (case_created,
 * status_change, note_added) and, for a pre-auth with no case, the pre-auth's
 * own existing `created` history row. No outcome, card status, case status or
 * event type is added anywhere. `destination` is a request discriminator; it is
 * never stored as a value.
 *
 * THE CARD, HONESTLY. Routing is something the desk does WHILE the card waits;
 * it is not one of the three checkout answers, so preauth / pipeline / followup
 * leave the card Waiting (it is still answered Scheduled / Not scheduled /
 * Nothing needed) and annotate it by linking it to the case it touched — the
 * card then shows that case, and the case's timeline says what was routed.
 * The Inbox RESOLVES the card: a waiting checkout card is what keeps a same-day
 * hygiene case out of the Inbox (CO-1), so sending the patient there closes the
 * card as Dismissed with the reason "Sent to the TC Inbox" — the existing
 * "closed by hand, with a reason" state, saying exactly what happened.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * CO-7: THE ASK-HYGIENE THREAD
 * ═════════════════════════════════════════════════════════════════════════════
 * A front-desk question about a checkout card, answered from the hygiene app's
 * day view. One row per message in tc_checkout_questions; a TC message is a
 * QUESTION, a hygienist message is a REPLY. The thread is OPEN while any TC
 * question in it is unresolved; "Mark resolved" closes every open one. In-app
 * only: nothing here writes Open Dental, sends an email or a text.
 */
import { z } from "zod";

import { FollowupChannel, PreauthType } from "./contract";
import { TcCheckoutHandoff } from "./checkout";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

// ── CO-6 ────────────────────────────────────────────────────────────────────

/**
 * The statuses "Route to → Pipeline" offers: the OPEN statuses a coordinator
 * pursues a case through. Not hygiene_review (that is the Inbox destination,
 * and it means unclaimed), and no terminal status: booking is the checkout's
 * own Scheduled answer, and closing a case (lost, completed) is not routing.
 * A subset of CaseStatus — a narrower request, not a new value.
 */
export const TC_CHECKOUT_PIPELINE_STATUSES = [
  "diagnosed",
  "pending_tc",
  "pending_pt",
  "presented",
  "considering",
  "financing_pending",
  "nurture",
] as const;
export const TcCheckoutPipelineStatus = z.enum(TC_CHECKOUT_PIPELINE_STATUSES);
export type TcCheckoutPipelineStatus = z.infer<typeof TcCheckoutPipelineStatus>;

export const TC_CHECKOUT_ROUTE_DESTINATIONS = ["preauth", "pipeline", "followup", "inbox"] as const;
export type TcCheckoutRouteDestination = (typeof TC_CHECKOUT_ROUTE_DESTINATIONS)[number];

export const TC_CHECKOUT_ROUTE_LABELS: Record<TcCheckoutRouteDestination, string> = {
  preauth: "Pre-auth",
  pipeline: "Pipeline",
  followup: "Follow-up",
  inbox: "TC Inbox",
};

const Words = (max: number) => z.string().trim().max(max);

export const TcCheckoutRouteRequest = z.discriminatedUnion("destination", [
  z
    .object({
      destination: z.literal("preauth"),
      preauthType: PreauthType.default("treatment"),
      insuranceCarrier: Words(200).default(""),
      /** Absent = the card's staged procedures, one per line. */
      description: Words(8000).optional(),
      notes: Words(8000).default(""),
    })
    .strict(),
  z
    .object({
      destination: z.literal("pipeline"),
      status: TcCheckoutPipelineStatus,
      note: Words(500).default(""),
    })
    .strict(),
  z
    .object({
      destination: z.literal("followup"),
      dueDate: IsoDate,
      talkingPoint: z.string().trim().min(1, "A talking point is required").max(8000),
      channel: FollowupChannel.default("phone_call"),
    })
    .strict(),
  z
    .object({
      destination: z.literal("inbox"),
      note: Words(500).default(""),
    })
    .strict(),
]);
export type TcCheckoutRouteRequest = z.input<typeof TcCheckoutRouteRequest>;

/** What a routing answers: the card READ BACK, and what was made or touched. */
export const TcCheckoutRouteResponse = z.object({
  success: z.literal(true),
  destination: z.enum(TC_CHECKOUT_ROUTE_DESTINATIONS),
  handoff: TcCheckoutHandoff,
  /** The case the routing wrote to, or null (a pre-auth for a patient with no case). */
  caseId: z.string().uuid().nullable(),
  url: z.string().nullable(),
  /** True when the routing joined an existing case; false when it made one or used none. */
  attached: z.boolean(),
  preauthId: z.string().uuid().nullable(),
  followupId: z.string().uuid().nullable(),
  /** Pipeline: whether the status actually moved (false = it was already there). */
  statusChanged: z.boolean().nullable(),
  /** True when the routing closed the card (the Inbox). */
  resolved: z.boolean(),
});
export type TcCheckoutRouteResponse = z.infer<typeof TcCheckoutRouteResponse>;

/** The reason a card sent to the Inbox is dismissed with. Prefix of the stored text. */
export const CHECKOUT_INBOX_DISMISS_REASON = "Sent to the TC Inbox for a coordinator to claim";

// ── CO-7 ────────────────────────────────────────────────────────────────────

export const TcCheckoutQuestionRole = z.enum(["tc", "hygienist"]);
export type TcCheckoutQuestionRole = z.infer<typeof TcCheckoutQuestionRole>;

/** The DB CHECK's bound on a message. */
export const CHECKOUT_QUESTION_MAX = 2000;

export const TcCheckoutQuestion = z.object({
  questionId: z.string().uuid(),
  handoffId: z.string().uuid(),
  authorEmail: z.string(),
  authorRole: TcCheckoutQuestionRole,
  body: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type TcCheckoutQuestion = z.infer<typeof TcCheckoutQuestion>;

export const TcCheckoutQuestionPost = z
  .object({ body: z.string().trim().min(1, "Say what you need to ask").max(CHECKOUT_QUESTION_MAX) })
  .strict();
export type TcCheckoutQuestionPost = z.infer<typeof TcCheckoutQuestionPost>;

/** A thread, oldest first, and how many of its questions are still open. */
export const TcCheckoutQuestionThread = z.object({
  handoffId: z.string().uuid(),
  open: z.number().int().min(0),
  messages: z.array(TcCheckoutQuestion),
});
export type TcCheckoutQuestionThread = z.infer<typeof TcCheckoutQuestionThread>;

export const TcCheckoutQuestionThreadResponse = z.object({
  success: z.literal(true),
  thread: TcCheckoutQuestionThread,
});

/**
 * The hygiene day view's badges (GET /api/hyg/day/checkout-questions): one entry per
 * AptNum on the day whose checkout card has a thread. Keyed by AptNum like the
 * progress pill — no PatNum, no name, no message text.
 */
export const HygCheckoutQuestionBadge = z.object({
  aptNum: z.number().int().positive(),
  handoffId: z.string().uuid(),
  open: z.number().int().min(0),
  total: z.number().int().min(1),
});
export type HygCheckoutQuestionBadge = z.infer<typeof HygCheckoutQuestionBadge>;

export const HygCheckoutQuestionBadgesResponse = z.object({
  success: z.literal(true),
  office: z.enum(["roland", "valley"]),
  /** False when checkout is switched off for the office: no badges. */
  enabled: z.boolean(),
  badges: z.array(HygCheckoutQuestionBadge),
});
export type HygCheckoutQuestionBadgesResponse = z.infer<typeof HygCheckoutQuestionBadgesResponse>;

/** GET /api/hyg/visit/:aptNum/checkout-questions and the reply's answer. */
export const HygCheckoutThreadResponse = z.object({
  success: z.literal(true),
  office: z.enum(["roland", "valley"]),
  aptNum: z.number().int().positive(),
  thread: TcCheckoutQuestionThread,
});
export type HygCheckoutThreadResponse = z.infer<typeof HygCheckoutThreadResponse>;

/** The open count of a thread's messages. Pure; the server and the client agree by sharing it. */
export function openQuestionCount(messages: readonly Pick<TcCheckoutQuestion, "authorRole" | "resolvedAt">[]): number {
  return messages.filter((m) => m.authorRole === "tc" && m.resolvedAt === null).length;
}
