/**
 * The hygiene module's shared contract — zod first, types derived.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE SOURCE OF TRUTH, AND WHICH DIRECTION IT POINTS
 * ═════════════════════════════════════════════════════════════════════════════
 * Every shape below is declared as a zod schema and its TypeScript type is
 * `z.infer` of that schema — never the other way round. A hand-written
 * `interface` beside a schema is two declarations that can disagree, and the
 * direction they disagree in is a runtime value the compiler already promised
 * could not exist.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHERE THIS IS ENFORCED, AND WHERE IT DELIBERATELY IS NOT (H1 slice 1)
 * ═════════════════════════════════════════════════════════════════════════════
 * The CLIENT parses every /api/hyg response through `HygDayResponse` before a
 * component sees it, so a backend that drifts from this file is a visible,
 * localised failure at the boundary rather than an `undefined` three components
 * deep.
 *
 * The BACKEND does not execute these schemas, and that is a decision rather
 * than an omission. It is CommonJS with no build step, so the only way it can
 * run zod is the committed esbuild bundle TC uses (backend/tc/contract.gen.cjs,
 * 650KB, plus a byte-compare drift test that this repo's CLAUDE.md already
 * documents as fragile under a plain `pnpm install`). Slice 1's entire request
 * surface is two query params — an office from a frozen two-item list and a
 * calendar date — which the route validates in eight lines, and everything
 * else crossing the wire is a RESPONSE the client parses here. A second 650KB
 * bundle would double a known-fragile guard to validate two strings.
 *
 * When slice 2 adds request BODIES (the routing slip, the staged writes), that
 * trade flips: a body is where a client and a server most need the same
 * schema, and the bundle should be added then. `hyg-contract.test.ts` pins the
 * backend's response keys against this file in the meantime, so the two cannot
 * drift silently while the bundle is absent.
 */
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Offices
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The frozen internal office keys, mirroring backend/routes/hyg/helpers.js.
 *
 * `valley` is internally the Fort Smith office branded Riley; the KEY stays
 * frozen even though the office is not called Valley any more, because it is a
 * database identity rather than a label. `unknown` is deliberately absent: it
 * has no Open Dental database, so it is not somewhere a day can be read from.
 */
export const OfficeIdSchema = z.enum(["roland", "valley"]);
export type OfficeId = z.infer<typeof OfficeIdSchema>;

export const OFFICE_IDS = OfficeIdSchema.options;

export function isOfficeId(value: unknown): value is OfficeId {
  return OfficeIdSchema.safeParse(value).success;
}

// ─────────────────────────────────────────────────────────────────────────────
// Treatment vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ PRIORITY AND CATEGORY ARE DIFFERENT AXES. ⚠️
 *
 * Priority answers "how soon"; category answers "what kind of dentistry". They
 * have almost collided once already: the prototype's `TreatmentCategory`
 * contains `"Cosmetic"`, and Beau's real priority vocabulary contains
 * `"cosmetic"`. A cosmetic veneer is a Cosmetic-category item; a cosmetic
 * PRIORITY is a statement that it can wait. Letting one flow into the other
 * would put "this can wait" on a chart because somebody picked a category.
 *
 * Two things stop that, and neither is the casing:
 *   - `hyg-contract.test.ts` asserts the two vocabularies are disjoint
 *     CASE-INSENSITIVELY, so lowercasing the category union later — the
 *     obvious future tidy-up — fails the build instead of opening the hole.
 *   - The same file carries a type-level assertion that neither union is
 *     assignable to the other.
 */

/**
 * How soon this needs doing — Beau's ruling, and the words his offices already
 * use out loud.
 *
 * THIS REPLACES THE PROTOTYPE'S P1–P4 ENTIRELY. P1–P4 does not ship. The
 * prototype also carried a second, parallel scale (Routine / Soon / Urgent) for
 * the TC handoff; one vocabulary, this one, is what a hygienist says and what
 * the slip prints.
 *
 * "Watch" is NOT here. It is a STATUS — the item exists and nobody is doing
 * anything about it yet — and it already lives in `TreatmentStatus`. A watch
 * with an urgency would be two contradictory sentences on one row.
 */
export const TreatmentPrioritySchema = z.enum(["urgent", "preventative", "cosmetic"]);
export type TreatmentPriority = z.infer<typeof TreatmentPrioritySchema>;

/** Display order and labels, so no screen invents its own. */
export const TREATMENT_PRIORITY_LABELS: Record<TreatmentPriority, string> = {
  urgent: "Urgent",
  preventative: "Preventative",
  cosmetic: "Cosmetic",
};

