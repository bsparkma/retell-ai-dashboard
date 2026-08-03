import { describe, expect, it } from "vitest";
import {
  applyPercentDiscountCents,
  centsToDollarsInput,
  dollarsInputToCents,
  formatCents,
  formatCentsExact,
} from "../client/src/features/tc/money";

describe("formatCents", () => {
  it("renders whole dollars (legacy display convention)", () => {
    expect(formatCents(1234500)).toBe("$12,345");
    expect(formatCents(0)).toBe("$0");
  });

  it("rounds sub-dollar cents to the nearest dollar", () => {
    expect(formatCents(149)).toBe("$1");
    expect(formatCents(151)).toBe("$2");
  });

  it("is defensive about non-finite input", () => {
    expect(formatCents(Number.NaN)).toBe("—");
    expect(formatCents(Infinity)).toBe("—");
  });
});

describe("formatCentsExact", () => {
  it("renders exact cents", () => {
    expect(formatCentsExact(123456)).toBe("$1,234.56");
    expect(formatCentsExact(5)).toBe("$0.05");
  });
});

describe("dollarsInputToCents", () => {
  it("parses plain and formatted dollar strings", () => {
    expect(dollarsInputToCents("1234")).toBe(123400);
    expect(dollarsInputToCents("$1,234.56")).toBe(123456);
    expect(dollarsInputToCents(" 12.5 ")).toBe(1250);
  });

  it("rejects invalid input with null (caller keeps the dialog open)", () => {
    expect(dollarsInputToCents("")).toBeNull();
    expect(dollarsInputToCents("abc")).toBeNull();
    expect(dollarsInputToCents("12.345")).toBeNull();
    expect(dollarsInputToCents("-5")).toBeNull();
    expect(dollarsInputToCents("1.2.3")).toBeNull();
  });
});

describe("centsToDollarsInput", () => {
  it("round-trips whole and fractional values", () => {
    expect(centsToDollarsInput(123400)).toBe("1234");
    expect(centsToDollarsInput(123456)).toBe("1234.56");
    expect(centsToDollarsInput(0)).toBe("0");
  });

  it("returns empty for invalid stored values", () => {
    expect(centsToDollarsInput(-1)).toBe("");
    expect(centsToDollarsInput(Number.NaN)).toBe("");
  });
});

describe("applyPercentDiscountCents", () => {
  it("computes integer-cent discounts", () => {
    expect(applyPercentDiscountCents(100_000, 5)).toEqual({
      discountedCents: 95_000,
      savingsCents: 5_000,
    });
  });

  it("rounds half-cent boundaries deterministically", () => {
    // 3% of $10.01 = 30.03 cents → rounds to 30.
    expect(applyPercentDiscountCents(1001, 3)).toEqual({
      discountedCents: 971,
      savingsCents: 30,
    });
  });

  it("0% is identity", () => {
    expect(applyPercentDiscountCents(555, 0)).toEqual({ discountedCents: 555, savingsCents: 0 });
  });
});
