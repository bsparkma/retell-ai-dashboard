/**
 * Financing rate constants — ported faithfully from TC-app client/src/lib/
 * calcRates.ts (which mirrored Calculator/src/rates.js).
 *
 * DOLLARS DOMAIN: everything in this file is user-facing scratchpad dollars,
 * never persisted money (persisted money is integer cents per shared/tc).
 *
 * Deliberate omission vs the legacy file: TREATMENT_PRESETS (14 hardcoded
 * practice fees) was NOT ported — treatment presets now derive from the
 * office library (see libraryAdapter.treatmentPresetsFromLibrary) so the
 * calculator never invents dollar amounts.
 */

export const TC_RATES = {
  carecredit: {
    promoTerms: [6, 12, 18, 24] as number[],
    promoMinPurchase: { 6: 200, 12: 200, 18: 200, 24: 1000 } as Record<number, number>,
    penaltyAPR: 26.99,
    promoMerchantFee: { 6: 0.055, 12: 0.075, 18: 0.095, 24: 0.1195 } as Record<number, number>,

    extendedTerms: [24, 36, 48, 60] as number[],
    extendedAPR: { 24: 14.9, 36: 14.9, 48: 15.9, 60: 16.9 } as Record<number, number>,
    extendedMinPurchase: { 24: 1000, 36: 1500, 48: 2500, 60: 2500 } as Record<number, number>,
    extendedMerchantFee: 0.035,
  },
  cherry: {
    terms: [3, 6, 12, 18, 24] as number[],
    aprTypical: { 3: 0, 6: 0, 12: 9.99, 18: 14.99, 24: 17.99 } as Record<number, number>,
    minMonthly: 25,
    minPurchase: 200,
    merchantFee: { 3: 0.039, 6: 0.049, 12: 0.079, 18: 0.099, 24: 0.119 } as Record<number, number>,
  },
  inHouse: {
    terms: [3, 6, 12, 18, 24, 36] as number[],
    apr: 0,
  },
};

export const APR_PRESETS: { label: string; apr: number }[] = [
  { label: "0% — Promo / In-house", apr: 0 },
  { label: `${TC_RATES.cherry.aprTypical[12]}% — Cherry 12mo`, apr: TC_RATES.cherry.aprTypical[12] ?? 9.99 },
  { label: `${TC_RATES.carecredit.extendedAPR[24]}% — CC Extended`, apr: TC_RATES.carecredit.extendedAPR[24] ?? 14.9 },
  { label: `${TC_RATES.cherry.aprTypical[24]}% — Cherry 24mo`, apr: TC_RATES.cherry.aprTypical[24] ?? 17.99 },
  { label: `${TC_RATES.carecredit.penaltyAPR}% — CC Penalty`, apr: TC_RATES.carecredit.penaltyAPR },
];

export const SIMPLE_TERMS = [3, 6, 12, 18, 24, 36, 48, 60];
