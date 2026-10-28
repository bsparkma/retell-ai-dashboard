/**
 * EXISTING TREATMENT DISPOSITIONS (hygiene Slice 2a) — the shared contract.
 *
 * The patient's treatment-planned procedures come from Open Dental, read by the
 * SERVER for the office and PatNum on the stored visit. What the hygienist taps
 * beside each one is stored in CareIN only (`hyg_existing_tx_disposition`);
 * nothing here is ever written back to Open Dental.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE VOCABULARIES ARE PINNED TO THE MIGRATION
 * ═════════════════════════════════════════════════════════════════════════════
 * migrations-tenant/1792800000000_hyg_existing_tx_disposition.js writes these
 * lists as inline CHECK literals, and backend/services/hyg/existingTxSchema.test.js
 * asserts the two agree. A value the contract accepts and the database refuses
 * is a 500 in front of a hygienist with a patient in the chair.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * "NOT DISCUSSED" IS THE DEFAULT AND IS NOT AN ANSWER
 * ═════════════════════════════════════════════════════════════════════════════
 * `patient` defaults to `not_discussed`, and the screen styles it as the absence
 * of an answer (grey, dashed) — never like the other chips. `clinical` has no
 * default at all: null means nobody said anything changed or did not.
 */

import { z } from "zod";

export const EXISTING_TX_CLINICAL = [
  "no_change",
  "worse_urgent",
  "re_evaluate",
  "no_longer_needed",
] as const;
export const ExistingTxClinicalSchema = z.enum(EXISTING_TX_CLINICAL);
export type ExistingTxClinical = z.infer<typeof ExistingTxClinicalSchema>;

export const EXISTING_TX_PATIENT = [
  "not_discussed",
  "ready_to_schedule",
  "wants_to_wait",
  "see_plan_again",
  "cost_questions",
  "declined",
] as const;
export const ExistingTxPatientSchema = z.enum(EXISTING_TX_PATIENT);
export type ExistingTxPatient = z.infer<typeof ExistingTxPatientSchema>;

export const EXISTING_TX_WAIT = ["1_month", "3_months", "6_months", "next_recall"] as const;
export const ExistingTxWaitSchema = z.enum(EXISTING_TX_WAIT);
export type ExistingTxWait = z.infer<typeof ExistingTxWaitSchema>;

/** The note's ceiling. The database CHECK carries the same number. */
export const EXISTING_TX_NOTE_MAX = 500;

/** The words on the chips. One place, so the screen and any later note agree. */
export const EXISTING_TX_CLINICAL_LABELS: Record<ExistingTxClinical, string> = {
  no_change: "No change",
  worse_urgent: "Getting worse → urgent",
  re_evaluate: "Re-evaluate",
  no_longer_needed: "No longer needed",
};
export const EXISTING_TX_PATIENT_LABELS: Record<ExistingTxPatient, string> = {
  not_discussed: "Not discussed",
  ready_to_schedule: "Ready to schedule",
  wants_to_wait: "Wants to wait",
  see_plan_again: "Wants to see the plan again",
  cost_questions: "Cost questions",
  declined: "Declined",
};
export const EXISTING_TX_WAIT_LABELS: Record<ExistingTxWait, string> = {
  "1_month": "1 month",
  "3_months": "3 months",
  "6_months": "6 months",
  next_recall: "Next recall",
};

/**
 * Whether Open Dental's own priority name says Watch.
 *
 * NEVER A GUESS. Only the priority NAME Open Dental returns on the procedure is
 * read, trimmed and compared case-insensitively to the whole word "watch". No
 * code, description or fee is consulted, and a missing name is "not Watch".
 */
export function isWatchPriority(priorityName: string | null | undefined): boolean {
  return typeof priorityName === "string" && priorityName.trim().toLowerCase() === "watch";
}

/**
 * PUT /api/hyg/visit/:aptNum/existing-tx/:procNum — what the hygienist chose.
 *
 * The WHOLE disposition, replaced. `waitTimeframe` is allowed only with
 * `wants_to_wait`, the same rule the database CHECK enforces.
 */
export const ExistingTxDispositionInputSchema = z
  .object({
    clinical: ExistingTxClinicalSchema.nullable(),
    patient: ExistingTxPatientSchema,
    waitTimeframe: ExistingTxWaitSchema.nullable(),
    note: z.string().max(EXISTING_TX_NOTE_MAX).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.waitTimeframe !== null && value.patient !== "wants_to_wait") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["waitTimeframe"],
        message: "A wait timeframe goes only with “Wants to wait”",
      });
    }
  });
export type ExistingTxDispositionInput = z.infer<typeof ExistingTxDispositionInputSchema>;

