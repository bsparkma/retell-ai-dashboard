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
