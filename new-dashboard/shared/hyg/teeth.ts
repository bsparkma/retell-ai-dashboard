/**
 * TOOTH NUMBERS AS STORED, AND TOOTH NAMES AS PRINTED — the one place.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY "#102, #109" REACHED A CHART NOTE
 * ═════════════════════════════════════════════════════════════════════════════
 * A treatment item stores `teeth` as numbers. A PRIMARY tooth is stored as 100
 * plus its letter's position in PRIMARY_LETTERS below — B → 102, I → 109 — so
 * the two dentitions cannot collide in one array. That encoding lived in the
 * client's ToothPicker, and only the client knew how to turn 102 back into
 * "B". The server's composer, the TC handoff and TC's own screens printed the
 * stored number with a "#" in front of it, so a primary tooth went into the
 * chart as "#102".
 *
 * So the encoding and its rendering live HERE, in shared code: the picker
 * imports it to store a tooth, and every surface that prints one — the note,
 * the Router, the TC handoff, TC's checkout and case views — imports it to
 * print it. There is no second copy to drift.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * HOW A TOOTH PRINTS
 * ═════════════════════════════════════════════════════════════════════════════
 * Permanent teeth as `#30`. Primary teeth as their bare letter, `B` — no "#",
 * because "#B" is not how a dental chart writes one and a reader could take it
 * for a typo of a number.
 *
 * THE ORDER OF PRIMARY_LETTERS IS LOAD-BEARING. It is the stored encoding:
 * upper A–J, then lower T→K, exactly as the picker has always laid them out.
 * Re-sorting it alphabetically would turn every stored lower primary tooth into
 * a different tooth. `hyg-teeth.test.ts` pins every value.
 */

/** Upper primary, the patient's right to left. */
export const UPPER_PRIMARY: readonly string[] = "ABCDEFGHIJ".split("");
/** Lower primary, the patient's left to right — the universal chart's order. */
export const LOWER_PRIMARY: readonly string[] = "TSRQPONMLK".split("");

/** A stored primary tooth is PRIMARY_OFFSET + its index here + 1. */
export const PRIMARY_OFFSET = 100;
const PRIMARY_LETTERS: readonly string[] = [...UPPER_PRIMARY, ...LOWER_PRIMARY];

/** Whether a stored tooth number is a primary tooth. */
export function isPrimaryTooth(tooth: number): boolean {
  return tooth > PRIMARY_OFFSET && tooth <= PRIMARY_OFFSET + PRIMARY_LETTERS.length;
}

/** The tooth's name without decoration: 30 → "30", 102 → "B". */
export function toothLabel(tooth: number): string {
  if (tooth > PRIMARY_OFFSET) {
    return PRIMARY_LETTERS[tooth - PRIMARY_OFFSET - 1] ?? String(tooth);
  }
  return String(tooth);
}

/** A primary letter → its stored number. "B" → 102. */
export function primaryToNumber(letter: string): number {
  return PRIMARY_OFFSET + PRIMARY_LETTERS.indexOf(letter) + 1;
}

/** One tooth as a chart prints it: 30 → "#30", 102 → "B". */
export function toothText(tooth: number): string {
  return isPrimaryTooth(tooth) ? toothLabel(tooth) : `#${toothLabel(tooth)}`;
}

/** Several: [30, 102, 109] → "#30, B, I". Empty → "". */
export function teethText(teeth: readonly number[]): string {
  return teeth.map(toothText).join(", ");
}

/**
 * A tooth as OPEN DENTAL names it (the existing-treatment read): "30" → "#30",
 * a primary letter "B" → "B", "" → "". Anything else is Open Dental's own words.
 */
export function odToothText(tooth: string): string {
  const t = tooth.trim();
  if (t === "") return "";
  if (/^[A-T]$/.test(t)) return t;
  return `#${t}`;
}
