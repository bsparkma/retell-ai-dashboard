/**
 * The checkout handoff, and the intake vocabulary it joins (queue item 49).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THREE KINDS OF INTAKE, ONE ENDPOINT
 * ═════════════════════════════════════════════════════════════════════════════
 * `POST /api/tc/hygiene-intakes` is the hygiene → TC handoff. Until item 49 it
 * knew one shape (a treatment intake, which an ortho screening rides on). It
 * now takes a `kind`:
 *
 *   hygiene   the treatment handoff (the visit's `tc-handoff` staged write, and
 *             TC's own intake form). Creates a `hygiene_review` case.
 *   ortho     the ortho screening (item 33). Creates a `hygiene_review` case.
 *   checkout  "this patient is on the way to the front desk, here is what was
 *             staged". Creates NO case — a `tc_checkout_handoffs` row. Whether
 *             a case follows is the front desk's decision at checkout (item 50:
 *             "Nothing needed" closes the handoff with no case at all).
 *
 * `kind` is optional for hygiene/ortho so a client that predates it still
 * works; the server then infers it from whether a screening rides along.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SOURCE KEY: A LOST RESPONSE CANNOT OPEN A SECOND CASE
 * ═════════════════════════════════════════════════════════════════════════════
 * Before item 49 an intake had no idempotency at all: a resend after a lost
 * response opened a duplicate case. Every intake may now carry a `sourceKey`
 * — the caller's own name for "this one handoff" — and TC answers a repeat key
 * with the case (or handoff) it already made, enforced by a unique index on
 * (office_id, source_key). The hygiene module derives its keys from the visit
 * id, so they are stable across retries and never carry PHI.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A CHECKOUT IS A SNAPSHOT, NEVER A REFERENCE
 * ═════════════════════════════════════════════════════════════════════════════
 * Everything the front desk sees is copied in at send time. Nothing TC renders
 * from a handoff reads Open Dental or the hygiene visit again.
 */
import { z } from "zod";

import { EXISTING_TX_HANDOFF_MAX, ExistingTxHandoffItemSchema } from "../hyg/existingTx";

/** The intake kinds `POST /api/tc/hygiene-intakes` accepts. */
export const TcIntakeKind = z.enum(["hygiene", "ortho", "checkout"]);
export type TcIntakeKind = z.infer<typeof TcIntakeKind>;

/** Labels, so no screen invents its own. */
export const TC_INTAKE_KIND_LABELS: Record<TcIntakeKind, string> = {
  hygiene: "Treatment",
  ortho: "Ortho screening",
  checkout: "Checkout",
};

/**
 * A caller's idempotency key for one intake. Machine-shaped on purpose — it is
 * an identifier, never a sentence, and never a name or a PatNum.
 */
export const TcIntakeSourceKey = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9:_-]+$/, "a source key is letters, digits, ':', '_' and '-' only");
export type TcIntakeSourceKey = z.infer<typeof TcIntakeSourceKey>;

/** The visit's treatment priority, as TC stores it on a checkout. */
export const TcCheckoutPriority = z.enum(["urgent", "preventative", "cosmetic"]);
export type TcCheckoutPriority = z.infer<typeof TcCheckoutPriority>;

export const TC_CHECKOUT_PRIORITY_LABELS: Record<TcCheckoutPriority, string> = {
  urgent: "Urgent",
  preventative: "Preventative",
  cosmetic: "Cosmetic",
};

/** Highest first — the order `checkoutPriorityOf` picks by. */
export const TC_CHECKOUT_PRIORITY_ORDER: readonly TcCheckoutPriority[] = [
  "urgent",
  "preventative",
  "cosmetic",
];

