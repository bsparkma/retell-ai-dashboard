/**
 * Single source of truth for tooth numbering/ordering.
 *
 * Universal numbering runs clockwise starting at the patient's upper right,
 * viewed facially:
 *   - Upper arch reads #1 → #16, left to right on screen (patient's right → left).
 *   - Lower arch reads #32 → #17, left to right on screen, so #32 sits directly
 *     beneath #1 and #17 sits directly beneath #16.
 *
 * Primary (deciduous) dentition mirrors the same layout with letters:
 *   - Upper arch reads A → J, left to right.
 *   - Lower arch reads T → K, left to right, so T sits beneath A and K beneath J.
 *
 * Every component that draws a tooth chart (Odontogram, PerioGrid, the Router
 * slip preview, the Findings read-only chart, tooth chip lists, etc.) must
 * import these arrays rather than building its own range — that's how the
 * 17→32 lower-arch bug crept in the first time.
 */

/** Upper permanent arch, #1–#16, in on-screen left-to-right display order. */
export const UPPER_PERMANENT: number[] = Array.from({ length: 16 }, (_, i) => i + 1)

/** Lower permanent arch, #32–#17, in on-screen left-to-right display order. */
export const LOWER_PERMANENT: number[] = Array.from({ length: 16 }, (_, i) => 32 - i)

/** Upper primary arch, A–J, in on-screen left-to-right display order. */
export const UPPER_PRIMARY: string[] = "ABCDEFGHIJ".split("")

/** Lower primary arch, T–K, in on-screen left-to-right display order. */
export const LOWER_PRIMARY: string[] = "TSRQPONMLK".split("")

export type Quadrant = "UR" | "UL" | "LL" | "LR"

/**
 * Quadrant for a universal tooth number (1-32) or primary tooth letter (A-T).
 * Permanent: UR 1-8, UL 9-16, LL 17-24, LR 25-32.
 * Primary: UR A-E, UL F-J, LL K-O, LR P-T.
 */
export function quadrantOf(tooth: number | string): Quadrant {
  if (typeof tooth === "number") {
    if (tooth >= 1 && tooth <= 8) return "UR"
    if (tooth >= 9 && tooth <= 16) return "UL"
    if (tooth >= 17 && tooth <= 24) return "LL"
    if (tooth >= 25 && tooth <= 32) return "LR"
    throw new Error(`Invalid universal tooth number: ${tooth}`)
  }
  const idx = "ABCDEFGHIJKLMNOPQRST".indexOf(tooth)
  if (idx === -1) throw new Error(`Invalid primary tooth letter: ${tooth}`)
  if (idx <= 4) return "UR" // A-E
  if (idx <= 9) return "UL" // F-J
  if (idx <= 14) return "LL" // K-O
  return "LR" // P-T
}

/** Tooth in the opposing arch that occludes with the given permanent tooth number. */
export function opposingTooth(tooth: number): number
/** Tooth in the opposing arch that occludes with the given primary tooth letter. */
export function opposingTooth(tooth: string): string
export function opposingTooth(tooth: number | string): number | string {
  if (typeof tooth === "number") {
    if (tooth < 1 || tooth > 32) throw new Error(`Invalid universal tooth number: ${tooth}`)
    return 33 - tooth
  }
  const letters = "ABCDEFGHIJKLMNOPQRST"
  const idx = letters.indexOf(tooth)
  if (idx === -1) throw new Error(`Invalid primary tooth letter: ${tooth}`)
  // 1-indexed position, mirrored across the 20-tooth primary arch (A<->T, J<->K).
  const position = idx + 1
  const opposingPosition = 21 - position
  return letters[opposingPosition - 1]
}
