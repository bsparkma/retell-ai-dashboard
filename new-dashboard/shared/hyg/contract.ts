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
 * THE BACKEND NOW EXECUTES THESE SCHEMAS TOO (H1 slice 2). It is CommonJS with
 * no build step, so it reaches them through a COMMITTED esbuild bundle —
 * backend/hyg/contract.gen.cjs, built from backend/hyg/contract.entry.ts, the
 * same mechanism TC has used since its slice 3. Slice 1 deliberately shipped
 * without it: its whole request surface was two query params, and a second
 * 650KB bundle to validate two strings was not worth doubling a known-fragile
 * byte-compare guard.
 *
 * Slice 2 flipped that trade, because slice 2 introduces request BODIES and
 * those bodies become chart writes one slice later. A body is exactly where a
 * client and a server most need the same schema, and "the client validated it"
 * is not a statement the server may rely on — see the REQUEST BODIES section
 * below. Regenerate the bundle whenever this file changes; the drift guard is
 * new-dashboard/tests/hyg-contract-bundle.test.ts and a stale bundle is a red
 * build rather than a discovery.
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
 * What one day read COST, in counts and milliseconds.
 *
 * Never a PatNum and never a name — a cost summary must not become a list of
 * who was seen. It is in the response rather than only in the log so a
 * before/after can be measured with one request instead of a log query, which
 * is the difference between "it should be faster" and a number.
 *
 * `patientsRequested = patientCacheHits + patientCacheDeduped + odPatientReads`
 * always holds, so cache MISSES need no field of their own: they are exactly
 * `odPatientReads`. Open Dental throttles at one request per second per
 * credential, so `odListReads + odPatientReads` is very close to the wall clock
 * in seconds.
 */
export const HygDayStatsSchema = z.object({
  /** Requests spent on list endpoints — appointments, operatories, types, providers. */
  odListReads: z.number().int(),
  /** `GET /patients/{PatNum}` requests actually issued. One second each. */
  odPatientReads: z.number().int(),
  /** Distinct patients this day needed named, after the fan-out cap. */
  patientsRequested: z.number().int(),
  /** Answered from a fresh cached record — no Open Dental request at all. */
  patientCacheHits: z.number().int(),
  /** Collapsed into an identical read already in flight — also no request. */
  patientCacheDeduped: z.number().int(),
  durationMs: z.number().int(),
});
export type HygDayStats = z.infer<typeof HygDayStatsSchema>;

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
  /** What this read cost. See HygDayStatsSchema. */
  stats: HygDayStatsSchema,
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

// ─────────────────────────────────────────────────────────────────────────────
// The routing slip (H1 slice 2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A yes/no a hygienist ticked. `null` — the field's absence from the slip —
 * means nobody has answered, and the two are never the same thing.
 */
export const YesNoSchema = z.enum(["yes", "no"]);
export type YesNo = z.infer<typeof YesNoSchema>;

/** Where one of the records a treatment needs currently stands. */
export const RecordStatusSchema = z.enum(["needed", "on_file", "taken_today"]);
export type RecordStatus = z.infer<typeof RecordStatusSchema>;

export const RECORD_STATUS_LABELS: Record<RecordStatus, string> = {
  needed: "Needed",
  on_file: "On file",
  taken_today: "Taken today",
};

/** Whether the doctor exam happened, is due, or is not owed today. */
export const ExamStatusSchema = z.enum(["needed_today", "completed", "not_due"]);
export type ExamStatus = z.infer<typeof ExamStatusSchema>;

export const EXAM_STATUS_LABELS: Record<ExamStatus, string> = {
  needed_today: "Needed today",
  completed: "Completed",
  not_due: "Not due",
};

/** The 2017 AAP staging, as the slip writes it. */
export const PerioStageSchema = z.enum([
  "health",
  "gingivitis",
  "stage_i",
  "stage_ii",
  "stage_iii",
  "stage_iv",
]);
export type PerioStage = z.infer<typeof PerioStageSchema>;

export const PERIO_STAGE_LABELS: Record<PerioStage, string> = {
  health: "Health",
  gingivitis: "Gingivitis",
  stage_i: "Stage I",
  stage_ii: "Stage II",
  stage_iii: "Stage III",
  stage_iv: "Stage IV",
};