/** One staged procedure, as the hygienist left it. */
export const TcCheckoutProcedure = z
  .object({
    /** Universal tooth numbers, or "mouth" for a whole-mouth item. */
    teeth: z.union([z.array(z.number().int()), z.literal("mouth")]),
    code: z.string().min(1).max(60),
    category: z.string().min(1).max(40),
    priority: TcCheckoutPriority,
    status: z.string().min(1).max(40),
    surfaces: z.array(z.string().max(4)).max(10),
    /** The hygienist marked this to schedule at the next visit. */
    scheduleNext: z.boolean(),
    note: z.string().max(500),
    /**
     * The routing slip's diagnosis shorthand ("D", "RD", "FX"…), verbatim (CO-1).
     * OPTIONAL and additive: every snapshot stored before CO-1 has no such key
     * and parses as it did. Kept as short strings rather than the hygiene
     * enum, so a code the slip gains later cannot make TC refuse a handoff.
     */
    dx: z.array(z.string().regex(/^[A-Za-z]{1,8}$/)).max(20).optional(),
    /** The hygienist's free-text diagnosis note, when there is one (CO-1). */
    dxNote: z.string().max(500).optional(),
  })
  .strict();
export type TcCheckoutProcedure = z.infer<typeof TcCheckoutProcedure>;

/** What the next visit needs, from the routing slip. Every field may be unset. */
export const TcCheckoutNextVisit = z
  .object({
    type: z.string().max(120).nullable(),
    intervalMonths: z.number().int().min(1).max(24).nullable(),
    lengthMin: z.number().int().min(5).max(240).nullable(),
    withDoctor: z.boolean(),
    /** The note's return-to-clinic line, verbatim. */
    rtc: z.string().max(4000),
  })
  .strict();
export type TcCheckoutNextVisit = z.infer<typeof TcCheckoutNextVisit>;

/**
 * What the front desk takes payment for (checkout v2) — LABELS, not ids. A
 * checkout is a snapshot, never a reference, so it carries the words the
 * hygiene slip showed. Six at most: five chips and one "Other".
 */
export const TcCollectAtCheckout = z.array(z.string().min(1).max(200)).max(6);
export type TcCollectAtCheckout = z.infer<typeof TcCollectAtCheckout>;

/**
 * Where a record stands — the hygiene slip's three answers, spelled the same
 * (shared/hyg/contract.ts RecordStatusSchema; a test pins that they match).
 */
export const TcCheckoutRecordStatus = z.enum(["needed", "on_file", "taken_today"]);
export type TcCheckoutRecordStatus = z.infer<typeof TcCheckoutRecordStatus>;
export const TC_CHECKOUT_RECORD_STATUS_LABELS: Record<TcCheckoutRecordStatus, string> = {
  needed: "Needed",
  on_file: "On file",
  taken_today: "Taken today",
};
export const TC_CHECKOUT_RECORDS_MAX = 60;
/** One record the planned treatment needs ("Pre-op PA"), and where it stands. */
export const TcCheckoutRecord = z
  .object({ record: z.string().min(1).max(120), status: TcCheckoutRecordStatus })
  .strict();
export type TcCheckoutRecord = z.infer<typeof TcCheckoutRecord>;

/** The whole snapshot a checkout carries. */
export const TcCheckoutSnapshot = z
  .object({
    procedures: z.array(TcCheckoutProcedure).max(100),
    /** The highest priority among the procedures; null when there are none. */
    priority: TcCheckoutPriority.nullable(),
    nextVisit: TcCheckoutNextVisit,
    /**
     * The clinical note has not reached the chart yet. True on an early
     * "Alert checkout" (the visit Send has not run); the visit Send's update
     * says whether the note landed.
     */
    notesPending: z.boolean(),
    frontDeskNote: z.string().max(4000),
    financialNote: z.string().max(4000),
    /**
     * The patient's EXISTING Open Dental plan and what was said about it
     * (hygiene Slice 2b). OPTIONAL and additive: every snapshot stored before
     * this has no such key and parses exactly as it did, and a visit whose plan
     * was never loaded sends none.
     */
    existingTx: z.array(ExistingTxHandoffItemSchema).max(EXISTING_TX_HANDOFF_MAX).optional(),
    /**
     * What to take payment for at the desk (checkout v2): the slip's chips and
     * "Other", as the front desk reads them. OPTIONAL and additive for the same
     * reason as existingTx; absent or empty means nothing to collect.
     */
    collectAtCheckout: TcCollectAtCheckout.optional(),
    /**
     * The records the staged treatment needs and where each stands (checkout
     * v2). OPTIONAL and additive; absent when the treatment needs none.
     */
    records: z.array(TcCheckoutRecord).max(TC_CHECKOUT_RECORDS_MAX).optional(),
  })
  .strict();
