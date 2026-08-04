/**
 * Port of TC-app client/src/lib/financingRates.test.ts — the ProviderOverride
 * type now lives in calc/financingRates (localStorage financingSettings was
 * not ported; overrides come from the server library adapter).
 *
 * The second half covers PM ruling 2: the catalog absorbed the legacy TC_RATES
 * table, so it is now the single rate source and must carry those constants —
 * and must keep reporting "unknown" (null) where it has no merchant-fee data.
 */
import { describe, expect, it } from "vitest";
import {
  buildAprPresets,
  getEffectiveApr,
  getFinancingProviderCatalog,
  getProviderByKey,
  getProviderByName,
  getProviderRateDetails,
  getProviderRates,
  merchantFeeFraction,
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

  it("resolves an override keyed by the library key as well as the name", () => {
    const cherry = getProviderByKey("cherry")!;
    const byKey: ProviderOverrideMap = {
      cherry: { promoEnabled: true, promoApr: 2, regularApr: 7 },
    };
    expect(getProviderRateDetails(cherry, byKey).regularApr).toBe(7);
    expect(getEffectiveApr(cherry, 24, byKey)).toBe(7);
  });
});

// ── PM ruling 2: the catalog is the single rate source ──────────────────────

describe("provider keys", () => {
  it("every catalog entry has a unique, library-shaped key", () => {
    const keys = getFinancingProviderCatalog().map((p) => p.key);
    expect(keys).toEqual(["carecredit", "cherry", "proceed", "sunbit", "in_house"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("looks providers up by key, tolerating the legacy in-house spelling", () => {
    expect(getProviderByKey("carecredit")?.name).toBe("CareCredit");
    expect(getProviderByKey("in_house")?.name).toBe("In-House");
    expect(getProviderByKey("in-house")?.name).toBe("In-House");
    expect(getProviderByKey("nope")).toBeUndefined();
  });
});

describe("merchantFeeFraction", () => {
  it("returns null (unknown) when there is no schedule at all", () => {
    expect(merchantFeeFraction(undefined, 12)).toBeNull();
  });

  it("prefers the per-term entry, then the flat rate, else null", () => {
    const schedule = { byTerm: { 12: 0.079 }, flat: 0.119 };
    expect(merchantFeeFraction(schedule, 12)).toBe(0.079);
    expect(merchantFeeFraction(schedule, 36)).toBe(0.119);
    expect(merchantFeeFraction({ byTerm: { 12: 0.079 } }, 36)).toBeNull();
  });

  it("distinguishes a known zero fee from an unknown one", () => {
    expect(merchantFeeFraction({ flat: 0 }, 12)).toBe(0);
    expect(merchantFeeFraction(undefined, 12)).toBeNull();
  });
});

describe("catalog rate schedules (absorbed TC_RATES)", () => {
  it("CareCredit carries the promo fee/minimum tables and the penalty APR", () => {
    const cc = getProviderRates("carecredit")!;
    expect(cc.promoMerchantFee?.byTerm).toEqual({
      6: 0.055,
      12: 0.075,
      18: 0.095,
      24: 0.1195,
    });
    expect(cc.promoMinPurchaseByTerm).toEqual({ 6: 200, 12: 200, 18: 200, 24: 1000 });
    expect(cc.penaltyApr).toBe(26.99);
    expect(cc.aprByTerm).toEqual({ 24: 14.9, 36: 14.9, 48: 15.9, 60: 16.9 });
    expect(cc.minPurchaseByTerm).toEqual({ 24: 1000, 36: 1500, 48: 2500, 60: 2500 });
    expect(merchantFeeFraction(cc.merchantFee, 36)).toBe(0.035); // flat extended fee
    expect(cc.extendedTerms).toEqual([24, 36, 48, 60]);
  });

  it("CareCredit's catalog terms cover both the promo and extended lanes", () => {
    const cc = getProviderByKey("carecredit")!;
    for (const t of [6, 12, 18, 24, 36, 48, 60]) expect(cc.terms).toContain(t);
    expect(cc.promoTerms).toEqual([6, 12, 18, 24]);
  });

  it("Cherry carries the per-term APR/fee tables and both minimums", () => {
    const ch = getProviderRates("cherry")!;
    expect(ch.aprByTerm).toEqual({ 3: 0, 6: 0, 12: 9.99, 18: 14.99, 24: 17.99 });
    expect(ch.aprFallback).toBe(17.99);
    expect(ch.merchantFee?.byTerm).toEqual({
      3: 0.039,
      6: 0.049,
      12: 0.079,
      18: 0.099,
      24: 0.119,
    });
    expect(ch.minPurchase).toBe(200);
    expect(ch.minMonthly).toBe(25);
  });

  it("In-House publishes a KNOWN zero merchant fee (no lender)", () => {
    const ih = getProviderRates("in_house")!;
    expect(merchantFeeFraction(ih.merchantFee, 12)).toBe(0);
    expect(ih.minPurchase).toBe(0);
    expect(ih.minMonthly).toBeUndefined();
  });

  it("providers with no published fee data stay UNKNOWN — never invented", () => {
    expect(getProviderRates("proceed")).toBeUndefined();
    expect(getProviderRates("sunbit")).toBeUndefined();
    expect(getProviderRates("some-custom-office-provider")).toBeUndefined();
  });

  it("looks a schedule up by display name too", () => {
    expect(getProviderRates("Cherry")).toBe(getProviderRates("cherry"));
  });
});
