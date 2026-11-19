/**
 * Which offices the client offers, derived from what the SERVER serves (MT-2b3).
 *
 * The client has no list of its own. The office roster (OfficeContext, from
 * GET /api/unified-calls/offices) is the source. Which keys are real offices
 * of the session's practice is decided server-side by every route's office
 * gate (backend/platform/officeGate.js), so nothing here can widen what a
 * request reaches; it only decides what the UI offers.
 *
 * FALLBACK_OFFICE_KEYS is the ONE client-side spelling of the two offices. It
 * exists only for the pages that already, deliberately, keep working when the
 * roster fails to load (an empty fees list must not read as "you have never
 * imported anything"). Replacing it needs a roster every module can read: the
 * current one sits behind the voice module guard. That is a disclosed MT-2b3
 * follow-up, and new code must not reach for this constant.
 */
import { OfficeKeySchema, isOfficeKey, type OfficeKey } from "@shared/officeKey";

export { isOfficeKey, type OfficeKey };

/**
 * The roster-failure fallback. See the header: not a list of offices, a list
 * of what to try when the server could not say.
 */
export const FALLBACK_OFFICE_KEYS: readonly OfficeKey[] = Object.freeze(
  ["roland", "valley"].map((k) => OfficeKeySchema.parse(k)),
);

/**
 * The offices in a server roster, in roster order: well-formed keys only,
 * 'unknown' (the unmapped-line bucket) dropped, duplicates dropped.
 */
export function servedOfficeKeys(roster: readonly { officeId: string }[]): OfficeKey[] {
  const out: OfficeKey[] = [];
  for (const { officeId } of roster) {
    if (isOfficeKey(officeId) && !out.includes(officeId)) out.push(officeId);
  }
  return out;
}

/** The roster's offices, or FALLBACK_OFFICE_KEYS when the roster names none. */
export function servedOfficeKeysOrFallback(roster: readonly { officeId: string }[]): OfficeKey[] {
  const served = servedOfficeKeys(roster);
  return served.length > 0 ? served : [...FALLBACK_OFFICE_KEYS];
}

/**
 * A concrete office selection as a key the server serves, or null.
 * Well-formed AND on the roster. When the roster names no office (still
 * loading, or it failed), the shape alone answers, so a page that worked
 * before the roster arrived keeps working. The server's gate still decides.
 */
export function selectedServedOffice(selection: unknown, roster: readonly { officeId: string }[]): OfficeKey | null {
  if (!isOfficeKey(selection)) return null;
  const served = servedOfficeKeys(roster);
  return served.length === 0 || served.includes(selection) ? selection : null;
}

/** `value` as an office key, or null. Shape only; the server decides WHOSE. */
export function asOfficeKey(value: unknown): OfficeKey | null {
  return isOfficeKey(value) ? value : null;
}

/**
 * A short label from a module's presentational map, falling back to the key
 * itself for an office the map does not name (a new office still renders).
 */
export function shortOfficeLabel(labels: Readonly<Record<string, string>>, officeKey: string): string {
  return labels[officeKey] ?? officeKey;
}
