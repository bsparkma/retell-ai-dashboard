/**
 * Treatment Coordinator finance math — ported faithfully from TC-app
 * client/src/lib/calcFinance.ts. All functions are pure.
 *
 * DOLLARS DOMAIN: inputs and outputs are scratchpad dollars (floats), used
 * only for on-screen what-if math. Never persist these as money fields —
 * persisted money is integer cents (features/tc/money.ts + lib/financing.ts).
 */

import { TC_RATES } from "./calcRates";

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

export function carecreditPromo(principal: number, months: number, penaltyAprOverride?: number): FinanceResult {
  const R = TC_RATES.carecredit;
  const penaltyAPR = penaltyAprOverride ?? R.penaltyAPR;
  const monthly = months > 0 ? principal / months : 0;
  const fee = R.promoMerchantFee[months] ?? 0;
  const merchantFee = principal * fee;
  const deferredRiskTotal = amortize(principal, penaltyAPR, months).total;
  const minPurchase = R.promoMinPurchase[months] ?? 0;
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

export function carecreditExtended(principal: number, months: number): FinanceResult {
  const R = TC_RATES.carecredit;
  const apr = R.extendedAPR[months] ?? 14.9;
  const { monthly, total, interest } = amortize(principal, apr, months);
  const merchantFee = principal * R.extendedMerchantFee;
  const minPurchase = R.extendedMinPurchase[months] ?? 0;
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

export function cherry(principal: number, months: number, aprOverride?: number): FinanceResult {
  const R = TC_RATES.cherry;
  const apr = aprOverride ?? R.aprTypical[months] ?? 17.99;
  const { monthly, total, interest } = amortize(principal, apr, months);
  const merchantFee = principal * (R.merchantFee[months] ?? 0.119);
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
    minPurchase: R.minPurchase,
    warning: monthly < R.minMonthly ? `Cherry requires ${fmtUSD(R.minMonthly)}/mo minimum.` : null,
    eligible: principal >= R.minPurchase && monthly >= R.minMonthly,
  };
}

export function inHousePlan(principal: number, months: number, apr = 0): FinanceResult {
  const { monthly, total, interest } = amortize(principal, apr, months);
  return {
    product: "In-house",
    variant: `${months}mo${apr > 0 ? ` @ ${apr}%` : " (0%)"}`,
    months,
    apr,
    monthly,
    totalIfOnTime: total,
    interestIfOnTime: interest,
    merchantFee: 0,
    netToPractice: principal,
    minPurchase: 0,
    warning: "Practice carries collection risk.",
    eligible: true,
  };
}
