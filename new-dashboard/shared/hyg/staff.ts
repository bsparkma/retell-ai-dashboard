/**
 * The Practice staff page's contract: the hygienists an office manager enters,
 * and how they are recognised when signed in.
 *
 * One file for both sides. The route parses its bodies with these schemas (via
 * backend/hyg/contract.gen.cjs) and the page builds its requests from the same
 * types, so "what the form accepts" and "what the server stores" cannot drift.
 *
 * Staff, not patients: nothing here is PHI. See
 * backend/migrations-tenant/1793400000000_hyg_staff.js for the table.
 */
import { z } from "zod";

/** At most this many sign-in ids per person (the table's CHECK says the same). */
export const HYG_STAFF_SIGN_IN_MAX = 10;

/**
 * How a sign-in id is compared: lowercased, runs of whitespace made one space,
 * trimmed. The SAME rule backend/config/hygStaff.js `normalizeName` applies to
 * a signed-in user's name and email, so a stored id and a session value meet
 * on one spelling.
 */
export function normalizeSignInId(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

const FullNameSchema = z
  .string()
  .transform((v) => v.replace(/\s+/g, " ").trim())
  .pipe(z.string().min(1, "A name is required").max(120, "A name is at most 120 characters"));

/**
 * The licence number, or null for "none on file". Blank input IS "none on
 * file" — never an empty string, which could print as `RDH #`.
 */
const LicenseSchema = z
  .union([z.string(), z.null()])
  .transform((v) => (v === null ? null : v.trim() === "" ? null : v.trim()))
  .pipe(z.union([z.string().max(40, "A licence number is at most 40 characters"), z.null()]));

const SignInIdsSchema = z
  .array(z.string())
  .transform((ids) => Array.from(new Set(ids.map(normalizeSignInId).filter((v) => v.length > 0))))
  .pipe(
    z
      .array(z.string().max(254, "A sign-in is at most 254 characters"))
      .min(1, "At least one sign-in email or username is required")
      .max(HYG_STAFF_SIGN_IN_MAX, `At most ${HYG_STAFF_SIGN_IN_MAX} sign-ins per person`),
  );

/** POST and PUT bodies: the three things the office manager types. */
export const HygStaffInputSchema = z
  .object({
    fullName: FullNameSchema,
    license: LicenseSchema,
    signInIds: SignInIdsSchema,
  })
  .strict();
export type HygStaffInput = z.input<typeof HygStaffInputSchema>;

/** One row, as every route answers with it. */
export const HygStaffSchema = z.object({
  id: z.string().uuid(),
  office: z.enum(["roland", "valley"]),
  fullName: z.string(),
  license: z.string().nullable(),
  signInIds: z.array(z.string()),
  active: z.boolean(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type HygStaff = z.infer<typeof HygStaffSchema>;

/** GET /api/platform/hyg-staff?office= */
export const HygStaffListSchema = z.object({
  success: z.literal(true),
  office: z.enum(["roland", "valley"]),
  staff: z.array(HygStaffSchema),
  /**
   * True while this office has NO rows: notes still take hygienist names from
   * the built-in list in backend/config/hygStaff.js. The page says so, and
   * never shows that list.
   */
  usingBuiltInList: z.boolean(),
});
export type HygStaffList = z.infer<typeof HygStaffListSchema>;

/**
 * ── The Users page's "Signature on notes" ─────────────────────────────────
 *
 * One door per person: the signature a note prints for someone is entered on
 * THEIR Users row, keyed to their app_user email. The body carries the two
 * things a person types and nothing else — never an email, never an office.
 * The server takes the sign-in from the app_user row and the office from the
 * user's home office, so a typo can no longer leave a licence unmatched.
 *
 * Both blank CLEARS the signature (the hyg_staff row is deactivated, never
 * deleted). A licence with no name is refused: a licence line needs a name to
 * hang on.
 */
const OptionalTrimmed = (max: number, label: string) =>
  z
    .union([z.string(), z.null()])
    .transform((v) => (v === null ? null : v.replace(/\s+/g, " ").trim() || null))
    .pipe(z.union([z.string().max(max, `${label} is at most ${max} characters`), z.null()]));

export const UserSignatureInputSchema = z
  .object({
    fullName: OptionalTrimmed(120, "A name"),
    license: OptionalTrimmed(40, "A licence number"),
  })
  .strict()
  .refine((v) => !(v.fullName === null && v.license !== null), {
    message: "Enter the name the licence belongs to",
    path: ["fullName"],
  });
export type UserSignatureInput = z.input<typeof UserSignatureInputSchema>;

/** GET and PUT /users/:email/signature (and the platform console's twin). */
export const UserSignatureResponseSchema = z.object({
  success: z.literal(true),
  /** The office whose notes this signature prints on (the user's home office). */
  office: z.enum(["roland", "valley"]),
  /** null = no active signature: the signed-in name prints alone. */
  signature: z
    .object({
      fullName: z.string(),
      license: z.string().nullable(),
    })
    .nullable(),
  /**
   * True while this office has NO hyg_staff rows, so notes still take licences
   * from the built-in list in backend/config/hygStaff.js. The first signature
   * saved switches the office to the table — the page warns before that save.
   */
  usingBuiltInList: z.boolean(),
});
export type UserSignatureResponse = z.infer<typeof UserSignatureResponseSchema>;
