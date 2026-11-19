/**
 * THE office key, as the wire and the database spell it (MT-2b3).
 *
 * Until MT-2b3, 23 shared/ schemas each spelled the two offices as a z.enum.
 * An office is now a row in the office registry, not a constant, so a schema
 * can no longer know which keys exist. It checks the FORMAT only, the same
 * format every tenant table's `<table>_office_check` has enforced since MT-2b2
 * (migrations-tenant/1795000000000_office_format_checks.js).
 *
 * WHICH keys are offices is decided by the SERVER, per request, for the
 * session tenant: backend/platform/officeGate.js (officeRegistry.isTenantOffice).
 * backend/test/officeGateWiring.test.js pins that every route that accepts an
 * office passes through one of those gates. So parsing a value with this schema
 * means only "this is shaped like an office key", never "this is one of your
 * offices".
 *
 * Branded, so a bare string cannot be passed where an office key is expected
 * without going through a parse or isOfficeKey(). A literal like "roland" must
 * be parsed too, which is the point: code that names an office by literal is
 * code that will not follow the registry.
 */
import { z } from "zod";

/** Same pattern as the database CHECK (MT-2b2). */
export const OFFICE_KEY_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

/**
 * Keys that pass the database format but are never an office, so no schema
 * here accepts them (every old two-value enum refused them too):
 *   - 'unknown': the system bucket for an unmapped phone line. It names no
 *     practice, and the server gates always refuse it.
 *   - 'all': the client's "All offices" selection (OfficeContext ALL_OFFICES).
 *     Accepting it would turn that selection into a request for an office
 *     named 'all' on every page that asks isOfficeKey(selection).
 */
export const RESERVED_OFFICE_KEYS: readonly string[] = Object.freeze(["unknown", "all"]);

export const OfficeKeySchema = z
  .string()
  .regex(OFFICE_KEY_PATTERN)
  .refine((v) => !RESERVED_OFFICE_KEYS.includes(v), { message: "not an office key" })
  .brand<"OfficeKey">();
export type OfficeKey = z.infer<typeof OfficeKeySchema>;

/** Is `value` shaped like an office key (and not reserved)? Says nothing about WHOSE office. */
export function isOfficeKey(value: unknown): value is OfficeKey {
  return OfficeKeySchema.safeParse(value).success;
}
