/**
 * The perio chart — its shape, the order it is charted in, and what it adds up
 * to (H4 slice 10).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SCOPE, LOCKED 2026-08-13
 * ═════════════════════════════════════════════════════════════════════════════
 * Six probing depths per tooth and the four per-site flags Open Dental packs
 * into one `BleedSupPlaqCalc` value. NO recession, NO mobility, NO furcation,
 * NO gingival margin, and NO clinical attachment loss — CAL is DERIVED by Open
 * Dental from probing and gingival margin, is never stored there, and so is
 * never entered here. A field for it would be a number nobody can write.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS FILE SENDS NOTHING
 * ═════════════════════════════════════════════════════════════════════════════
 * Slice 10 reads, displays and stages. The chart lives on the server as the
 * visit's `perio` staged-write row — `Draft` while it is being entered, `Staged`
 * once somebody stages it — and nothing on any path reaches a perio write.
 * A stray Probing row in Open Dental is PERMANENT (only Mobility and SkipTooth
 * can be deleted), which is why the chart stages WHOLE before the send slice
 * is allowed to exist at all.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CHARTING ORDER IS LOAD-BEARING
 * ═════════════════════════════════════════════════════════════════════════════
 * Typing a depth moves to the next site in the order a hygienist calls numbers
 * out loud, and voice entry will lean on exactly this order later. So it is one
 * pure function here, `chartingOrder`, rather than arithmetic in a component.
 *
 * Sites are walked in SCREEN order, and screen order is anatomical: tooth #1
 * sits at the screen's left, so on the patient's RIGHT side (#1–#8, #25–#32) the
 * distal site is the left-hand one, and on the patient's LEFT side (#9–#24) the
 * mesial site is. A sweep across the upper facial therefore reads
 * `#8 DB B MB`, then `#9 MB B DB` — not `#9 DB B MB`, which would put the
 * cursor on the far side of the tooth from where the probe just was.
 *
 * The default sweep is the continuous "snake": upper facial left→right, upper
 * lingual back right→left, lower lingual left→right, lower facial back. Each of
 * the four sweeps can be flipped on its own.
 */
import { z } from "zod";

import {
  HygAppointmentSchema,
  OfficeIdSchema,
  StagedWriteSchema,
  ToothSurfaceSchema,
  type ToothSurface,
} from "./contract";

// ─────────────────────────────────────────────────────────────────────────────
// Numbers
// ─────────────────────────────────────────────────────────────────────────────

/** Open Dental's Probing surface values run 0–19; `-1` is "no measurement". */
export const PERIO_MAX_DEPTH = 19;
export const PERIO_TOOTH_COUNT = 32;
export const PERIO_SITES_PER_TOOTH = 6;
/** "n of 192 sites" — a full permanent mouth with nothing skipped. */
export const PERIO_FULL_MOUTH_SITES = PERIO_TOOTH_COUNT * PERIO_SITES_PER_TOOTH;

/**
 * The two arches in on-screen left-to-right order.
 *
 * The SAME arrays as `client/src/lib/hyg/dentition.ts` — restated because this
 * file is bundled into the backend and cannot import a client module.
 * `tests/hyg-perio.test.ts` asserts they are equal, so the lower arch cannot
 * quietly start reading #17 → #32 here while the rest of the app reads it the
 * right way round.
 */
export const PERIO_UPPER_TEETH: readonly number[] = Array.from({ length: 16 }, (_, i) => i + 1);
export const PERIO_LOWER_TEETH: readonly number[] = Array.from({ length: 16 }, (_, i) => 32 - i);

// ─────────────────────────────────────────────────────────────────────────────
// The chart
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ITEM 26 §0 — WHICH FAMILY OF GINGIVAL-MARGIN VALUES MEANS RECESSION.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * MEASURED, NOT INFERRED. THIS IS THE ONE CONSTANT THE SLICE TURNS ON.
 * ═════════════════════════════════════════════════════════════════════════════
 * `POST /periomeasures` with `SequenceType: GingMargin` accepts TWO families —
 * `0–19` and `101–119` — and item 19's probe measured that both store VERBATIM:
 * 101/102 are not converted, clamped or re-signed in either direction. H0's prose
 * documents 101–119 as "negative (subtract 100)". Neither the API nor the docs
 * say which family a RECESSION goes in; that is a convention of Open Dental's own
 * user interface, and no amount of writing to the API can reveal it.
 *
 * So a person entered one. Beau hand-entered a perio exam in **Open Dental's own
 * perio chart** on roland test patient 12828 on 2026-09-29 with a known
 * **2 mm recession on #3 buccal**, and the probe
 * (`backend/scripts/probe-hyg-perio-gm-sign.js`) read it back from staging
 * (revision `--0000211`). The raw row, quoted:
 *
 *     {"PerioExamNum":2268,"SequenceType":"GingMargin","IntTooth":3,
 *      "ToothValue":-1,"MBvalue":-1,"Bvalue":2, ...}
 *
 * **`Bvalue` is 2 for a 2 mm recession. THE RECESSION FAMILY IS THE LOW ONE,
 * 0–19.** Therefore `CAL = depth + recession`, by ADDITION, and CareIN's entry
 * writes 0–19 and never 101–119.
 *
 * Two consequences this constant also carries:
 *
 * - `101–119` is the OTHER family. CareIN never writes it. It can still arrive on
 *   a READ-BACK, from a writer that is not us, and when it does the value is
 *   shown raw and marked unrecognised — **never** turned into a CAL. H0 says to
 *   subtract 100; that sign has never been observed, and a guess here becomes a
 *   clinical number that reads as plausible.
 * - Open Dental's own UI **refused a negative** (Beau, same session): overgrowth,
 *   a margin coronal to the CEJ, could not be typed there at all. So CareIN
 *   charts recession only. That is parity with the chart of record, not a gap.
 */
