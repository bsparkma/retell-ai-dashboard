/**
 * Referral note templates — per-office wording that PREFILLS two fields
 * (Beau's ruling: both places, per-office wording):
 *
 *   specialist_message   "Notes for the specialist" on the referral form (the
 *                        referral's narrative, which goes into the letter)
 *   correspondence_note  the note in "Log correspondence"
 *
 * One template per (office, kind). Blank = no prefill.
 *
 * A PREFILL IS A STARTING POINT. The browser fills the placeholders from values
 * already on the form, staff edit the text freely, and what they save is what
 * is stored and sent — the send path (routes/tc/referralSend.js) never sees a
 * template.
 *
 * THE MENU IS CLOSED. A template may name only `REFERRAL_TEMPLATE_PLACEHOLDERS`;
 * an unknown `{name}`, or a stray brace, is refused at save with the problem
 * named. `fillReferralTemplate` looks values up only by those names. None of
 * them identifies the patient: they are what the referral form already shows.
 *
 * One home for the rules: the Settings editor's live preview, the two forms'
 * prefill and the server's save validation all call the functions below.
 */
import { z } from "zod";

/** The closed placeholder menu, in the order the picker shows it. */
export const REFERRAL_TEMPLATE_PLACEHOLDERS = [
  "specialist_name",
  "specialty",
  "referring_provider",
  "teeth",
  "reason",
] as const;
export type ReferralTemplatePlaceholder = (typeof REFERRAL_TEMPLATE_PLACEHOLDERS)[number];

export const REFERRAL_TEMPLATE_PLACEHOLDER_LABELS: Record<ReferralTemplatePlaceholder, string> = {
  specialist_name: "Specialist",
  specialty: "Specialty",
  referring_provider: "Referring provider",
  teeth: "Teeth",
  reason: "Reason",
};

/** What an empty value fills in as: a visible gap staff will see and fill. */
export const REFERRAL_TEMPLATE_BLANK = "____";

/** The template body's cap, in characters (the DB CHECK carries the same). */
export const REFERRAL_TEMPLATE_BODY_MAX = 2000;

/** The two kinds, with what each prefills. */
export const REFERRAL_TEMPLATE_KINDS = ["specialist_message", "correspondence_note"] as const;
export const ReferralTemplateKind = z.enum(REFERRAL_TEMPLATE_KINDS);
export type ReferralTemplateKind = z.infer<typeof ReferralTemplateKind>;

export const REFERRAL_TEMPLATE_KIND_LABELS: Record<ReferralTemplateKind, { title: string; help: string }> = {
  specialist_message: {
    title: "Message to the specialist",
    help: "Prefills “Notes for the specialist” when someone starts or edits a referral. It goes into the referral letter.",
  },
  correspondence_note: {
    title: "Correspondence note",
    help: "Prefills the note in “Log correspondence” on a referral.",
  },
};

export function isReferralTemplateKind(value: unknown): value is ReferralTemplateKind {
  return typeof value === "string" && (REFERRAL_TEMPLATE_KINDS as readonly string[]).includes(value);
}

/** `{name}` where name is snake_case. */
const TOKEN = /\{([a-z][a-z_]*)\}/g;

/** One refusal, worded for the person at the editor. */
export interface ReferralTemplateProblem {
  code: "REFERRAL_TEMPLATE_UNKNOWN_PLACEHOLDER" | "REFERRAL_TEMPLATE_MALFORMED_PLACEHOLDER";
  message: string;
  token?: string;
}

/**
 * Every problem with a template's placeholders, or [] when it may be saved.
 * Pure; the editor runs it as you type and the server runs it on save.
 */
export function validateReferralTemplate(body: string): ReferralTemplateProblem[] {
  const problems: ReferralTemplateProblem[] = [];
  for (const m of Array.from(body.matchAll(TOKEN))) {
    if (!(REFERRAL_TEMPLATE_PLACEHOLDERS as readonly string[]).includes(m[1])) {
      problems.push({
        code: "REFERRAL_TEMPLATE_UNKNOWN_PLACEHOLDER",
        token: m[0],
        message: `${m[0]} is not on the placeholder menu. Insert placeholders with the buttons.`,
      });
    }
  }
  // Braces left once every {name} is taken out: an unclosed, empty or odd one.
  const rest = body.replace(TOKEN, "");
  if (rest.includes("{") || rest.includes("}")) {
    problems.push({
      code: "REFERRAL_TEMPLATE_MALFORMED_PLACEHOLDER",
      message: 'The text has a "{" or "}" that is not part of a placeholder.',
    });
  }
  return problems;
}

export type ReferralTemplateValues = Partial<Record<ReferralTemplatePlaceholder, string>>;

/**
 * Fill a template. Looks values up ONLY by menu name; an empty value fills in
 * as REFERRAL_TEMPLATE_BLANK. Anything that is not a menu token stays as typed
 * (and could not have been saved in the first place). Pure.
 */
export function fillReferralTemplate(body: string, values: ReferralTemplateValues): string {
  return body.replace(TOKEN, (whole, name: string) => {
    if (!(REFERRAL_TEMPLATE_PLACEHOLDERS as readonly string[]).includes(name)) return whole;
    const v = values[name as ReferralTemplatePlaceholder];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : REFERRAL_TEMPLATE_BLANK;
  });
}

/** Values for the editor's live preview: obviously sample, never a patient. */
export const REFERRAL_TEMPLATE_SAMPLE_VALUES: Record<ReferralTemplatePlaceholder, string> = {
  specialist_name: "Dr. Sample Specialist",
  specialty: "Endodontics",
  referring_provider: "Dr. Sample Provider",
  teeth: "#3, #14",
  reason: "Evaluate for root canal therapy",
};

// ── Wire shapes ─────────────────────────────────────────────────────────────

/** One template as the server stores it. `body: ""` with null updatedAt = never saved. */
export const ReferralTemplateState = z.object({
  kind: ReferralTemplateKind,
  body: z.string(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type ReferralTemplateState = z.infer<typeof ReferralTemplateState>;

/** GET /api/tc/referrals/templates (and the chairside read). Both kinds, always. */
export const ReferralTemplatesResponse = z.object({
  success: z.literal(true),
  office: z.enum(["roland", "valley"]),
  /** May this user change them? (Settings only; the same rule as the referral policies.) */
  canEdit: z.boolean(),
  templates: z.array(ReferralTemplateState),
});
export type ReferralTemplatesResponse = z.infer<typeof ReferralTemplatesResponse>;

/** PUT /api/tc/referrals/templates/:kind — the whole body; "" clears it. */
export const ReferralTemplateSaveRequest = z
  .object({
    body: z
      .string()
      .max(REFERRAL_TEMPLATE_BODY_MAX, `Keep a template under ${REFERRAL_TEMPLATE_BODY_MAX} characters`),
  })
  .strict();
export type ReferralTemplateSaveRequest = z.infer<typeof ReferralTemplateSaveRequest>;

export const ReferralTemplateSaveResponse = z.object({ success: z.literal(true), template: ReferralTemplateState });
export type ReferralTemplateSaveResponse = z.infer<typeof ReferralTemplateSaveResponse>;

/** The stored body for one kind, or "" when there is none. */
export function templateBody(templates: readonly ReferralTemplateState[] | null | undefined, kind: ReferralTemplateKind): string {
  return templates?.find((t) => t.kind === kind)?.body ?? "";
}
