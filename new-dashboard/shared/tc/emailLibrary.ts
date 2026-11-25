/**
 * The TC patient email library (EL-1): one office's WORDING answers, and the
 * catalog / profile / preview API shapes.
 *
 * WHAT THIS IS. The library (backend/services/tcEmailLibrary/source.json, frozen
 * and hash-pinned) holds 36 procedure blocks and 54 stage frames. An office's
 * answers to the questionnaire below change the WORDING of the emails composed
 * from it, and nothing else: never who is contacted, when, or whether. In this
 * slice the library is configuration plus a preview. Nothing here creates a
 * draft, a message row or a send.
 *
 * THE ANSWERS ARE PRINTED INSIDE PATIENT EMAILS. That is why the free-text
 * fields refuse braces, brackets, angle brackets, control characters and line
 * breaks: a `{` or `[[` could become a merge token or a template token, and a
 * `<` has no business in an email body. Links are https only.
 *
 * NEVER STORED: office_name and office_phone. They are questions in the source
 * (the handoff's standalone questionnaire asked them) but in the app they come
 * from the office's saved email identity, server-side. An answers object that
 * carries either is refused, never silently dropped.
 *
 * ONE REFUSAL CODE PER FAILURE. `validateEmailLibraryAnswers` names the first
 * problem with a code from EMAIL_LIBRARY_ANSWER_CODES and the key it found it
 * on. The server runs it on every PUT /profile and on any unsaved answers sent
 * to POST /preview; the page runs the same function as you type.
 *
 * The key and option lists below are copies of source.json's questions, held
 * here so the contract is strict on its own. backend
 * services/tcEmailLibrary/tcEmailLibrary.test.js pins them to the source, so a
 * wording PR that adds a question or an option fails until this file follows.
 */
import { z } from "zod";
import { OfficeKeySchema } from "../officeKey";

/** Questions in the source that are NEVER stored or accepted (server-derived). */
export const EMAIL_LIBRARY_NEVER_STORED = ["office_name", "office_phone"] as const;

/** Yes/no questions: a boolean. */
export const EMAIL_LIBRARY_YESNO_KEYS = [
  "same_day_crowns",
  "digital_scanner",
  "cbct",
  "laser",
  "surgical_guides",
  "buffered",
  "immediate_implants",
] as const;

/** Single-choice questions: exactly one declared option value. */
export const EMAIL_LIBRARY_SELECT_OPTIONS = {
  insurance_mode: ["standard", "in_network", "files_claims", "no_insurance"],
  implant_surgery: ["in_house", "specialist"],
  whitening_type: ["both", "in_office", "take_home"],
  parent_in_room: ["yes", "child_first", "no"],
  sleep_test: ["home_test", "both", "refer"],
} as const;

/** Multi-choice questions: a list of declared option values. */
export const EMAIL_LIBRARY_MULTI_OPTIONS = {
  sedation: ["nitrous", "oral", "iv"],
  sedation_kids: ["nitrous", "oral", "iv"],
  new_patient_welcome: [
    "xrays",
    "meet_doctor",
    "tour",
    "coffee",
    "tv",
    "comfort_menu",
    "welcome_gift",
    "same_day_cleaning",
  ],
  schedule_perks: ["early", "lunch", "evening", "friday", "saturday"],
} as const;

/** Free-text answers and their length caps (after trimming). */
export const EMAIL_LIBRARY_TEXT_MAX = {
  doctor_name: 120,
  same_day_length: 120,
  amenities: 200,
  financing_partners: 120,
  membership_name: 120,
  aligner_brand: 120,
} as const;

/** Link answers: https only, at most this long. */
export const EMAIL_LIBRARY_LINK_KEYS = ["schedule_link"] as const;
export const EMAIL_LIBRARY_LINK_MAX = 300;

/** Hours of notice to change an appointment: an integer string in this range. */
export const EMAIL_LIBRARY_CANCEL_HOURS = { key: "cancel_hours", min: 1, max: 168 } as const;

