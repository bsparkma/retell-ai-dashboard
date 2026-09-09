/**
 * The practice's own hygiene auto notes, re-stated as data.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ═════════════════════════════════════════════════════════════════════════════
 * A hygienist documents today by opening an Open Dental auto note — a SOAP
 * skeleton with `[Prompt:"Calculus"]` holes in it — and tapping a graded
 * pick-list into each hole. If filling in the CareIN visit does not PRODUCE
 * that note, she documents twice and stops using the app. So the templates come
 * here, as data, and the visit form's chips are the pick-lists.
 *
 * The source is committed beside this file at `docs/hyg-autonotes/autonotes.json`
 * — the practice's own export — and `backend/services/hyg/autonoteParity.test.js`
 * reads it and fails the build when this file and that export disagree about a
 * template's existence, a control's name, or a control's options. A
 * re-statement that can drift silently is a re-statement that will.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * AN UNSET PICK RENDERS AS ITS LABEL AND A BLANK. IT NEVER RENDERS A VALUE.
 * ═════════════════════════════════════════════════════════════════════════════
 * That is exactly what their notes do today: a hole nobody filled prints as
 * `Calculus: ` and the reader knows nobody answered. The alternative — a
 * default, a "WNL", a "none recorded" — would put a clinical claim in a chart
 * that no clinician made. Every renderer below leaves the blank.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHERE THIS RUNS
 * ═════════════════════════════════════════════════════════════════════════════
 * `renderVisitNote` is PURE — data in, `string[]` out, no clock and no request
 * — and it runs on the SERVER, inside `stagedWriteComposer.js`, through the
 * committed contract bundle. The client imports the same file for the labels
 * and options its chip rows draw, so the form and the note can never offer and
 * print different vocabularies.
 *
 * The three deviations from the source templates, all deliberate, all so the
 * note stays honest:
 *
 *   1. WHITESPACE IS NORMALISED. The export pads its holes with runs of spaces
 *      (`STE:               HTE:`) because a person types into them. We fill
 *      them, so one space after each colon is what reads correctly.
 *   2. `P:  Return for Recall in 6  months` IS NOT HARDCODED. The recall
 *      interval comes from the slip. When nobody set one, the line stops at
 *      `Return for Recall` rather than asserting six months on a chart.
 *   3. `FL2TX` and `Perio chart updated` ARE CONDITIONAL. Both are flat
 *      assertions in the source. Printing "fluoride was applied" on a visit
 *      where it was not is the same defect as inventing a grade.
 */
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// The five visit types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which of the practice's hygiene notes this visit is.
 *
 * Five, matching the five hygiene AutoNotes. SRP, FMD/4346 and the laser notes
 * are deliberately absent: they carry anesthetic, carps and quadrant detail
 * that this form has no fields for, and half a template is worse than none.
 */
export const VisitTypeSchema = z.enum([
  "adult_prophy_np",
  "adult_prophy_recall",
  "child_prophy_np",
  "child_prophy_recall",
  "perio_maint",
]);
export type VisitType = z.infer<typeof VisitTypeSchema>;

export const VISIT_TYPES = VisitTypeSchema.options;

/** The practice's own name for each, so the picker reads like Open Dental. */
export const VISIT_TYPE_LABELS: Record<VisitType, string> = {
  adult_prophy_np: "Adult Prophy NP",
  adult_prophy_recall: "Adult Prophy Recall",
  child_prophy_np: "Child Prophy NP",
  child_prophy_recall: "Child Prophy Recall",
  perio_maint: "Perio Maint",
};

/**
 * The AutoNoteName in Open Dental each visit type re-states.
 *
 * Kept separate from the label above because the export's own names carry
 * stray whitespace (`"Adult Prophy Recall "`), and the parity test matches on
 * these — trimmed — rather than on what a picker happens to show.
 */
export const VISIT_TYPE_AUTONOTE: Record<VisitType, string> = {
  adult_prophy_np: "Adult Prophy NP",
  adult_prophy_recall: "Adult Prophy Recall",
  child_prophy_np: "Child Prophy NP",
  child_prophy_recall: "Child Prophy Recall",
  perio_maint: "Perio Maint",
};

/** Whether a visit type is a child's. Drives the behaviour scale and FL2TX. */
export function isChildVisit(type: VisitType): boolean {
  return type === "child_prophy_np" || type === "child_prophy_recall";
}

