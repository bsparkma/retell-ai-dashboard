import { describe, expect, it } from "vitest";
import {
  amortizeMonthlyCents,
  cashDiscountCents,
  financingOptionsCents,
  serviceFeeCents,
} from "../client/src/features/tc/lib/financing";
import {
  getCadenceTier,
  getDaysOverdue,
  getEscalationTier,
} from "../client/src/features/tc/lib/followups";

const provider = {
  key: "carecredit",
  label: "CareCredit",
  logo: "CC",
  color: "#2f6f4f",
  description: "",
  terms: [24, 36],
  promoTerms: [6, 12],
  minAmountCents: 20_000,
  promoApr: 0,
  regularApr: 14.9,
  enabled: true,
};

describe("amortizeMonthlyCents", () => {
  it("0% APR divides evenly and rounds to cents", () => {
    expect(amortizeMonthlyCents(120_000, 0, 12)).toBe(10_000);
    expect(amortizeMonthlyCents(100_000, 0, 3)).toBe(33_333);
  });

  it("standard amortization matches the known formula", () => {
    // $10,000 at 12% APR over 12 months ≈ $888.49/mo.
    expect(amortizeMonthlyCents(1_000_000, 12, 12)).toBe(88_849);
  });

  it("degenerate inputs return 0", () => {
    expect(amortizeMonthlyCents(0, 10, 12)).toBe(0);
    expect(amortizeMonthlyCents(100_000, 10, 0)).toBe(0);
  });
});

describe("financingOptionsCents", () => {
  it("emits promo terms at promo APR and regular terms at regular APR", () => {
    const opts = financingOptionsCents(120_000, [provider], null);
    const promo12 = opts.find((o) => o.months === 12);
    const reg24 = opts.find((o) => o.months === 24);
    expect(promo12?.isPromo).toBe(true);
    expect(promo12?.apr).toBe(0);
    expect(promo12?.monthlyCents).toBe(10_000);
    expect(reg24?.isPromo).toBe(false);
    expect(reg24?.apr).toBe(14.9);
  });

  it("flags ineligible-below-minimum instead of dropping", () => {
    const opts = financingOptionsCents(10_000, [provider], null);
    expect(opts.length).toBeGreaterThan(0);
    expect(opts.every((o) => o.eligible === false)).toBe(true);
  });

  it("settings can disable a provider and override APRs", () => {
    const settings = {
      enabledProviders: { carecredit: false },
      serviceFeeEnabled: false,
      serviceFeePercent: 0,
      providerOverrides: {},
    };
    expect(financingOptionsCents(120_000, [provider], settings)).toEqual([]);

    const overridden = financingOptionsCents(120_000, [provider], {
      enabledProviders: { carecredit: true },
      serviceFeeEnabled: false,
      serviceFeePercent: 0,
      providerOverrides: { carecredit: { promoEnabled: false, promoApr: 0, regularApr: 9.9 } },
    });
    // Promo disabled → promo terms drop; regular APR overridden.
    expect(overridden.every((o) => !o.isPromo)).toBe(true);
    expect(overridden.find((o) => o.months === 24)?.apr).toBe(9.9);
  });
});

describe("serviceFeeCents / cashDiscountCents", () => {
  it("service fee applies only when enabled", () => {
    expect(serviceFeeCents(100_000, { serviceFeeEnabled: false, serviceFeePercent: 3 }).feeCents).toBe(0);
    const fee = serviceFeeCents(100_000, { serviceFeeEnabled: true, serviceFeePercent: 3 });
    expect(fee.feeCents).toBe(3_000);
    expect(fee.totalWithFeeCents).toBe(103_000);
  });

  it("cash discount is OFF (no line) unless configured — the hardcoded-5% fix", () => {
    const off = cashDiscountCents(100_000, null);
    expect(off.enabled).toBe(false);
    expect(off.discountedCents).toBe(100_000);

    const disabled = cashDiscountCents(100_000, {
      serviceFeeEnabled: false,
      serviceFeePercent: 0,
      cashDiscountEnabled: false,
      cashDiscountPercent: 5,
    });
    expect(disabled.enabled).toBe(false);

    const on = cashDiscountCents(100_000, {
      serviceFeeEnabled: false,
      serviceFeePercent: 0,
      cashDiscountEnabled: true,
      cashDiscountPercent: 5,
    });
    expect(on).toEqual({ enabled: true, percent: 5, discountedCents: 95_000, savingsCents: 5_000 });
  });
});

describe("follow-up escalation (legacy thresholds preserved)", () => {
  it("computes calendar-day overdue", () => {
    expect(getDaysOverdue("2026-08-01", "2026-08-03")).toBe(2);
    expect(getDaysOverdue("2026-08-05", "2026-08-03")).toBe(-2);
  });

  it("tiers at 1/7/14 days", () => {
    expect(getEscalationTier("2026-08-03", "2026-08-03")).toBe("normal");
    expect(getEscalationTier("2026-08-02", "2026-08-03")).toBe("mild");
    expect(getEscalationTier("2026-07-27", "2026-08-03")).toBe("overdue");
    expect(getEscalationTier("2026-07-20", "2026-08-03")).toBe("critical");
  });

  it("is timezone-proof across month boundaries", () => {
    expect(getDaysOverdue("2026-07-31", "2026-08-01")).toBe(1);
    expect(getDaysOverdue("2025-12-31", "2026-01-01")).toBe(1);
  });
});

describe("cadence tier (cents, legacy boundary semantics)", () => {
  it("defaults preserve $999 light / $5000 standard / $5001+ high", () => {
    expect(getCadenceTier(99_900)).toBe("light");
    expect(getCadenceTier(100_000)).toBe("standard");
    expect(getCadenceTier(500_000)).toBe("standard");
    expect(getCadenceTier(500_100)).toBe("high_touch");
  });

  it("honors library-config thresholds", () => {
    expect(
      getCadenceTier(150_000, { standardMinCents: 200_000, highTouchMinCents: 800_000 }),
    ).toBe("light");
  });
});
