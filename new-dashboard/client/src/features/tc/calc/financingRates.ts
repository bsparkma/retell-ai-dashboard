/**
 * Financing provider catalog — the SINGLE source of financing rate truth for
 * the TC calculators.
 *
 * PM ruling 2 (TC parity slice): the legacy DentaFlow app carried two competing
 * rate sources — a hardcoded `TC_RATES` table (merchant fees, promo/penalty
 * APRs, per-term lists, minimums) in calcRates.ts AND this provider catalog +
 * settings overrides. The duality is dead: every rate constant now lives in
 * this catalog as per-provider data, and the office library layers overrides on
 * top of it. calcRates.ts keeps ONLY UI affordances (see the comment there).
 *
 * PRECEDENCE — highest wins:
 *   1. Library / settings override  (financing_settings.providerOverrides)
 *   2. Catalog headline rates       (promoApr / regularApr — office-configurable,
 *                                    these are the two fields the library
 *                                    contract mirrors per provider)
 *   3. Catalog rate schedule        (`rates`: the lender's published reference
 *                                    tables an office cannot configure —
 *                                    merchant fees, per-term APR/minimums,
 *                                    minimum monthly, deferred-interest penalty)
 *
 * `rates` is OPTIONAL on purpose. A provider with no merchant-fee data (custom
 * office providers, Proceed, Sunbit) reports "net unknown" rather than letting
 * the UI claim the practice collects in full. Never invent a fee to fill a gap.
 *
 * PLATFORM ADAPTATION: the legacy ProviderOverride type lived in the
 * localStorage-backed financingSettings.ts, which was NOT ported — the platform
 * stores provider enablement and APR overrides server-side in the office
 * library (financing_settings section). ProviderOverride is defined here
 * instead, and libraryAdapter.ts derives ProviderOverrideMap / catalog entries
 * from the server library.
 *
 * DOLLARS DOMAIN: every amount in this file is user-facing scratchpad dollars,
 * never persisted money (persisted money is integer cents per shared/tc).
 */

/** Legacy shape (was financingSettings.ProviderOverride) — per-provider APR
 * override, keyed by provider display name in ProviderOverrideMap. */
export interface ProviderOverride {
  promoEnabled: boolean;
  promoApr: number;
  regularApr: number;
}

/** Merchant discount rate, as a fraction of the financed amount. An absent
 * schedule (or a term with no entry and no `flat`) means UNKNOWN, not zero. */
export interface MerchantFeeSchedule {
  /** Fee fraction by term, e.g. `{ 12: 0.075 }` = 7.5% at 12 months. */
  byTerm?: Record<number, number>;
  /** Fee fraction used for terms absent from `byTerm`. */
  flat?: number;
}

/**
 * The lender's published reference tables (not office-configurable). Absent
 * fields mean "we have no data" — callers must keep the honest unknown state.
 */
export interface ProviderRateSchedule {
  /** Published APR by term for the interest-bearing lane. */
  aprByTerm?: Record<number, number>;
  /** APR used for terms absent from `aprByTerm`. */
  aprFallback?: number;
  /** Merchant fee for the 0%-promo (deferred-interest) lane. */
  promoMerchantFee?: MerchantFeeSchedule;
  /** Merchant fee for the interest-bearing lane. */
  merchantFee?: MerchantFeeSchedule;
  /** Minimum financed amount (dollars) by term, promo lane. */
  promoMinPurchaseByTerm?: Record<number, number>;
  /** Minimum financed amount (dollars) by term, interest-bearing lane. */
  minPurchaseByTerm?: Record<number, number>;
  /** Floor minimum financed amount (dollars) when no per-term entry applies. */
  minPurchase?: number;
  /** Smallest monthly payment the lender will originate (dollars). */
  minMonthly?: number;
  /** Retroactive APR charged if a deferred-interest promo isn't paid in full. */
  penaltyApr?: number;
  /** Terms the lender offers on its interest-bearing (extended) lane. */
  extendedTerms?: number[];
}