export const PerioGradeSchema = z.enum(["a", "b", "c"]);
export type PerioGrade = z.infer<typeof PerioGradeSchema>;

/** What was done in the chair today. Chip ids, so no screen invents its own. */
export const DONE_TODAY_OPTIONS = [
  { id: "prophy", label: "Prophy" },
  { id: "srp-ur", label: "SRP UR" },
  { id: "srp-ul", label: "SRP UL" },
  { id: "srp-lr", label: "SRP LR" },
  { id: "srp-ll", label: "SRP LL" },
  { id: "fluoride", label: "Fluoride" },
  { id: "sealants", label: "Sealants" },
  { id: "irrigation", label: "Irrigation" },
  { id: "polish", label: "Polish" },
] as const;

export const XRAY_OPTIONS = ["FMX", "PANO", "BW-4", "BW-2", "PA"] as const;

/**
 * The next hygiene visit the front desk should book.
 *
 * Every field is nullable because the slip is filled DURING a visit, not after
 * it: a half-filled slip is the normal state of this object for most of an
 * hour, and a schema that refused one would refuse every save but the last.
 */
export const NextVisitSchema = z
  .object({
    type: z.string().max(120).nullable(),
    intervalMonths: z.number().int().min(1).max(24).nullable(),
    lengthMin: z.number().int().min(5).max(240).nullable(),
    withDoctor: z.boolean(),
  })
  .strict();
export type NextVisit = z.infer<typeof NextVisitSchema>;

/**
 * The routing slip: the paper form, as one object.
 *
 * ⚠️ `recareScheduled` and `txEnteredInOd` ARE ORDINARY FIELDS. ⚠️
 *
 * The prototype's Finish tab treated both as blocking gates — `Send all` was
 * disabled until they were answered. Beau's ruling, verbatim: *"the hygienist
 * should be able to send the treatment to the tc app."* Both describe work the
 * FRONT DESK does after the hygienist has finished, so gating on them makes a
 * hygienist wait on somebody else's task while a patient sits in the chair.
 * They render an unobtrusive reminder when unanswered and nothing more.
 * Nothing in this module may hard-gate a send on a completeness check, and
 * `hyg-visit.test.ts` and `hygVisitStage.test.js` both pin it.
 *
 * `.strict()` is deliberate: an unknown key is a 400 naming the key rather
 * than a silently-dropped field. A slip that quietly loses what somebody typed
 * is worse than one that refuses to save.
 */
export const HygSlipSchema = z
  .object({
    /** Chip ids from DONE_TODAY_OPTIONS. */
    doneToday: z.array(z.string().min(1).max(60)),
    doneTodayNote: z.string().max(4000),
    xrayTypes: z.array(z.string().min(1).max(20)),
    examStatus: ExamStatusSchema.nullable(),
    perioStage: PerioStageSchema.nullable(),
    perioGrade: PerioGradeSchema.nullable(),
    patientConcerns: z.string().max(4000),
    hygieneFindings: z.string().max(4000),
    nextVisit: NextVisitSchema,
    /** A reminder when unanswered. NEVER a gate. See the note above. */
    recareScheduled: YesNoSchema.nullable(),
    /** A reminder when unanswered. NEVER a gate. See the note above. */
    txEnteredInOd: YesNoSchema.nullable(),
    frontDeskNote: z.string().max(4000),
    financialNote: z.string().max(4000),
    productsDispensed: z.array(z.string().min(1).max(120)),
    /** Keyed by the record label RECORDS_MATRIX produces. */
    recordsStatus: z.record(z.string(), RecordStatusSchema),
  })
  .strict();
export type HygSlip = z.infer<typeof HygSlipSchema>;

/**
 * An empty slip.
 *
 * Exported so the server can persist a real object on first open and the
 * client can render one before the first save — one definition, because two
 * would drift and the drift would look like data loss.
 */
