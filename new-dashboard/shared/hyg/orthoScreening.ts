/**
 * The ortho screening — the hygienist's "green sheet", as data (queue item 33).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A SCREENING, NOT A WORK-UP
 * ═════════════════════════════════════════════════════════════════════════════
 * This is the FAST sheet a hygienist taps during the hygiene visit while the
 * doctor examines, so the treatment coordinator can work the case up, present
 * it and sell it. It is deliberately NOT Beau's full ortho work-up form, which
 * stays his own planning tool. Every answer is a tap except two short optional
 * text boxes, and nothing is required except "Interested?".
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE VOCABULARY, TWO MODULES
 * ═════════════════════════════════════════════════════════════════════════════
 * The hygiene slip stores this object and the TC contract carries it on
 * `TcHygieneIntake.orthoScreening`. Both import it from HERE, and the summary
 * line and the label → value rows are built here too, so the line a hygienist
 * reads above "Send to TC" and the line the TC reads on the case are the same
 * function of the same object. Two renderers would be two vocabularies.
 *
 * Imports zod and nothing else: shared/tc/contract.ts imports this file, and a
 * dependency from here back into either module's contract would be a cycle.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IDS ARE STORED, LABELS ARE SHOWN — AND THE LABELS ARE BEAU'S, VERBATIM
 * ═════════════════════════════════════════════════════════════════════════════
 * Each option is `{ id, label }`, the DONE_TODAY_OPTIONS pattern. Ids are what
 * the jsonb holds, so a label can be reworded without rewriting stored rows.
 * Upper and lower appliances share labels (RMD, MDA) but are separate lists,
 * because a lower RMD and an upper RMD are different appliances.
 *
 * The labels and their order are the approved mockup's (2026-10-05).
 * `hyg-ortho-screening.test.ts` pins every one of them, so a rename, a reorder
 * or an extra option is a red build rather than a drift.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EVERY FIELD CARRIES A `.default()`, AND THAT IS LOAD-BEARING
 * ═════════════════════════════════════════════════════════════════════════════
 * This object rides inside the slip's jsonb, and `visitStore.readSlip` reports
 * a slip this build cannot parse as an EMPTY one. A required field added here
 * later would blank every visit saved before it. Defaults make an older object
 * parse and gain the new key instead — the same rule the clinic-note fields on
 * the slip follow.
 */
import { z } from "zod";

/** One chip: the stored id and the words on it. */
export interface OrthoOption<Id extends string = string> {
  readonly id: Id;
  readonly label: string;
}

/** A zod enum over an option list's ids, in the list's order. */
function enumOf<const T extends readonly [OrthoOption, ...OrthoOption[]]>(options: T) {
  const ids = options.map((o) => o.id) as [T[number]["id"], ...T[number]["id"][]];
  return z.enum(ids);
}

// ─────────────────────────────────────────────────────────────────────────────
// The vocabularies — labels exactly as approved, in the approved order
// ─────────────────────────────────────────────────────────────────────────────

export const ORTHO_INTEREST_OPTIONS = [
  { id: "yes", label: "Yes" },
  { id: "maybe", label: "Maybe" },
  { id: "not_now", label: "Not now" },
] as const;

export const ORTHO_DECIDER_OPTIONS = [
  { id: "patient", label: "Patient decides" },
  { id: "parent", label: "Parent decides" },
] as const;

export const ORTHO_CONCERN_OPTIONS = [
  { id: "crowding", label: "Crowding" },
  { id: "spacing", label: "Spacing" },
  { id: "overbite", label: "Overbite" },
  { id: "underbite", label: "Underbite" },
  { id: "crossbite", label: "Crossbite" },
  { id: "open_bite", label: "Open bite" },
  { id: "protrusion", label: "Protrusion" },
  { id: "midline_off", label: "Midline off" },
  { id: "bite_jaw", label: "Bite / jaw" },
  { id: "snoring_airway", label: "Snoring / airway" },
] as const;

export const ORTHO_ARCH_OPTIONS = [
  { id: "upper", label: "Upper" },
  { id: "lower", label: "Lower" },
  { id: "comprehensive", label: "Comprehensive (both)" },
] as const;

export const ORTHO_MODALITY_OPTIONS = [
  { id: "aligners", label: "Clear aligners" },
  { id: "braces", label: "Traditional braces" },
  { id: "doctor_decides", label: "Doctor to decide" },
] as const;

