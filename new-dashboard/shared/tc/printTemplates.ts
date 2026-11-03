/**
 * Print templates (CO-3): the school/work excuse and the appointment card the
 * front desk prints from the checkout workup. Beau's rulings, 2026-10-29 and
 * 11-02: per office, edited by the office manager in Settings, shipped
 * defaults, a CLOSED placeholder menu, printed from the workup.
 *
 * ONE HOME FOR THE RULES. The admin page's live preview and the server's PDF
 * both render from `composePrintDocument`, and the server refuses a save with
 * `validatePrintTemplate` — the same functions the editor runs as you type. A
 * preview that disagreed with the printout would be a preview of nothing.
 *
 * THE MENU IS THE WHOLE SURFACE. A template can say only what
 * `PRINT_PLACEHOLDERS` names; a `{{...}}` that is not on it is refused at save,
 * with its name in the error. And `fillPlaceholders` looks values up ONLY by
 * those names, from a value object built of those names — so even a template
 * that somehow held an unknown token could not reach any other field.
 *
 * A NEW TYPE IS AN ADDITION. A third printout is one more entry in
 * `PRINT_TEMPLATE_TYPES` (label, heading, body, signature line). The table
 * stores a type as a slug, the routes and the editor iterate this registry,
 * and nothing switches on a type by name.
 */
import { z } from "zod";

import { PRINT_STYLING_DEFAULTS, PrintStyling } from "./printStyling";

/** The closed placeholder menu, in the order the picker shows it. */
export const PRINT_PLACEHOLDERS = [
  "patient_first_name",
  "patient_full_name",
  "date_seen",
  "time_seen_range",
  "next_appointment_date",
  "next_appointment_time",
  "office_name",
  "office_address",
  "office_phone",
  "provider_name",
] as const;
export type PrintPlaceholder = (typeof PRINT_PLACEHOLDERS)[number];

/** What the picker calls each one. */
export const PRINT_PLACEHOLDER_LABELS: Record<PrintPlaceholder, string> = {
  patient_first_name: "Patient first name",
  patient_full_name: "Patient full name",
  date_seen: "Date seen",
  time_seen_range: "Time seen",
  next_appointment_date: "Next appointment date",
  next_appointment_time: "Next appointment time",
  office_name: "Office name",
  office_address: "Office address",
  office_phone: "Office phone",
  provider_name: "Provider name",
};

/** The values one printout is filled from — exactly the menu, nothing else. */
export type PrintValues = Record<PrintPlaceholder, string>;

/** What a placeholder with no value prints as: a line to write on, never a blank. */
export const PRINT_BLANK = "__________";

/** The registry. A third type is one more entry here. */
export const PRINT_TEMPLATE_TYPES = {
  excuse: {
    label: "School / work excuse",
    heading: "School / Work Excuse",
    body: [
      "To whom it may concern,",
      "",
      "{{patient_full_name}} was seen in our office on {{date_seen}} ({{time_seen_range}}) for a dental appointment. Please excuse their absence from school or work for this time.",
      "",
      "If you have any questions, please call us at {{office_phone}}.",
    ].join("\n"),
    signatureLine: "{{provider_name}}, {{office_name}}",
  },
  appointment_card: {
    label: "Appointment card",
    heading: "Your Next Appointment",
    body: [
      "{{patient_first_name}}, we look forward to seeing you again.",
      "",
      "{{next_appointment_date}} at {{next_appointment_time}}",
      "",
      "{{office_name}}",
      "{{office_address}}",
      "{{office_phone}}",
      "",
      "If you need to reschedule, please call us at least 24 hours ahead.",
    ].join("\n"),
    signatureLine: "",
  },
} as const;

export type PrintTemplateType = keyof typeof PRINT_TEMPLATE_TYPES;
export const PRINT_TEMPLATE_TYPE_KEYS = Object.keys(PRINT_TEMPLATE_TYPES) as PrintTemplateType[];
export const PrintTemplateTypeSchema = z.enum(PRINT_TEMPLATE_TYPE_KEYS as [PrintTemplateType, ...PrintTemplateType[]]);

export function isPrintTemplateType(value: unknown): value is PrintTemplateType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PRINT_TEMPLATE_TYPES, value);
}

/** The editable fields of one template. */
export const PrintTemplateFields = z
  .object({
    heading: z.string().trim().max(120),
    letterheadName: z.string().trim().max(120),
    letterheadAddress: z.string().trim().max(300),
    letterheadPhone: z.string().trim().max(40),
    body: z.string().max(4000),
    signatureLine: z.string().trim().max(200),
  })
  .strict();
export type PrintTemplateFields = z.infer<typeof PrintTemplateFields>;

/** The office's own details a template starts from (Settings → Email identity, else app settings). */
export interface PrintLetterheadPrefill {
  name: string;
  address: string;
  phone: string;
}

