import { LOWER_PERMANENT, UPPER_PERMANENT } from "@/lib/dentition"
import type { ToothChart, ToothSurface } from "@/mock/types"

export const FACIAL_SURFACES: ToothSurface[] = ["DB", "B", "MB"]
export const LINGUAL_SURFACES: ToothSurface[] = ["DL", "L", "ML"]

/** Upper arch = teeth 1-16, lower arch = teeth 17-32 (universal numbering). */
export function isUpperArch(toothNumber: number) {
  return toothNumber >= 1 && toothNumber <= 16
}

/** Display order for the upper row, #1-16 left-to-right. */
export const UPPER_TEETH = UPPER_PERMANENT
/** Display order for the lower row, #32-17 left-to-right (so #32 sits under #1). */
export const LOWER_TEETH = LOWER_PERMANENT

export function depthClass(depth: number | null): string {
  if (depth === null) return "bg-muted text-muted-foreground"
  if (depth >= 5) return "bg-destructive text-destructive-foreground"
  if (depth === 4) return "bg-warning text-warning-foreground"
  return "bg-secondary text-secondary-foreground"
}

export function chartSummary(teeth: ToothChart[]) {
  let bleedingSites = 0
  let totalSites = 0
  let deepSites = 0
  let plaqueSites = 0
  for (const tooth of teeth) {
    if (tooth.missing) continue
    for (const surface of [...FACIAL_SURFACES, ...LINGUAL_SURFACES]) {
      const reading = tooth.sites[surface]
      if (reading.depth === null) continue
      totalSites += 1
      if (reading.bleeding) bleedingSites += 1
      if (reading.depth >= 5) deepSites += 1
      if (reading.plaque) plaqueSites += 1
    }
  }
  return {
    bleedingSites,
    totalSites,
    deepSites,
    plaqueSites,
    bopPercent: totalSites ? Math.round((bleedingSites / totalSites) * 100) : 0,
  }
}

export function findTooth(teeth: ToothChart[], toothNumber: number) {
  return teeth.find((t) => t.toothNumber === toothNumber)
}
