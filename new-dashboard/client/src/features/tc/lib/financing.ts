/**
 * Financing math — monthly-payment options computed from the server-owned
 * library config (financing_providers + financing_settings + financing_config
 * sections of tc_library_config). Replaces the legacy localStorage
 * financingSettings path and the hardcoded 9.99%/60mo estimate.
 *
 * All money in/out is integer CENTS. The amortization interior uses floats
 * (interest math), but results round to cents before leaving this module —
 * components never do float math.
 */
import { z } from "zod";
import type {
  LibraryFinancingConfig,
  LibraryFinancingProvider,
  LibraryFinancingSettings,
} from "@shared/tc/contract";

type FinancingProvider = z.infer<typeof LibraryFinancingProvider>;
type FinancingSettings = z.infer<typeof LibraryFinancingSettings>;

export interface MonthlyOptionCents {
  providerKey: string;
  providerLabel: string;
  months: number;
  apr: number;
  isPromo: boolean;
  monthlyCents: number;
  totalCents: number;
  interestCents: number;
  eligible: boolean;
  minAmountCents: number;
}

/** Standard amortized monthly payment, rounded to cents. 0% APR = principal/months. */
export function amortizeMonthlyCents(principalCents: number, aprPct: number, months: number): number {
  if (months <= 0 || principalCents <= 0) return 0;
  const r = aprPct / 100 / 12;
  if (r === 0) return Math.round(principalCents / months);
  const p = Math.round(principalCents);
  const m = (p * (r * Math.pow(1 + r, months))) / (Math.pow(1 + r, months) - 1);
  return Math.round(m);
}

function effectiveApr(
  provider: FinancingProvider,
  isPromo: boolean,
  settings: FinancingSettings | null,
): number {
  const override = settings?.providerOverrides[provider.key];
  if (isPromo) {
    if (override && !override.promoEnabled) return override.regularApr;
    return override?.promoApr ?? provider.promoApr;
  }
  return override?.regularApr ?? provider.regularApr;
}

function providerEnabled(provider: FinancingProvider, settings: FinancingSettings | null): boolean {
  if (!provider.enabled) return false;
  if (settings && provider.key in settings.enabledProviders) {
    return settings.enabledProviders[provider.key] === true;
  }
  return true;
}

/**
 * Every presentable monthly option for a patient portion, from enabled
 * providers only, promo terms first then regular terms, cheapest-monthly last
 * ordering left to the caller. Ineligible (below provider minimum) options are
 * returned flagged, not dropped — the UI shows them disabled with the minimum.
 */
export function financingOptionsCents(
  patientPortionCents: number,
  providers: readonly FinancingProvider[],
  settings: FinancingSettings | null,
): MonthlyOptionCents[] {
  const options: MonthlyOptionCents[] = [];
  for (const p of providers) {
    if (!providerEnabled(p, settings)) continue;
    const promoDisabled = settings?.providerOverrides[p.key]?.promoEnabled === false;
    const seen = new Set<number>();
    const push = (months: number, isPromo: boolean) => {
      if (months <= 0 || seen.has(months)) return;
      seen.add(months);
      const apr = effectiveApr(p, isPromo, settings);
      const monthlyCents = amortizeMonthlyCents(patientPortionCents, apr, months);
      const totalCents = monthlyCents * months;
      options.push({
        providerKey: p.key,
        providerLabel: p.label,
        months,
        apr,
        isPromo,
        monthlyCents,
        totalCents,
        interestCents: Math.max(0, totalCents - Math.round(patientPortionCents)),
        eligible: patientPortionCents >= p.minAmountCents,
        minAmountCents: p.minAmountCents,
      });
    };
    if (!promoDisabled) for (const months of p.promoTerms) push(months, true);
    for (const months of p.terms) push(months, false);
  }
  return options;
}

export interface ServiceFeeCents {
  enabled: boolean;
  percent: number;
  feeCents: number;
  totalWithFeeCents: number;
}

export function serviceFeeCents(
  patientPortionCents: number,
  config: Pick<LibraryFinancingConfig, "serviceFeeEnabled" | "serviceFeePercent"> | null,
): ServiceFeeCents {
  if (!config?.serviceFeeEnabled) {
    return { enabled: false, percent: 0, feeCents: 0, totalWithFeeCents: Math.round(patientPortionCents) };
  }
  const feeCents = Math.round((Math.round(patientPortionCents) * config.serviceFeePercent) / 100);
  return {
    enabled: true,
    percent: config.serviceFeePercent,
    feeCents,
    totalWithFeeCents: Math.round(patientPortionCents) + feeCents,
  };
}

export interface CashDiscountCents {
  enabled: boolean;
  percent: number;
  discountedCents: number;
  savingsCents: number;
}

/**
 * Pay-in-full cash discount from server config (financing_config section).
 * Replaces the legacy hardcoded 5% — when the office hasn't enabled it, the
 * UI shows no discount line at all.
 */
export function cashDiscountCents(
  patientPortionCents: number,
  config: LibraryFinancingConfig | null,
): CashDiscountCents {
  const rounded = Math.round(patientPortionCents);
  if (!config?.cashDiscountEnabled) {
    return { enabled: false, percent: 0, discountedCents: rounded, savingsCents: 0 };
  }
  const savingsCents = Math.round((rounded * config.cashDiscountPercent) / 100);
  return {
    enabled: true,
    percent: config.cashDiscountPercent,
    discountedCents: rounded - savingsCents,
    savingsCents,
  };
}
