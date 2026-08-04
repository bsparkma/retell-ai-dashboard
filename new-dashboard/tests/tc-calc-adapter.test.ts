/**
 * Library → calculator adapter tests: server-library-driven provider
 * enablement/overrides (replacing legacy localStorage financingSettings) and
 * crown_pricing-derived treatment presets (replacing the hardcoded fee list).
 */
import { describe, expect, it } from "vitest";
import {
  financingViewFromLibrary,
  treatmentPresetsFromLibrary,
  type FinancingLibraryInput,
} from "../client/src/features/tc/calc/libraryAdapter";
import { getEffectiveApr } from "../client/src/features/tc/calc/financingRates";

function provider(key: string, label: string, over: Partial<{
  enabled: boolean;
  minAmountCents: number;
  promoTerms: number[];
  terms: number[];
  promoApr: number;
  regularApr: number;
}> = {}) {
  return {
    key,
    label,
    logo: label.slice(0, 2).toUpperCase(),
    color: "var(--chart-1)",
    description: `${label} financing`,
    terms: over.terms ?? [12, 24, 36],
    promoTerms: over.promoTerms ?? [12],
    minAmountCents: over.minAmountCents ?? 20_000,
    promoApr: over.promoApr ?? 0,
    regularApr: over.regularApr ?? 14.9,
    enabled: over.enabled ?? true,
  };
}

describe("financingViewFromLibrary", () => {
  it("null/empty library → unconfigured, no providers, everything off", () => {
    const view = financingViewFromLibrary(null);
    expect(view.configured).toBe(false);
    expect(view.providers).toEqual([]);
    expect(view.serviceFeeEnabled).toBe(false);
    expect(view.cashDiscountEnabled).toBe(false);
    expect(view.cashDiscountPercent).toBe(0);
  });

  it("maps library providers to catalog items, cents → dollars at the boundary", () => {
    const lib: FinancingLibraryInput = {
      financing_providers: [provider("carecredit", "CareCredit", { minAmountCents: 20_000 })],
    };
    const view = financingViewFromLibrary(lib);
    expect(view.configured).toBe(true);
    expect(view.providers).toHaveLength(1);
    const p = view.providers[0]!;
    expect(p.key).toBe("carecredit");
    expect(p.name).toBe("CareCredit");
    expect(p.minAmount).toBe(200); // dollars
    expect(p.regularApr).toBe(14.9);
  });

  it("drops providers disabled in the provider row or in financing_settings", () => {
    const lib: FinancingLibraryInput = {
      financing_providers: [
        provider("carecredit", "CareCredit"),
        provider("cherry", "Cherry", { enabled: false }),
        provider("sunbit", "Sunbit"),
      ],
      financing_settings: {
        enabledProviders: { sunbit: false, carecredit: true },
        serviceFeeEnabled: false,
        serviceFeePercent: 0,
        providerOverrides: {},
      },
    };
    const view = financingViewFromLibrary(lib);
    expect(view.providers.map((p) => p.key)).toEqual(["carecredit"]);
  });

  it("exposes APR overrides under both library key and display name", () => {
    const lib: FinancingLibraryInput = {
      financing_providers: [provider("cherry", "Cherry", { promoTerms: [3, 6], terms: [3, 6, 12, 24] })],
      financing_settings: {
        enabledProviders: {},
        serviceFeeEnabled: false,
        serviceFeePercent: 0,
        providerOverrides: {
          cherry: { promoEnabled: true, promoApr: 1.25, regularApr: 8.75 },
        },
      },
    };
    const view = financingViewFromLibrary(lib);
    expect(view.overrides["cherry"]?.regularApr).toBe(8.75);
    expect(view.overrides["Cherry"]?.regularApr).toBe(8.75);
    // The ported (name-keyed) helpers work directly on adapted providers.
    const cherry = view.providers[0]!;
    expect(getEffectiveApr(cherry, 6, view.overrides)).toBe(1.25);
    expect(getEffectiveApr(cherry, 24, view.overrides)).toBe(8.75);
  });

  it("service fee and cash discount require both the flag and a non-zero percent", () => {
    const base: FinancingLibraryInput = {
      financing_config: {
        serviceFeeEnabled: true,
        serviceFeePercent: 3,
        cashDiscountEnabled: true,
        cashDiscountPercent: 5,
      },
    };
    const on = financingViewFromLibrary(base);
    expect(on.serviceFeeEnabled).toBe(true);
    expect(on.serviceFeePercent).toBe(3);
    expect(on.cashDiscountEnabled).toBe(true);
    expect(on.cashDiscountPercent).toBe(5);

    const off = financingViewFromLibrary({
      financing_config: {
        serviceFeeEnabled: false,
        serviceFeePercent: 3,
        cashDiscountEnabled: false,
        cashDiscountPercent: 5,
      },
    });
    expect(off.serviceFeeEnabled).toBe(false);
    // Disabled discount reports 0% — the legacy hardcoded 5 is dead.
    expect(off.cashDiscountEnabled).toBe(false);
    expect(off.cashDiscountPercent).toBe(0);
  });
});

describe("treatmentPresetsFromLibrary", () => {
  it("no library / no crown_pricing → empty (honest empty state, no invented fees)", () => {
    expect(treatmentPresetsFromLibrary(null)).toEqual([]);
    expect(treatmentPresetsFromLibrary({})).toEqual([]);
  });

  it("derives dollar presets from crown_pricing and drops zero entries", () => {
    const presets = treatmentPresetsFromLibrary({
      crown_pricing: {
        economyCents: 80_000,
        standardCents: 110_000,
        premiumCents: 150_000,
        implantCents: 0,
      },
    });
    expect(presets).toEqual([
      { name: "Crown — Economy", fee: 800 },
      { name: "Crown — Standard", fee: 1100 },
      { name: "Crown — Premium", fee: 1500 },
    ]);
  });
});