export type TcCheckoutSnapshot = z.infer<typeof TcCheckoutSnapshot>;

/**
 * `POST /api/tc/hygiene-intakes` with `kind: "checkout"`.
 *
 * `final` marks the visit Send's update. A final payload is never overwritten
 * by a non-final one, so an early alert that arrives late cannot roll back the
 * hygienist's last word.
 */
export const TcCheckoutSubmit = z
  .object({
    kind: z.literal("checkout"),
    sourceKey: TcIntakeSourceKey,
    final: z.boolean(),
    patientName: z.string().min(1).max(200),
    odPatientId: z.number().int().positive(),
    provider: z.string().max(200),
    providerSeen: z.string().max(200),
    operatory: z.string().max(200),
    visitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    snapshot: TcCheckoutSnapshot,
  })
  .strict();
export type TcCheckoutSubmit = z.infer<typeof TcCheckoutSubmit>;

/**
 * Where a checkout handoff stands at the front desk (item 50).
 *
 *   open            waiting; nobody has picked it up
 *   claimed         a TC user said "I've got this patient"
 *   scheduled       outcome: booked — the case is in the Scheduled column
 *   not_scheduled   outcome: left without booking — the case waits on the patient
 *   nothing_needed  outcome: nothing to schedule — NO case
 *   dismissed       closed by hand, with a reason (not a checkout after all)
 *   expired         its office day ended with no outcome; closed by the system
 *
 * The DB CHECK (1791500000000_tc_checkout_outcome.js) carries the same seven.
 */
export const TcCheckoutStatus = z.enum([
  "open",
  "claimed",
  "scheduled",
  "not_scheduled",
  "nothing_needed",
  "dismissed",
  "expired",
]);
export type TcCheckoutStatus = z.infer<typeof TcCheckoutStatus>;

export const TC_CHECKOUT_STATUS_LABELS: Record<TcCheckoutStatus, string> = {
  open: "Waiting",
  claimed: "Claimed",
  scheduled: "Scheduled",
  not_scheduled: "Not scheduled",
  nothing_needed: "Nothing needed",
  dismissed: "Dismissed",
  expired: "Expired",
};

/** The statuses the inbox shows as still waiting on the front desk. */
export const TC_CHECKOUT_WAITING: readonly TcCheckoutStatus[] = ["open", "claimed"];

/** The three answers a front desk gives at checkout. */
export const TcCheckoutOutcome = z.enum(["scheduled", "not_scheduled", "nothing_needed"]);
export type TcCheckoutOutcome = z.infer<typeof TcCheckoutOutcome>;

export const TC_CHECKOUT_OUTCOME_LABELS: Record<TcCheckoutOutcome, string> = {
  scheduled: "Scheduled",
  not_scheduled: "Not scheduled",
  nothing_needed: "Nothing needed",
};

// ── CO-1: the workup checklist ──────────────────────────────────────────────

/** Who ticked a box, and when. */
export const TcCheckoutWorkupMark = z.object({ by: z.string(), at: z.string() }).strict();
export type TcCheckoutWorkupMark = z.infer<typeof TcCheckoutWorkupMark>;

/**
 * The front desk's own progress through one checkout (CO-1), stored on the
 * handoff (tc_checkout_handoffs.workup, NULLABLE jsonb). A record from before
 * CO-1 has none and reads as this object with nothing ticked.
 *
 *   workedUp    per staged procedure, keyed by its index.
 *   present     per existing-treatment group ("Ready to present").
 *   collected   the collect list as a whole.
 *   referrals   the referrals step as a whole ("handled": started, or none needed).
 *
 * STALE TICKS. The first three each carry a `key` naming WHAT was ticked — the
 * item's checkoutItemKey, the group's procedures, the collect list. A later
 * visit Send that changes that thing makes the tick STALE, and a stale tick
 * counts as not done (the attestation rule, C2b). Referrals has nothing in the
 * snapshot to go stale against.
 *
 * It is a desk checklist, NOT a sync: nothing here reads or writes Open Dental.
 */