/** The shipped template for a type, letterhead from the office's existing config. */
export function defaultPrintTemplate(type: PrintTemplateType, prefill: PrintLetterheadPrefill): PrintTemplateFields {
  const d = PRINT_TEMPLATE_TYPES[type];
  return {
    heading: d.heading,
    letterheadName: prefill.name,
    letterheadAddress: prefill.address,
    letterheadPhone: prefill.phone,
    body: d.body,
    signatureLine: d.signatureLine,
  };
}

const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** One refusal, worded for the person at the editor. */
export interface PrintTemplateProblem {
  field: keyof PrintTemplateFields;
  code: "PRINT_TEMPLATE_UNKNOWN_PLACEHOLDER" | "PRINT_TEMPLATE_MALFORMED_PLACEHOLDER" | "PRINT_TEMPLATE_PLACEHOLDER_NOT_ALLOWED_HERE";
  message: string;
  token?: string;
}

const FIELD_NAMES: Record<keyof PrintTemplateFields, string> = {
  heading: "the heading",
  letterheadName: "the letterhead name",
  letterheadAddress: "the letterhead address",
  letterheadPhone: "the letterhead phone",
  body: "the body",
  signatureLine: "the signature line",
};

/** Fields that may carry placeholders. The letterhead and heading are plain text. */
const PLACEHOLDER_FIELDS: ReadonlyArray<keyof PrintTemplateFields> = ["body", "signatureLine"];

/**
 * Every problem with a template's placeholders, or [] when it may be saved.
 * Pure; the editor runs it as you type and the server runs it on save.
 */
export function validatePrintTemplate(t: PrintTemplateFields): PrintTemplateProblem[] {
  const problems: PrintTemplateProblem[] = [];
  for (const field of Object.keys(FIELD_NAMES) as Array<keyof PrintTemplateFields>) {
    const text = t[field];
    const allowed = PLACEHOLDER_FIELDS.includes(field);
    for (const m of Array.from(text.matchAll(TOKEN))) {
      const name = m[1];
      if (!allowed) {
        problems.push({
          field,
          code: "PRINT_TEMPLATE_PLACEHOLDER_NOT_ALLOWED_HERE",
          token: m[0],
          message: `Placeholders can go only in the body and the signature line, not in ${FIELD_NAMES[field]} (found ${m[0]}).`,
        });
      } else if (!(PRINT_PLACEHOLDERS as readonly string[]).includes(name)) {
        problems.push({
          field,
          code: "PRINT_TEMPLATE_UNKNOWN_PLACEHOLDER",
          token: m[0],
          message: `${m[0]} in ${FIELD_NAMES[field]} is not on the placeholder menu. Insert placeholders with the picker.`,
        });
      }
    }
    // Braces left over once every {{...}} is taken out: an unclosed or stray one.
    const rest = text.replace(TOKEN, "");
    if (rest.includes("{{") || rest.includes("}}")) {
      problems.push({
        field,
        code: "PRINT_TEMPLATE_MALFORMED_PLACEHOLDER",
        message: `${FIELD_NAMES[field][0].toUpperCase()}${FIELD_NAMES[field].slice(1)} has a "{{" or "}}" that is not part of a placeholder.`,
      });
    }
  }
  return problems;
}

/**
 * Fill a template's text. Looks values up ONLY by menu name; a value that is
 * empty prints as a line to write on. Anything that is not a menu token stays
 * exactly as typed (and could not have been saved in the first place).
 */
export function fillPlaceholders(text: string, values: PrintValues): string {
  return text.replace(TOKEN, (whole, name: string) => {
    if (!(PRINT_PLACEHOLDERS as readonly string[]).includes(name)) return whole;
    const v = values[name as PrintPlaceholder];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : PRINT_BLANK;
  });
}

/** A filled printout, ready to draw as a page or as the preview. */
export interface PrintDocument {
  letterhead: { name: string; addressLines: string[]; phone: string };
  heading: string;
  /** Paragraphs, each a list of lines (the body's own line breaks kept). */
  paragraphs: string[][];
  /** Null when the template has no signature line. */
  signatureLine: string | null;
}

/** The ONE composer the preview and the PDF both use. Pure. */
export function composePrintDocument(t: PrintTemplateFields, values: PrintValues): PrintDocument {
  const body = fillPlaceholders(t.body.replace(/\r\n?/g, "\n"), values);
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.split("\n").map((l) => l.trimEnd()))
    .filter((lines) => lines.some((l) => l.trim() !== ""));
  const signature = fillPlaceholders(t.signatureLine, values).trim();
  return {
    letterhead: {
      name: t.letterheadName.trim(),
      addressLines: t.letterheadAddress
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
      phone: t.letterheadPhone.trim(),
    },
    heading: t.heading.trim(),
    paragraphs,
    signatureLine: signature === "" ? null : signature,
  };
}

