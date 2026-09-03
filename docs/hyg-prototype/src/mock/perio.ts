import type { PerioExam, SiteReading, ToothChart, ToothSurface } from "./types"

export const SURFACES: ToothSurface[] = ["DB", "B", "MB", "DL", "L", "ML"]

function site(depth: number | null, flags: Partial<Omit<SiteReading, "depth">> = {}): SiteReading {
  return {
    depth,
    bleeding: false,
    suppuration: false,
    plaque: false,
    calculus: false,
    ...flags,
  }
}

function emptyTooth(toothNumber: number, missing = false): ToothChart {
  const sites: Record<ToothSurface, SiteReading> = {} as Record<ToothSurface, SiteReading>
  for (const s of SURFACES) {
    sites[s] = missing ? site(null) : site(2)
  }
  return { toothNumber, missing, sites }
}

export function blankChart(missingTeeth: number[] = []): ToothChart[] {
  return Array.from({ length: 32 }, (_, i) => {
    const toothNumber = i + 1
    return emptyTooth(toothNumber, missingTeeth.includes(toothNumber))
  })
}

// Deterministic pseudo-random generator so mock data is stable across renders.
function seededRandom(seed: number) {
  let value = seed
  return () => {
    value = (value * 9301 + 49297) % 233280
    return value / 233280
  }
}

function generatePriorExam(patientId: string, seed: number, missingTeeth: number[]): PerioExam {
  const rand = seededRandom(seed)
  const teeth = blankChart(missingTeeth).map((tooth) => {
    if (tooth.missing) return tooth
    const sites: Record<ToothSurface, SiteReading> = {} as Record<ToothSurface, SiteReading>
    for (const s of SURFACES) {
      const roll = rand()
      const depth = roll > 0.88 ? Math.floor(rand() * 4) + 5 : roll > 0.65 ? 4 : Math.floor(rand() * 3) + 1
      sites[s] = site(depth, {
        bleeding: rand() > 0.8,
        plaque: rand() > 0.75,
        calculus: rand() > 0.85,
        suppuration: rand() > 0.95,
      })
    }
    return { ...tooth, sites }
  })
  return { id: `perio-${patientId}-prior`, patientId, date: "2025-05-12", teeth }
}

// One prior perio exam per synthetic patient, used for the Compare overlay.
export const priorExams: Record<string, PerioExam> = {
  "pt-roland-1": generatePriorExam("pt-roland-1", 11, []),
  "pt-roland-3": generatePriorExam("pt-roland-3", 23, [1, 16, 17, 32]),
  "pt-roland-4": generatePriorExam("pt-roland-4", 37, []),
  "pt-roland-5": generatePriorExam("pt-roland-5", 41, [1, 16, 17, 32, 4, 13]),
  "pt-valley-1": generatePriorExam("pt-valley-1", 53, [1, 16, 17, 32]),
  "pt-valley-2": generatePriorExam("pt-valley-2", 61, []),
  "pt-valley-4": generatePriorExam("pt-valley-4", 71, [1, 16, 17, 32]),
  "pt-valley-7": generatePriorExam("pt-valley-7", 83, []),
}

export function getPriorExam(patientId: string): PerioExam | undefined {
  return priorExams[patientId]
}

/**
 * Scripted demo transcript for "Demo dictation" in the Perio tab.
 * Each entry is a voice command/utterance and the parsed interpretation
 * the app should show in the staged confirm strip.
 */
export interface DictationStep {
  transcript: string
  toothNumber: number
  surfaceGroup: "facial" | "lingual"
  readings: Partial<Record<ToothSurface, Partial<SiteReading>>>
  interpretation: string
}

export const demoDictationScript: DictationStep[] = [
  {
    transcript: "Starting at tooth 3, facial.",
    toothNumber: 3,
    surfaceGroup: "facial",
    readings: {},
    interpretation: "Starting exam at #3, facial surfaces.",
  },
  {
    transcript: "Three two three, bleeding on distal.",
    toothNumber: 3,
    surfaceGroup: "facial",
    readings: {
      DB: { depth: 3, bleeding: true },
      B: { depth: 2 },
      MB: { depth: 3 },
    },
    interpretation: "#3 facial: 3-2-3, BOP distal",
  },
  {
    transcript: "Next.",
    toothNumber: 4,
    surfaceGroup: "facial",
    readings: {},
    interpretation: "Advance to #4, facial.",
  },
  {
    transcript: "Two two three.",
    toothNumber: 4,
    surfaceGroup: "facial",
    readings: { DB: { depth: 2 }, B: { depth: 2 }, MB: { depth: 3 } },
    interpretation: "#4 facial: 2-2-3",
  },
  {
    transcript: "Next.",
    toothNumber: 5,
    surfaceGroup: "facial",
    readings: {},
    interpretation: "Advance to #5, facial.",
  },
  {
    transcript: "Five six five, bleeding all, calculus.",
    toothNumber: 5,
    surfaceGroup: "facial",
    readings: {
      DB: { depth: 5, bleeding: true, calculus: true },
      B: { depth: 6, bleeding: true, calculus: true },
      MB: { depth: 5, bleeding: true, calculus: true },
    },
    interpretation: "#5 facial: 5-6-5, BOP all, calculus",
  },
  {
    transcript: "Lingual.",
    toothNumber: 5,
    surfaceGroup: "lingual",
    readings: {},
    interpretation: "Switch to #5, lingual.",
  },
  {
    transcript: "Four four three, plaque.",
    toothNumber: 5,
    surfaceGroup: "lingual",
    readings: { DL: { depth: 4, plaque: true }, L: { depth: 4, plaque: true }, ML: { depth: 3, plaque: true } },
    interpretation: "#5 lingual: 4-4-3, plaque",
  },
  {
    transcript: "Skip.",
    toothNumber: 6,
    surfaceGroup: "facial",
    readings: {},
    interpretation: "Skip #6 facial — no reading recorded.",
  },
  {
    transcript: "Missing.",
    toothNumber: 7,
    surfaceGroup: "facial",
    readings: {},
    interpretation: "#7 marked missing — auto-skipped.",
  },
  {
    transcript: "Back.",
    toothNumber: 6,
    surfaceGroup: "facial",
    readings: {},
    interpretation: "Return to #6, facial.",
  },
  {
    transcript: "Three three two.",
    toothNumber: 6,
    surfaceGroup: "facial",
    readings: { DB: { depth: 3 }, B: { depth: 3 }, MB: { depth: 2 } },
    interpretation: "#6 facial: 3-3-2",
  },
]
