/**
 * Library → calculator adapter.
 *
 * The legacy DentaFlow calculator read provider enablement / APR overrides
 * from per-browser localStorage (financingSettings.ts) and treatment presets
 * from a hardcoded 14-item fee list (calcRates.TREATMENT_PRESETS). Neither
 * was ported. On the platform the office library (server-owned, per office —
 * features/tc/api.ts getLibrary) is the single source of truth:
 *
 *  - financing_providers  → which lanes/rows exist, terms, min amounts, APRs
 *  - financing_settings   → per-office enable map + APR overrides
 *  - financing_config     → service fee + cash discount configuration
 *  - crown_pricing        → the ONLY fee data we have → treatment presets
 *
 * Everything returned here is in the calculator's DOLLARS scratchpad domain
 * (library money is integer cents; converted at this boundary, display-only).
 * This module is pure — no fetching, no persistence, no new backend routes.
 */

import type { z } from "zod";
import type {
  LibraryCrownPricing,
  LibraryFinancingConfig,
  LibraryFinancingProvider,
  LibraryFinancingSettings,
} from "@shared/tc/contract";
import {
  getProviderByKey,
  getProviderByName,
  type FinancingProviderCatalogItem,
  type ProviderOverrideMap,
} from "./financingRates";

type FinancingProvider = z.infer<typeof LibraryFinancingProvider>;
type FinancingSettings = z.infer<typeof LibraryFinancingSettings>;
type FinancingConfig = z.infer<typeof LibraryFinancingConfig>;
type CrownPricing = z.infer<typeof LibraryCrownPricing>;

/** Structural subset of api.ts TcLibrary — lets tests build inputs without
 * importing the API client. */
export interface FinancingLibraryInput {
  financing_providers?: FinancingProvider[];
  financing_settings?: FinancingSettings;
  financing_config?: FinancingConfig;
  crown_pricing?: CrownPricing;
}

/** Catalog item carrying the library's stable provider key (e.g. "carecredit").
 * The catalog item type now owns `key`, so this is a straight alias kept for
 * call-site readability. */
export type AdaptedFinancingProvider = FinancingProviderCatalogItem;

export interface FinancingLibraryView {
  /** False until the office has a financing_providers section in its library —
   * the calculators render honest empty states instead of invented lanes. */
  configured: boolean;
  /** Enabled providers only (provider.enabled AND not disabled in settings). */
  providers: AdaptedFinancingProvider[];
  /** APR overrides keyed by BOTH library key and display name, so the ported
   * financingRates helpers (name-keyed) work unchanged. */
  overrides: ProviderOverrideMap;
  serviceFeeEnabled: boolean;
  serviceFeePercent: number;
  cashDiscountEnabled: boolean;
  cashDiscountPercent: number;
}

function providerEnabled(provider: FinancingProvider, settings: FinancingSettings | undefined): boolean {
  if (!provider.enabled) return false;
  if (settings && provider.key in settings.enabledProviders) {
    return settings.enabledProviders[provider.key] === true;
  }
  return true;
}

export function financingViewFromLibrary(
  library: FinancingLibraryInput | null | undefined,
): FinancingLibraryView {
  const providersSection = library?.financing_providers;
  const settings = library?.financing_settings;
  const config = library?.financing_config;

  const overrides: ProviderOverrideMap = {};
  const providers: AdaptedFinancingProvider[] = [];

  for (const p of providersSection ?? []) {
    if (!providerEnabled(p, settings)) continue;
    const override = settings?.providerOverrides[p.key];
    // Catalog entry (rate truth: merchant fees, per-term APR/minimums, penalty
    // APR). Missing ⇒ a custom office provider we have no lender data for, and
    // the UI keeps its honest "net unknown" treatment — never invented fees.
    const catalog = getProviderByKey(p.key) ?? getProviderByName(p.label);
    providers.push({
      key: p.key,
      name: p.label,
      logo: p.logo,
      color: p.color,
      description: p.description,
      // An office row with no terms would render a lane with no term chips —
      // fall back to the catalog's per-provider list (never SIMPLE_TERMS).
      // promoTerms deliberately does NOT fall back: empty means the office
      // turned promos off, which is a real answer.
      terms: p.terms.length > 0 ? [...p.terms] : [...(catalog?.terms ?? [])],
      promoTerms: [...p.promoTerms],
      minAmount: p.minAmountCents / 100, // cents → dollars at the boundary
      apr: p.promoApr,
      promoApr: p.promoApr,
      regularApr: p.regularApr,
      rates: catalog?.rates,
    });
    if (override) {
      overrides[p.key] = override;
      overrides[p.label] = override;
    }
  }

  return {
    configured: providersSection !== undefined,
    providers,
    overrides,
    serviceFeeEnabled: (config?.serviceFeeEnabled ?? false) && (config?.serviceFeePercent ?? 0) > 0,
    serviceFeePercent: config?.serviceFeePercent ?? 0,
    cashDiscountEnabled: (config?.cashDiscountEnabled ?? false) && (config?.cashDiscountPercent ?? 0) > 0,
    cashDiscountPercent: config?.cashDiscountEnabled ? (config?.cashDiscountPercent ?? 0) : 0,
  };
}

// ── Treatment presets (honest: library fees only, never invented) ───────────

export interface TreatmentPreset {
  name: string;
  /** Dollars (calculator scratchpad domain). */
  fee: number;
}

/**
 * The legacy 14-item hardcoded TREATMENT_PRESETS list is dead. The office
 * library's only fee-schedule data today is crown_pricing — derive presets
 * from it and return [] when it's absent so the UI can say
 * "No fee schedule in Library yet" instead of inventing prices.
 */
export function treatmentPresetsFromLibrary(
  library: FinancingLibraryInput | null | undefined,
): TreatmentPreset[] {
  const pricing = library?.crown_pricing;
  if (!pricing) return [];
  const entries: { name: string; cents: number }[] = [
    { name: "Crown — Economy", cents: pricing.economyCents },
    { name: "Crown — Standard", cents: pricing.standardCents },
    { name: "Crown — Premium", cents: pricing.premiumCents },
    { name: "Implant Crown", cents: pricing.implantCents },
  ];
  return entries
    .filter((e) => e.cents > 0)
    .map((e) => ({ name: e.name, fee: e.cents / 100 }));
}