/**
 * The preview's sample values — CLEARLY SYNTHETIC, never a patient. The
 * office's own letterhead fills the office placeholders, as it would in print.
 */
export function samplePrintValues(t: Pick<PrintTemplateFields, "letterheadName" | "letterheadAddress" | "letterheadPhone">): PrintValues {
  return {
    patient_first_name: "Sample",
    patient_full_name: "Sample Patient",
    date_seen: "January 2, 2026",
    time_seen_range: "9:00 AM - 10:00 AM",
    next_appointment_date: "Tuesday, July 7, 2026",
    next_appointment_time: "9:00 AM",
    office_name: t.letterheadName.trim(),
    office_address: t.letterheadAddress.replace(/\r?\n/g, ", ").trim(),
    office_phone: t.letterheadPhone.trim(),
    provider_name: "Dr. Sample Provider",
  };
}

/** One office's template of one type, as the Settings page reads it. */
export const PrintTemplateState = z.object({
  type: PrintTemplateTypeSchema,
  label: z.string(),
  /** False: nobody has saved one; this is the shipped default. */
  stored: z.boolean(),
  fields: PrintTemplateFields,
  logo: z.object({ present: z.boolean(), contentType: z.string().nullable() }),
  /** CO-3b: how it prints — the saved styling, or the defaults (today's printout). */
  styling: PrintStyling.default({ ...PRINT_STYLING_DEFAULTS }),
  /** CO-3b: false — no styling saved; it prints exactly as before CO-3b. */
  styled: z.boolean().default(false),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type PrintTemplateState = z.infer<typeof PrintTemplateState>;

/** GET /api/platform/print-templates?office= */
export const PrintTemplatesResponse = z.object({
  success: z.literal(true),
  office: z.enum(["roland", "valley"]),
  prefill: z.object({ name: z.string(), address: z.string(), phone: z.string() }),
  templates: z.array(PrintTemplateState),
  /** False: logo upload is refused here until the storage container exists. */
  logoStorageConfigured: z.boolean(),
});
export type PrintTemplatesResponse = z.infer<typeof PrintTemplatesResponse>;

/** PUT /api/platform/print-templates/:type?office= — answers the template as read back. */
export const PrintTemplateSaveResponse = z.object({ success: z.literal(true), template: PrintTemplateState });

/** The three values the print dialog lets the desk change before generating. */
export const PrintEditableValues = z
  .object({
    timeSeenRange: z.string().trim().max(80).default(""),
    nextAppointmentDate: z.string().trim().max(80).default(""),
    nextAppointmentTime: z.string().trim().max(40).default(""),
  })
  .strict();

/** POST /api/tc/checkout/:id/print?office= — the PDF comes back. */
export const TcCheckoutPrintRequest = PrintEditableValues.extend({ templateType: PrintTemplateTypeSchema }).strict();
export type TcCheckoutPrintRequest = z.infer<typeof TcCheckoutPrintRequest>;

/** GET /api/tc/checkout/:id/print?office= — what the dialog starts from. */
export const TcCheckoutPrintDefaults = z.object({
  success: z.literal(true),
  templates: z.array(z.object({ type: PrintTemplateTypeSchema, label: z.string() })),
  /** Server-derived, shown read-only: the card's own patient, day and provider, and the office. */
  fixed: z.object({ patientFullName: z.string(), dateSeen: z.string(), providerName: z.string(), officeName: z.string() }),
  /** Pre-filled where known, editable before generating. */
  editable: z.object({ timeSeenRange: z.string(), nextAppointmentDate: z.string(), nextAppointmentTime: z.string() }),
});
export type TcCheckoutPrintDefaults = z.infer<typeof TcCheckoutPrintDefaults>;

/** "Kiwi, Sam" → { first: "Sam", full: "Sam Kiwi" }; a name not in that shape stays as it is. Pure. */
export function printNameParts(stored: string): { first: string; full: string } {
  const s = stored.trim();
  const m = /^([^,]+),\s*(.+)$/.exec(s);
  if (!m) return { first: s.split(/\s+/)[0] ?? s, full: s };
  const last = m[1].trim();
  const first = m[2].trim();
  return { first, full: `${first} ${last}` };
}

/** 'YYYY-MM-DD' → "November 2, 2026" (no timezone math). Pure. */
export function printDateLabel(isoDay: string, { weekday = false }: { weekday?: boolean } = {}): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDay);
  if (!m) return isoDay;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString("en-US", {
    ...(weekday ? { weekday: "long" } : {}),
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** 'YYYY-MM-DD HH:MM[:SS]' → "9:00 AM" (an Open Dental wall clock; no timezone math). Pure. */
export function printTimeLabel(dateTime: string): string {
  const m = /[ T](\d{2}):(\d{2})/.exec(dateTime);
  if (!m) return "";
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}