const TcCheckoutKeyedMark = TcCheckoutWorkupMark.extend({ key: z.string() });

export const TcCheckoutWorkup = z
  .object({
    workedUp: z.record(z.string().regex(/^\d{1,3}$/), TcCheckoutKeyedMark).default({}),
    present: z.record(z.string(), TcCheckoutKeyedMark).default({}),
    collected: TcCheckoutKeyedMark.nullable().default(null),
    referrals: TcCheckoutWorkupMark.nullable().default(null),
  })
  .strict();
export type TcCheckoutWorkup = z.infer<typeof TcCheckoutWorkup>;

/** What a "Ready to present" tick was made against: the group's procedures. Pure. */
export function checkoutPresentKey(
  existingTx: readonly { procNum: number; patient: string }[] | undefined,
  group: string,
): string {
  return JSON.stringify(
    (existingTx ?? [])
      .filter((i) => i.patient === group)
      .map((i) => i.procNum)
      .sort((a, b) => a - b),
  );
}

/** What a "Collected" tick was made against: the collect list. Pure. */
export function checkoutCollectKey(collect: readonly string[] | undefined): string {
  return JSON.stringify(collect ?? []);
}

/** The checklist with nothing ticked — what every pre-CO-1 record reads as. */
export function emptyCheckoutWorkup(): TcCheckoutWorkup {
  return { workedUp: {}, present: {}, collected: null, referrals: null };
}

/** POST /api/tc/checkout/:id/workup — tick or untick ONE box. */
export const TcCheckoutWorkupRequest = z.discriminatedUnion("section", [
  z.object({ section: z.literal("workup"), index: z.number().int().min(0).max(99), done: z.boolean() }).strict(),
  z.object({ section: z.literal("present"), group: z.string().min(1).max(40), done: z.boolean() }).strict(),
  z.object({ section: z.literal("collect"), done: z.boolean() }).strict(),
  z.object({ section: z.literal("referrals"), done: z.boolean() }).strict(),
]);
export type TcCheckoutWorkupRequest = z.infer<typeof TcCheckoutWorkupRequest>;

/** The workup view's sections, in desk order. */
export const TC_CHECKOUT_WORKUP_SECTIONS = ["workup", "present", "collect", "referrals"] as const;
export type TcCheckoutWorkupSection = (typeof TC_CHECKOUT_WORKUP_SECTIONS)[number];

export const TC_CHECKOUT_WORKUP_SECTION_LABELS: Record<TcCheckoutWorkupSection, string> = {
  workup: "Work up in OD",
  present: "Existing treatment to present",
  collect: "Collect payment",
  referrals: "Referrals",
};

/** The handoff's own fields a progress count needs. */
type WorkupProgressInput = {
  snapshot: Pick<TcCheckoutSnapshot, "procedures" | "existingTx" | "collectAtCheckout">;
  /** Absent reads as nothing ticked — the same rule the server's reader applies. */
  workup?: TcCheckoutWorkup;
};

/**
 * Is each section done, and how many of the sections that APPLY are? Pure.
 *
 * A section applies only when the snapshot gives it something to do: work-up
 * when anything was staged, present when existing treatment came along, collect
 * when there is something to take payment for. Referrals always applies: the
 * desk decides whether one is needed, and "none needed" is still an answer.
 * A section is done when every box in it is ticked (a stale work-up tick does
 * not count).
 */
