/**
 * Financing provider catalog + effective-APR helpers — ported faithfully from
 * TC-app client/src/lib/financingRates.ts.
 *
 * PLATFORM ADAPTATION: the legacy ProviderOverride type lived in the
 * localStorage-backed financingSettings.ts, which was NOT ported — the
 * platform stores provider enablement and APR overrides server-side in the
 * office library (financing_settings section). ProviderOverride is defined
 * here instead, and libraryAdapter.ts derives ProviderOverrideMap /
 * catalog entries from the server library.
 *
 * The static catalog below carries the reference merchant-fee-free rate data
 * (dollars-domain min amounts) used for APR presets and rate details; live
 * office truth comes from the library adapter.
 */

/** Legacy shape (was financingSettings.ProviderOverride) — per-provider APR
 * override, keyed by provider display name in ProviderOverrideMap. */
export interface ProviderOverride {
  promoEnabled: boolean;
  promoApr: number;
  regularApr: number;
}

export interface FinancingProviderCatalogItem {
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
}

export type ProviderOverrideMap = Record<string, ProviderOverride | undefined>;

const PROVIDER_CATALOG: FinancingProviderCatalogItem[] = [
  {
    name: "CareCredit",
    logo: "CC",
    color: "var(--chart-1)",
    description: "Healthcare credit card with 0% promotional periods",
    terms: [12, 18, 24, 36, 48, 60],
    promoTerms: [12, 18, 24],
    minAmount: 200,
    apr: 0,
    promoApr: 0,
    regularApr: 26.99,
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
    name: "In-House",
    logo: "IH",
    color: "var(--chart-3)",
    description: "Practice-managed payment plan",
    terms: [3, 6, 12, 18, 24],
    promoTerms: [3, 6, 12],
    minAmount: 0,
    apr: 0,
    promoApr: 0,
    regularApr: 0,
  },
];

export function getFinancingProviderCatalog(): FinancingProviderCatalogItem[] {
  return PROVIDER_CATALOG;
}

export function getProviderByName(
  name: string,
  providers: FinancingProviderCatalogItem[] = PROVIDER_CATALOG,
): FinancingProviderCatalogItem | undefined {
  return providers.find((provider) => provider.name === name);
}

export function getProviderRateDetails(
  provider: FinancingProviderCatalogItem,
  overrides: ProviderOverrideMap = {},
): { promoEnabled: boolean; promoApr: number; regularApr: number } {
  const override = overrides[provider.name];
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
