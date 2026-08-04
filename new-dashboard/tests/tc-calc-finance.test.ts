/**
 * calcFinance regression suite — the legacy TC-app shipped this math with NO
 * tests; these pin the ported behavior (amortization, CareCredit promo vs
 * extended, Cherry APR table, in-house 0%). Dollars domain throughout.
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
import { TC_RATES } from "../client/src/features/tc/calc/calcRates";

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
    expect(carecreditPromo(200, 6).eligible).toBe(true);
    expect(carecreditPromo(500, 24).eligible).toBe(false); // min 1000
    expect(carecreditPromo(500, 24).minPurchase).toBe(1000);
  });

  it("warns about the retroactive penalty APR (default and override)", () => {
    expect(carecreditPromo(1000, 12).warning).toContain(
      `${TC_RATES.carecredit.penaltyAPR}% APR retroactive`,
    );
    expect(carecreditPromo(1000, 12, 22.5).warning).toContain("22.5% APR retroactive");
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
    expect(carecreditExtended(1000, 24).eligible).toBe(true);
    expect(carecreditExtended(2000, 48).eligible).toBe(false); // min 2500
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
});

describe("formatters", () => {
  it("formats dollars and dashes non-finite values", () => {
    expect(fmtUSD(1234.5)).toBe("$1,234.50");
    expect(fmtUSD0(1234.5)).toBe("$1,235");
    expect(fmtUSD(Infinity)).toBe("—");
    expect(fmtUSD0(NaN)).toBe("—");
  });
});