/** A stored disposition, as read back. */
export const ExistingTxDispositionSchema = z.object({
  clinical: ExistingTxClinicalSchema.nullable(),
  patient: ExistingTxPatientSchema,
  waitTimeframe: ExistingTxWaitSchema.nullable(),
  note: z.string().nullable(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type ExistingTxDisposition = z.infer<typeof ExistingTxDispositionSchema>;

/** The most recent answer from an EARLIER visit, for the same office, patient and procedure. */
export const ExistingTxLastDiscussedSchema = z.object({
  visitDate: z.string(),
  patient: ExistingTxPatientSchema,
  waitTimeframe: ExistingTxWaitSchema.nullable(),
  clinical: ExistingTxClinicalSchema.nullable(),
});
export type ExistingTxLastDiscussed = z.infer<typeof ExistingTxLastDiscussedSchema>;

/** One treatment-planned procedure, as the server read it from Open Dental. No fees. */
export const ExistingTxItemSchema = z.object({
  procNum: z.number().int().positive(),
  code: z.string(),
  description: z.string(),
  /** '' when Open Dental has no tooth on the procedure. */
  tooth: z.string(),
  surface: z.string(),
  /** 'YYYY-MM-DD', or null when Open Dental carries its null date. */
  dateTp: z.string().nullable(),
  /** Open Dental's own priority name, or null when it has none. */
  priorityName: z.string().nullable(),
  /** `isWatchPriority(priorityName)`, computed once on the server. */
  watch: z.boolean(),
  /** On an appointment Open Dental reports as Scheduled. */
  scheduled: z.boolean(),
  /** Null until somebody taps something for this visit. */
  disposition: ExistingTxDispositionSchema.nullable(),
  lastDiscussed: ExistingTxLastDiscussedSchema.nullable(),
});
export type ExistingTxItem = z.infer<typeof ExistingTxItemSchema>;

/** GET /api/hyg/visit/:aptNum/existing-tx */
export const ExistingTxResponseSchema = z.object({
  success: z.literal(true),
  office: z.enum(["roland", "valley"]),
  aptNum: z.number().int().positive(),
  /** The visit's note or slip has been sent: the answers are locked. */
  frozen: z.boolean(),
  /** When the server's Open Dental read was taken (it may be cached). */
  readAt: z.string(),
  items: z.array(ExistingTxItemSchema),
});
export type ExistingTxResponse = z.infer<typeof ExistingTxResponseSchema>;

/** PUT …/existing-tx/:procNum — the stored row, read back. */
export const ExistingTxSaveResponseSchema = z.object({
  success: z.literal(true),
  office: z.enum(["roland", "valley"]),
  aptNum: z.number().int().positive(),
  procNum: z.number().int().positive(),
  disposition: ExistingTxDispositionSchema,
});
export type ExistingTxSaveResponse = z.infer<typeof ExistingTxSaveResponseSchema>;

/**
 * How many existing items nobody discussed at this visit. The Send reminder
 * counts these; it never gates on them.
 */
export function countNotDiscussed(items: readonly Pick<ExistingTxItem, "disposition">[]): number {
  return items.filter((i) => i.disposition === null || i.disposition.patient === "not_discussed")
    .length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slice 2b: what leaves the hygiene module — the note, the Router, and TC
// ─────────────────────────────────────────────────────────────────────────────

/** The most items one handoff carries. Far past any real plan; a bound, not a quota. */
export const EXISTING_TX_HANDOFF_MAX = 200;

/**
 * One existing-treatment item as it is HANDED ON: the server's own snapshot of
 * the procedure, both answers, the timeframe and the note. No fee, no PatNum.
 *
 * Built by the SERVER from the stored dispositions and their `proc_snapshot`
 * (and, for items nobody answered, the plan the server last read) — never from
 * a request. TC stores it as sent; it does not follow later Open Dental edits.
 */
export const ExistingTxHandoffItemSchema = z
  .object({
    procNum: z.number().int().positive(),
    code: z.string().max(40),
    description: z.string().max(300),
    tooth: z.string().max(40),
    surface: z.string().max(20),
    dateTp: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    priorityName: z.string().max(100).nullable(),
    scheduled: z.boolean(),
    clinical: ExistingTxClinicalSchema.nullable(),
    patient: ExistingTxPatientSchema,
    waitTimeframe: ExistingTxWaitSchema.nullable(),
    note: z.string().max(EXISTING_TX_NOTE_MAX).nullable(),
  })
  .strict();
export type ExistingTxHandoffItem = z.infer<typeof ExistingTxHandoffItemSchema>;

/**
 * The order a treatment coordinator works them in: the ones ready to book
 * first, the ones nobody asked about last.
 */
export const EXISTING_TX_TC_GROUP_ORDER: readonly ExistingTxPatient[] = [
  "ready_to_schedule",
  "see_plan_again",
  "cost_questions",
  "wants_to_wait",
  "declined",
  "not_discussed",
];

/** Items grouped by the patient's answer, in EXISTING_TX_TC_GROUP_ORDER; empty groups dropped. */
export function groupExistingTxForTc<T extends Pick<ExistingTxHandoffItem, "patient">>(
  items: readonly T[],
): { patient: ExistingTxPatient; items: T[] }[] {
  return EXISTING_TX_TC_GROUP_ORDER.map((patient) => ({
    patient,
    items: items.filter((i) => i.patient === patient),
  })).filter((g) => g.items.length > 0);
}