export const PERIO_GM_FAMILIES = Object.freeze({
  /** What a recession is stored as — measured. CareIN writes only this range. */
  recessionMin: 0,
  recessionMax: 19,
  /** The other family Open Dental accepts. Recognised on read-back, never written. */
  otherMin: 101,
  otherMax: 119,
});

/** Is this gingival-margin value a recession, in the §0-proven family? */
export function perioGmIsRecession(value: number | null): boolean {
  return (
    value !== null &&
    Number.isInteger(value) &&
    value >= PERIO_GM_FAMILIES.recessionMin &&
    value <= PERIO_GM_FAMILIES.recessionMax
  );
}

/** Clinical mobility, Miller 0–3. Open Dental would take 0–19; we do not. */
export const PERIO_MAX_MOBILITY = 3;

/** Furcation classes I–III. Open Dental accepted a 5 (probe §7); we refuse it. */
export const PERIO_MIN_FURCATION = 1;
export const PERIO_MAX_FURCATION = 3;

/**
 * THE TEETH THAT HAVE A FURCATION AT ALL — molars, plus the upper first premolars
 * (#5 and #12), which are the two-rooted ones.
 *
 * Open Dental does not know this: the probe posted Furcation on #8, a central
 * incisor, and it was **accepted and stored** (§7). A single-rooted tooth has no
 * furcation, so a class on one is a corruption of the chart of record, and the
 * product is the only thing standing between a typo and that.
 */
export const PERIO_FURCATION_TEETH: readonly number[] = Object.freeze([
  1, 2, 3, 14, 15, 16, // upper molars
  5, 12, // upper first premolars — two-rooted
  17, 18, 19, 30, 31, 32, // lower molars
]);

export function perioToothHasFurcation(tooth: number): boolean {
  return PERIO_FURCATION_TEETH.includes(tooth);
}

/**
 * One site. `depth: null` is "not charted", which is NOT zero — a zero is a
 * reading. The four flags can be set on a site with no depth, because Open
 * Dental stores them in a separate row and a hygienist can see bleeding on a
 * site she has not recorded a number for yet.
 */
export const PerioSiteSchema = z
  .object({
    depth: z.number().int().min(0).max(PERIO_MAX_DEPTH).nullable(),
    bleeding: z.boolean(),
    suppuration: z.boolean(),
    plaque: z.boolean(),
    calculus: z.boolean(),
    /*
     * ITEM 26. Both carry `.default(null)` so a chart stored before v2 parses —
     * a strict object with a new required field would refuse every draft in the
     * database.
     */
    /**
     * Gingival margin, in millimetres of RECESSION (§0: the 0–19 family).
     *
     * The schema also admits 101–119 because Open Dental does and a read-back can
     * carry one. CareIN's entry never produces one — `perioGmIsRecession` is how
     * the two are told apart, and an unrecognised value gets no CAL.
     */
    gm: z
      .union([
        z.number().int().min(PERIO_GM_FAMILIES.recessionMin).max(PERIO_GM_FAMILIES.recessionMax),
        z.number().int().min(PERIO_GM_FAMILIES.otherMin).max(PERIO_GM_FAMILIES.otherMax),
      ])
      .nullable()
      .default(null),
    /** Furcation class I–III. Only on a tooth that has one — see PERIO_FURCATION_TEETH. */
    furcation: z
      .number()
      .int()
      .min(PERIO_MIN_FURCATION)
      .max(PERIO_MAX_FURCATION)
      .nullable()
      .default(null),
  })
  .strict();
export type PerioSite = z.infer<typeof PerioSiteSchema>;

export const PERIO_FLAGS = ["bleeding", "suppuration", "plaque", "calculus"] as const;
export type PerioFlag = (typeof PERIO_FLAGS)[number];

export const PERIO_FLAG_LABELS: Record<PerioFlag, string> = {
  bleeding: "Bleeding",
  suppuration: "Suppuration",
  plaque: "Plaque",
  calculus: "Calculus",
};

/** The one-letter key each flag answers to, B/S/P/C. */
export const PERIO_FLAG_KEYS: Record<PerioFlag, string> = {
  bleeding: "B",
  suppuration: "S",
  plaque: "P",
  calculus: "C",
};

/**
 * One tooth. `skipped` is Open Dental's SkipTooth — a missing or unchartable
 * tooth — and a skipped tooth's sites do not count toward the chart. Its
 * readings are KEPT rather than wiped, so an accidental skip is one key to undo
 * rather than a row of numbers to re-enter.
 */
export const PerioToothSchema = z
  .object({
    skipped: z.boolean(),
    /**
     * ITEM 26: mobility is PER TOOTH, not per site — Open Dental stores it in
     * `ToothValue` with every surface column `-1` (probe §4). Clinical range 0–3;
     * `0` is a real reading ("tested, firm"), which is why it is nullable rather
     * than defaulting to zero. `.default(null)` so pre-v2 charts parse.
     */
    mobility: z.number().int().min(0).max(PERIO_MAX_MOBILITY).nullable().default(null),
    sites: z
      .object({
        DB: PerioSiteSchema,
        B: PerioSiteSchema,
        MB: PerioSiteSchema,
        DL: PerioSiteSchema,
        L: PerioSiteSchema,
        ML: PerioSiteSchema,
      })
      .strict(),
  })
  .strict();
export type PerioTooth = z.infer<typeof PerioToothSchema>;

/** A universal tooth number as a record key. Permanent dentition only in v1. */
export const PerioToothKeySchema = z
  .string()
  .regex(/^(?:[1-9]|[12]\d|3[0-2])$/, "must be a universal tooth number from 1 to 32");

export const PerioSegmentSchema = z.enum([
  "upperFacial",
  "upperLingual",
  "lowerLingual",
  "lowerFacial",
]);
export type PerioSegment = z.infer<typeof PerioSegmentSchema>;

