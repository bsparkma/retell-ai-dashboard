/**
 * Port of TC-app client/src/lib/financingRates.test.ts — the ProviderOverride
 * type now lives in calc/financingRates (localStorage financingSettings was
 * not ported; overrides come from the server library adapter).
 */
import { describe, expect, it } from "vitest";
import {
  buildAprPresets,
  getEffectiveApr,
  getFinancingProviderCatalog,
  getProviderByName,
  getProviderRateDetails,
  type ProviderOverrideMap,
} from "../client/src/features/tc/calc/financingRates";

describe("financingRates", () => {
  it("uses financing provider overrides for calculator APR presets and provider APRs", () => {
    const providers = getFinancingProviderCatalog();
    const overrides: ProviderOverrideMap = {
      Cherry: { promoEnabled: true, promoApr: 1.25, regularApr: 8.75 },
      CareCredit: { promoEnabled: true, promoApr: 0, regularApr: 22.5 },
    };

    const cherry = providers.find((provider) => provider.name === "Cherry");
    const careCredit = providers.find((provider) => provider.name === "CareCredit");

    expect(cherry).toBeDefined();
    expect(careCredit).toBeDefined();
    expect(getEffectiveApr(cherry!, 6, overrides)).toBe(1.25);
    expect(getEffectiveApr(cherry!, 24, overrides)).toBe(8.75);
    expect(getEffectiveApr(careCredit!, 36, overrides)).toBe(22.5);

    expect(buildAprPresets(providers, overrides)).toEqual([
      { label: "0% — Promo / In-house", apr: 0 },
      { label: "8.75% — Cherry 12mo", apr: 8.75 },
      { label: "22.5% — CC Extended", apr: 22.5 },
      { label: "8.75% — Cherry 24mo", apr: 8.75 },
      { label: "22.5% — CC Penalty", apr: 22.5 },
    ]);
  });

  it("falls back to catalog rates when no override exists", () => {
    const cherry = getProviderByName("Cherry");
    expect(cherry).toBeDefined();
    // Promo term with default promoEnabled (promoTerms non-empty).
    expect(getEffectiveApr(cherry!, 3)).toBe(0);
    // Non-promo term → regular APR.
    expect(getEffectiveApr(cherry!, 24)).toBe(9.9);
  });

  it("promoEnabled:false override forces the regular APR on promo terms", () => {
    const cherry = getProviderByName("Cherry");
    const overrides: ProviderOverrideMap = {
      Cherry: { promoEnabled: false, promoApr: 0, regularApr: 11.5 },
    };
    expect(getProviderRateDetails(cherry!, overrides).promoEnabled).toBe(false);
    expect(getEffectiveApr(cherry!, 3, overrides)).toBe(11.5);
  });

  it("buildAprPresets without overrides uses catalog regular APRs", () => {
    expect(buildAprPresets()).toEqual([
      { label: "0% — Promo / In-house", apr: 0 },
      { label: "9.9% — Cherry 12mo", apr: 9.9 },
      { label: "26.99% — CC Extended", apr: 26.99 },
      { label: "9.9% — Cherry 24mo", apr: 9.9 },
      { label: "26.99% — CC Penalty", apr: 26.99 },
    ]);
  });
});
