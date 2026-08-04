/**
 * calcFinance regression suite — the legacy TC-app shipped this math with NO
 * tests; these pin the ported behavior (amortization, CareCredit promo vs
 * extended, Cherry APR table, in-house 0%). Dollars domain throughout.
 *
 * Rate constants come from the financingRates catalog (PM ruling 2 killed the
 * parallel TC_RATES table), so these tests read the catalog rather than a
 * second copy of the numbers.
 */
import { describe, expect, it } from "vitest";
import {
  amortize,
  carecreditExtended,
  carecreditPromo,
  cherry,
  fmtUSD,
  fmtUSD0,
  inHousePlan,
} from "../client/src/features/tc/calc/calcFinance";
import {
  getProviderRates,
  type ProviderRateSchedule,
} from "../client/src/features/tc/calc/financingRates";

const CARECREDIT = getProviderRates("carecredit")!;
const CHERRY = getProviderRates("cherry")!;

describe("amortize", () => {
  it("0% APR divides the principal evenly with zero interest", () => {
    const r = amortize(1200, 0, 12);
    expect(r.monthly).toBe(100);
    expect(r.total).toBe(1200);
    expect(r.interest).toBe(0);
  });

  it("matches the standard amortization formula ($10,000 @ 12% over 12mo ≈ $888.49)", () => {
    const r = amortize(10_000, 12, 12);
    expect(r.monthly).toBeCloseTo(888.4879, 3);
    expect(r.total).toBeCloseTo(888.4879 * 12, 2);
    expect(r.interest).toBeCloseTo(888.4879 * 12 - 10_000, 2);
  });

  it("zero/negative months returns zeros", () => {
    expect(amortize(1000, 10, 0)).toEqual({ monthly: 0, total: 0, interest: 0 });
    expect(amortize(1000, 10, -3)).toEqual({ monthly: 0, total: 0, interest: 0 });
  });

  // ── Ruling 7 edge cases ───────────────────────────────────────────────────

  it("zero principal is zero everywhere, at any APR", () => {
    expect(amortize(0, 0, 12)).toEqual({ monthly: 0, total: 0, interest: 0 });
    const paid = amortize(0, 17.99, 24);
    expect(paid.monthly).toBe(0);
    expect(paid.total).toBe(0);
    expect(paid.interest).toBe(0);
  });

  it("a one-month term charges exactly one month of interest", () => {
    expect(amortize(1000, 0, 1).monthly).toBe(1000);
    const r = amortize(1000, 12, 1); // 12%/yr = 1%/mo
    expect(r.monthly).toBeCloseTo(1010, 6);
    expect(r.total).toBeCloseTo(1010, 6);
    expect(r.interest).toBeCloseTo(10, 6);
  });

  it("converges on the 0% split as the APR approaches zero", () => {
    const zero = amortize(1200, 0, 12);
    const nearZero = amortize(1200, 0.000001, 12);
    expect(nearZero.monthly).toBeCloseTo(zero.monthly, 4);
    expect(nearZero.total).toBeCloseTo(zero.total, 3);
    // A real (non-zero) APR must cost strictly more than the 0% split.
    expect(amortize(1200, 9.99, 12).total).toBeGreaterThan(zero.total);
  });

  it("total and interest stay internally consistent", () => {
    const r = amortize(7350.75, 15.9, 48);
    expect(r.total).toBeCloseTo(r.monthly * 48, 9);
    expect(r.interest).toBeCloseTo(r.total - 7350.75, 9);
  });
});