export interface FinancingProviderCatalogItem {
  /** Stable key — matches the office library's provider key. */
  key: string;
  name: string;
  logo: string;
  color: string;
  description: string;
  terms: number[];
  promoTerms: number[];
  /** Dollars (calculator scratchpad domain), NOT cents. */
  minAmount: number;
  apr: number;
  promoApr: number;
  regularApr: number;
  /** Lender reference tables. Absent ⇒ merchant fee / minimums unknown. */
  rates?: ProviderRateSchedule;
}

export type ProviderOverrideMap = Record<string, ProviderOverride | undefined>;

const PROVIDER_CATALOG: FinancingProviderCatalogItem[] = [
  {
    key: "carecredit",
    name: "CareCredit",
    logo: "CC",
    color: "var(--chart-1)",
    description: "Healthcare credit card with 0% promotional periods",
    // 6mo promo + the extended lane's 36/48/60 come from the legacy rate
    // table; the catalog is now the union so no lane loses a term.
    terms: [6, 12, 18, 24, 36, 48, 60],
    promoTerms: [6, 12, 18, 24],
    minAmount: 200,
    apr: 0,
    promoApr: 0,
    // Headline regular rate; equals the deferred-interest penalty rate, which
    // is what a promo that isn't paid off converts to.
    regularApr: 26.99,
    rates: {
      aprByTerm: { 24: 14.9, 36: 14.9, 48: 15.9, 60: 16.9 },
      aprFallback: 14.9,
      promoMerchantFee: { byTerm: { 6: 0.055, 12: 0.075, 18: 0.095, 24: 0.1195 } },
      merchantFee: { flat: 0.035 },
      promoMinPurchaseByTerm: { 6: 200, 12: 200, 18: 200, 24: 1000 },
      minPurchaseByTerm: { 24: 1000, 36: 1500, 48: 2500, 60: 2500 },
      penaltyApr: 26.99,
      extendedTerms: [24, 36, 48, 60],
    },
  },
  {
    key: "cherry",
    name: "Cherry",
    logo: "CH",
    color: "var(--chart-2)",
    description: "Flexible financing with fast approval",
    terms: [3, 6, 12, 18, 24, 36, 48],
    promoTerms: [3, 6],
    minAmount: 200,
    apr: 0,
    promoApr: 0,
    regularApr: 9.9,
    rates: {
      aprByTerm: { 3: 0, 6: 0, 12: 9.99, 18: 14.99, 24: 17.99 },
      aprFallback: 17.99,
      merchantFee: {
        byTerm: { 3: 0.039, 6: 0.049, 12: 0.079, 18: 0.099, 24: 0.119 },
        flat: 0.119,
      },
      minPurchase: 200,
      minMonthly: 25,
    },
  },
  {
    key: "proceed",
    name: "Proceed Finance",
    logo: "PF",
    color: "var(--chart-4)",
    description: "Long-term financing for large cases",
    terms: [24, 36, 48, 60, 72, 84],
    promoTerms: [],
    minAmount: 1000,
    apr: 9.9,
    promoApr: 9.9,
    regularApr: 9.9,
    // No merchant-fee data published to us → net-to-practice stays unknown.
  },
  {
    key: "sunbit",
    name: "Sunbit",
    logo: "SB",
    color: "var(--chart-5)",
    description: "Buy now, pay later for dental care",
    terms: [3, 6, 12, 18, 24, 36],
    promoTerms: [3, 6],
    minAmount: 50,
    apr: 0,
    promoApr: 0,
    regularApr: 9.9,
    // No merchant-fee data published to us → net-to-practice stays unknown.
  },
  {
    key: "in_house",
    name: "In-House",
    logo: "IH",
    color: "var(--chart-3)",
    description: "Practice-managed payment plan",
    terms: [3, 6, 12, 18, 24, 36],
    promoTerms: [3, 6, 12],
    minAmount: 0,
    apr: 0,
    promoApr: 0,
    regularApr: 0,
    rates: {
      aprFallback: 0,
      // No lender, so no merchant discount — a KNOWN zero, not a gap.
      merchantFee: { flat: 0 },
      minPurchase: 0,
    },
  },
];