export function emptySlip(): HygSlip {
  return {
    doneToday: [],
    doneTodayNote: "",
    xrayTypes: [],
    examStatus: null,
    perioStage: null,
    perioGrade: null,
    patientConcerns: "",
    hygieneFindings: "",
    nextVisit: { type: null, intervalMonths: null, lengthMin: null, withDoctor: false },
    recareScheduled: null,
    txEnteredInOd: null,
    frontDeskNote: "",
    financialNote: "",
    productsDispensed: [],
    recordsStatus: {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST BODIES — the schemas the BACKEND runs (H1 slice 2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A treatment item as a CLIENT may send it.
 *
 * `id`, `createdBy` and `createdAt` are omitted because they are the server's
 * to mint. A client that could choose an item's id could overwrite another
 * visit's row, and a client that could choose `createdBy` could put somebody
 * else's name on a proposal that ends up on a chart.
 */
export const TreatmentItemInputSchema = TreatmentItemSchema.omit({
  id: true,
  createdBy: true,
  createdAt: true,
}).strict();
export type TreatmentItemInput = z.infer<typeof TreatmentItemInputSchema>;

/** PUT /api/hyg/visit/:aptNum — the slip, whole. */
export const VisitUpsertRequestSchema = z.object({ slip: HygSlipSchema }).strict();
export type VisitUpsertRequest = z.infer<typeof VisitUpsertRequestSchema>;

/** POST /api/hyg/visit/:aptNum/items */
export const TreatmentItemCreateRequestSchema = TreatmentItemInputSchema;

/**
 * PUT /api/hyg/visit/:aptNum/items/:itemId — a partial edit.
 *
 * Partial rather than whole-object so a tooth toggle is one field on the wire;
 * the server merges onto the stored row and re-validates the RESULT, so a
 * partial body can never assemble an item the whole-object schema would refuse.
 */
export const TreatmentItemUpdateRequestSchema = TreatmentItemInputSchema.partial();
export type TreatmentItemUpdateRequest = z.infer<typeof TreatmentItemUpdateRequestSchema>;

/**
 * POST /api/hyg/visit/:aptNum/staged-writes — stage one kind.
 *
 * ⚠️ THE BODY CARRIES ONLY THE KIND. ⚠️ The title, the summary, the preview
 * lines and the payload are all composed SERVER-SIDE from the stored visit.
 * That is the fix for RCM audit finding F3 ("confirm gates client-side only;
 * submit paths never re-check and record no user") and it is what makes slice
 * 3's rule — the preview IS the write — expressible at all: a payload the
 * client supplied is a payload the client can change after the preview.
 */
export const StagedWriteCreateRequestSchema = z
  .object({ kind: StagedWriteKindSchema })
  .strict();
export type StagedWriteCreateRequest = z.infer<typeof StagedWriteCreateRequestSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/hyg/visit/:aptNum
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One staged write, as the server reports it.
 *
 * `state` is READ-ONLY over the wire. There is no request schema anywhere in
 * this contract that accepts a `state`, and that is the point: `Sending`,
 * `Written` and `Failed` are reached by the SERVER, in slice 3, after Open
 * Dental answers. A client that could post `Written` could make a failed write
 * look sent, which is the exact failure the honest-states rule exists for.
 */
export const StagedWriteSchema = z.object({
  id: z.string().min(1),
  kind: StagedWriteKindSchema,
  state: StagedWriteStateSchema,
  title: z.string(),
  summary: z.string(),
  /** The lines a hygienist reads before confirming. Slice 3 sends exactly these. */
  preview: z.array(z.string()),
  /**
   * A fingerprint of `preview`, computed by the server.
   *
   * THE PREVIEW IS THE WRITE. A send names the fingerprint of what the
   * hygienist actually read, the server recomputes it from the stored row, and
   * a mismatch refuses the WHOLE send. Without it, anything that re-stages
   * between the preview and the confirm — her own edit in another tab, a second
   * device — would send words nobody approved.
   */
  previewFingerprint: z.string(),
  /** Why it failed, when it did. Null in every other state. */
  errorMessage: z.string().nullable(),
  /**
   * What Open Dental (or TC) minted, once it landed: `Document 4711`,
   * `Case 8f3c…`. Null until then. A pointer a person can follow — the
   * difference between "it was sent" and "here is where it went".
   */
  writtenRef: z.string().nullable(),
  stagedBy: z.string().nullable(),
  stagedAt: z.string().nullable(),
  sentBy: z.string().nullable(),
  sentAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type StagedWrite = z.infer<typeof StagedWriteSchema>;

/** The whole visit: the slip, the items, and what is staged. */
export const HygVisitSchema = z.object({
  visitId: z.string().min(1),
  office: OfficeIdSchema,
  aptNum: z.number().int(),
  /** MEANINGLESS WITHOUT `office` — see HygAppointmentSchema. */
  patNum: z.number().int(),
  visitDate: z.string().nullable(),
  slip: HygSlipSchema,
  items: z.array(TreatmentItemSchema),
  stagedWrites: z.array(StagedWriteSchema),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string(),
});
export type HygVisit = z.infer<typeof HygVisitSchema>;

export const HygVisitResponseSchema = z.object({
  success: z.literal(true),
  visit: HygVisitSchema,
  /** Every record the proposed treatments need, from RECORDS_MATRIX. */
  recordsNeeded: z.array(z.string()),
  /** The handoff category deriveCategory() computes from the items. */
  handoffCategory: HandoffCategorySchema,
});
export type HygVisitResponse = z.infer<typeof HygVisitResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/hyg/visit/:aptNum/send  (H1 slice 3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A confirmation: one kind, and the fingerprint of the preview the hygienist
 * read before pressing send.
 *
 * The fingerprint is not decoration. The server recomputes it from the stored
 * row and refuses the whole send on a mismatch, which is what makes "the
 * preview IS the write" a property rather than an intention.
 */
export const SendConfirmationSchema = z
  .object({
    kind: StagedWriteKindSchema,
    previewFingerprint: z.string().min(1).max(200),
  })
  .strict();
export type SendConfirmation = z.infer<typeof SendConfirmationSchema>;

/**
 * POST /api/hyg/visit/:aptNum/send
 *
 * `.strict()`, and it carries NO payload — only which kinds are being confirmed
 * and what they looked like. Everything that reaches Open Dental is built
 * server-side from the row that was staged.
 */
export const SendVisitRequestSchema = z
  .object({ confirm: z.array(SendConfirmationSchema).min(1).max(4) })
  .strict();
export type SendVisitRequest = z.infer<typeof SendVisitRequestSchema>;

/**
 * What one write did.
 *
 * A VISIT IS NEVER "SENT". Its individual writes are, and partial success is
 * the normal case: the note can land and the slip fail. Every entry carries its
 * own outcome, and the summary below counts rather than concludes.
 */
export const SendOutcomeSchema = z.object({
  kind: StagedWriteKindSchema,
  state: StagedWriteStateSchema,
  /** Present when it landed. */
  writtenRef: z.string().nullable(),
  /** Present when it did not. Never empty when the state is Failed. */
  errorMessage: z.string().nullable(),
  /** The precise reason, for a screen that wants to switch on it. */
  code: z.string().nullable(),
});
export type SendOutcome = z.infer<typeof SendOutcomeSchema>;

export const HygSendResponseSchema = z.object({
  success: z.literal(true),
  visit: HygVisitSchema,
  recordsNeeded: z.array(z.string()),
  handoffCategory: HandoffCategorySchema,
  /** One entry per confirmed kind, in the order they were attempted. */
  outcomes: z.array(SendOutcomeSchema),
  /** Counts, not a verdict. `written + failed` is what was attempted. */
  written: z.number().int(),
  failed: z.number().int(),
});
export type HygSendResponse = z.infer<typeof HygSendResponseSchema>;

/** The refusal codes slice 2 adds on top of HYG_ERROR_CODES. */
export const HYG_VISIT_ERROR_CODES = [
  "INVALID_APT_NUM",
  "INVALID_BODY",
  "APPOINTMENT_NOT_ON_DAY",
  "APPOINTMENT_HAS_NO_PATIENT",
  "VISIT_NOT_FOUND",
  "ITEM_NOT_FOUND",
  "STAGED_WRITE_NOT_FOUND",
  "STAGED_WRITE_IMMUTABLE",
  "STAGED_WRITE_KIND_UNAVAILABLE",
  "NOTHING_TO_STAGE",
  // Slice 3.
  "PREVIEW_CHANGED",
  "NOTHING_TO_SEND",
  "NOT_STAGED",
] as const;
export type HygVisitErrorCode = (typeof HYG_VISIT_ERROR_CODES)[number];