/** The procedures an office can switch off (`services_off`): the source's block ids. */
export const EMAIL_LIBRARY_PROCEDURE_IDS = [
  "filling", "crown", "onlay", "root_canal", "bridge", "extraction", "wisdom_teeth", "bone_graft",
  "implant", "implant_denture", "full_arch", "denture", "partial", "reline", "deep_cleaning",
  "perio_maintenance", "gum_graft", "recare", "new_patient", "night_guard", "whitening", "veneers",
  "bonding", "smile_makeover", "aligners", "braces", "early_ortho", "retainer", "sleep_appliance",
  "tmj", "sealants", "pediatric_restorative", "space_maintainer", "frenectomy", "large_case",
  "emergency_followup",
] as const;
export type EmailLibraryProcedureId = (typeof EMAIL_LIBRARY_PROCEDURE_IDS)[number];

/** The tones a frame comes in. */
export const EMAIL_LIBRARY_VARIANTS = ["A", "B", "C"] as const;
export type EmailLibraryVariant = (typeof EMAIL_LIBRARY_VARIANTS)[number];

/**
 * The OPTIONAL office settings the wording reads from the answers (as opposed to
 * the email identity, the signed-in user, or the patient). Since library 1.2.0
 * the composer writes them into the text itself (globals BOOK_ONLINE,
 * BOOK_BULLET, REACH_ONLINE, DOCTOR): a blank scheduling link drops the
 * online-booking sentence and a blank doctor name reads "we". So a blank one is
 * a choice, not a gap. GET /profile reports them twice:
 *   `missing`        only a setting some composed email still prints as its
 *                    {{token}} (none, with 1.2.0)
 *   `blankOptional`  every one of these the office has left blank
 */
export const EMAIL_LIBRARY_MERGE_SETTINGS = ["schedule_link", "doctor_name"] as const;
export type EmailLibraryMergeSetting = (typeof EMAIL_LIBRARY_MERGE_SETTINGS)[number];

/**
 * Answer keys a library version has RETIRED, which a profile saved under an
 * older version may still hold. The server strips exactly these from a SAVED
 * row before validating it (it does not rewrite the row; the key disappears at
 * the office's next save), so the office is not locked out with
 * EMAIL_LIBRARY_SAVED_ANSWERS_STALE. They are NOT answer keys: a PUT or an
 * unsaved preview that sends one is refused as an unknown key, and any other
 * unknown saved key still reads as stale.
 *   review_link   retired in 1.2.0 with the review_referral stage: the library
 *                 never asks for a review
 */
export const EMAIL_LIBRARY_RETIRED_SAVED_KEYS = ["review_link"] as const;

/**
 * The preview's fixed sample values. Clearly synthetic: the preview never
 * touches a case, a patient or Open Dental.
 */
export const EMAIL_LIBRARY_PREVIEW_SAMPLES = {
  first_name: "Jordan",
  appointment_date: "Tuesday, March 3",
  appointment_time: "9:00 AM",
} as const;

/** Every key an answers object may carry. */
export const EMAIL_LIBRARY_ANSWER_KEYS = [
  ...EMAIL_LIBRARY_YESNO_KEYS,
  ...(Object.keys(EMAIL_LIBRARY_SELECT_OPTIONS) as Array<keyof typeof EMAIL_LIBRARY_SELECT_OPTIONS>),
  ...(Object.keys(EMAIL_LIBRARY_MULTI_OPTIONS) as Array<keyof typeof EMAIL_LIBRARY_MULTI_OPTIONS>),
  ...(Object.keys(EMAIL_LIBRARY_TEXT_MAX) as Array<keyof typeof EMAIL_LIBRARY_TEXT_MAX>),
  ...EMAIL_LIBRARY_LINK_KEYS,
  EMAIL_LIBRARY_CANCEL_HOURS.key,
  "services_off",
] as const;
export type EmailLibraryAnswerKey = (typeof EMAIL_LIBRARY_ANSWER_KEYS)[number];