export function checkoutWorkupProgress(h: WorkupProgressInput): {
  sections: { section: TcCheckoutWorkupSection; applies: boolean; done: boolean }[];
  done: number;
  total: number;
} {
  const w = h.workup ?? emptyCheckoutWorkup();
  const procs = h.snapshot.procedures;
  const groups = Array.from(new Set((h.snapshot.existingTx ?? []).map((i) => i.patient)));
  const collect = h.snapshot.collectAtCheckout ?? [];
  const sections = [
    {
      section: "workup" as const,
      applies: procs.length > 0,
      done: procs.length > 0 && procs.every((p, i) => w.workedUp[String(i)]?.key === checkoutItemKey(p)),
    },
    {
      section: "present" as const,
      applies: groups.length > 0,
      done: groups.length > 0 && groups.every((g) => w.present[g]?.key === checkoutPresentKey(h.snapshot.existingTx, g)),
    },
    {
      section: "collect" as const,
      applies: collect.length > 0,
      done: collect.length > 0 && w.collected?.key === checkoutCollectKey(collect),
    },
    { section: "referrals" as const, applies: true, done: w.referrals !== null },
  ];
  const applying = sections.filter((s) => s.applies);
  return { sections, done: applying.filter((s) => s.done).length, total: applying.length };
}

/** "2 of 4 sections done". */
export function checkoutWorkupProgressLabel(p: { done: number; total: number }): string {
  return `${p.done} of ${p.total} ${p.total === 1 ? "section" : "sections"} done`;
}

/**
 * Where a checkout card came from: the hygiene visit, the front desk's "Add
 * patient" (CO-5a), or today's Open Dental schedule (CO-5b — a non-hygiene
 * appointment Open Dental marked Complete).
 */
export const TcCheckoutSource = z.enum(["hygiene", "manual", "schedule"]);
export type TcCheckoutSource = z.infer<typeof TcCheckoutSource>;

/**
 * The snapshot a card added by hand is stored with: nothing staged, nothing to
 * collect, no next visit, no notes. Never rendered as hygiene data —
 * checkoutHasHygieneData says the card has none. Pure.
 */
export function emptyCheckoutSnapshot(): TcCheckoutSnapshot {
  return {
    procedures: [],
    priority: null,
    nextVisit: { type: null, intervalMonths: null, lengthMin: null, withDoctor: false, rtc: "" },
    notesPending: false,
    frontDeskNote: "",
    financialNote: "",
  };
}

/**
 * One of the patient's UPCOMING Open Dental appointments, as the "Scheduled"
 * picker lists it (CO-4a). Exactly these fields — no notes, no other patient.
 * `dateTime` is Open Dental's own wall-clock reading for the office,
 * 'YYYY-MM-DD HH:MM:SS'; it is never converted between timezones.
 */
export const TcCheckoutUpcomingAppointment = z.object({
  aptNum: z.number().int().positive(),
  dateTime: z.string(),
  provider: z.string(),
  appointmentType: z.string(),
  operatory: z.string(),
});
export type TcCheckoutUpcomingAppointment = z.infer<typeof TcCheckoutUpcomingAppointment>;

/**
 * The appointment a Scheduled checkout is anchored to (CO-4a): what Open
 * Dental said about it when it was linked, and who linked it. The office is
 * the checkout's own. What the OD-driven sync (CO-4b) will track.
 */
export const TcCheckoutAppointmentAnchor = TcCheckoutUpcomingAppointment.extend({
  linkedBy: z.string().nullable(),
  linkedAt: z.string().nullable(),
});
export type TcCheckoutAppointmentAnchor = z.infer<typeof TcCheckoutAppointmentAnchor>;

/** GET /api/tc/checkout/:id/appointments — the picker's list, soonest first. */
export const TcCheckoutAppointmentsResponse = z.object({
  success: z.literal(true),
  appointments: z.array(TcCheckoutUpcomingAppointment),
});
export type TcCheckoutAppointmentsResponse = z.infer<typeof TcCheckoutAppointmentsResponse>;

/**
 * POST /api/tc/checkout/:id/appointment — link, change, or (null) clear a
 * Scheduled checkout's anchor later. The AptNum must be one of that patient's
 * upcoming appointments in that office, re-read from Open Dental.
 */
export const TcCheckoutAppointmentLinkRequest = z.object({ aptNum: z.number().int().positive().nullable() }).strict();
export type TcCheckoutAppointmentLinkRequest = z.infer<typeof TcCheckoutAppointmentLinkRequest>;

