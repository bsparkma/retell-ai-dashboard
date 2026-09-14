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
  return { depth: null, bleeding: false, suppuration: false, plaque: false, calculus: false };
}

export function emptyPerioTooth(): PerioTooth {
  return {
    skipped: false,
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
    sites: { ...current.sites, [surface]: { ...current.sites[surface], ...patch } },
  };
  return { ...chart, teeth: { ...chart.teeth, [String(tooth)]: next } };
}

/** A new chart with one tooth skipped or un-skipped. Its readings are kept. */
export function withPerioSkipped(chart: PerioChart, tooth: number, skipped: boolean): PerioChart {
  const current = perioTooth(chart, tooth);
  return {
    ...chart,
    teeth: { ...chart.teeth, [String(tooth)]: { skipped, sites: current.sites } },
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
  };
  for (let tooth = 1; tooth <= PERIO_TOOTH_COUNT; tooth += 1) {
    const t = perioTooth(chart, tooth);
    if (t.skipped) {
      counts.teethSkipped.push(tooth);
      continue;
    }
    for (const surface of ALL_SITES) {
      const site = t.sites[surface];
      if (site.depth !== null) {
        counts.sitesCharted += 1;
        if (site.depth >= 5) counts.sitesAtLeast5 += 1;
        if (counts.deepest === null || site.depth > counts.deepest.depth) {
          counts.deepest = { depth: site.depth, tooth, surface };
        }
      }
      for (const flag of PERIO_FLAGS) if (site[flag]) counts[flag] += 1;
    }
  }
  counts.sitesExpected = PERIO_FULL_MOUTH_SITES - PERIO_SITES_PER_TOOTH * counts.teethSkipped.length;
  counts.complete = counts.sitesExpected > 0 && counts.sitesCharted === counts.sitesExpected;
  counts.empty =
    counts.sitesCharted === 0 &&
    counts.teethSkipped.length === 0 &&
    PERIO_FLAGS.every((flag) => counts[flag] === 0);
  return counts;
}

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
  return site.depth === null && PERIO_FLAGS.every((flag) => !site[flag]);
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
    const canonical: PerioTooth = { skipped: stored.skipped, sites: {} as PerioTooth["sites"] };
    for (const surface of ALL_SITES) {
      const s = sites[surface];
      canonical.sites[surface] = {
        depth: s.depth,
        bleeding: s.bleeding,
        suppuration: s.suppuration,
        plaque: s.plaque,
        calculus: s.calculus,
      };
    }
    if (!canonical.skipped && ALL_SITES.every((surface) => siteIsEmpty(canonical.sites[surface]))) {
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

/** GET /api/hyg/visit/:aptNum/perio/prior — Open Dental's last exam. */
export const HygPerioPriorResponseSchema = z.object({
  success: z.literal(true),
  office: OfficeIdSchema,
  aptNum: z.number().int(),
  date: z.string(),
  appointment: HygAppointmentSchema,
  prior: PerioPriorSchema,
});
export type HygPerioPriorResponse = z.infer<typeof HygPerioPriorResponseSchema>;