/**
 * What kind of dentistry this is. The prototype's union, unchanged — it feeds
 * `deriveCategory` below, which is what removes the manual category pick from
 * the TC handoff.
 */
export const TreatmentCategorySchema = z.enum([
  "Restorative",
  "Endo",
  "Surgery",
  "Perio",
  "Prosth",
  "Ortho",
  "Cosmetic",
  "Other",
]);
export type TreatmentCategory = z.infer<typeof TreatmentCategorySchema>;

/**
 * Where an item is in its life, independent of both axes above.
 *
 * `watch` lives HERE and only here. See the priority note.
 */
export const TreatmentStatusSchema = z.enum(["proposed", "watch", "confirmed", "scheduled"]);
export type TreatmentStatus = z.infer<typeof TreatmentStatusSchema>;

/** Tooth surfaces as a PERIO chart names them (six sites per tooth). */
export const ToothSurfaceSchema = z.enum(["DB", "B", "MB", "DL", "L", "ML"]);
export type ToothSurface = z.infer<typeof ToothSurfaceSchema>;

/**
 * Tooth surfaces as a RESTORATIVE plan names them (MOD, MOB, …).
 *
 * A separate union from `ToothSurface` on purpose: "B" means the same face in
 * both, but the SETS are different and a perio site code is not a valid
 * restoration surface. Merging them would let "ML" reach a composite.
 */
export const ToothSurfaceLabelSchema = z.enum(["M", "O", "D", "B", "L"]);
export type ToothSurfaceLabel = z.infer<typeof ToothSurfaceLabelSchema>;

/**
 * The diagnosis shorthand from the paper routing slip, verbatim. These are the
 * letters already written by hand on the slip every day; the app's job is to
 * accept them, not to improve them.
 */
export const DxCodeSchema = z.enum([
  "I", "D", "RD", "XD", "E", "AB", "EXCR", "FX", "CR", "PAIN",
  "RCT", "MISS", "OM", "N", "LF", "SAP", "AT", "OH", "UE", "GR",
]);
export type DxCode = z.infer<typeof DxCodeSchema>;

export const DX_LABELS: Record<DxCode, string> = {
  I: "Incipient lesion",
  D: "Decay",
  RD: "Recurrent decay",
  XD: "Extensive decay",
  E: "Existing defective restoration",
  AB: "Abscess",
  EXCR: "Existing crack",
  FX: "Fracture",
  CR: "Cracked tooth",
  PAIN: "Pain / sensitivity",
  RCT: "Needs root canal treatment",
  MISS: "Missing tooth",
  OM: "Open margin",
  N: "Necrosis",
  LF: "Leaking filling",
  SAP: "Symptomatic apical periodontitis",
  AT: "Attrition",
  OH: "Poor oral hygiene",
  UE: "Unesthetic",
  GR: "Gingival recession",
};

/** Why the patient might say yes — the other half of the paper slip. */
export const MotivationCodeSchema = z.enum([
  "FF", "R", "esthetic", "pain", "function", "insurance", "other",
]);
export type MotivationCode = z.infer<typeof MotivationCodeSchema>;

export const MOTIVATION_LABELS: Record<MotivationCode, string> = {
  FF: "Failing filling",
  R: "Patient request",
  esthetic: "Esthetic concern",
  pain: "Pain",
  function: "Function",
  insurance: "Insurance renewal / benefit",
  other: "Other",
};

/**
 * The category a TC handoff is filed under. A SMALLER vocabulary than
 * `TreatmentCategory` — a treatment coordinator's pipeline does not distinguish
 * endo from surgery, and `deriveCategory` below is what folds one into the other.
 */
export const HandoffCategorySchema = z.enum([
  "Restorative", "Perio", "Ortho", "Cosmetic", "Implant", "Other",
]);
export type HandoffCategory = z.infer<typeof HandoffCategorySchema>;

/**
 * One thing a hygienist proposes. The unit the Router produces, the slip
 * prints, the Findings tab reads and the TC handoff carries — ONE list on the
 * visit, not four.
 *
 * `teeth` is either a list of universal tooth numbers or the literal "mouth"
 * for something that has no tooth (oral hygiene instruction, a whitening
 * consult). Modelling "whole mouth" as an empty array would make "no teeth
 * selected yet" and "this is a whole-mouth item" the same value.
 */