/** Offices that predate the stable-key contract may store "in-house". */
const KEY_ALIASES: Record<string, string> = { "in-house": "in_house" };

function normalizeKey(key: string): string {
  const lower = key.trim().toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

export function getFinancingProviderCatalog(): FinancingProviderCatalogItem[] {
  return PROVIDER_CATALOG;
}

export function getProviderByName(
  name: string,
  providers: FinancingProviderCatalogItem[] = PROVIDER_CATALOG,
): FinancingProviderCatalogItem | undefined {
  return providers.find((provider) => provider.name === name);
}

export function getProviderByKey(
  key: string,
  providers: FinancingProviderCatalogItem[] = PROVIDER_CATALOG,
): FinancingProviderCatalogItem | undefined {
  const wanted = normalizeKey(key);
  return providers.find((provider) => normalizeKey(provider.key) === wanted);
}

/**
 * Rate schedule for a provider, looked up by library key first then by display
 * name. `undefined` means the catalog has no reference data for that provider —
 * callers MUST keep the honest unknown state instead of substituting zeros.
 */
export function getProviderRates(keyOrName: string): ProviderRateSchedule | undefined {
  return (getProviderByKey(keyOrName) ?? getProviderByName(keyOrName))?.rates;
}

/**
 * Merchant fee fraction for a term, or `null` when the catalog has no data.
 * `null` ≠ 0: zero means "the practice really does collect in full" (in-house),
 * null means "we don't know this lender's fee".
 */
export function merchantFeeFraction(
  schedule: MerchantFeeSchedule | undefined,
  termMonths: number,
): number | null {
  if (!schedule) return null;
  const byTerm = schedule.byTerm?.[termMonths];
  if (byTerm !== undefined) return byTerm;
  return schedule.flat ?? null;
}

export function getProviderRateDetails(
  provider: FinancingProviderCatalogItem,
  overrides: ProviderOverrideMap = {},
): { promoEnabled: boolean; promoApr: number; regularApr: number } {
  const override = overrides[provider.name] ?? overrides[provider.key];
  return {
    promoEnabled: override?.promoEnabled ?? provider.promoTerms.length > 0,
    promoApr: override?.promoApr ?? provider.promoApr,
    regularApr: override?.regularApr ?? provider.regularApr,
  };
}

export function getEffectiveApr(
  provider: FinancingProviderCatalogItem,
  termMonths: number,
  overrides: ProviderOverrideMap = {},
): number {
  const details = getProviderRateDetails(provider, overrides);
  const isPromo = details.promoEnabled && provider.promoTerms.includes(termMonths);
  return isPromo ? details.promoApr : details.regularApr;
}

export function buildAprPresets(
  providers: FinancingProviderCatalogItem[] = PROVIDER_CATALOG,
  overrides: ProviderOverrideMap = {},
): { label: string; apr: number }[] {
  const cherry = getProviderByName("Cherry", providers);
  const careCredit = getProviderByName("CareCredit", providers);
  const cherryRegularApr = cherry ? getProviderRateDetails(cherry, overrides).regularApr : 9.9;
  const careCreditRegularApr = careCredit ? getProviderRateDetails(careCredit, overrides).regularApr : 26.99;

  return [
    { label: "0% — Promo / In-house", apr: 0 },
    { label: `${cherryRegularApr}% — Cherry 12mo`, apr: cherryRegularApr },
    { label: `${careCreditRegularApr}% — CC Extended`, apr: careCreditRegularApr },
    { label: `${cherryRegularApr}% — Cherry 24mo`, apr: cherryRegularApr },
    { label: `${careCreditRegularApr}% — CC Penalty`, apr: careCreditRegularApr },
  ];
}