/** "Tue, Nov 4, 9:00 AM" from an OD wall-clock 'YYYY-MM-DD HH:MM[:SS]'. Pure; no timezone math. */
export function appointmentWhenLabel(dateTime: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(dateTime);
  if (!m) return dateTime;
  const [, y, mo, d, hh, mm] = m;
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const date = day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const h = Number(hh);
  const time = `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
  return `${date}, ${time}`;
}

/**
 * The answer a card had before a later hygiene visit reopened it (CO-5a fix,
 * PM ruling): a hygiene handoff that merges onto an answered card puts it back
 * in Waiting, and what it was answered with is kept here as history.
 */
export const TcCheckoutReopened = z.object({
  outcome: TcCheckoutOutcome,
  outcomeBy: z.string().nullable(),
  outcomeAt: z.string().nullable(),
  appointmentNote: z.string().nullable(),
  /** The case that outcome made or moved. The case itself is left as it is. */
  caseId: z.string().uuid().nullable(),
  reopenedAt: z.string(),
  /** CO-4a: the appointment that answer was anchored to, if any. */
  appointment: TcCheckoutAppointmentAnchor.nullable().default(null),
});
export type TcCheckoutReopened = z.infer<typeof TcCheckoutReopened>;

/** A checkout handoff as TC reads it back. */
export const TcCheckoutHandoff = z.object({
  handoffId: z.string().uuid(),
  officeId: z.enum(["roland", "valley"]),
  odPatientId: z.number().int().positive(),
  patientName: z.string(),
  provider: z.string(),
  providerSeen: z.string(),
  operatory: z.string(),
  visitDate: z.string(),
  snapshot: TcCheckoutSnapshot,
  final: z.boolean(),
  revision: z.number().int().positive(),
  submittedBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Item 50 — the front desk's side. Defaulted so an item-49 reader still parses.
  status: TcCheckoutStatus.default("open"),
  claimedBy: z.string().nullable().default(null),
  claimedAt: z.string().nullable().default(null),
  dismissedReason: z.string().nullable().default(null),
  dismissedBy: z.string().nullable().default(null),
  dismissedAt: z.string().nullable().default(null),
  outcomeBy: z.string().nullable().default(null),
  outcomeAt: z.string().nullable().default(null),
  appointmentNote: z.string().nullable().default(null),
  caseId: z.string().uuid().nullable().default(null),
  expiredAt: z.string().nullable().default(null),
  /** Always `system:checkout_expiry` when set — the system closed it, not a person. */
  expiredBy: z.string().nullable().default(null),
  /** CO-1. Defaulted so a pre-CO-1 reader and a pre-CO-1 record both parse. */
  workup: TcCheckoutWorkup.default(emptyCheckoutWorkup),
  /**
   * CO-5a. Where the card came from: the hygiene visit, or the front desk's
   * "Add patient". Every record before CO-5a reads as `hygiene`, which is what
   * it was. Who added a manual card is `submittedBy`.
   */
  source: TcCheckoutSource.default("hygiene"),
  /**
   * CO-5a. When a hygiene handoff for the same patient and day arrived after a
   * manual card and merged onto it. Null on a hygiene card, and on a manual
   * card that has no hygiene visit data.
   */
  hygieneMergedAt: z.string().nullable().default(null),
  /**
   * CO-5a fix. Set when a hygiene visit arrived after this card was ANSWERED
   * and reopened it: the answer it had, kept as history. Null otherwise.
   */
  reopenedFrom: TcCheckoutReopened.nullable().default(null),
  /**
   * CO-4a. The Open Dental appointment a Scheduled checkout is anchored to.
   * Null on every other status, on every record before CO-4a, and on a
   * Scheduled checkout marked "Not in Open Dental yet".
   */
  appointment: TcCheckoutAppointmentAnchor.nullable().default(null),
  /**
   * CO-5b. On a `schedule` card, the Open Dental appointment it was made from,
   * as Open Dental described it then. It stays when a hygiene handoff later
   * merges onto the card. Null on every other card.
   */
  scheduleAppointment: TcCheckoutUpcomingAppointment.nullable().default(null),
});
export type TcCheckoutHandoff = z.infer<typeof TcCheckoutHandoff>;

/**
 * Does this card carry hygiene visit data? A hygiene card always does; a manual
 * or schedule card only once a hygiene handoff merged onto it. When it does
 * not, the workup view says so instead of rendering the hygiene sections as if
 * they were empty. Pure.
 */
export function checkoutHasHygieneData(h: Pick<TcCheckoutHandoff, "source" | "hygieneMergedAt">): boolean {
  return h.source === "hygiene" || h.hygieneMergedAt !== null;
}

/**
 * GET /api/tc/checkout/schedule-check — the Checkout page's "today's schedule"
 * line (CO-5b), per office. Asking also refreshes the office's schedule read
 * when it is older than its cache window; the answer is the state as it stands.
 *
 *   off      the office's switch is off: nothing is read, nothing is made
 *   pending  switched on, no read has finished since the server started
 *   ok       the last read succeeded
 *   failed   the last read failed — the page says "Couldn't check today's
 *            schedule" with `lastSuccessAt`, never a silent stale list
 */
export const TcCheckoutScheduleCheckStatus = z.enum(["off", "pending", "ok", "failed"]);
export type TcCheckoutScheduleCheckStatus = z.infer<typeof TcCheckoutScheduleCheckStatus>;

export const TcCheckoutScheduleCheck = z.object({
  success: z.literal(true),
  office: z.enum(["roland", "valley"]),
  status: TcCheckoutScheduleCheckStatus,
  running: z.boolean(),
  lastSuccessAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  /** Counts from the last read that finished. Never a PatNum or a name. */
  summary: z
    .object({
      completedNonHygiene: z.number().int().nonnegative(),
      created: z.number().int().nonnegative(),
      alreadyCarded: z.number().int().nonnegative(),
      skippedHygiene: z.number().int().nonnegative(),
      skippedNoPatient: z.number().int().nonnegative(),
      deferred: z.number().int().nonnegative(),
      partial: z.boolean(),
    })
    .nullable(),
});
export type TcCheckoutScheduleCheck = z.infer<typeof TcCheckoutScheduleCheck>;

/**
 * POST /api/tc/checkout/manual — the front desk's "Add patient" (CO-5a).
 * The PatNum names which patient the person picked from the patient search;
 * the office is the request's, and the name is re-read from that office's Open
 * Dental. Nothing else rides along.
 */
export const TcCheckoutManualAddRequest = z.object({ patNum: z.number().int().positive() }).strict();
export type TcCheckoutManualAddRequest = z.infer<typeof TcCheckoutManualAddRequest>;

/** POST /api/tc/checkout/:id/outcome */
export const TcCheckoutOutcomeRequest = z
  .object({
    outcome: TcCheckoutOutcome,
    /** Optional, and only meaningful for "Scheduled" ("Tue 9am, Dr. chair"). */
    appointmentNote: z.string().trim().max(500).default(""),
    /**
     * CO-4a, Scheduled only. The AptNum picked from the patient's upcoming
     * appointments, or null / absent for "Not in Open Dental yet". Re-read
     * from Open Dental before anything is stored.
     */
    aptNum: z.number().int().positive().nullable().optional(),
  })
  .strict();
export type TcCheckoutOutcomeRequest = z.infer<typeof TcCheckoutOutcomeRequest>;

/** POST /api/tc/checkout/:id/dismiss — a reason is required, like an opportunity's. */
export const TcCheckoutDismissRequest = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();
export type TcCheckoutDismissRequest = z.infer<typeof TcCheckoutDismissRequest>;

/**
 * GET /api/tc/checkout/summary — what the nav badge and the arrival toast read.
 * `enabled: false` means the office has checkout switched off: no badge, no
 * nav item, no toast.
 */
export const TcCheckoutSummary = z.object({
  success: z.literal(true),
  office: z.enum(["roland", "valley"]),
  enabled: z.boolean(),
  /** The office's own day, `YYYY-MM-DD`, that "today" means here. */
  today: z.string().nullable(),
  waiting: z.number().int().nonnegative(),
  /** The newest waiting handoff — what an arrival toast names. Null when none. */
  newest: z
    .object({ handoffId: z.string().uuid(), patientName: z.string(), createdAt: z.string() })
    .nullable(),
});
export type TcCheckoutSummary = z.infer<typeof TcCheckoutSummary>;

/** The response to a checkout submit. */
export const TcCheckoutSubmitResponse = z.object({
  success: z.literal(true),
  kind: z.literal("checkout"),
  handoff: TcCheckoutHandoff,
  /** True when the key was already known and nothing new was stored. */
  replayed: z.boolean(),
});
export type TcCheckoutSubmitResponse = z.infer<typeof TcCheckoutSubmitResponse>;

/** The highest priority among procedures, or null for none. Pure. */
export function checkoutPriorityOf(
  procedures: readonly { priority: TcCheckoutPriority }[],
): TcCheckoutPriority | null {
  for (const p of TC_CHECKOUT_PRIORITY_ORDER) {
    if (procedures.some((x) => x.priority === p)) return p;
  }
  return null;
}

// ── C2b (item 50b): the treatment stays on the case ─────────────────────────

/**
 * The name of the treatment-plan phase a checkout writes onto its case. One
 * place, so the backend that writes it and the screens that recognise it
 * (the Present guard, the Open Dental pull warning) cannot drift apart.
 */
export function checkoutPhaseName(visitDate: string | null): string {
  return `Hygiene visit ${visitDate ?? ""}`.trim();
}

/** A phase name a checkout wrote: "Hygiene visit YYYY-MM-DD". */
export const CHECKOUT_PHASE_NAME_RE = /^Hygiene visit \d{4}-\d{2}-\d{2}$/;

/**
 * The checkout-origin phases of a plan that still hold an unpriced ($0) item.
 * The Present guard asks for confirmation while this is non-empty. Pure.
 */
export function unpricedCheckoutPhases(
  phases: readonly { name: string; items: readonly { feeCents: number }[] }[],
): string[] {
  return phases
    .filter((p) => CHECKOUT_PHASE_NAME_RE.test(p.name) && p.items.some((i) => i.feeCents === 0))
    .map((p) => p.name);
}

/** The checkout-origin phase names in a plan (the OD-pull warning names them). */
export function checkoutPhaseNames(phases: readonly { name: string }[]): string[] {
  return phases.filter((p) => CHECKOUT_PHASE_NAME_RE.test(p.name)).map((p) => p.name);
}

/**
 * Which procedure an attestation was made against. A later visit Send can
 * revise the snapshot; an attestation whose key no longer matches the item at
 * its index is STALE and counts as not entered. Pure.
 */
export function checkoutItemKey(p: Pick<TcCheckoutProcedure, "code" | "teeth" | "surfaces">): string {
  return JSON.stringify([p.code, p.teeth, p.surfaces]);
}

/** One staged item on the staff panel, with its "entered in Open Dental" state. */
export const TcCheckoutPanelItem = z.object({
  index: z.number().int().nonnegative(),
  procedure: TcCheckoutProcedure,
  /** Set while a CURRENT (non-stale) attestation exists. */
  enteredBy: z.string().nullable(),
  enteredAt: z.string().nullable(),
  /** An attestation exists but was made against an item that has since changed. */
  stale: z.boolean(),
});
export type TcCheckoutPanelItem = z.infer<typeof TcCheckoutPanelItem>;

/** GET /api/tc/checkout/by-case/:caseId — the staff-only "Treatment from hygiene" panel. */
export const TcCheckoutCaseTreatment = z.object({
  success: z.literal(true),
  caseId: z.string().uuid(),
  /** Admin-only: may undo an attestation. */
  canUnattest: z.boolean(),
  visits: z.array(
    z.object({
      handoff: TcCheckoutHandoff,
      items: z.array(TcCheckoutPanelItem),
      /** CO-4a: a Scheduled visit whose case is still open may be (re)linked to an appointment. */
      canLinkAppointment: z.boolean().default(false),
    }),
  ),
});
export type TcCheckoutCaseTreatment = z.infer<typeof TcCheckoutCaseTreatment>;