/** Estimated months. MULTI-select — Beau: "clickable months, allow multiple". */
export const ORTHO_MONTH_OPTIONS = [6, 9, 12, 15, 18, 21, 24, 30, 36] as const;
export type OrthoMonth = (typeof ORTHO_MONTH_OPTIONS)[number];

export const ORTHO_PHASE_OPTIONS = [
  { id: "phase_1", label: "Phase 1" },
  { id: "phase_2", label: "Phase 2" },
] as const;

export const ORTHO_UPPER_APPLIANCE_OPTIONS = [
  { id: "expansion_rpe", label: "Expansion / RPE" },
  { id: "niti_rpe", label: "NiTi RPE" },
  { id: "mda", label: "MDA" },
  { id: "rmd", label: "RMD" },
  { id: "nance", label: "Nance" },
  { id: "reverse_pull_hg", label: "Reverse-pull HG" },
] as const;

export const ORTHO_LOWER_APPLIANCE_OPTIONS = [
  { id: "expansion", label: "Expansion" },
  { id: "lip_bumper", label: "Lip bumper" },
  { id: "lingual_3d", label: "3D lingual" },
  { id: "fla", label: "FLA" },
  { id: "rmd", label: "RMD" },
  { id: "mda", label: "MDA" },
] as const;

export const ORTHO_MYO_OPTIONS = [
  { id: "not_needed", label: "Not needed" },
  { id: "before", label: "Before" },
  { id: "during", label: "During" },
  { id: "after", label: "After" },
] as const;

export const ORTHO_MYO_REASON_OPTIONS = [
  { id: "tongue_thrust", label: "Tongue thrust" },
  { id: "mouth_breathing", label: "Mouth breathing" },
  { id: "low_tongue", label: "Low tongue" },
  { id: "asymmetry", label: "Asymmetry" },
  { id: "airway", label: "Airway" },
] as const;

/** "None" is EXCLUSIVE — see `toggleAfterOrtho` and the schema's refinement. */
export const ORTHO_AFTER_OPTIONS = [
  { id: "none", label: "None" },
  { id: "peg_laterals", label: "Peg laterals" },
  { id: "anterior_bonding", label: "Anterior bonding" },
  { id: "implants", label: "Implants" },
  { id: "pontic_maryland", label: "Pontic / Maryland" },
  { id: "smile_makeover", label: "Smile makeover" },
  { id: "fmr", label: "FMR" },
] as const;

export const ORTHO_RECORD_OPTIONS = [
  { id: "photos", label: "Photos" },
  { id: "pano", label: "Pano" },
  { id: "scan", label: "Scan" },
  { id: "ceph", label: "Ceph" },
] as const;

export const ORTHO_BENEFIT_OPTIONS = [
  { id: "has_benefit", label: "Has ortho benefit" },
  { id: "no_benefit", label: "No ortho benefit" },
  { id: "not_sure", label: "Not sure, TC will verify" },
] as const;

export const ORTHO_CONSULT_OPTIONS = [
  { id: "in_office", label: "In-office consult" },
  { id: "phone", label: "Phone consult" },
  { id: "tc_to_call", label: "TC to call" },
] as const;

/** The two text boxes. Short on purpose — this is a screening, not a chart note. */
export const ORTHO_AFTER_TEETH_MAX = 40;
export const ORTHO_NOTE_MAX = 280;

/**
 * Universal tooth numbers, as typed: 1–32, primary A–T, separated by commas,
 * spaces, `#` or a range dash. Format only — the TC reads it, nothing parses it.
 */
