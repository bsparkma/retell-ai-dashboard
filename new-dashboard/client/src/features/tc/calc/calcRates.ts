/**
 * UI affordances for the calculator — deliberately NOT rate truth.
 *
 * PM ruling 2 (TC parity slice) killed the TC_RATES / financingRates duality:
 * every financing constant that describes a real lender product (per-provider
 * terms, promo/regular/penalty APRs, merchant fees, minimum purchase, minimum
 * monthly) now lives in financingRates.ts as catalog data, with the office
 * library's financing_settings layered on top. The legacy `TC_RATES` table and
 * the static `APR_PRESETS` list built from it are gone — APR chips come from
 * `buildAprPresets(catalog, overrides)` so they track the office's real rates.
 *
 * What survives here is the one constant that has no lender behind it:
 *
 * SIMPLE_TERMS is the Simple-mode term-chip row. Simple mode is a free-hand
 * what-if — the TC picks any term and drags any APR; nothing on that screen
 * claims a provider will actually originate it. So this list is chrome (a
 * spread of common term lengths), not a rate table, and provider lanes must
 * NEVER use it — Full-mode lanes take their terms from the library provider
 * (falling back to the catalog's per-provider term list).
 *
 * The legacy TREATMENT_PRESETS (14 hardcoded practice fees) was likewise not
 * ported — presets derive from the office library (see
 * libraryAdapter.treatmentPresetsFromLibrary) so the calculator never invents
 * dollar amounts.
 */

export const SIMPLE_TERMS = [3, 6, 12, 18, 24, 36, 48, 60];