/** Refusal codes, one per kind of failure. */
export const EMAIL_LIBRARY_ANSWER_CODES = {
  NOT_AN_OBJECT: "EMAIL_LIBRARY_ANSWERS_NOT_OBJECT",
  OFFICE_FIELD: "EMAIL_LIBRARY_OFFICE_FIELD_REFUSED",
  UNKNOWN_KEY: "EMAIL_LIBRARY_UNKNOWN_KEY",
  NOT_BOOLEAN: "EMAIL_LIBRARY_NOT_BOOLEAN",
  BAD_OPTION: "EMAIL_LIBRARY_BAD_OPTION",
  BAD_PROCEDURE: "EMAIL_LIBRARY_BAD_PROCEDURE",
  TEXT_NOT_STRING: "EMAIL_LIBRARY_TEXT_NOT_STRING",
  TEXT_TOO_LONG: "EMAIL_LIBRARY_TEXT_TOO_LONG",
  TEXT_FORBIDDEN_CHARACTER: "EMAIL_LIBRARY_TEXT_FORBIDDEN_CHARACTER",
  CANCEL_HOURS: "EMAIL_LIBRARY_CANCEL_HOURS_INVALID",
  LINK: "EMAIL_LIBRARY_LINK_INVALID",
} as const;
export type EmailLibraryAnswerCode = (typeof EMAIL_LIBRARY_ANSWER_CODES)[keyof typeof EMAIL_LIBRARY_ANSWER_CODES];

/**
 * Characters a printed answer may never hold: braces and brackets (they are the
 * library's token syntax), angle brackets, every C0/C1 control character
 * (newlines and tabs included), the Unicode line/paragraph separators, and
 * (EL-2) the invisible bidi and format controls: zero-width space/joiners and
 * the LRM/RLM marks (U+200B–U+200F), the embeddings and overrides
 * (U+202A–U+202E), the isolates (U+2066–U+2069) and the BOM (U+FEFF). Those
 * print nothing but can reorder or hide what a patient reads next to them, and
 * an answer is printed into patient email, so they are refused with the same
 * code as any other control character.
 */
const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const BIDI_AND_FORMAT = "\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff";
const FORBIDDEN_TEXT = new RegExp(`[{}\\[\\]<>\\x00-\\x1f\\x7f-\\x9f${LINE_SEPARATORS}${BIDI_AND_FORMAT}]`);
const CANCEL_HOURS_SHAPE = /^[1-9][0-9]{0,2}$/;

/** The stored, normalized answers. Every key optional: absent = the library's default. */
const textField = (max: number) => z.string().min(1).max(max).refine((v) => v === v.trim() && !FORBIDDEN_TEXT.test(v));
const linkField = z
  .string()
  .min(1)
  .max(EMAIL_LIBRARY_LINK_MAX)
  .refine((v) => isHttpsLink(v));
const multiField = <T extends readonly [string, ...string[]]>(values: T) => z.array(z.enum(values)).min(1);

export const EmailLibraryAnswers = z
  .object({
    same_day_crowns: z.boolean().optional(),
    digital_scanner: z.boolean().optional(),
    cbct: z.boolean().optional(),
    laser: z.boolean().optional(),
    surgical_guides: z.boolean().optional(),
    buffered: z.boolean().optional(),
    immediate_implants: z.boolean().optional(),
    insurance_mode: z.enum(EMAIL_LIBRARY_SELECT_OPTIONS.insurance_mode).optional(),
    implant_surgery: z.enum(EMAIL_LIBRARY_SELECT_OPTIONS.implant_surgery).optional(),
    whitening_type: z.enum(EMAIL_LIBRARY_SELECT_OPTIONS.whitening_type).optional(),
    parent_in_room: z.enum(EMAIL_LIBRARY_SELECT_OPTIONS.parent_in_room).optional(),
    sleep_test: z.enum(EMAIL_LIBRARY_SELECT_OPTIONS.sleep_test).optional(),
    sedation: multiField(EMAIL_LIBRARY_MULTI_OPTIONS.sedation).optional(),
    sedation_kids: multiField(EMAIL_LIBRARY_MULTI_OPTIONS.sedation_kids).optional(),
    new_patient_welcome: multiField(EMAIL_LIBRARY_MULTI_OPTIONS.new_patient_welcome).optional(),
    schedule_perks: multiField(EMAIL_LIBRARY_MULTI_OPTIONS.schedule_perks).optional(),
    doctor_name: textField(EMAIL_LIBRARY_TEXT_MAX.doctor_name).optional(),
    same_day_length: textField(EMAIL_LIBRARY_TEXT_MAX.same_day_length).optional(),
    amenities: textField(EMAIL_LIBRARY_TEXT_MAX.amenities).optional(),
    financing_partners: textField(EMAIL_LIBRARY_TEXT_MAX.financing_partners).optional(),
    membership_name: textField(EMAIL_LIBRARY_TEXT_MAX.membership_name).optional(),
    aligner_brand: textField(EMAIL_LIBRARY_TEXT_MAX.aligner_brand).optional(),
    schedule_link: linkField.optional(),
    cancel_hours: z
      .string()
      .refine((v) => CANCEL_HOURS_SHAPE.test(v) && Number(v) >= EMAIL_LIBRARY_CANCEL_HOURS.min && Number(v) <= EMAIL_LIBRARY_CANCEL_HOURS.max)
      .optional(),
    services_off: multiField(EMAIL_LIBRARY_PROCEDURE_IDS).optional(),
  })
  .strict();
