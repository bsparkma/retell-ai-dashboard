/**
 * TC money — THE single money formatter for the TC module.
 *
 * The contract stores money as non-negative integer cents (`*Cents`). The
 * legacy TC-app duplicated an Intl dollars formatter ~20 times and did float
 * math in components; here every component renders through these helpers and
 * does arithmetic in integer cents only.
 */

const usdWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const usdExact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$1,234" — the legacy app's dominant whole-dollar rendering. */
export function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  return usdWhole.format(Math.round(cents) / 100);
}

/** "$1,234.56" — for COB/finance breakdowns where cents matter. */
export function formatCentsExact(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  return usdExact.format(Math.round(cents) / 100);
}

/**
 * Parse a user-typed dollars string ("1,234.56", "$1234") into integer cents.
 * Returns null for empty/invalid/negative input — callers keep dialogs open
 * and show a validation message instead of guessing.
 */
export function dollarsInputToCents(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const value = Math.round(parseFloat(cleaned) * 100);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Cents → editable dollars string ("1234.56"; whole dollars stay whole). */
export function centsToDollarsInput(cents: number): string {
  if (!Number.isFinite(cents) || cents < 0) return "";
  const dollars = Math.round(cents) / 100;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

/** Integer-percent application in cents (e.g. cash discount). Never floats out. */
export function applyPercentDiscountCents(cents: number, percent: number): {
  discountedCents: number;
  savingsCents: number;
} {
  const savingsCents = Math.round((Math.round(cents) * percent) / 100);
  return { discountedCents: Math.round(cents) - savingsCents, savingsCents };
}