/** Which way a sweep crosses the SCREEN. */
export const PerioDirectionSchema = z.enum(["ltr", "rtl"]);
export type PerioDirection = z.infer<typeof PerioDirectionSchema>;

export const PerioSweepSchema = z
  .object({
    upperFacial: PerioDirectionSchema,
    upperLingual: PerioDirectionSchema,
    lowerLingual: PerioDirectionSchema,
    lowerFacial: PerioDirectionSchema,
  })
  .strict();
export type PerioSweep = z.infer<typeof PerioSweepSchema>;

/** The continuous snake. See the header. */
export function defaultPerioSweep(): PerioSweep {
  return { upperFacial: "ltr", upperLingual: "rtl", lowerLingual: "ltr", lowerFacial: "rtl" };
}

/**
 * The whole chart.
 *
 * `teeth` is keyed by tooth number and PARTIAL: a tooth nobody has touched is
 * absent, which reads exactly like an all-null tooth. `sweep` is how this chart
 * is being entered — it travels with the chart so a visit resumed on another
 * iPad walks the same way, and it carries a `.default()` so a chart stored
 * without one still parses (the slice-8 lesson: a required field added to a
 * stored jsonb shape blanks every in-flight row).
 */
export const PerioChartSchema = z
  .object({
    teeth: z.record(PerioToothKeySchema, PerioToothSchema),
    sweep: PerioSweepSchema.default(defaultPerioSweep),
  })
  .strict();
export type PerioChart = z.infer<typeof PerioChartSchema>;

export function emptyPerioSite(): PerioSite {
  return {
    depth: null,
    bleeding: false,
    suppuration: false,
    plaque: false,
    calculus: false,
    gm: null,
    furcation: null,
  };
}

export function emptyPerioTooth(): PerioTooth {
  return {
    skipped: false,
    mobility: null,
    sites: {
      DB: emptyPerioSite(),
      B: emptyPerioSite(),
      MB: emptyPerioSite(),
      DL: emptyPerioSite(),
      L: emptyPerioSite(),
      ML: emptyPerioSite(),
    },
  };
}

export function emptyPerioChart(): PerioChart {
  return { teeth: {}, sweep: defaultPerioSweep() };
}

/** A tooth, whether or not the chart holds it. Never undefined. */
export function perioTooth(chart: PerioChart, tooth: number): PerioTooth {
  return chart.teeth[String(tooth)] ?? emptyPerioTooth();
}

export function perioSite(chart: PerioChart, tooth: number, surface: ToothSurface): PerioSite {
  return perioTooth(chart, tooth).sites[surface];
}

/** A new chart with one site changed. Never mutates. */
export function withPerioSite(
  chart: PerioChart,
  tooth: number,
  surface: ToothSurface,
  patch: Partial<PerioSite>,
): PerioChart {
  const current = perioTooth(chart, tooth);
  const next: PerioTooth = {
    skipped: current.skipped,
    // ITEM 26: mobility is a TOOTH value and must survive a change to a site.
    mobility: current.mobility,
    sites: { ...current.sites, [surface]: { ...current.sites[surface], ...patch } },
  };
  return { ...chart, teeth: { ...chart.teeth, [String(tooth)]: next } };
}

/** A new chart with one tooth skipped or un-skipped. Its readings are kept. */
export function withPerioSkipped(chart: PerioChart, tooth: number, skipped: boolean): PerioChart {
  const current = perioTooth(chart, tooth);
  return {
    ...chart,
    teeth: {
      ...chart.teeth,
      [String(tooth)]: { skipped, mobility: current.mobility, sites: current.sites },
    },
  };
}