export type EmailLibraryAnswers = z.infer<typeof EmailLibraryAnswers>;

/** Is `v` a parseable https URL with a host, no whitespace and no forbidden character? */
export function isHttpsLink(v: string): boolean {
  if (v.length === 0 || v.length > EMAIL_LIBRARY_LINK_MAX) return false;
  if (/\s/.test(v) || FORBIDDEN_TEXT.test(v)) return false;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname.length > 0;
}

export type EmailLibraryValidation =
  | { ok: true; answers: EmailLibraryAnswers }
  | { ok: false; code: EmailLibraryAnswerCode; key: string | null; message: string };

const has = (list: readonly string[], v: string): boolean => list.includes(v);
const refuse = (code: EmailLibraryAnswerCode, key: string | null, message: string): EmailLibraryValidation => ({
  ok: false,
  code,
  key,
  message,
});

/**
 * Validate and normalize one office's answers.
 *
 * Normalizing: an absent, null or blank answer (and an empty list) means "not
 * set" and is dropped, so a saved profile holds only answers that were given.
 * Text is trimmed. A list keeps the source's option order with duplicates
 * removed. Nothing else is rewritten: a refused value is refused, never fixed.
 */
export function validateEmailLibraryAnswers(raw: unknown): EmailLibraryValidation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return refuse(EMAIL_LIBRARY_ANSWER_CODES.NOT_AN_OBJECT, null, "Answers must be an object");
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (has(EMAIL_LIBRARY_NEVER_STORED, key)) {
      return refuse(
        EMAIL_LIBRARY_ANSWER_CODES.OFFICE_FIELD,
        key,
        `${key} comes from the office's email identity and cannot be set here`,
      );
    }
    if (!has(EMAIL_LIBRARY_ANSWER_KEYS, key)) {
      return refuse(EMAIL_LIBRARY_ANSWER_CODES.UNKNOWN_KEY, key, `${key} is not a question in this library`);
    }
    if (value === undefined || value === null) continue;

    if (has(EMAIL_LIBRARY_YESNO_KEYS, key)) {
      if (typeof value !== "boolean") return refuse(EMAIL_LIBRARY_ANSWER_CODES.NOT_BOOLEAN, key, `${key} must be yes or no`);
      out[key] = value;
      continue;
    }

    if (key in EMAIL_LIBRARY_SELECT_OPTIONS) {
      const options: readonly string[] = EMAIL_LIBRARY_SELECT_OPTIONS[key as keyof typeof EMAIL_LIBRARY_SELECT_OPTIONS];
      if (value === "") continue;
      if (typeof value !== "string" || !has(options, value)) {
        return refuse(EMAIL_LIBRARY_ANSWER_CODES.BAD_OPTION, key, `${key} must be one of: ${options.join(", ")}`);
      }
      out[key] = value;
      continue;
    }

    if (key in EMAIL_LIBRARY_MULTI_OPTIONS || key === "services_off") {
      const options: readonly string[] =
        key === "services_off"
          ? EMAIL_LIBRARY_PROCEDURE_IDS
          : EMAIL_LIBRARY_MULTI_OPTIONS[key as keyof typeof EMAIL_LIBRARY_MULTI_OPTIONS];
      const code = key === "services_off" ? EMAIL_LIBRARY_ANSWER_CODES.BAD_PROCEDURE : EMAIL_LIBRARY_ANSWER_CODES.BAD_OPTION;
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !has(options, v))) {
        return refuse(
          code,
          key,
          key === "services_off" ? "services_off may list only this library's procedures" : `${key} may list only: ${options.join(", ")}`,
        );
      }
      const picked = options.filter((o) => (value as string[]).includes(o));
      if (picked.length > 0) out[key] = picked;
      continue;
    }

    // Everything left is typed as text in the source.
    if (typeof value !== "string") return refuse(EMAIL_LIBRARY_ANSWER_CODES.TEXT_NOT_STRING, key, `${key} must be text`);
    const text = value.trim();
    if (text === "") continue;

    if (key === EMAIL_LIBRARY_CANCEL_HOURS.key) {
      const n = Number(text);
      if (!CANCEL_HOURS_SHAPE.test(text) || n < EMAIL_LIBRARY_CANCEL_HOURS.min || n > EMAIL_LIBRARY_CANCEL_HOURS.max) {
        return refuse(
          EMAIL_LIBRARY_ANSWER_CODES.CANCEL_HOURS,
          key,
          `cancel_hours must be a whole number of hours from ${EMAIL_LIBRARY_CANCEL_HOURS.min} to ${EMAIL_LIBRARY_CANCEL_HOURS.max}`,
        );
      }
      out[key] = text;
      continue;
    }

    if (has(EMAIL_LIBRARY_LINK_KEYS, key)) {
      if (!isHttpsLink(text)) {
        return refuse(
          EMAIL_LIBRARY_ANSWER_CODES.LINK,
          key,
          `${key} must be a complete https:// link of at most ${EMAIL_LIBRARY_LINK_MAX} characters, with no spaces`,
        );
      }
      out[key] = text;
      continue;
    }

    const max = EMAIL_LIBRARY_TEXT_MAX[key as keyof typeof EMAIL_LIBRARY_TEXT_MAX];
    if (text.length > max) return refuse(EMAIL_LIBRARY_ANSWER_CODES.TEXT_TOO_LONG, key, `${key} must be at most ${max} characters`);
    if (FORBIDDEN_TEXT.test(text)) {
      return refuse(
        EMAIL_LIBRARY_ANSWER_CODES.TEXT_FORBIDDEN_CHARACTER,
        key,
        `${key} cannot contain line breaks or any of { } [ ] < >`,
      );
    }
    out[key] = text;
  }
  const parsed = EmailLibraryAnswers.safeParse(out);
  // Unreachable while the checks above and the schema agree; refusing is the
  // honest answer if they ever drift.
  if (!parsed.success) return refuse(EMAIL_LIBRARY_ANSWER_CODES.UNKNOWN_KEY, null, "Answers did not match the contract");
  return { ok: true, answers: parsed.data };
}