/** How the picker was arrived at. `null` when nobody has picked one. */
export const VisitTypeSourceSchema = z.enum(["auto", "manual"]);
export type VisitTypeSource = z.infer<typeof VisitTypeSourceSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The pick-lists (Open Dental's AutoNoteControls)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One graded row on the form and one filled hole in the note.
 *
 * `descript` is the control's name in Open Dental — what the parity test looks
 * for. `label` is the word the NOTE prints before the colon, which is not
 * always the same: the same "Calculus" control appears in Perio Maint twice, as
 * `Sub Calculus` and `Supra Calculus`.
 *
 * `multi` mirrors the export's ControlType. A MultiResponse control genuinely
 * takes more than one answer — HTE is routinely `RD, XD` — so `grades` is an
 * ARRAY everywhere and a single-answer row simply holds at most one. One
 * storage shape rather than two, so nothing downstream has to ask which kind of
 * row it is holding.
 */
export interface NoteControl {
  /** The AutoNoteControl `Descript`, trimmed. */
  descript: string;
  /** What the form calls it. */
  label: string;
  options: readonly string[];
  multi: boolean;
}

export const NoteControlIdSchema = z.enum([
  "oh",
  "perioStatus",
  "perioClass",
  "boneLoss",
  "plaque",
  "calculus",
  "subCalculus",
  "supraCalculus",
  "bleeding",
  "stain",
  "mallampati",
  "ste",
  "hte",
  "pedBehavior",
  "drs",
]);
export type NoteControlId = z.infer<typeof NoteControlIdSchema>;

/**
 * Plaque's fourth option is lower-case `none` in the practice's export and
 * `None` on Bleeding's. That is not worth "fixing": these strings are printed
 * verbatim into a chart, the parity test compares them character for character,
 * and a tidy-up here would be a difference nobody asked for in a legal record.
 */
const PLAQUE_OPTIONS = ["Minimal", "Moderate", "Heavy", "none"] as const;
const BLEEDING_OPTIONS = ["Minimal", "Moderate", "Heavy", "None"] as const;
const CALCULUS_OPTIONS = ["Slight", "Moderate", "Heavy", "None"] as const;

/**
 * Every pick-list the five hygiene templates use, with its options verbatim.
 *
 * Two spellings are corrected against the export — `Inflamamtion` and
 * `Advaced`. Both are typos in the practice's pick-list, and a typo is not
 * clinical content worth reproducing into a chart; the parity test knows about
 * exactly these two and about nothing else, so a THIRD difference is a red
 * build rather than a habit.
 */
export const NOTE_CONTROLS: Record<NoteControlId, NoteControl> = {
  oh: { descript: "OH", label: "OH", options: ["Good", "Fair", "Poor"], multi: false },
  perioStatus: {
    descript: "Perio Status",
    label: "Perio status",
    options: ["WNL", "Mild", "Moderate", "Severe"],
    multi: false,
  },
  perioClass: {
    descript: "Perio Class",
    label: "Perio Class",
    options: ["WNL", "Mild", "Moderate", "Severe", "Advanced"],
    multi: true,
  },
  boneLoss: {
    descript: "Bone Loss",
    label: "Bone Loss",
    options: ["WNL(1-2mm)", "Mild (3-4mm)", "Moderate (5-6 mm)", "Severe (6+mm)"],
    multi: false,
  },
  plaque: { descript: "Plaque", label: "Plaque", options: PLAQUE_OPTIONS, multi: false },
  calculus: { descript: "Calculus", label: "Calculus", options: CALCULUS_OPTIONS, multi: false },
  subCalculus: {
    descript: "Calculus",
    label: "Sub Calculus",
    options: CALCULUS_OPTIONS,
    multi: false,
  },
  supraCalculus: {
    descript: "Calculus",
    label: "Supra Calculus",
    options: CALCULUS_OPTIONS,
    multi: false,
  },
  bleeding: { descript: "Bleeding", label: "Bleeding", options: BLEEDING_OPTIONS, multi: false },
  stain: { descript: "Stain", label: "Stain", options: CALCULUS_OPTIONS, multi: false },
  mallampati: {
    descript: "Mallampati",
    label: "Mallampati",
    options: ["Class 1", "Class 2", "Class 3", "Class 4"],
    multi: false,
  },
  ste: {
    descript: "STE",
    label: "STE",
    options: [
      "Inflammation/bleeding Mild",
      "Inflammation/bleeding Moderate",
      "Inflammation/bleeding Severe",
      "WNL",
    ],
    multi: true,
  },
  hte: {
    descript: "HTE",
    label: "HTE",
    options: ["RD", "XD", "Demineralization", "WNL"],
    multi: true,
  },
  pedBehavior: {
    descript: "Pediatric Behavior",
    label: "Pediatric behavior",
    options: [
      "1- uncooperative/combative",
      "2- somewhat uncooperative",
      "3- somewhat cooperative",
      "4- fantastic",
    ],
    multi: true,
  },
  /**
   * The doctor who examined. Its OPTIONS ARE EMPTY HERE ON PURPOSE — they are
   * the office's own supervising doctors, and a name in a shared file is a name
   * that ends up in the wrong practice's chart note. `backend/config/hygStaff.js`
   * holds them per office and the form is handed them at runtime.
   */
  drs: { descript: "Drs", label: "Doctor", options: [], multi: true },
};

/**
 * The two spellings this file deliberately corrects, source → ours.
 * The parity test pins exactly these and refuses a third.
 */
export const CORRECTED_OPTION_SPELLINGS: Record<string, string> = {
  "Inflamamtion/bleeding Severe": "Inflammation/bleeding Severe",
  Advaced: "Advanced",
};

/**
 * One row's answer: what was picked, and the location or qualifier typed after it.
 *
 * The suffix is the half that makes these notes worth reading. Their real notes
 * say `Calculus: Slight-mod Lower ant and U post` — a grade alone would lose
 * the second half of every one of them.
 */
export const NoteFieldSchema = z
  .object({
    /** Picked options, verbatim. Empty means nobody answered. */
    grades: z.array(z.string().min(1).max(80)).max(8),
    /** The free text after the grade. `Lower ant and U post`. */
    detail: z.string().max(200),
  })
  .strict();
export type NoteField = z.infer<typeof NoteFieldSchema>;

/** An empty answer. One definition, so no screen invents a second shape. */
export function emptyNoteField(): NoteField {
  return { grades: [], detail: "" };
}

/** An answered row. Empty grades AND empty detail means nobody answered. */
export function isAnswered(field: NoteField | undefined): boolean {
  if (!field) return false;
  return field.grades.length > 0 || field.detail.trim().length > 0;
}

/** `Slight-mod Lower ant and U post` — grades then suffix, both optional. */
export function fieldText(field: NoteField | undefined): string {
  if (!field) return "";
  const grades = field.grades.join(", ");
  const detail = field.detail.trim();
  if (grades && detail) return `${grades} ${detail}`;
  return grades || detail;
}

// ─────────────────────────────────────────────────────────────────────────────
// The templates
// ─────────────────────────────────────────────────────────────────────────────

/** The free-text boxes a template can print. All live on the slip already. */
export const NoteFreeFieldSchema = z.enum(["chiefComplaint", "findings", "rtc"]);
export type NoteFreeField = z.infer<typeof NoteFreeFieldSchema>;

/**
 * One line of a template.
 *
 * A discriminated union rather than a string with holes in it: a `{{Calculus}}`
 * placeholder is a second, untyped language that nothing can check, and the one
 * thing this file must not do is print a hole it does not understand.
 */
export type NoteLine =
  /** A literal line of the practice's own wording. */
  | { t: "text"; text: string }
  | { t: "blank" }
  /** `Calculus: <grades> <detail>` — blank after the colon when unanswered. */
  | { t: "control"; id: NoteControlId; label?: string }
  /** `RTC: <text>` — blank after the colon when nothing was typed. */
  | { t: "free"; field: NoteFreeField; label: string }
  /** The A: line, which packs STE, HTE, the doctor and the findings into one. */
  | { t: "assessment"; exam: "comp" | "periodic" | null; fluoride: boolean; findings: boolean }
  /** The S: line, whose wording differs per template and whose tail is the CC. */
  | { t: "subjective"; text: string; ccLabel: string }
  /** The O: line, plus the radiographs when any were taken. */
  | { t: "objective"; same: boolean }
  /** `P:  Return for Recall in 6 months`, plus products when any were given. */
  | { t: "plan" }
  /** `Perio chart updated` — only when she said it was. */
  | { t: "perioChart" };

export interface NoteTemplate {
  visitType: VisitType;
  /** The AutoNoteName this re-states. */
  autoNote: string;
  lines: readonly NoteLine[];
}

/** `A:` for the four prophy templates — STE, HTE, the doctor, the findings. */
function assessment(
  exam: "comp" | "periodic" | null,
  fluoride: boolean,
  findings = true,
): NoteLine {
  return { t: "assessment", exam, fluoride, findings };
}

/**
 * The five templates.
 *
 * Read these beside `docs/hyg-autonotes/autonotes.json`. Section for section,
 * label for label, in the source's own order — including the fact that Adult
 * Prophy Recall drops OH and Bone Loss while the NP note keeps both, and that
 * Perio Maint is the only one that asks for sub and supra calculus separately.
 */
export const NOTE_TEMPLATES: Record<VisitType, NoteTemplate> = {
  adult_prophy_np: {
    visitType: "adult_prophy_np",
    autoNote: "Adult Prophy NP",
    lines: [
      {
        t: "subjective",
        text: "Patient presents for new pt appointment.",
        ccLabel: "Chief complaint",
      },
      { t: "blank" },
      { t: "objective", same: false },
      { t: "blank" },
      assessment("comp", false),
      { t: "blank" },
      { t: "plan" },
      { t: "blank" },
      { t: "control", id: "oh" },
      { t: "control", id: "perioStatus" },
      { t: "control", id: "boneLoss" },
      { t: "control", id: "plaque" },
      { t: "control", id: "calculus" },
      { t: "control", id: "bleeding" },
      { t: "control", id: "stain" },
      { t: "control", id: "mallampati" },
      { t: "free", field: "rtc", label: "RTC" },
    ],
  },

  adult_prophy_recall: {
    visitType: "adult_prophy_recall",
    autoNote: "Adult Prophy Recall",
    lines: [
      {
        t: "subjective",
        text: "Patient presents for recall appointment.",
        ccLabel: "Chief complaint",
      },
      { t: "blank" },
      { t: "objective", same: true },
      { t: "blank" },
      assessment("periodic", false),
      { t: "blank" },
      { t: "plan" },
      { t: "blank" },
      // The recall note asks for fewer rows than the new-patient one. That is
      // the practice's own choice and it is not this file's to "improve".
      { t: "control", id: "perioStatus", label: "Perio" },
      { t: "control", id: "plaque" },
      { t: "control", id: "calculus" },
      { t: "control", id: "bleeding" },
      { t: "control", id: "stain" },
      { t: "control", id: "mallampati" },
      { t: "free", field: "rtc", label: "RTC" },
    ],
  },

  child_prophy_np: {
    visitType: "child_prophy_np",
    autoNote: "Child Prophy NP",
    lines: [
      {
        t: "subjective",
        text: "Patient presents for new pt appointment.",
        ccLabel: "Chief complaint",
      },
      { t: "blank" },
      { t: "objective", same: false },
      { t: "blank" },
      assessment("comp", true),
      { t: "blank" },
      { t: "plan" },
      { t: "blank" },
      { t: "control", id: "oh" },
      { t: "control", id: "plaque" },
      { t: "control", id: "calculus" },
      { t: "control", id: "bleeding" },
      { t: "control", id: "stain" },
      { t: "blank" },
      { t: "control", id: "pedBehavior" },
      { t: "blank" },
      { t: "free", field: "rtc", label: "RTC" },
    ],
  },

  child_prophy_recall: {
    visitType: "child_prophy_recall",
    autoNote: "Child Prophy Recall",
    lines: [
      {
        t: "subjective",
        text: "Patient presents for recall appointment.",
        ccLabel: "Chief complaint",
      },
      { t: "blank" },
      { t: "objective", same: true },
      { t: "blank" },
      assessment("periodic", true),
      { t: "blank" },
      { t: "plan" },
      { t: "blank" },
      { t: "control", id: "oh" },
      { t: "control", id: "plaque" },
      { t: "control", id: "calculus" },
      { t: "control", id: "bleeding" },
      { t: "control", id: "stain" },
      { t: "blank" },
      { t: "control", id: "pedBehavior" },
      { t: "blank" },
      { t: "free", field: "rtc", label: "RTC" },
    ],
  },

  perio_maint: {
    visitType: "perio_maint",
    autoNote: "Perio Maint",
    lines: [
      {
        t: "subjective",
        text: "Patient presents for perio maintenance appointment.",
        ccLabel: "CC",
      },
      { t: "blank" },
      { t: "objective", same: true },
      { t: "blank" },
      // No doctor clause: the source template has no exam sentence in it.
      assessment(null, false, false),
      { t: "blank" },
      { t: "plan" },
      { t: "blank" },
      { t: "control", id: "perioClass" },
      { t: "perioChart" },
      { t: "control", id: "plaque" },
      { t: "control", id: "subCalculus" },
      { t: "control", id: "supraCalculus" },
      { t: "control", id: "boneLoss" },
      { t: "control", id: "bleeding" },
      { t: "control", id: "stain" },
      { t: "control", id: "mallampati", label: "Mallampati class" },
      // Its A: line has no Findings slot, and dropping what a hygienist typed is
      // worse than one extra line. So the box gets its own line here instead.
      { t: "free", field: "findings", label: "Findings" },
      { t: "blank" },
      { t: "free", field: "rtc", label: "RTC" },
    ],
  },
};

/**
 * The rows a visit type's form shows, in the note's own order.
 *
 * THE FORM IS GENERATED FROM THE TEMPLATE. A hand-kept second list would drift,
 * and the drift would be a chip she filled in that no note prints.
 */
export function controlsFor(visitType: VisitType): NoteControlId[] {
  const ids: NoteControlId[] = [];
  for (const l of NOTE_TEMPLATES[visitType].lines) {
    if (l.t === "control") ids.push(l.id);
    if (l.t === "assessment") {
      ids.push("ste", "hte");
      if (l.exam !== null) ids.push("drs");
    }
  }
  return ids;
}

/** The label the NOTE prints for a row of this visit type. */
export function controlLabel(visitType: VisitType, id: NoteControlId): string {
  for (const l of NOTE_TEMPLATES[visitType].lines) {
    if (l.t === "control" && l.id === id) return l.label ?? NOTE_CONTROLS[id].label;
  }
  return NOTE_CONTROLS[id].label;
}

/** Whether this visit type's note has a `Perio chart updated` line. */
export function hasPerioChartLine(visitType: VisitType): boolean {
  return NOTE_TEMPLATES[visitType].lines.some((l) => l.t === "perioChart");
}

/** The free-text boxes this visit type's note prints, in its own order. */
export function freeFieldsFor(visitType: VisitType): NoteFreeField[] {
  const out: NoteFreeField[] = [];
  for (const l of NOTE_TEMPLATES[visitType].lines) {
    if (l.t === "subjective") out.push("chiefComplaint");
    if (l.t === "assessment" && l.findings) out.push("findings");
    if (l.t === "free" && !out.includes(l.field)) out.push(l.field);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-picking the visit type from the appointment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the appointment says this visit is — or `null`, which means ASK HER.
 *
 * The rule is deliberately narrow. Open Dental appointment type labels are free
 * text a front desk types, and the cost of a wrong guess here is a chart note
 * written against the wrong template. So:
 *
 *   · `perio maint` / `perio maintenance` / `PM` wins outright.
 *   · The label must say whether it is a CHILD's visit. Nothing else can:
 *     age is not on the appointment, and "Prophy" alone is neither.
 *   · New-patient vs recall comes from the label, and ONLY falls back to Open
 *     Dental's own `isNewPatient` when the label is silent about it. A `null`
 *     there means nobody knows, so nothing is guessed.
 *
 * Anything this cannot read cleanly returns `null` and the hygienist picks. A
 * suggestion is also never applied silently: the form says it came from the
 * appointment type, and one tap changes it.
 */
export function suggestVisitType(input: {
  apptTypeLabel: string | null;
  isNewPatient: boolean | null;
}): VisitType | null {
  const raw = (input.apptTypeLabel ?? "").toLowerCase().trim();
  if (raw === "") return null;
  // Padded with spaces so `pm` cannot match inside `pmt`, and every separator
  // an appointment type might use (`-`, `/`, `_`) reads as a word boundary.
  const label = ` ${raw.replace(/[^a-z0-9]+/g, " ").trim()} `;
  const has = (needle: string) => label.includes(` ${needle} `);

  if (label.includes(" perio ") && (has("maint") || has("maintenance") || has("pm"))) {
    return "perio_maint";
  }
  if (has("pm") && !has("prophy")) return "perio_maint";

  const child = has("child") || has("ped") || has("peds") || has("pedo") || has("kid");
  const adult = has("adult");
  // Neither said: "Prophy 60" could be anybody, and a child's note on an adult
  // is a wrong note. She picks.
  if (child === adult) return null;

  const np = has("np") || label.includes(" new pt ") || label.includes(" new patient ");
  const recall = has("rc") || has("recall") || has("recare");
  let newPatient: boolean | null = null;
  if (np && !recall) newPatient = true;
  else if (recall && !np) newPatient = false;
  else if (!np && !recall) newPatient = input.isNewPatient;

  if (newPatient === null) return null;
  if (child) return newPatient ? "child_prophy_np" : "child_prophy_recall";
  return newPatient ? "adult_prophy_np" : "adult_prophy_recall";
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the renderer needs that is not a template. */
export interface RenderNoteInput {
  visitType: VisitType;
  fields: Record<string, NoteField | undefined>;
  chiefComplaint: string;
  findings: string;
  rtc: string;
  /** Chip ids from the slip's `doneToday`. Only `fluoride` is read. */
  doneToday: readonly string[];
  xrayTypes: readonly string[];
  productsDispensed: readonly string[];
  /** Months to the next hygiene visit, or null — never defaulted to six. */
  recallMonths: number | null;
  /** `yes` / `no` / null, for Perio Maint's chart line. */
  perioChartUpdated: "yes" | "no" | null;
}

/**
 * `Label: value` — and `Label: ` when there is no value.
 *
 * The trailing space on an empty one is not an accident. It is what their own
 * notes look like where nobody answered, and it is the visible difference
 * between a question left open and an answer somebody invented.
 */
function labelled(label: string, value: string): string {
  return `${label}: ${value}`;
}

const FREE_FIELD_READERS: Record<NoteFreeField, (i: RenderNoteInput) => string> = {
  chiefComplaint: (i) => i.chiefComplaint,
  findings: (i) => i.findings,
  rtc: (i) => i.rtc,
};

/**
 * The note, as the lines that go in the chart.
 *
 * PURE. No clock, no request, no database. The treatment block and the
 * signature block are appended by the composer, which is the only place that
 * knows who is signed in and what was proposed today.
 */
export function renderVisitNote(input: RenderNoteInput): string[] {
  const template = NOTE_TEMPLATES[input.visitType];
  const out: string[] = [];
  const field = (id: NoteControlId) => input.fields[id];

  for (const l of template.lines) {
    switch (l.t) {
      case "text":
        out.push(l.text);
        break;

      case "blank":
        out.push("");
        break;

      case "subjective":
        out.push(`S:  ${l.text}  ${labelled(l.ccLabel, input.chiefComplaint.trim())}`);
        break;

      case "objective":
        out.push(`O:  Reviewed medical history with patient.${l.same ? "  Same" : ""}`);
        // The source templates have no radiographs slot, and a hygienist who
        // ticked FMX has recorded something a chart note must not lose.
        if (input.xrayTypes.length > 0) {
          out.push(`    Radiographs taken: ${input.xrayTypes.join(", ")}`);
        }
        break;

      case "assessment": {
        const parts = [
          `A:   ${labelled("STE", fieldText(field("ste")))}`,
          labelled("HTE", fieldText(field("hte"))),
        ];
        const fluoride = l.fluoride && input.doneToday.includes("fluoride");
        parts.push(`Polished, flossed, scaled as needed${fluoride ? ", FL2TX" : ""}.`);
        if (l.exam !== null) {
          const drs = fieldText(field("drs"));
          // `Dr.` with nothing after it is the source template's own blank.
          parts.push(`${drs ? `Dr. ${drs}` : "Dr."} performed ${l.exam} exam.`);
        }
        if (l.findings) parts.push(labelled("Findings", input.findings.trim()));
        out.push(parts.join("  "));
        break;
      }

      case "plan":
        out.push(
          input.recallMonths === null
            ? "P:  Return for Recall"
            : `P:  Return for Recall in ${input.recallMonths} months`,
        );
        if (input.productsDispensed.length > 0) {
          out.push(`    Products dispensed: ${input.productsDispensed.join(", ")}`);
        }
        break;

      case "perioChart":
        // A flat assertion in the source. Here it is only printed when she said
        // so, and an unanswered one keeps the label and the blank.
        if (input.perioChartUpdated === "yes") out.push("Perio chart updated");
        else if (input.perioChartUpdated === "no") out.push("Perio chart NOT updated");
        else out.push(labelled("Perio chart updated", ""));
        break;

      case "control":
        out.push(labelled(l.label ?? NOTE_CONTROLS[l.id].label, fieldText(field(l.id))));
        break;

      case "free":
        out.push(labelled(l.label, FREE_FIELD_READERS[l.field](input).trim()));
        break;
    }
  }

  return out;
}
