/**
 * Email identity per office (R5c): the contact details outbound email carries.
 *
 * ONE identity per office, used by EVERY email the office sends: the TC
 * patient email (footer, {{practice.*}} tokens, Reply-To) and the referral
 * letter (signature, footer, Reply-To). Not per feature.
 *
 *   replyTo        where a reply lands (the From address is a sending-only
 *                  address on the verified domain and cannot receive mail)
 *   practiceName   the name the email signs with
 *   practicePhone  the phone in the footer and in {{practice.phone}}
 *
 * Precedence, per field, read at send time:
 *   the value saved in the app  ->  the app setting (env)  ->  not set
 *
 * The FROM address is deliberately NOT here: it is bound to the DNS-verified
 * sending domain and stays a platform app setting. The response shows it
 * read-only so an office can see what it is, never change it.
 *
 * None of these values is a secret; none is patient data.
 */
import { z } from "zod";

/** Caps the server enforces (and the send-time readers re-apply). */
export const EMAIL_IDENTITY_LIMITS = {
  replyTo: 254,
  practiceName: 120,
  practicePhone: 40,
} as const;

export const TcEmailIdentityField = z.enum(["replyTo", "practiceName", "practicePhone"]);
export type TcEmailIdentityField = z.infer<typeof TcEmailIdentityField>;

export const TC_EMAIL_IDENTITY_FIELD_LABELS: Record<TcEmailIdentityField, string> = {
  replyTo: "Reply-to address",
  practiceName: "Practice name",
  practicePhone: "Practice phone",
};

/** Where an effective value came from. */
export const TcEmailIdentitySource = z.enum(["stored", "env", "none"]);
export type TcEmailIdentitySource = z.infer<typeof TcEmailIdentitySource>;

/** One field's state in GET/PUT /api/tc/email-identity. */
export const TcEmailIdentityFieldState = z.object({
  /** What an email sent right now would use, or null. */
  value: z.string().nullable(),
  source: TcEmailIdentitySource,
  /** The value saved in the app for this office, or null when none is. */
  stored: z.string().nullable(),
  /** The app setting's value (the fallback), or null when unset or unusable. */
  fallback: z.string().nullable(),
  /** The NAME of that app setting, e.g. ACS_EMAIL_REPLY_TO_ROLAND. */
  fallbackSetting: z.string(),
});
export type TcEmailIdentityFieldState = z.infer<typeof TcEmailIdentityFieldState>;

export const TcEmailIdentityResponse = z.object({
  success: z.literal(true),
  office: z.enum(["roland", "valley"]),
  fields: z.object({
    replyTo: TcEmailIdentityFieldState,
    practiceName: TcEmailIdentityFieldState,
    practicePhone: TcEmailIdentityFieldState,
  }),
  /** Read-only: managed by the platform, bound to the verified sending domain. */
  from: z.object({
    /** The sender a patient email uses (this office's own, else the shared one). */
    patientEmail: z.string().nullable(),
    /** The sender a referral letter uses (this office's own only). */
    referral: z.string().nullable(),
  }),
  /** False when the saved values could not be read since boot (env answers). */
  policyKnown: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export type TcEmailIdentityResponse = z.infer<typeof TcEmailIdentityResponse>;

/** No control characters (a header or a line of the footer must stay one line). */
const SINGLE_LINE = /^[^\u0000-\u001f\u007f]*$/;

/** A trimmed, non-empty, single-line string up to `max` characters. */
function line(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(SINGLE_LINE, "must be a single line of plain text");
}

/**
 * PUT /api/tc/email-identity — the WHOLE identity for the office. Every key is
 * required; null clears the saved value (back to the app setting). Strict: a
 * field that is not one of these three is a 400, so `from`, `office` or any
 * other smuggled key can never be written.
 */
export const TcEmailIdentityRequest = z
  .object({
    replyTo: line(EMAIL_IDENTITY_LIMITS.replyTo)
      .regex(/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/, "must be one plain email address")
      .nullable(),
    practiceName: line(EMAIL_IDENTITY_LIMITS.practiceName).nullable(),
    practicePhone: line(EMAIL_IDENTITY_LIMITS.practicePhone).nullable(),
  })
  .strict();
export type TcEmailIdentityRequest = z.infer<typeof TcEmailIdentityRequest>;