// ── API shapes ───────────────────────────────────────────────────────────────

const QuestionOption = z.object({ value: z.string(), label: z.string(), phrase: z.string().optional() }).strict();

/** One questionnaire entry, as the source declares it (minus the office fields). */
export const EmailLibraryQuestion = z
  .object({
    id: z.enum(EMAIL_LIBRARY_ANSWER_KEYS),
    section: z.string(),
    type: z.enum(["text", "yesno", "select", "multi", "procedures"]),
    label: z.string(),
    help: z.string(),
    options: z.array(QuestionOption),
    default: z.union([z.string(), z.null()]),
    show_if: z.union([z.string(), z.null()]),
    placeholder: z.string(),
  })
  .strict();
export type EmailLibraryQuestion = z.infer<typeof EmailLibraryQuestion>;

export const EmailLibraryProcedure = z
  .object({ id: z.enum(EMAIL_LIBRARY_PROCEDURE_IDS), name: z.string(), category: z.string(), audience: z.string() })
  .strict();
export type EmailLibraryProcedure = z.infer<typeof EmailLibraryProcedure>;

export const EmailLibraryStage = z
  .object({
    id: z.string(),
    label: z.string(),
    phase: z.string(),
    use: z.string(),
    /** False when this office's answers switch the stage off (e.g. no insurance → no benefits deadline). */
    inUse: z.boolean(),
  })
  .strict();
export type EmailLibraryStage = z.infer<typeof EmailLibraryStage>;

export const EmailLibrarySequence = z
  .object({
    id: z.string(),
    name: z.string(),
    track: z.string(),
    use: z.string(),
    exit: z.string(),
    steps: z.array(z.object({ stage: z.string(), when: z.string() }).strict()),
  })
  .strict();