const AFTER_TEETH_PATTERN = /^[0-9A-Ta-t#,\s-]*$/;

// ─────────────────────────────────────────────────────────────────────────────
// The schema
// ─────────────────────────────────────────────────────────────────────────────

export const OrthoInterestSchema = enumOf(ORTHO_INTEREST_OPTIONS);
export const OrthoDeciderSchema = enumOf(ORTHO_DECIDER_OPTIONS);
export const OrthoConcernSchema = enumOf(ORTHO_CONCERN_OPTIONS);
export const OrthoArchSchema = enumOf(ORTHO_ARCH_OPTIONS);
export const OrthoModalitySchema = enumOf(ORTHO_MODALITY_OPTIONS);
export const OrthoPhaseSchema = enumOf(ORTHO_PHASE_OPTIONS);
export const OrthoUpperApplianceSchema = enumOf(ORTHO_UPPER_APPLIANCE_OPTIONS);
export const OrthoLowerApplianceSchema = enumOf(ORTHO_LOWER_APPLIANCE_OPTIONS);
export const OrthoMyoSchema = enumOf(ORTHO_MYO_OPTIONS);
export const OrthoMyoReasonSchema = enumOf(ORTHO_MYO_REASON_OPTIONS);
export const OrthoAfterSchema = enumOf(ORTHO_AFTER_OPTIONS);
export const OrthoRecordSchema = enumOf(ORTHO_RECORD_OPTIONS);
export const OrthoBenefitSchema = enumOf(ORTHO_BENEFIT_OPTIONS);
export const OrthoConsultSchema = enumOf(ORTHO_CONSULT_OPTIONS);

const OrthoMonthSchema = z
  .number()
  .int()
  .refine((n) => (ORTHO_MONTH_OPTIONS as readonly number[]).includes(n), {
    message: `Estimated months must be one of ${ORTHO_MONTH_OPTIONS.join(", ")}`,
  });

/** A many-pick list: no repeats, and never longer than its vocabulary. */
function picks<T extends z.ZodTypeAny>(item: T, max: number) {
  return z
    .array(item)
    .max(max)
    .refine((values) => new Set(values).size === values.length, {
      message: "An option was picked twice",
    })
    .default([]);
}

export const OrthoScreeningSchema = z
  .object({
    interest: OrthoInterestSchema.nullable().default(null),
    decider: OrthoDeciderSchema.nullable().default(null),
    concerns: picks(OrthoConcernSchema, ORTHO_CONCERN_OPTIONS.length),
    arches: OrthoArchSchema.nullable().default(null),
    modality: OrthoModalitySchema.nullable().default(null),
    months: picks(OrthoMonthSchema, ORTHO_MONTH_OPTIONS.length),
    phase: OrthoPhaseSchema.nullable().default(null),
    upperAppliances: picks(OrthoUpperApplianceSchema, ORTHO_UPPER_APPLIANCE_OPTIONS.length),
    lowerAppliances: picks(OrthoLowerApplianceSchema, ORTHO_LOWER_APPLIANCE_OPTIONS.length),
    myo: OrthoMyoSchema.nullable().default(null),
    myoReasons: picks(OrthoMyoReasonSchema, ORTHO_MYO_REASON_OPTIONS.length),
    afterOrtho: picks(OrthoAfterSchema, ORTHO_AFTER_OPTIONS.length).refine(
      (values) => !values.includes("none") || values.length === 1,
      { message: '"None" cannot be picked with other work after ortho' },
    ),
    afterOrthoTeeth: z
      .string()
      .max(ORTHO_AFTER_TEETH_MAX)
      .regex(AFTER_TEETH_PATTERN, "Which teeth takes universal tooth numbers only")
      .default(""),
    recordsToday: picks(OrthoRecordSchema, ORTHO_RECORD_OPTIONS.length),
    orthoBenefit: OrthoBenefitSchema.nullable().default(null),
    consult: OrthoConsultSchema.nullable().default(null),
    /** Optional. A local calendar date, never an instant. */
    bookedFor: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Booked for must be YYYY-MM-DD")
      .nullable()
      .default(null),
    noteForTc: z.string().max(ORTHO_NOTE_MAX).default(""),
  })
  .strict();
export type OrthoScreening = z.infer<typeof OrthoScreeningSchema>;

/** A screening nobody has answered anything on. */
export function emptyOrthoScreening(): OrthoScreening {
  return {
    interest: null,
    decider: null,
    concerns: [],
    arches: null,
    modality: null,
    months: [],
    phase: null,
    upperAppliances: [],
    lowerAppliances: [],
    myo: null,
    myoReasons: [],
    afterOrtho: [],
    afterOrthoTeeth: "",
    recordsToday: [],
    orthoBenefit: null,
    consult: null,
    bookedFor: null,
    noteForTc: "",
  };
}

/**
 * Whether this screening can go to the TC. ONE requirement: "Interested?".
 *
 * A screening with only that answered is still sendable — the TC calls. Nothing
 * else may gate it; the hygienist has a patient in the chair.
 */
export function isOrthoSendable(screening: OrthoScreening | null | undefined): boolean {
  return screening !== null && screening !== undefined && screening.interest !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Editing helpers — pure, so the chip rules are testable without a screen
// ─────────────────────────────────────────────────────────────────────────────

/** A single-pick group: tapping the picked chip again CLEARS it. */
export function pickOne<T extends string>(current: T | null, tapped: T): T | null {
  return current === tapped ? null : tapped;
}

/** A many-pick group: tap adds, tap again removes. Vocabulary order is kept. */
export function toggleMany<T extends string | number>(
  current: readonly T[],
  tapped: T,
  order: readonly T[],
): T[] {
  const next = current.includes(tapped)
    ? current.filter((v) => v !== tapped)
    : [...current, tapped];
  return order.filter((v) => next.includes(v));
}

type AfterId = (typeof ORTHO_AFTER_OPTIONS)[number]["id"];
const AFTER_ORDER: AfterId[] = ORTHO_AFTER_OPTIONS.map((o) => o.id);

/**
 * "After ortho", where "None" is EXCLUSIVE: picking None clears the rest, and
 * picking anything else clears None. A screening that says "None" and
 * "Implants" is two contradictory sentences to a TC.
 */
export function toggleAfterOrtho(current: readonly AfterId[], tapped: AfterId): AfterId[] {
  if (tapped === "none") return current.includes("none") ? [] : ["none"];
  return toggleMany(
    current.filter((v) => v !== "none"),
    tapped,
    AFTER_ORDER,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// What the TC gets — ONE function, used by the hygiene screen and the TC render
// ─────────────────────────────────────────────────────────────────────────────

/** id → label for one option list. An unknown id renders as itself, never blank. */
function labelOf(options: readonly OrthoOption[], id: string): string {
  return options.find((o) => o.id === id)?.label ?? id;
}

function labelsOf(options: readonly OrthoOption[], ids: readonly string[]): string {
  return ids.map((id) => labelOf(options, id)).join(", ");
}

/**
 * Estimated months as a range. One month → `18 mo`; several → `min–max mo`
 * (an EN dash): 18 and 24 → `18–24 mo`; 6, 12 and 36 → `6–36 mo`. None → "".
 */
export function formatOrthoMonths(months: readonly number[]): string {
  if (months.length === 0) return "";
  const lo = Math.min(...months);
  const hi = Math.max(...months);
  return lo === hi ? `${lo} mo` : `${lo}–${hi} mo`;
}

/** "Implants, Anterior bonding #7, #10" — the teeth ride on the after-ortho list. */
function afterOrthoText(s: OrthoScreening): string {
  const work = labelsOf(ORTHO_AFTER_OPTIONS, s.afterOrtho);
  const teeth = s.afterOrthoTeeth.trim();
  if (!work) return teeth ? `Teeth ${teeth}` : "";
  return teeth && !s.afterOrtho.includes("none") ? `${work} (${teeth})` : work;
}

/**
 * The one line "What the TC will get" — and what TC's `suspectedTreatment`
 * carries, so today's text-only TC surfaces show something useful too.
 *
 * Unanswered parts are left out rather than printed as blanks. The note for the
 * TC is NOT in this line; it travels and renders on its own.
 */
export function orthoScreeningSummary(s: OrthoScreening): string {
  const parts: string[] = [];
  if (s.interest !== null) {
    parts.push(
      s.interest === "not_now" ? "Not now" : `Interested: ${labelOf(ORTHO_INTEREST_OPTIONS, s.interest)}`,
    );
  }
  if (s.decider !== null) parts.push(labelOf(ORTHO_DECIDER_OPTIONS, s.decider));
  if (s.concerns.length > 0) parts.push(labelsOf(ORTHO_CONCERN_OPTIONS, s.concerns));
  if (s.arches !== null) parts.push(labelOf(ORTHO_ARCH_OPTIONS, s.arches));
  if (s.modality !== null) parts.push(labelOf(ORTHO_MODALITY_OPTIONS, s.modality));
  const months = formatOrthoMonths(s.months);
  if (months) parts.push(months);
  if (s.phase !== null) parts.push(labelOf(ORTHO_PHASE_OPTIONS, s.phase));
  if (s.upperAppliances.length > 0) {
    parts.push(`Upper: ${labelsOf(ORTHO_UPPER_APPLIANCE_OPTIONS, s.upperAppliances)}`);
  }
  if (s.lowerAppliances.length > 0) {
    parts.push(`Lower: ${labelsOf(ORTHO_LOWER_APPLIANCE_OPTIONS, s.lowerAppliances)}`);
  }
  if (s.myo !== null || s.myoReasons.length > 0) {
    const when = s.myo !== null ? labelOf(ORTHO_MYO_OPTIONS, s.myo) : "";
    const why = labelsOf(ORTHO_MYO_REASON_OPTIONS, s.myoReasons);
    parts.push(`Myo: ${[when, why ? `(${why})` : ""].filter(Boolean).join(" ")}`);
  }
  const after = afterOrthoText(s);
  if (after) parts.push(`After ortho: ${after}`);
  if (s.recordsToday.length > 0) {
    parts.push(`Records today: ${labelsOf(ORTHO_RECORD_OPTIONS, s.recordsToday)}`);
  }
  if (s.orthoBenefit !== null) parts.push(labelOf(ORTHO_BENEFIT_OPTIONS, s.orthoBenefit));
  if (s.consult !== null || s.bookedFor !== null) {
    const consult = s.consult !== null ? labelOf(ORTHO_CONSULT_OPTIONS, s.consult) : "Consult";
    parts.push(s.bookedFor !== null ? `${consult} ${s.bookedFor}` : consult);
  }
  return parts.join(" · ");
}

/** The concerns, joined — TC's `chiefConcern` for an ortho case. */
export function orthoConcernsText(s: OrthoScreening): string {
  return labelsOf(ORTHO_CONCERN_OPTIONS, s.concerns);
}

/** One answered field, as the TC case detail renders it. */
export interface OrthoScreeningRow {
  label: string;
  value: string;
}

/**
 * Every ANSWERED field as label → value, in sheet order. Unanswered fields are
 * omitted rather than shown blank: a blank row reads as "the hygienist said
 * nothing", which is not the same as "the hygienist was not asked". The note
 * for the TC is not a row; it renders on its own.
 */
export function orthoScreeningRows(s: OrthoScreening): OrthoScreeningRow[] {
  const rows: OrthoScreeningRow[] = [];
  const add = (label: string, value: string) => {
    if (value) rows.push({ label, value });
  };
  add("Interested?", s.interest !== null ? labelOf(ORTHO_INTEREST_OPTIONS, s.interest) : "");
  add("Who decides?", s.decider !== null ? labelOf(ORTHO_DECIDER_OPTIONS, s.decider) : "");
  add("Concerns", labelsOf(ORTHO_CONCERN_OPTIONS, s.concerns));
  add("Which arches?", s.arches !== null ? labelOf(ORTHO_ARCH_OPTIONS, s.arches) : "");
  add("Aligners or braces?", s.modality !== null ? labelOf(ORTHO_MODALITY_OPTIONS, s.modality) : "");
  add("Estimated months", formatOrthoMonths(s.months));
  add("Phase (if staged)", s.phase !== null ? labelOf(ORTHO_PHASE_OPTIONS, s.phase) : "");
  add("Upper appliances", labelsOf(ORTHO_UPPER_APPLIANCE_OPTIONS, s.upperAppliances));
  add("Lower appliances", labelsOf(ORTHO_LOWER_APPLIANCE_OPTIONS, s.lowerAppliances));
  add("Myo therapy", s.myo !== null ? labelOf(ORTHO_MYO_OPTIONS, s.myo) : "");
  add("Myo — why", labelsOf(ORTHO_MYO_REASON_OPTIONS, s.myoReasons));
  add("After ortho", labelsOf(ORTHO_AFTER_OPTIONS, s.afterOrtho));
  add("Which teeth", s.afterOrthoTeeth.trim());
  add("Records taken today", labelsOf(ORTHO_RECORD_OPTIONS, s.recordsToday));
  add("Ortho benefit", s.orthoBenefit !== null ? labelOf(ORTHO_BENEFIT_OPTIONS, s.orthoBenefit) : "");
  add("Consult", s.consult !== null ? labelOf(ORTHO_CONSULT_OPTIONS, s.consult) : "");
  add("Booked for", s.bookedFor ?? "");
  return rows;
}