describe("carecreditPromo", () => {
  it("promo is 0% APR: monthly = principal/months, total = principal", () => {
    const r = carecreditPromo(1200, 12);
    expect(r.apr).toBe(0);
    expect(r.monthly).toBe(100);
    expect(r.totalIfOnTime).toBe(1200);
    expect(r.interestIfOnTime).toBe(0);
  });

  it("applies the promo merchant-fee table and nets to practice", () => {
    const r = carecreditPromo(1000, 12); // 7.5% fee at 12mo
    expect(r.merchantFee).toBeCloseTo(75, 6);
    expect(r.netToPractice).toBeCloseTo(925, 6);
    const r24 = carecreditPromo(2000, 24); // 11.95% at 24mo
    expect(r24.merchantFee).toBeCloseTo(239, 6);
  });

  it("enforces the promo minimum-purchase table", () => {
    expect(carecreditPromo(150, 6).eligible).toBe(false); // min 200
    expect(carecreditPromo(200, 6).eligible).toBe(true); // exactly at the minimum
    expect(carecreditPromo(199.99, 6).eligible).toBe(false);
    expect(carecreditPromo(500, 24).eligible).toBe(false); // min 1000
    expect(carecreditPromo(500, 24).minPurchase).toBe(1000);
  });

  it("warns about the retroactive penalty APR (default and override)", () => {
    expect(carecreditPromo(1000, 12).warning).toContain(
      `${CARECREDIT.penaltyApr}% APR retroactive`,
    );
    expect(carecreditPromo(1000, 12, 22.5).warning).toContain("22.5% APR retroactive");
  });

  // ── Ruling 7 edge cases ───────────────────────────────────────────────────

  it("quotes the deferred-interest exposure as the amortized penalty total", () => {
    const principal = 3000;
    const months = 18;
    const penalty = CARECREDIT.penaltyApr!;
    const exposure = amortize(principal, penalty, months).total - principal;
    const r = carecreditPromo(principal, months);
    // Promo path itself stays interest-free…
    expect(r.apr).toBe(0);
    expect(r.interestIfOnTime).toBe(0);
    expect(r.totalIfOnTime).toBe(principal);
    // …while the warning prices the penalty path.
    expect(r.warning).toContain(fmtUSD0(exposure));
    expect(r.warning).toContain(`by month ${months}`);
  });

  it("a lower penalty override quotes a smaller exposure", () => {
    const high = carecreditPromo(3000, 18);
    const low = carecreditPromo(3000, 18, 9.9);
    expect(high.warning).not.toEqual(low.warning);
    expect(amortize(3000, 9.9, 18).total).toBeLessThan(
      amortize(3000, CARECREDIT.penaltyApr!, 18).total,
    );
  });

  it("zero principal and zero-month terms degrade to zeros, not NaN", () => {
    const zeroPrincipal = carecreditPromo(0, 12);
    expect(zeroPrincipal.monthly).toBe(0);
    expect(zeroPrincipal.merchantFee).toBe(0);
    expect(zeroPrincipal.netToPractice).toBe(0);
    expect(zeroPrincipal.eligible).toBe(false); // below the $200 minimum

    const zeroTerm = carecreditPromo(1000, 0);
    expect(zeroTerm.monthly).toBe(0);
    expect(Number.isNaN(zeroTerm.monthly)).toBe(false);
    // No fee/minimum row for a 0-month term ⇒ no invented fee.
    expect(zeroTerm.merchantFee).toBe(0);
    expect(zeroTerm.minPurchase).toBe(0);
  });

  it("takes its numbers from the injected schedule, not a private table", () => {
    const custom: ProviderRateSchedule = {
      promoMerchantFee: { flat: 0.02 },
      promoMinPurchaseByTerm: { 12: 5000 },
      penaltyApr: 30,
    };
    const r = carecreditPromo(1000, 12, undefined, custom);
    expect(r.merchantFee).toBeCloseTo(20, 6);
    expect(r.minPurchase).toBe(5000);
    expect(r.eligible).toBe(false);
    expect(r.warning).toContain("30% APR retroactive");
  });
});