export type EmailLibrarySequence = z.infer<typeof EmailLibrarySequence>;

/** GET /api/tc/email-library/catalog */
export const EmailLibraryCatalogResponse = z
  .object({
    success: z.literal(true),
    office: OfficeKeySchema,
    libraryVersion: z.string(),
    /** True since EL-2 (1.3.0 is the doctor-reviewed wording); flips only by PR. While false, nurture cannot start a library enrollment (409 LIBRARY_NOT_APPROVED). */
    clinicallyApproved: z.boolean(),
    status: z.string(),
    rulesOfUse: z.array(z.string()),
    /** The procedures this office provides (after its services_off). */
    procedures: z.array(EmailLibraryProcedure),
    /** Every procedure, for the services_off question. */
    allProcedures: z.array(EmailLibraryProcedure),
    stages: z.array(EmailLibraryStage),
    variants: z.record(z.enum(EMAIL_LIBRARY_VARIANTS), z.string()),
    sequences: z.array(EmailLibrarySequence),
    questions: z.array(EmailLibraryQuestion),
    emailCount: z.number().int().nonnegative(),
  })
  .strict();
export type EmailLibraryCatalogResponse = z.infer<typeof EmailLibraryCatalogResponse>;

export const EmailLibraryMissingSetting = z
  .object({ field: z.enum(EMAIL_LIBRARY_MERGE_SETTINGS), stages: z.array(z.string()) })
  .strict();
export type EmailLibraryMissingSetting = z.infer<typeof EmailLibraryMissingSetting>;

/** GET /profile, and the PUT's read-back answer. */
export const EmailLibraryProfileResponse = z
  .object({
    success: z.literal(true),
    office: OfficeKeySchema,
    /** False until the office's first save: `answers` is then {} (every default). */
    saved: z.boolean(),
    answers: EmailLibraryAnswers,
    /** The library version the answers were saved against (null until saved). */
    libraryVersion: z.string().nullable(),
    updatedBy: z.string().nullable(),
    updatedAt: z.string().nullable(),
    /** Settings some composed email still prints as a {{token}} (normally none since 1.2.0). */
    missing: z.array(EmailLibraryMissingSetting),
    /** The optional settings this office has left blank (server-computed; the wording works without them). */
    blankOptional: z.array(z.enum(EMAIL_LIBRARY_MERGE_SETTINGS)),
    /** May this viewer save? (admin.all) — UX only; the server enforces it. */
    canEdit: z.boolean(),
  })
  .strict();
export type EmailLibraryProfileResponse = z.infer<typeof EmailLibraryProfileResponse>;

/** PUT /profile — the whole answers object, replacing what was saved. */
export const EmailLibraryProfilePutRequest = z.object({ answers: z.record(z.string(), z.unknown()) }).strict();
export type EmailLibraryProfilePutRequest = z.infer<typeof EmailLibraryProfilePutRequest>;

/** POST /preview */
export const EmailLibraryPreviewRequest = z
  .object({
    procedure_id: z.string().min(1).max(64),
    stage: z.string().min(1).max(64),
    variant: z.string().min(1).max(8),
    /** Unsaved answers to preview with; absent = the office's saved answers. */
    answers: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type EmailLibraryPreviewRequest = z.infer<typeof EmailLibraryPreviewRequest>;

export const EmailLibraryPreviewResponse = z
  .object({
    success: z.literal(true),
    office: OfficeKeySchema,
    id: z.string(),
    procedureId: z.string(),
    procedureName: z.string(),
    stage: z.string(),
    stageLabel: z.string(),
    variant: z.enum(EMAIL_LIBRARY_VARIANTS),
    tone: z.string(),
    answersSource: z.enum(["saved", "unsaved"]),
    /** Merge fields filled in; any left unresolved stay as their {{token}}. */
    subject: z.string(),
    preheader: z.string(),
    bodyText: z.string(),
    mergeFields: z.array(z.string()),
    /** The merge fields with no value: shown as {{token}}, never blank, never invented. */
    unresolved: z.array(z.string()),
    wordCount: z.number().int().nonnegative(),
    clinicallyApproved: z.boolean(),
  })
  .strict();
export type EmailLibraryPreviewResponse = z.infer<typeof EmailLibraryPreviewResponse>;