/** A new chart with one tooth's mobility set or cleared. Never mutates. */
export function withPerioMobility(
  chart: PerioChart,
  tooth: number,
  mobility: number | null,
): PerioChart {
  const current = perioTooth(chart, tooth);
  return {
    ...chart,
    teeth: { ...chart.teeth, [String(tooth)]: { ...current, mobility } },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The charting order
// ─────────────────────────────────────────────────────────────────────────────

export type PerioSide = "facial" | "lingual";

/** #1–#8 and #25–#32 are on the patient's right, which is the screen's left. */
export function isPatientRight(tooth: number): boolean {
  return (tooth >= 1 && tooth <= 8) || (tooth >= 25 && tooth <= 32);
}

export function perioSideOf(surface: ToothSurface): PerioSide {
  return surface === "DB" || surface === "B" || surface === "MB" ? "facial" : "lingual";
}

/**
 * One side of one tooth, in SCREEN order left to right. See the header: the
 * distal site is on the left for a patient-right tooth, and on the right for a
 * patient-left tooth.
 */
export function screenSites(tooth: number, side: PerioSide): ToothSurface[] {
  const right = isPatientRight(tooth);
  if (side === "facial") return right ? ["DB", "B", "MB"] : ["MB", "B", "DB"];
  return right ? ["DL", "L", "ML"] : ["ML", "L", "DL"];
}

export interface PerioSegmentInfo {
  id: PerioSegment;
  arch: "upper" | "lower";
  side: PerioSide;
  /** On-screen left-to-right. */
  teeth: readonly number[];
  label: string;
}

/** The four sweeps, in the order a chart is walked. */
export const PERIO_SEGMENTS: readonly PerioSegmentInfo[] = [
  { id: "upperFacial", arch: "upper", side: "facial", teeth: PERIO_UPPER_TEETH, label: "Upper facial" },
  { id: "upperLingual", arch: "upper", side: "lingual", teeth: PERIO_UPPER_TEETH, label: "Upper lingual" },
  { id: "lowerLingual", arch: "lower", side: "lingual", teeth: PERIO_LOWER_TEETH, label: "Lower lingual" },
  { id: "lowerFacial", arch: "lower", side: "facial", teeth: PERIO_LOWER_TEETH, label: "Lower facial" },
];

export function perioSegmentOf(tooth: number, surface: ToothSurface): PerioSegment {
  const upper = tooth <= 16;
  const facial = perioSideOf(surface) === "facial";
  if (upper) return facial ? "upperFacial" : "upperLingual";
  return facial ? "lowerFacial" : "lowerLingual";
}

export interface PerioCursor {
  tooth: number;
  surface: ToothSurface;
}

export function sameCursor(a: PerioCursor | null, b: PerioCursor | null): boolean {
  return a !== null && b !== null && a.tooth === b.tooth && a.surface === b.surface;
}

/**
 * Every site of one sweep, in the order it is charted.
 *
 * `rtl` reverses the teeth AND each tooth's sites, because the probe is moving
 * the other way along the arch — reversing only the teeth would jump to the far
 * side of every tooth.
 */
export function segmentOrder(segment: PerioSegmentInfo, direction: PerioDirection): PerioCursor[] {
  const teeth = direction === "ltr" ? segment.teeth.slice() : segment.teeth.slice().reverse();
  const out: PerioCursor[] = [];
  for (const tooth of teeth) {
    const sites = screenSites(tooth, segment.side);
    if (direction === "rtl") sites.reverse();
    for (const surface of sites) out.push({ tooth, surface });
  }
  return out;
}

/** All 192 sites, in charting order, for this sweep. Skipped teeth included. */
export function chartingOrder(sweep: PerioSweep): PerioCursor[] {
  const out: PerioCursor[] = [];
  for (const segment of PERIO_SEGMENTS) out.push(...segmentOrder(segment, sweep[segment.id]));
  return out;
}

/**
 * The next (or previous) chartable site after `from`, skipping skipped teeth.
 * `null` at either end — the cursor stays where it is rather than wrapping,
 * because wrapping from #32 back to #1 would put the next number on a tooth
 * that was charted five minutes ago.
 */
export function stepPerioCursor(
  chart: PerioChart,
  from: PerioCursor,
  step: 1 | -1,
): PerioCursor | null {
  const order = chartingOrder(chart.sweep);
  let i = order.findIndex((c) => sameCursor(c, from));
  if (i === -1) return null;
  for (i += step; i >= 0 && i < order.length; i += step) {
    if (!perioTooth(chart, order[i].tooth).skipped) return order[i];
  }
  return null;
}

/**
 * Where entry should start: the first uncharted site on a tooth that is not
 * skipped. A resumed chart lands on the next number to call, not on #1.
 */
export function firstOpenPerioCursor(chart: PerioChart): PerioCursor {
  const order = chartingOrder(chart.sweep);
  const open = order.find(
    (c) => !perioTooth(chart, c.tooth).skipped && perioSite(chart, c.tooth, c.surface).depth === null,
  );
  if (open) return open;
  const chartable = order.find((c) => !perioTooth(chart, c.tooth).skipped);
  return chartable ?? order[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Open Dental's packed flags
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `BleedSupPlaqCalc` is ONE integer per site, 0–15: bleeding 1, suppuration 2,
 * plaque 4, calculus 8 (H0 §2, from Open Dental's docs).
 */
export function bleedSupPlaqCalcBits(site: Pick<PerioSite, PerioFlag>): number {
  return (
    (site.bleeding ? 1 : 0) +
    (site.suppuration ? 2 : 0) +
    (site.plaque ? 4 : 0) +
    (site.calculus ? 8 : 0)
  );
}

/**
 * The reverse. `null` for anything outside 0–15 — including Open Dental's `-1`
 * "no measurement" — so a value this build cannot read is not rendered as four
 * confident `false`s.
 */
export function flagsFromBits(bits: unknown): Pick<PerioSite, PerioFlag> | null {
  if (typeof bits !== "number" || !Number.isInteger(bits) || bits < 0 || bits > 15) return null;
  return {
    bleeding: (bits & 1) !== 0,
    suppuration: (bits & 2) !== 0,
    plaque: (bits & 4) !== 0,
    calculus: (bits & 8) !== 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// What a chart adds up to
// ─────────────────────────────────────────────────────────────────────────────

export const PerioCountsSchema = z.object({
  /** Sites with a depth, on teeth that are not skipped. */
  sitesCharted: z.number().int(),
  /** 192, less six for every skipped tooth. */
  sitesExpected: z.number().int(),
  teethSkipped: z.array(z.number().int()),
  bleeding: z.number().int(),
  suppuration: z.number().int(),
  plaque: z.number().int(),
  calculus: z.number().int(),
  sitesAtLeast5: z.number().int(),
  deepest: z
    .object({ depth: z.number().int(), tooth: z.number().int(), surface: ToothSurfaceSchema })
    .nullable(),
  /** Every expected site charted. A partial chart is `false` and SAYS so. */
  complete: z.boolean(),
  /** No depth, no flag, no skipped tooth — nothing to stage. */
  empty: z.boolean(),
  /* ITEM 26. `.default(0)` so a response from an older build still parses. */
  /** Sites carrying a gingival-margin value, on un-skipped teeth. */
  gmSites: z.number().int().default(0),
  /** Sites carrying a furcation class. */
  furcationSites: z.number().int().default(0),
  /** Teeth carrying a mobility value. */
  mobilityTeeth: z.number().int().default(0),
});
export type PerioCounts = z.infer<typeof PerioCountsSchema>;

/** Sites within a tooth in a fixed, anatomical order — for counting and for the preview. */
const FACIAL_SITES: ToothSurface[] = ["DB", "B", "MB"];
const LINGUAL_SITES: ToothSurface[] = ["DL", "L", "ML"];
const ALL_SITES: ToothSurface[] = [...FACIAL_SITES, ...LINGUAL_SITES];

export function countPerioChart(chart: PerioChart): PerioCounts {
  const counts: PerioCounts = {
    sitesCharted: 0,
    sitesExpected: PERIO_FULL_MOUTH_SITES,
    teethSkipped: [],
    bleeding: 0,
    suppuration: 0,
    plaque: 0,
    calculus: 0,
    sitesAtLeast5: 0,
    deepest: null,
    complete: false,
    empty: true,
    gmSites: 0,
    furcationSites: 0,
    mobilityTeeth: 0,
  };
  for (let tooth = 1; tooth <= PERIO_TOOTH_COUNT; tooth += 1) {
    const t = perioTooth(chart, tooth);
    if (t.skipped) {
      counts.teethSkipped.push(tooth);
      continue;
    }
    if (t.mobility !== null) counts.mobilityTeeth += 1;
    for (const surface of ALL_SITES) {
      const site = t.sites[surface];
      if (site.depth !== null) {
        counts.sitesCharted += 1;
        if (site.depth >= 5) counts.sitesAtLeast5 += 1;
        if (counts.deepest === null || site.depth > counts.deepest.depth) {
          counts.deepest = { depth: site.depth, tooth, surface };
        }
      }
      if (site.gm !== null) counts.gmSites += 1;
      if (site.furcation !== null) counts.furcationSites += 1;
      for (const flag of PERIO_FLAGS) if (site[flag]) counts[flag] += 1;
    }
  }
  counts.sitesExpected = PERIO_FULL_MOUTH_SITES - PERIO_SITES_PER_TOOTH * counts.teethSkipped.length;
  counts.complete = counts.sitesExpected > 0 && counts.sitesCharted === counts.sitesExpected;
  counts.empty =
    counts.sitesCharted === 0 &&
    counts.teethSkipped.length === 0 &&
    counts.gmSites === 0 &&
    counts.furcationSites === 0 &&
    counts.mobilityTeeth === 0 &&
    PERIO_FLAGS.every((flag) => counts[flag] === 0);
  return counts;
}

/**
 * ITEM 26: CAL — CLINICAL ATTACHMENT LEVEL, COMPUTED FOR THE SCREEN AND NOWHERE
 * ELSE.
 *
 * `CAL = probing depth + recession`, by ADDITION, because §0 measured that a
 * recession is stored in the 0–19 family (see PERIO_GM_FAMILIES).
 *
 * ⚠️ IT IS NEVER TYPED, NEVER STAGED AND NEVER WRITTEN TO OPEN DENTAL. Open
 * Dental derives its own CAL from Probing + GingMargin, so a CAL CareIN wrote
 * could disagree with the chart of record — and the chart of record would be the
 * one that looked wrong. `odPerioWriter.js` refuses the SequenceType outright and
 * a test asserts no CAL reaches any payload.
 *
 * `null` means "do not show a number", and the three ways to get there are all
 * honest absences rather than zeros:
 *   - no depth at this site
 *   - no gingival margin at this site
 *   - a gingival margin in the OTHER family (101–119). It came from a writer that
 *     is not us, its sign has never been observed, and H0's "subtract 100" is a
 *     guess. The screen shows the raw value and marks it unrecognised.
 */
export function perioCal(site: PerioSite): number | null {
  if (site.depth === null) return null;
  if (!perioGmIsRecession(site.gm)) return null;
  return site.depth + (site.gm as number);
}

/**
 * ITEM 28: DOES THIS CHART HOLD A MEASUREMENT? The one gate on staging.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A SKIP IS A STATEMENT ABOUT A TOOTH. IT IS NOT A READING.
 * ═════════════════════════════════════════════════════════════════════════════
 * `empty` counts a skipped tooth as content, which is right for the question it
 * answers — "has anybody touched this chart at all" — and wrong for this one. A
 * chart of nothing but skips passed `!empty`, staged, and sent a perio exam with
 * NO READINGS into the chart of record: a dated exam in a patient's permanent
 * record saying, in effect, that a perio chart was done and found nothing.
 *
 * Hand-skipping made that reachable. Item 27's pre-skip made it reachable with
 * the hygienist having entered nothing at all — she opens a chart, Open Dental's
 * missing teeth skip themselves, and Stage lights up. So the gate is a
 * measurement she took: a depth, or a flag riding a site.
 *
 * ⚠️ USE THIS, NOT `!counts.empty`, FOR ANYTHING THAT WRITES. `empty` is still
 * the right question for "has she touched this chart" — item 27's pre-skip is
 * suppressed by it, deliberately, because a tooth she skipped by hand is a
 * decision the pre-skip must not overrule.
 *
 * Flags are counted on un-skipped teeth only (see the loop above), so a flag on
 * a skipped tooth cannot satisfy this either.
 */
export function perioHasReading(counts: PerioCounts): boolean {
  return (
    counts.sitesCharted > 0 ||
    // ITEM 26: a recession, a furcation class and a mobility grade are all things
    // she measured, so each one is a reading by item 28's rule. Only a SKIP is
    // not — and that is still the whole content of the test that pins this.
    counts.gmSites > 0 ||
    counts.furcationSites > 0 ||
    counts.mobilityTeeth > 0 ||
    PERIO_FLAGS.some((flag) => counts[flag] > 0)
  );
}

/** The refusal, in the one wording the server and the screen both use. */
export const PERIO_NO_READING_REFUSAL =
  "There are no perio readings on this visit yet, so there is nothing to stage. " +
  "Skipped teeth do not count — a skip says a tooth was not charted, not what " +
  "was measured. Open the perio chart and enter a reading first.";

/**
 * "Partial chart: 84 of 192 sites charted" — the words a partial chart is
 * labelled with EVERYWHERE, so the tray, the workspace and the staged preview
 * cannot describe one chart three ways.
 */
export function perioProgressLabel(counts: PerioCounts): string {
  const skipped = counts.teethSkipped.length;
  const tail =
    skipped === 0 ? "" : ` (${skipped} ${skipped === 1 ? "tooth" : "teeth"} skipped)`;
  const head = counts.complete ? "Full chart" : "Partial chart";
  return `${head}: ${counts.sitesCharted} of ${counts.sitesExpected} sites charted${tail}`;
}

function siteIsEmpty(site: PerioSite): boolean {
  return (
    site.depth === null &&
    site.gm === null &&
    site.furcation === null &&
    PERIO_FLAGS.every((flag) => !site[flag])
  );
}

/**
 * The chart in ONE canonical form: teeth in numeric order, sites in a fixed
 * order, untouched teeth dropped, keys in a fixed order.
 *
 * Postgres `jsonb` does not preserve key order, so "is the stored chart the same
 * as this one" is only answerable after both have been through here. It is also
 * idempotent, which a test pins.
 */
export function normalizePerioChart(chart: PerioChart): PerioChart {
  const teeth: Record<string, PerioTooth> = {};
  for (let tooth = 1; tooth <= PERIO_TOOTH_COUNT; tooth += 1) {
    const stored = chart.teeth[String(tooth)];
    if (!stored) continue;
    const sites = {
      DB: { ...emptyPerioSite(), ...stored.sites.DB },
      B: { ...emptyPerioSite(), ...stored.sites.B },
      MB: { ...emptyPerioSite(), ...stored.sites.MB },
      DL: { ...emptyPerioSite(), ...stored.sites.DL },
      L: { ...emptyPerioSite(), ...stored.sites.L },
      ML: { ...emptyPerioSite(), ...stored.sites.ML },
    };
    const canonical: PerioTooth = {
      skipped: stored.skipped,
      mobility: stored.mobility ?? null,
      sites: {} as PerioTooth["sites"],
    };
    for (const surface of ALL_SITES) {
      const s = sites[surface];
      canonical.sites[surface] = {
        depth: s.depth,
        bleeding: s.bleeding,
        suppuration: s.suppuration,
        plaque: s.plaque,
        calculus: s.calculus,
        gm: s.gm ?? null,
        furcation: s.furcation ?? null,
      };
    }
    // A tooth holding ONLY a mobility reading is still a charted tooth.
    if (
      !canonical.skipped &&
      canonical.mobility === null &&
      ALL_SITES.every((surface) => siteIsEmpty(canonical.sites[surface]))
    ) {
      continue;
    }
    teeth[String(tooth)] = canonical;
  }
  const sweep = chart.sweep ?? defaultPerioSweep();
  return {
    teeth,
    sweep: {
      upperFacial: sweep.upperFacial,
      upperLingual: sweep.upperLingual,
      lowerLingual: sweep.lowerLingual,
      lowerFacial: sweep.lowerFacial,
    },
  };
}

/** Same readings, same skips. The sweep is how it was typed, not what it says. */
export function samePerioReadings(a: PerioChart, b: PerioChart): boolean {
  return JSON.stringify(normalizePerioChart(a).teeth) === JSON.stringify(normalizePerioChart(b).teeth);
}

function teethList(teeth: number[]): string {
  return teeth.map((t) => "#" + t).join(", ");
}

/**
 * What a staged chart SAYS — every reading it holds, as lines a person can read.
 *
 * Composed on the SERVER (services/hyg/stagedWriteComposer.js runs it) and
 * fingerprinted there, the same way every other staged write is. It lives in the
 * shared file for the reason `renderVisitNote` does: one definition. The screen
 * never builds a preview of its own.
 *
 * Every depth and every flag on every tooth that holds one is in these lines,
 * so two charts with the same preview are the same chart — which is what lets
 * the fingerprint stand for the readings when the send slice arrives.
 *
 * ASCII only: a hyphen for a site not charted, and no typographic punctuation.
 */
export function perioPreviewLines(chart: PerioChart): string[] {
  const normalized = normalizePerioChart(chart);
  const counts = countPerioChart(normalized);
  const lines: string[] = [perioProgressLabel(counts)];

  if (counts.teethSkipped.length > 0) lines.push("Teeth skipped: " + teethList(counts.teethSkipped));
  lines.push(
    `Bleeding: ${counts.bleeding} sites; suppuration: ${counts.suppuration}; ` +
      `plaque: ${counts.plaque}; calculus: ${counts.calculus}`,
  );
  if (counts.deepest !== null) {
    lines.push(
      `Deepest: ${counts.deepest.depth} mm at #${counts.deepest.tooth} ${counts.deepest.surface}; ` +
        `sites 5 mm or deeper: ${counts.sitesAtLeast5}`,
    );
  }
  /*
   * ITEM 26 — AND THE PREVIEW IS WHAT THE FINGERPRINT IS TAKEN OF.
   *
   * `visitStore.fingerprintPreview` hashes these lines, and the send refuses when
   * the fingerprint no longer matches the one she confirmed. So a recession edited
   * between the preview and the send has to CHANGE A LINE HERE, or the confirm
   * gate would wave through a chart she never read. Every v2 value is printed per
   * tooth below for exactly that reason, not only counted.
   */
  if (counts.gmSites > 0 || counts.furcationSites > 0 || counts.mobilityTeeth > 0) {
    lines.push(
      `Recession: ${counts.gmSites} sites; furcation: ${counts.furcationSites} sites; ` +
        `mobility: ${counts.mobilityTeeth} teeth`,
    );
  }
  lines.push("Depths read DB B MB (facial) and DL L ML (lingual); - is not charted.");

  const notCharted: number[] = [];
  for (let tooth = 1; tooth <= PERIO_TOOTH_COUNT; tooth += 1) {
    const t = normalized.teeth[String(tooth)];
    if (!t) {
      notCharted.push(tooth);
      continue;
    }
    if (t.skipped) {
      lines.push(`  #${tooth} skipped`);
      continue;
    }
    const depths = (sites: ToothSurface[]) =>
      sites.map((s) => (t.sites[s].depth === null ? "-" : String(t.sites[s].depth))).join(" ");
    const flagParts: string[] = [];
    for (const flag of PERIO_FLAGS) {
      const at = ALL_SITES.filter((s) => t.sites[s][flag]);
      if (at.length > 0) flagParts.push(`${flag} ${at.join(", ")}`);
    }
    // ITEM 26: named per site, so an edited value moves the fingerprint.
    const gmAt = ALL_SITES.filter((site) => t.sites[site].gm !== null);
    if (gmAt.length > 0) {
      flagParts.push(
        "recession " + gmAt.map((site) => `${site} ${t.sites[site].gm} mm`).join(", "),
      );
    }
    const furcationAt = ALL_SITES.filter((site) => t.sites[site].furcation !== null);
    if (furcationAt.length > 0) {
      flagParts.push(
        "furcation " + furcationAt.map((site) => `${site} class ${t.sites[site].furcation}`).join(", "),
      );
    }
    if (t.mobility !== null) flagParts.push(`mobility grade ${t.mobility}`);
    lines.push(
      `  #${tooth} facial ${depths(FACIAL_SITES)}, lingual ${depths(LINGUAL_SITES)}` +
        (flagParts.length > 0 ? "; " + flagParts.join("; ") : ""),
    );
  }
  if (notCharted.length > 0 && notCharted.length < PERIO_TOOTH_COUNT) {
    lines.push("Not charted: " + teethList(notCharted));
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// The wire
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PUT /api/hyg/visit/:aptNum/perio — the chart, whole.
 *
 * Whole rather than per-site for the slip's reason: a merge makes "she cleared
 * this site" and "this client does not know about this site" the same request.
 * `.strict()` so an unknown key is a 400 that names it.
 */
export const PerioChartSaveRequestSchema = z.object({ chart: PerioChartSchema }).strict();
export type PerioChartSaveRequest = z.infer<typeof PerioChartSaveRequestSchema>;

/**
 * GET and PUT /api/hyg/visit/:aptNum/perio — what is stored. No Open Dental.
 *
 * `stagedWrite` is the visit's `perio` row: `Draft` while the chart is being
 * entered, `Staged` once somebody stages it, null when nothing is stored.
 */
export const HygPerioResponseSchema = z.object({
  success: z.literal(true),
  office: OfficeIdSchema,
  aptNum: z.number().int(),
  /** False until somebody changes something on this appointment. */
  visitStarted: z.boolean(),
  chart: PerioChartSchema,
  stagedWrite: StagedWriteSchema.nullable(),
  counts: PerioCountsSchema,
  /**
   * ITEM 27: has a perio chart for this visit EVER been stored? Not "is it
   * empty" — `counts.empty` already answers that, and it is the wrong question
   * for a pre-skip. A hygienist who un-skips the last pre-skipped tooth leaves
   * an empty chart behind, and an empty chart is indistinguishable from an
   * untouched one, so keying the pre-skip on emptiness would undo her un-skip
   * on the next open. A stored row says she has been here. Defaults false so an
   * older answer pre-skips as a first open would.
   */
  chartStored: z.boolean().default(false),
});
export type HygPerioResponse = z.infer<typeof HygPerioResponseSchema>;

/**
 * The most recent perio exam Open Dental holds for this patient.
 *
 * THREE ANSWERS, AND A SCREEN MUST DRAW THEM THREE WAYS:
 *   `found`       — an exam, with whatever readings it holds (possibly none).
 *   `none`        — Open Dental answered, and this patient has no perio exam.
 *                   An honest empty, never a chart of zeros.
 *   `unavailable` — Open Dental did not answer. Not "no history".
 * The fourth state, "not read yet", is the request still being in flight, and
 * the client draws that one too.
 */
export const PerioPriorSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("found"),
    examNum: z.number().int(),
    /** Open Dental's ExamDate, `YYYY-MM-DD`, or null when it gave none. */
    examDate: z.string().nullable(),
    provNum: z.number().int().nullable(),
    chart: PerioChartSchema,
    counts: PerioCountsSchema,
    /** The measurement list did not come back whole. Some readings are missing. */
    truncated: z.boolean(),
  }),
  z.object({ status: z.literal("none") }),
  z.object({
    status: z.literal("unavailable"),
    message: z.string(),
    /** Open Dental's own status line. Never a body. */
    detail: z.string().nullable(),
  }),
]);
export type PerioPrior = z.infer<typeof PerioPriorSchema>;

/**
 * One site that differs between two charts: `#14 B: 3 mm → 4 mm`.
 *
 * Lives HERE rather than beside the comparison that produces it
 * (`perioChartChanges`, in perioSend.ts) because the drift check below needs the
 * shape and perio.ts cannot import from perioSend.ts — the import runs one way
 * only. The formatters stay with the comparison.
 */
export const PerioSiteChangeSchema = z.object({
  tooth: z.number().int(),
  surface: ToothSurfaceSchema.nullable(),
  kind: z.enum(["depth", "flags", "skipped"]),
  from: z.string(),
  to: z.string(),
});
export type PerioSiteChange = z.infer<typeof PerioSiteChangeSchema>;

/**
 * One perio exam Open Dental holds for this patient on the visit's date.
 *
 * `careinWrote` is false for an exam CareIN has no send row for — a hygienist
 * who deleted CareIN's exam and re-charted by hand in Open Dental. The resend
 * confirmation lists those too, which is the entire reason this carries a flag
 * instead of being filtered down to CareIN's own.
 */
export const PerioSameDateExamSchema = z.object({
  examNum: z.number().int(),
  examDate: z.string().nullable(),
  provNum: z.number().int().nullable(),
  careinWrote: z.boolean(),
});
export type PerioSameDateExam = z.infer<typeof PerioSameDateExamSchema>;

/**
 * IS THE EXAM CAREIN WROTE STILL THE EXAM OPEN DENTAL HOLDS? (item 14)
 *
 * `Written` means every site was read back and matched — AT THE MOMENT IT WAS
 * READ BACK. Open Dental's own perio chart has a Delete button on that screen,
 * so the claim can stop being true without CareIN ever hearing about it. This is
 * the answer to asking again, when a `Written` chart is OPENED.
 *
 * FIVE ANSWERS, AND THE SCREEN SAYS SOMETHING FOR ONLY TWO OF THEM:
 *
 *   `not_applicable` — the chart is not `Written`, so there is no claim to check.
 *   `matches`        — the exam is there and every site still agrees. The
 *                      existing `Written` line stands. NOTHING is said.
 *   `missing`        — the exam is not in `/perioexams` at all. SAID, and the
 *                      resend is offered: this is the one dead end #180 left.
 *   `changed`        — the exam is there and the readings DIFFER. SAID, naming
 *                      the sites, and NO resend is offered.
 *   `unknown`        — Open Dental could not be read. NOTHING is said, and the
 *                      `Written` line stands unqualified.
 *
 * ⚠️ `changed` OFFERS NO RESEND, AND THAT IS THE DESIGN. A reading that differs
 * is a human who corrected the chart in Open Dental. Resending would create a
 * second exam and bury their correction under CareIN's stale numbers. "It does
 * not match, so send it again" is precisely the bug this union exists to make
 * unrepresentable.
 *
 * ⚠️ `unknown` SAYS NOTHING, AND THAT IS ALSO THE DESIGN. A failed read is not
 * evidence the exam is gone — the same doctrine as `NOTE_PRECHECK_UNAVAILABLE`.
 * When CareIN cannot see, it does not guess in either direction.
 */
export const PerioDriftSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_applicable") }),
  z.object({ status: z.literal("matches"), examNum: z.number().int() }),
  z.object({
    status: z.literal("missing"),
    examNum: z.number().int(),
    /**
     * EVERY exam this patient has on the visit's date, CareIN's or not. The
     * hygienist sees this before she creates a second one for the same visit.
     */
    sameDateExams: z.array(PerioSameDateExamSchema),
  }),
  z.object({
    status: z.literal("changed"),
    examNum: z.number().int(),
    /** What Open Dental holds now, against what CareIN wrote. Never empty here. */
    changes: z.array(PerioSiteChangeSchema),
  }),
  z.object({ status: z.literal("unknown"), examNum: z.number().int() }),
]);
export type PerioDrift = z.infer<typeof PerioDriftSchema>;

/**
 * ITEM 27: WHICH TEETH OPEN DENTAL RECORDS AS MISSING, so a fresh chart opens
 * with them already skipped instead of asking her to skip them by hand.
 *
 * TWO ANSWERS, AND NEITHER OF THEM IS AN ERROR THE SCREEN SHOWS:
 *
 *   `ready`       — `GET /toothinitials?PatNum=` answered. `teeth` is every
 *                   permanent tooth it marked `Missing`, ascending and unique.
 *                   **An EMPTY array is a real answer** — "this patient has no
 *                   missing teeth" — and pre-skips nothing. Measured 2026-10-01:
 *                   a patient with none answers HTTP 200 with `[]`, like
 *                   `/perioexams` and NOT like GroupNotes' 404-with-a-sentence.
 *                   So absence and failure never have to be guessed apart. The
 *                   capture is tests/fixtures/od-toothinitials-measured.json.
 *   `unavailable` — the read did not land. The chart opens exactly as it does
 *                   today, nothing pre-skipped, and the screen says NOTHING —
 *                   the `NOTE_PRECHECK_UNAVAILABLE` doctrine. A failed read is
 *                   not evidence that a patient has all 32 teeth, and it is not
 *                   worth a banner over a convenience.
 *
 * ⚠️ A PRE-SKIP IS A DEFAULT, NEVER A LOCK. An implant gets probed, and every
 * tooth named here can be un-skipped like any other. That is why this carries
 * TEETH rather than a chart: the server states what Open Dental holds, and the
 * client applies it only to a chart that has never been stored, so her readings
 * and her own skips win — including on every later re-open.
 */
export const PerioPreSkipSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    /** Permanent teeth 1–32 marked `Missing`. Empty = none, NOT "unknown". */
    teeth: z.array(z.number().int().min(1).max(PERIO_TOOTH_COUNT)),
  }),
  z.object({ status: z.literal("unavailable") }),
]);
export type PerioPreSkip = z.infer<typeof PerioPreSkipSchema>;

