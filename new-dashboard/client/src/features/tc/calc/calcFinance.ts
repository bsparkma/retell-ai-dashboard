/**
 * Treatment Coordinator finance math — ported faithfully from TC-app
 * client/src/lib/calcFinance.ts. All functions are pure.
 *
 * DOLLARS DOMAIN: inputs and outputs are scratchpad dollars (floats), used
 * only for on-screen what-if math. Never persist these as money fields —
 * persisted money is integer cents (features/tc/money.ts + lib/financing.ts).
 */

import {
  getProviderRates,
  merchantFeeFraction,
  type ProviderRateSchedule,
} from "./financingRates";

/**
 * Catalog defaults for the three product-shaped lanes. These are lookups, not
 * a second rate table — the numbers live in financingRates.ts (PM ruling 2).
 * Each function accepts a `rates` argument so a library-adapted provider can
 * pass its own schedule through.
 */
const CARECREDIT_RATES: ProviderRateSchedule = getProviderRates("carecredit") ?? {};
const CHERRY_RATES: ProviderRateSchedule = getProviderRates("cherry") ?? {};
const IN_HOUSE_RATES: ProviderRateSchedule = getProviderRates("in_house") ?? {};

export interface FinanceResult {
  product: string;
  variant: string;
  months: number;
  apr: number;
  monthly: number;
  totalIfOnTime: number;
  interestIfOnTime: number;
  merchantFee: number;
  netToPractice: number;
  minPurchase: number;
  warning: string | null;
  eligible: boolean;
}

export function fmtUSD(n: number): string {
  if (!isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export function fmtUSD0(n: number): string {
  if (!isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

/** Standard amortization. Exported (legacy kept it private) so tests and the
 * generic provider lanes can reuse the same formula. */
export function amortize(
  principal: number,
  aprPct: number,
  months: number,
): { monthly: number; total: number; interest: number } {
  if (months <= 0) return { monthly: 0, total: 0, interest: 0 };
  const r = aprPct / 100 / 12;
  if (r === 0) return { monthly: principal / months, total: principal, interest: 0 };
  const m = (principal * (r * Math.pow(1 + r, months))) / (Math.pow(1 + r, months) - 1);
  return { monthly: m, total: m * months, interest: m * months - principal };
}

/**
 * Deferred-interest promo lane: 0% while it's paid on schedule, retroactive
 * `penaltyApr` on the whole balance if it isn't.
 */
export function carecreditPromo(
  principal: number,
  months: number,
  penaltyAprOverride?: number,
  rates: ProviderRateSchedule = CARECREDIT_RATES,
): FinanceResult {
  const penaltyAPR = penaltyAprOverride ?? rates.penaltyApr ?? 0;
  const monthly = months > 0 ? principal / months : 0;
  const fee = merchantFeeFraction(rates.promoMerchantFee, months) ?? 0;
  const merchantFee = principal * fee;
  const deferredRiskTotal = amortize(principal, penaltyAPR, months).total;
  const minPurchase = rates.promoMinPurchaseByTerm?.[months] ?? rates.minPurchase ?? 0;
  return {
    product: "CareCredit",
    variant: `${months}mo Promo`,
    months,
    apr: 0,
    monthly,
    totalIfOnTime: principal,
    interestIfOnTime: 0,
    merchantFee,
    netToPractice: principal - merchantFee,
    minPurchase,
    warning: `0% if paid in full by month ${months}. Otherwise ${penaltyAPR}% APR retroactive — up to ${fmtUSD0(deferredRiskTotal - principal)} extra.`,
    eligible: principal >= minPurchase,
  };
}

/** Interest-bearing (extended) lane at the lender's published per-term APR. */
export function carecreditExtended(
  principal: number,
  months: number,
  rates: ProviderRateSchedule = CARECREDIT_RATES,
): FinanceResult {
  const apr = rates.aprByTerm?.[months] ?? rates.aprFallback ?? 0;
  const { monthly, total, interest } = amortize(principal, apr, months);
  const merchantFee = principal * (merchantFeeFraction(rates.merchantFee, months) ?? 0);
  const minPurchase = rates.minPurchaseByTerm?.[months] ?? rates.minPurchase ?? 0;
  return {
    product: "CareCredit Extended",
    variant: `${months}mo @ ${apr}%`,
    months,
    apr,
    monthly,
    totalIfOnTime: total,
    interestIfOnTime: interest,
    merchantFee,
    netToPractice: principal - merchantFee,
    minPurchase,
    warning: null,
    eligible: principal >= minPurchase,
  };
}

/**
 * Amortized lane with a per-term APR table, a minimum purchase and a minimum
 * monthly payment. `aprOverride` (the library's effective APR) wins over the
 * catalog's published table.
 */
export function cherry(
  principal: number,
  months: number,
  aprOverride?: number,
  rates: ProviderRateSchedule = CHERRY_RATES,
): FinanceResult {
  const apr = aprOverride ?? rates.aprByTerm?.[months] ?? rates.aprFallback ?? 0;
  const { monthly, total, interest } = amortize(principal, apr, months);
  const merchantFee = principal * (merchantFeeFraction(rates.merchantFee, months) ?? 0);
  const minPurchase = rates.minPurchase ?? 0;
  const minMonthly = rates.minMonthly ?? 0;
  return {
    product: "Cherry",
    variant: `${months}mo`,
    months,
    apr,
    monthly,
    totalIfOnTime: total,
    interestIfOnTime: interest,
    merchantFee,
    netToPractice: principal - merchantFee,
    minPurchase,
    warning:
      minMonthly > 0 && monthly < minMonthly
        ? `Cherry requires ${fmtUSD(minMonthly)}/mo minimum.`
        : null,
    eligible: principal >= minPurchase && monthly >= minMonthly,
  };
}

/**
 * Practice-managed plan. There is no lender, so the merchant fee is a KNOWN
 * zero (catalog `merchantFee: { flat: 0 }`) — not an unknown we're papering
 * over — and there are no lender minimums.
 */
export function inHousePlan(
  principal: number,
  months: number,
  apr = 0,
  rates: ProviderRateSchedule = IN_HOUSE_RATES,
): FinanceResult {
  const { monthly, total, interest } = amortize(principal, apr, months);
  const merchantFee = principal * (merchantFeeFraction(rates.merchantFee, months) ?? 0);
  const minPurchase = rates.minPurchase ?? 0;
  return {
    product: "In-house",
    variant: `${months}mo${apr > 0 ? ` @ ${apr}%` : " (0%)"}`,
    months,
    apr,
    monthly,
    totalIfOnTime: total,
    interestIfOnTime: interest,
    merchantFee,
    netToPractice: principal - merchantFee,
    minPurchase,
    warning: "Practice carries collection risk.",
    eligible: principal >= minPurchase,
  };
}