describe("carecreditExtended", () => {
  it("uses the extended APR table (with 14.9 fallback for unknown terms)", () => {
    expect(carecreditExtended(5000, 24).apr).toBe(14.9);
    expect(carecreditExtended(5000, 48).apr).toBe(15.9);
    expect(carecreditExtended(5000, 60).apr).toBe(16.9);
    expect(carecreditExtended(5000, 30).apr).toBe(14.9); // fallback
  });

  it("amortizes at the term APR and charges the flat 3.5% merchant fee", () => {
    const r = carecreditExtended(5000, 24);
    const expected = amortize(5000, 14.9, 24);
    expect(r.monthly).toBeCloseTo(expected.monthly, 6);
    expect(r.totalIfOnTime).toBeCloseTo(expected.total, 6);
    expect(r.merchantFee).toBeCloseTo(5000 * 0.035, 6);
    expect(r.netToPractice).toBeCloseTo(5000 - 175, 6);
  });

  it("enforces the extended minimum-purchase table", () => {
    expect(carecreditExtended(900, 24).eligible).toBe(false); // min 1000
    expect(carecreditExtended(1000, 24).eligible).toBe(true); // exactly at it
    expect(carecreditExtended(2000, 48).eligible).toBe(false); // min 2500
    expect(carecreditExtended(2500, 48).eligible).toBe(true);
  });

  it("zero principal / zero term stay at zero", () => {
    const zero = carecreditExtended(0, 36);
    expect(zero.monthly).toBe(0);
    expect(zero.merchantFee).toBe(0);
    expect(zero.eligible).toBe(false); // 0 < the 36mo $1,500 minimum

    expect(carecreditExtended(5000, 0).monthly).toBe(0);
    expect(carecreditExtended(5000, 0).totalIfOnTime).toBe(0);
  });
});

describe("cherry", () => {
  it("uses the typical APR table by term", () => {
    expect(cherry(1000, 3).apr).toBe(0);
    expect(cherry(1000, 6).apr).toBe(0);
    expect(cherry(1000, 12).apr).toBe(9.99);
    expect(cherry(1000, 18).apr).toBe(14.99);
    expect(cherry(1000, 24).apr).toBe(17.99);
  });

  it("honors an APR override (library-driven effective APR)", () => {
    const r = cherry(1000, 12, 8.75);
    expect(r.apr).toBe(8.75);
    expect(r.monthly).toBeCloseTo(amortize(1000, 8.75, 12).monthly, 6);
  });

  it("applies the per-term merchant-fee table", () => {
    expect(cherry(1000, 3).merchantFee).toBeCloseTo(39, 6);
    expect(cherry(1000, 24).merchantFee).toBeCloseTo(119, 6);
  });

  it("flags the $25/mo minimum and the $200 minimum purchase", () => {
    const tiny = cherry(300, 24); // ~ $15/mo < $25 minimum
    expect(tiny.monthly).toBeLessThan(25);
    expect(tiny.warning).toContain("minimum");
    expect(tiny.eligible).toBe(false);

    const small = cherry(150, 3); // below $200 min purchase
    expect(small.eligible).toBe(false);

    const fine = cherry(1200, 12);
    expect(fine.warning).toBeNull();
    expect(fine.eligible).toBe(true);
  });

  // ── Ruling 7 edge cases ───────────────────────────────────────────────────

  it("APR table boundaries: promo terms are 0%, off-table terms fall back", () => {
    // Every term the lender publishes.
    expect(Object.keys(CHERRY.aprByTerm!).map(Number).sort((a, b) => a - b)).toEqual([
      3, 6, 12, 18, 24,
    ]);
    // Just outside the table on both sides → the published fallback, never NaN
    // and never a silent 0%.
    expect(cherry(2000, 2).apr).toBe(CHERRY.aprFallback);
    expect(cherry(2000, 36).apr).toBe(CHERRY.aprFallback);
    expect(cherry(2000, 36).apr).toBe(17.99);
    // …and the merchant fee falls back too (0.119), not to zero.
    expect(cherry(1000, 36).merchantFee).toBeCloseTo(119, 6);
  });

  it("minimum-monthly ineligibility is a strict boundary", () => {
    const at = cherry(600, 24, 0); // exactly $25.00/mo
    expect(at.monthly).toBe(25);
    expect(at.warning).toBeNull();
    expect(at.eligible).toBe(true);

    const under = cherry(599.76, 24, 0); // $24.99/mo
    expect(under.monthly).toBeCloseTo(24.99, 6);
    expect(under.warning).toContain("$25.00/mo minimum");
    expect(under.eligible).toBe(false);
  });

  it("minimum-purchase ineligibility is a strict boundary", () => {
    expect(cherry(200, 3).eligible).toBe(true); // exactly $200
    expect(cherry(199.99, 3).eligible).toBe(false);
    expect(cherry(199.99, 3).minPurchase).toBe(200);
  });

  it("zero principal is ineligible on both minimums and never NaN", () => {
    const r = cherry(0, 12);
    expect(r.monthly).toBe(0);
    expect(r.merchantFee).toBe(0);
    expect(r.netToPractice).toBe(0);
    expect(r.eligible).toBe(false);
    expect(r.warning).toContain("minimum");
  });

  it("a schedule with no minimums imposes none (no invented lender rules)", () => {
    const r = cherry(50, 12, 0, { merchantFee: { flat: 0 } });
    expect(r.minPurchase).toBe(0);
    expect(r.warning).toBeNull();
    expect(r.eligible).toBe(true);
  });
});