/**
 * POST /api/hyg/visit/:aptNum/perio/resend — send a vanished chart again.
 *
 * The exam number is REPEATED by the client, the same way the undo repeats it:
 * the server refuses unless it is exactly the exam the live send wrote, and
 * refuses again if that exam turns out to still be in Open Dental.
 */
export const PerioResendRequestSchema = z.object({ examNum: z.number().int().positive() }).strict();
export type PerioResendRequest = z.infer<typeof PerioResendRequestSchema>;

/**
 * GET /api/hyg/visit/:aptNum/perio/prior — Open Dental's last exam, and whether
 * the exam CareIN wrote is still the exam Open Dental holds.
 *
 * `drift` rides on THIS response rather than on one of its own because it is
 * answered from the SAME `/perioexams?PatNum=` read the prior panel already
 * makes. A second endpoint would be a second request per open of a chart, for a
 * question the first request has already answered.
 *
 * `preSkip` (item 27) rides it for the neighbouring reason: it DOES cost one
 * more Open Dental request, so it belongs on the one response that is already
 * waiting on Open Dental rather than on a third round trip of its own. It
 * defaults to `unavailable` so a build that answers without it pre-skips
 * nothing, which is exactly what "we did not read it" should do.
 */
export const HygPerioPriorResponseSchema = z.object({
  success: z.literal(true),
  office: OfficeIdSchema,
  aptNum: z.number().int(),
  date: z.string(),
  appointment: HygAppointmentSchema,
  prior: PerioPriorSchema,
  drift: PerioDriftSchema,
  preSkip: PerioPreSkipSchema.default({ status: "unavailable" }),
});
export type HygPerioPriorResponse = z.infer<typeof HygPerioPriorResponseSchema>;