export const TreatmentItemSchema = z.object({
  id: z.string().min(1),
  teeth: z.union([z.array(z.number().int()), z.literal("mouth")]),
  /** e.g. "Comp", "Crown", "RC", "EX", "IMP", "Ortho", "Aligners". */
  code: z.string().min(1),
  category: TreatmentCategorySchema,
  surfaces: z.array(ToothSurfaceLabelSchema).optional(),
  dx: z.array(DxCodeSchema),
  dxNote: z.string().optional(),
  priority: TreatmentPrioritySchema,
  motivation: z.array(MotivationCodeSchema),
  motivationNote: z.string().optional(),
  status: TreatmentStatusSchema,
  crownType: z.enum(["initial", "replacement"]).optional(),
  prosthesis: z
    .object({ newOrReplacement: z.enum(["new", "replacement"]), years: z.string().optional() })
    .optional(),
  scheduleNext: z.boolean(),
  note: z.string().optional(),
  photos: z.array(z.string()),
  /** Free-form markers, e.g. "post-ortho". */
  tags: z.array(z.string()).optional(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type TreatmentItem = z.infer<typeof TreatmentItemSchema>;

/**
 * Which handoff category wins when a visit proposes several kinds of work.
 *
 * Ortho first because an ortho case is a different conversation from everything
 * else on this list; Implant next because it is the one restorative case a
 * treatment coordinator preps differently. `Other` is last and is the answer
 * for an empty list — a visit that proposed nothing has no category, and
 * guessing "Restorative" for it would put an empty case in a real queue.
 */
const HANDOFF_CATEGORY_PRIORITY: HandoffCategory[] = [
  "Ortho",
  "Implant",
  "Restorative",
  "Cosmetic",
  "Perio",
  "Other",
];

/**
 * The single handoff category that best represents a set of treatment items.
 *
 * Ported from the prototype unchanged. It is what removes the manual category
 * pick from the handoff: a hygienist has already said what each item IS, and
 * asking her to also classify the visit is asking the same question twice and
 * accepting two answers.
 */
export function deriveCategory(items: readonly TreatmentItem[]): HandoffCategory {
  if (items.length === 0) return "Other";
  const present = new Set<HandoffCategory>();
  for (const item of items) {
    if (item.category === "Prosth") {
      present.add(item.code === "IMP" || item.code === "Mini" ? "Implant" : "Restorative");
    } else if (item.category === "Endo" || item.category === "Surgery") {
      present.add("Restorative");
    } else if (item.category === "Cosmetic") {
      present.add("Cosmetic");
    } else if (item.category === "Ortho") {
      present.add("Ortho");
    } else if (item.category === "Perio") {
      present.add("Perio");
    } else {
      present.add("Other");
    }
  }
  return HANDOFF_CATEGORY_PRIORITY.find((c) => present.has(c)) ?? "Other";
}

// ─────────────────────────────────────────────────────────────────────────────
// Staged writes — the "nothing writes automatically" model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a staged write is FOR. Kept from the prototype as a contract rather than
 * as mock data: slice 2 turns this into rows in `hyg_staged_write`, and slice 3
 * turns `Sending` into a real Open Dental call.
 */
export const StagedWriteKindSchema = z.enum(["router", "perio", "note", "tc-handoff"]);
export type StagedWriteKind = z.infer<typeof StagedWriteKindSchema>;

/**
 * The lifecycle, and the reason this module has one at all.
 *
 * Draft → Staged → Sending → Written | Failed. `Written` is only ever reached
 * after a READ-BACK confirms the write landed — the platform's honest-states
 * rule, and the reason RCM's drain reads a chart after posting to it. A failed
 * send never looks sent.
 */
export const StagedWriteStateSchema = z.enum([
  "Draft",
  "Staged",
  "Sending",
  "Written",
  "Failed",
]);
export type StagedWriteState = z.infer<typeof StagedWriteStateSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/hyg/day
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether a flag on a card is a real answer or an unasked question.
 *
 * `od` — we asked Open Dental; the value is true, false, or null because the
 *        patient record could not be read.
 * `not_read` — this slice does not read this flag at all. The value can only be
 *        null, and a screen must not render it as "no".
 */
export const FlagSourceSchema = z.enum(["od", "not_read"]);
export type FlagSource = z.infer<typeof FlagSourceSchema>;

/**
 * The chairside flags, EVERY ONE NULLABLE.
 *
 * A null is "unknown", and unknown is a third state the UI must render as such.
 * "This patient does not need premedication" and "we could not find out" are
 * different sentences, and a screen a hygienist reads before putting
 * instruments in someone's mouth is the last place to conflate them.
 */
export const HygDayFlagsSchema = z.object({
  premed: z.boolean().nullable(),
  medicalAlerts: z.boolean().nullable(),
  allergies: z.boolean().nullable(),
  lastPerioDate: z.string().nullable(),
  xraysDue: z.boolean().nullable(),
  examNeeded: z.boolean().nullable(),
  openTcCase: z.boolean().nullable(),
});
export type HygDayFlags = z.infer<typeof HygDayFlagsSchema>;

/** One chair. */
export const HygOperatorySchema = z.object({
  opNum: z.number().int(),
  name: z.string().nullable(),
  abbrev: z.string().nullable(),
  isHygiene: z.boolean().nullable(),
  itemOrder: z.number().int().nullable(),
});
export type HygOperatory = z.infer<typeof HygOperatorySchema>;

/** One appointment on the day. */
export const HygAppointmentSchema = z.object({
  aptNum: z.number().int().nullable(),
  /**
   * MEANINGLESS WITHOUT `office`. PatNum numbering restarts in every Open
   * Dental database: 7115 is the valley test patient and a different, real
   * person in roland. Nothing may carry one of these without the office beside it.
   */
  patNum: z.number().int().nullable(),
  /** Null when the patient record could not be read. Never "Unknown Patient". */
  patientName: z.string().nullable(),
  /** Open Dental local time, `YYYY-MM-DD HH:mm:ss`. Not a UTC instant. */
  start: z.string().nullable(),
  /** Null when the appointment carries no Pattern. Never a fabricated 30. */
  lengthMin: z.number().int().nullable(),
  opNum: z.number().int().nullable(),
  opName: z.string().nullable(),
  /** The APPOINTMENT's own hygiene flag — authoritative for "is this a hygiene visit". */
  isHygiene: z.boolean().nullable(),
  /** The CHAIR's hygiene flag. Can disagree with the above; both are carried. */
  opIsHygiene: z.boolean().nullable(),
  provNum: z.number().int().nullable(),
  provHyg: z.number().int().nullable(),
  providerName: z.string().nullable(),
  apptTypeLabel: z.string().nullable(),
  /**
   * The RESOLVED confirmation string Open Dental ships beside the DefNum
   * ("Confirmed", "In Treatment Room"). The DefNum itself is per-office and is
   * deliberately not in this contract — nothing may compare one across offices.
   */
  confirmedStatus: z.string().nullable(),
  aptStatus: z.string().nullable(),
  isNewPatient: z.boolean().nullable(),
  flags: HygDayFlagsSchema,
});
export type HygAppointment = z.infer<typeof HygAppointmentSchema>;

/** Something the server could not fetch, in words a screen can render. */
export const HygWarningSchema = z.object({
  resource: z.string(),
  message: z.string(),
});
export type HygWarning = z.infer<typeof HygWarningSchema>;

/**
 * A successful day.
 *
 * `success: true` and an empty `appointments` means, and only means, that
 * nobody is booked. Every way of failing to know is a non-2xx with a code — see
 * `HygErrorSchema` and backend/routes/hyg/day.js.
 */
export const HygDayResponseSchema = z.object({
  success: z.literal(true),
  office: OfficeIdSchema,
  officeName: z.string(),
  date: z.string(),
  operatories: z.array(HygOperatorySchema),
  appointments: z.array(HygAppointmentSchema),
  warnings: z.array(HygWarningSchema),
  flagSources: z.record(z.string(), FlagSourceSchema),
  excludedByStatus: z.number().int(),
  /** The SCHEDULE is incomplete — an appointment is missing from this payload. */
  truncated: z.boolean(),
  /** Every appointment is here; some carry no name. A different fact. */
  patientNamesTruncated: z.boolean(),
});
export type HygDayResponse = z.infer<typeof HygDayResponseSchema>;

/**
 * Every refusal shape /api/hyg can return.
 *
 * `error` carries the sentence a screen shows. `code` is what it switches on.
 * MODULE_NOT_ENTITLED is the platform's own denial and arrives in `error`
 * rather than `code` (backend/middleware/tenantContext.js) — the client
 * normalises it, which is why `code` is optional here.
 */
export const HygErrorSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
  /** The precise odOffices reason behind an OFFICE_NOT_READY. */
  reason: z.string().optional(),
  office: z.string().optional(),
  date: z.string().optional(),
});
export type HygError = z.infer<typeof HygErrorSchema>;

/** The refusal codes slice 1 can produce, for exhaustive UI handling. */
export const HYG_ERROR_CODES = [
  "INVALID_OFFICE",
  "INVALID_DATE",
  "OFFICE_NOT_READY",
  "OD_READ_FAILED",
  "MODULE_NOT_ENTITLED",
  "FORBIDDEN",
  "AUDIT_FAILED",
  "INTERNAL_ERROR",
] as const;
export type HygErrorCode = (typeof HYG_ERROR_CODES)[number];