describe("inHousePlan", () => {
  it("defaults to 0% — even split, no merchant fee, practice keeps 100%", () => {
    const r = inHousePlan(1200, 12);
    expect(r.apr).toBe(0);
    expect(r.monthly).toBe(100);
    expect(r.totalIfOnTime).toBe(1200);
    expect(r.interestIfOnTime).toBe(0);
    expect(r.merchantFee).toBe(0);
    expect(r.netToPractice).toBe(1200);
    expect(r.eligible).toBe(true);
    expect(r.variant).toBe("12mo (0%)");
  });

  it("supports an interest-bearing in-house APR", () => {
    const r = inHousePlan(1200, 12, 5);
    expect(r.apr).toBe(5);
    expect(r.variant).toBe("12mo @ 5%");
    expect(r.monthly).toBeCloseTo(amortize(1200, 5, 12).monthly, 6);
    expect(r.netToPractice).toBe(1200); // fee-free regardless of APR
  });

  // ── Ruling 7 edge cases ───────────────────────────────────────────────────

  it("0% is exact — the plan never invents a cent of interest", () => {
    for (const [principal, months] of [
      [1000, 3],
      [1300, 7],
      [8500, 24],
      [0.03, 12],
    ] as const) {
      const r = inHousePlan(principal, months);
      expect(r.interestIfOnTime).toBe(0);
      expect(r.totalIfOnTime).toBe(principal); // exact, not close
      expect(r.netToPractice).toBe(principal); // known-zero fee, not unknown
      expect(r.monthly).toBe(principal / months);
    }
  });

  it("zero principal and zero-month terms stay at zero and remain eligible", () => {
    const zero = inHousePlan(0, 12);
    expect(zero.monthly).toBe(0);
    expect(zero.totalIfOnTime).toBe(0);
    expect(zero.netToPractice).toBe(0);
    expect(zero.eligible).toBe(true); // the practice has no minimum

    const noTerm = inHousePlan(1000, 0);
    expect(noTerm.monthly).toBe(0);
    expect(Number.isFinite(noTerm.monthly)).toBe(true);
  });
});

describe("formatters", () => {
  it("formats dollars and dashes non-finite values", () => {
    expect(fmtUSD(1234.5)).toBe("$1,234.50");
    expect(fmtUSD0(1234.5)).toBe("$1,235");
    expect(fmtUSD(Infinity)).toBe("—");
    expect(fmtUSD0(NaN)).toBe("—");
  });

  it("rounds half away from zero at the cent boundary", () => {
    expect(fmtUSD(0.005)).toBe("$0.01");
    expect(fmtUSD(0.004)).toBe("$0.00"); // rounds down to zero, still 2dp
    expect(fmtUSD(99.995)).toBe("$100.00");
    expect(fmtUSD(99.994)).toBe("$99.99");
    expect(fmtUSD(1234.567)).toBe("$1,234.57");
    expect(fmtUSD0(1233.5)).toBe("$1,234");
    expect(fmtUSD0(1233.49)).toBe("$1,233");
  });

  it("a sub-cent monthly still renders as money, not scientific notation", () => {
    const r = amortize(0.03, 0, 12);
    expect(r.monthly).toBeCloseTo(0.0025, 9);
    expect(fmtUSD(r.monthly)).toBe("$0.00");
  });
});
