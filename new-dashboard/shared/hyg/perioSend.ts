/**
 * The perio SEND plan (H4 item 12) — what a staged chart becomes in Open Dental.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EVERY RULE HERE IS SOMETHING THE PROBE MEASURED, NOT SOMETHING THE DOCS IMPLY
 * ═════════════════════════════════════════════════════════════════════════════
 * `scripts/probe-hyg-perio-arch.js` ran against roland's staging database on a
 * fixture patient (docs/reports/feature-hyg-perio-arch-probe.md, Findings):
 *
 *   1. `POST /perioexams` with the four arch strings lands a whole chart in ONE
 *      request.
 *   2. Each string is a continuous sweep of 16 teeth × 3 sites, patient right to
 *      left, and the site order reverses at the midline. The table below is
 *      COPIED from that run's read-back, and a test re-encodes the chart the
 *      probe read back and requires the exact strings the probe sent.
 *   3. A flag letter follows its depth and flags stack: `8bspc` is depth 8 with
 *      all four.
 *   4. A reading of 10 or more CANNOT be written. `"10 11 19 3"` landed as
 *      1,0,1,1,1,9,3 — every digit took its own site, silently, and every later
 *      site shifted by one.
 *   5. No character holds a place. `x`, `-`, `_` and spaces are ignored, so a
 *      site that was not charted cannot be expressed before one that was.
 *   6. A refused body creates nothing.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SO AN ARCH GOES AS A STRING ONLY WHEN THE STRING CANNOT LIE
 * ═════════════════════════════════════════════════════════════════════════════
 * `perioArchVerdict` sends a string for an arch only when every charted depth on
 * it is 0–9, the charted sites run unbroken from the arch's first position, and
 * no flag sits on a site with no depth (a flag letter needs a digit to follow).
 * Anything else goes row by row. A trailing run of uncharted sites is fine: the
 * string simply stops. An arch with nothing on it sends no string at all — not
 * an empty one.
 *
 * A SITE THAT WAS NOT CHARTED IS NEVER WRITTEN AS 0. Zero is a reading. No
 * padding, no truncating, no "fixing" a reading to fit.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE JAW RULE — ONE TIGHTENING BEYOND THE BRIEF, ON PURPOSE
 * ═════════════════════════════════════════════════════════════════════════════
 * Open Dental holds ONE Probing row per tooth, carrying both the facial and the
 * lingual sites. If the upper facial went as a string and the upper lingual row
 * by row, every upper tooth's lingual readings would have to be PUT onto the row
 * the string created — a verb the probe never exercised, onto a row that can
 * never be deleted, merging two sources for one tooth. So when either arch of a
 * jaw goes row by row, BOTH do (`partner`). It costs no extra requests — a PUT
 * per tooth and a POST per tooth are the same count — and it means no tooth is
 * ever written by two paths.
 *
 * Pure and shared: the confirm dialog's description and the server's send are
 * one computation, and the server only ever plans from the STAGED chart.
 */
import { z } from "zod";

import { OfficeIdSchema, StagedWriteSchema, ToothSurfaceSchema, type ToothSurface } from "./contract";
import {
  PERIO_FLAGS,
  PERIO_FLAG_LABELS,
  PERIO_TOOTH_COUNT,
  bleedSupPlaqCalcBits,
  normalizePerioChart,
  perioSite,
  perioTooth,
  type PerioChart,
  type PerioCursor,
  type PerioFlag,
  type PerioSite,
} from "./perio";

// ─────────────────────────────────────────────────────────────────────────────
// The four strings and the sites they fill
// ─────────────────────────────────────────────────────────────────────────────

/** Open Dental's body keys, in the order the probe sent them. */
export const PERIO_ARCH_STRING_FIELDS = ["UpperFacial", "UpperLingual", "LowerLingual", "LowerFacial"] as const;
export type PerioArchStringField = (typeof PERIO_ARCH_STRING_FIELDS)[number];
export const PerioArchStringFieldSchema = z.enum(PERIO_ARCH_STRING_FIELDS);

export const PERIO_ARCH_STRING_LABELS: Record<PerioArchStringField, string> = {
  UpperFacial: "Upper facial",
  UpperLingual: "Upper lingual",
  LowerLingual: "Lower lingual",
  LowerFacial: "Lower facial",
};

export type PerioJaw = "upper" | "lower";

export function perioJawOfField(field: PerioArchStringField): PerioJaw {
  return field.startsWith("Upper") ? "upper" : "lower";
}

export function perioJawOfTooth(tooth: number): PerioJaw {
  return tooth <= 16 ? "upper" : "lower";
}

/** Positions in one string. 16 teeth × 3 sites. */
export const PERIO_ARCH_STRING_SITES_PER_ARCH = 48;

/** The deepest reading a string can carry: one digit per site (probe finding 4). */
export const PERIO_STRING_MAX_DEPTH = 9;

/**
 * POSITION → (tooth, site), for each string, COPIED FROM THE PROBE'S READ-BACK.
 *
 * ⚠️ DO NOT RE-DERIVE THIS. ⚠️ It is the table `probe-hyg-perio-arch.js` printed
 * for exam 2249 (48/48 on every arch, verdict UNIQUE), row for row. A wrong
 * table writes plausible numbers onto the wrong teeth, and nothing downstream
 * could tell. `tests/hyg-perio-send-plan.test.ts` holds it to
 * `tests/fixtures/perio-arch-probe-staging.json`, which is that run's output.
 *
 * Read one line as one tooth. Teeth 1–8 and 32–25 run distal first; teeth 9–16
 * and 24–17 run mesial first — one sweep around the arch, which flips at the
 * midline.
 */
const PROBED_SITES: Record<PerioArchStringField, ReadonlyArray<readonly [number, ToothSurface]>> = {
  UpperFacial: [
    [1, "DB"], [1, "B"], [1, "MB"],
    [2, "DB"], [2, "B"], [2, "MB"],
    [3, "DB"], [3, "B"], [3, "MB"],
    [4, "DB"], [4, "B"], [4, "MB"],
    [5, "DB"], [5, "B"], [5, "MB"],
    [6, "DB"], [6, "B"], [6, "MB"],
    [7, "DB"], [7, "B"], [7, "MB"],
    [8, "DB"], [8, "B"], [8, "MB"],
    [9, "MB"], [9, "B"], [9, "DB"],
    [10, "MB"], [10, "B"], [10, "DB"],
    [11, "MB"], [11, "B"], [11, "DB"],
    [12, "MB"], [12, "B"], [12, "DB"],
    [13, "MB"], [13, "B"], [13, "DB"],
    [14, "MB"], [14, "B"], [14, "DB"],
    [15, "MB"], [15, "B"], [15, "DB"],
    [16, "MB"], [16, "B"], [16, "DB"],
  ],
  UpperLingual: [
    [1, "DL"], [1, "L"], [1, "ML"],
    [2, "DL"], [2, "L"], [2, "ML"],
    [3, "DL"], [3, "L"], [3, "ML"],
    [4, "DL"], [4, "L"], [4, "ML"],
    [5, "DL"], [5, "L"], [5, "ML"],
    [6, "DL"], [6, "L"], [6, "ML"],
    [7, "DL"], [7, "L"], [7, "ML"],
    [8, "DL"], [8, "L"], [8, "ML"],
    [9, "ML"], [9, "L"], [9, "DL"],
    [10, "ML"], [10, "L"], [10, "DL"],
    [11, "ML"], [11, "L"], [11, "DL"],
    [12, "ML"], [12, "L"], [12, "DL"],
    [13, "ML"], [13, "L"], [13, "DL"],
    [14, "ML"], [14, "L"], [14, "DL"],
    [15, "ML"], [15, "L"], [15, "DL"],
    [16, "ML"], [16, "L"], [16, "DL"],
  ],
  LowerLingual: [
    [32, "DL"], [32, "L"], [32, "ML"],
    [31, "DL"], [31, "L"], [31, "ML"],
    [30, "DL"], [30, "L"], [30, "ML"],
    [29, "DL"], [29, "L"], [29, "ML"],
    [28, "DL"], [28, "L"], [28, "ML"],
    [27, "DL"], [27, "L"], [27, "ML"],
    [26, "DL"], [26, "L"], [26, "ML"],
    [25, "DL"], [25, "L"], [25, "ML"],
    [24, "ML"], [24, "L"], [24, "DL"],
    [23, "ML"], [23, "L"], [23, "DL"],
    [22, "ML"], [22, "L"], [22, "DL"],
    [21, "ML"], [21, "L"], [21, "DL"],
    [20, "ML"], [20, "L"], [20, "DL"],
    [19, "ML"], [19, "L"], [19, "DL"],
    [18, "ML"], [18, "L"], [18, "DL"],
    [17, "ML"], [17, "L"], [17, "DL"],
  ],
  LowerFacial: [
    [32, "DB"], [32, "B"], [32, "MB"],
    [31, "DB"], [31, "B"], [31, "MB"],
    [30, "DB"], [30, "B"], [30, "MB"],
    [29, "DB"], [29, "B"], [29, "MB"],
    [28, "DB"], [28, "B"], [28, "MB"],
    [27, "DB"], [27, "B"], [27, "MB"],
    [26, "DB"], [26, "B"], [26, "MB"],
    [25, "DB"], [25, "B"], [25, "MB"],
    [24, "MB"], [24, "B"], [24, "DB"],
    [23, "MB"], [23, "B"], [23, "DB"],
    [22, "MB"], [22, "B"], [22, "DB"],
    [21, "MB"], [21, "B"], [21, "DB"],
    [20, "MB"], [20, "B"], [20, "DB"],
    [19, "MB"], [19, "B"], [19, "DB"],
    [18, "MB"], [18, "B"], [18, "DB"],
    [17, "MB"], [17, "B"], [17, "DB"],
  ],
};

export const PERIO_ARCH_STRING_SITES: Readonly<Record<PerioArchStringField, readonly PerioCursor[]>> =
  Object.freeze({
    UpperFacial: PROBED_SITES.UpperFacial.map(([tooth, surface]) => ({ tooth, surface })),
    UpperLingual: PROBED_SITES.UpperLingual.map(([tooth, surface]) => ({ tooth, surface })),
    LowerLingual: PROBED_SITES.LowerLingual.map(([tooth, surface]) => ({ tooth, surface })),
    LowerFacial: PROBED_SITES.LowerFacial.map(([tooth, surface]) => ({ tooth, surface })),
  });

/** The letter each flag is written as, in the order the probe stacked them (`8bspc`). */
export const PERIO_FLAG_LETTERS: ReadonlyArray<readonly [PerioFlag, string]> = [
  ["bleeding", "b"],
  ["suppuration", "s"],
  ["plaque", "p"],
  ["calculus", "c"],
];

/**
 * A string this build would send: one digit per site, each followed by at most
 * one of each flag letter in `bspc` order, and never more digits than the arch
 * has sites. Nothing else — no space, no separator, no second digit.
 *
 * The writer refuses anything that fails this BEFORE the transport, so a string
 * assembled anywhere else cannot reach Open Dental however it was built.
 */
export function isWellFormedArchString(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:[0-9]b?s?p?c?)+$/.test(value)) return false;
  return value.replace(/[bspc]/g, "").length <= PERIO_ARCH_STRING_SITES_PER_ARCH;
}

// ─────────────────────────────────────────────────────────────────────────────
// The predicate
// ─────────────────────────────────────────────────────────────────────────────

export type PerioArchReason = "deep" | "gap" | "flag_without_depth" | "partner";

export type PerioArchVerdict =
  | { field: PerioArchStringField; status: "string"; string: string; sites: number }
  | { field: PerioArchStringField; status: "empty" }
  | {
      field: PerioArchStringField;
      status: "per_row";
      reason: Exclude<PerioArchReason, "partner">;
      /** deep: every site ≥10. gap / flag_without_depth: the first site that breaks the run. */
      at: PerioCursor[];
    };

function isCharted(chart: PerioChart, c: PerioCursor): boolean {
  return !perioTooth(chart, c.tooth).skipped && perioSite(chart, c.tooth, c.surface).depth !== null;
}

function hasFlag(site: PerioSite): boolean {
  return PERIO_FLAGS.some((flag) => site[flag]);
}

/**
 * Can this arch go into `POST /perioexams` as a string without lying? See the
 * header. Pure; the chart is normalised first.
 */
export function perioArchVerdict(chart: PerioChart, field: PerioArchStringField): PerioArchVerdict {
  const normalized = normalizePerioChart(chart);
  const sites = PERIO_ARCH_STRING_SITES[field];

  // A two-digit reading ANYWHERE on the arch. Finding 4: it cannot appear in a
  // string at all, so where it sits does not matter.
  const deep = sites.filter((c) => {
    const depth = perioSite(normalized, c.tooth, c.surface).depth;
    return isCharted(normalized, c) && depth !== null && depth > PERIO_STRING_MAX_DEPTH;
  });
  if (deep.length > 0) return { field, status: "per_row", reason: "deep", at: deep };

  // A flag with no depth before it has no digit to follow.
  const orphan = sites.find((c) => {
    if (perioTooth(normalized, c.tooth).skipped) return false;
    const site = perioSite(normalized, c.tooth, c.surface);
    return site.depth === null && hasFlag(site);
  });
  if (orphan) return { field, status: "per_row", reason: "flag_without_depth", at: [orphan] };

  let last = -1;
  sites.forEach((c, i) => {
    if (isCharted(normalized, c)) last = i;
  });
  if (last === -1) return { field, status: "empty" };

  // Finding 5: nothing holds a place, so an uncharted site BEFORE the last
  // charted one would hand its position to the next reading.
  const gap = sites.slice(0, last).find((c) => !isCharted(normalized, c));
  if (gap) return { field, status: "per_row", reason: "gap", at: [gap] };

  let out = "";
  for (const c of sites.slice(0, last + 1)) {
    const site = perioSite(normalized, c.tooth, c.surface);
    out += String(site.depth);
    for (const [flag, letter] of PERIO_FLAG_LETTERS) if (site[flag]) out += letter;
  }
  return { field, status: "string", string: out, sites: last + 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// The plan
// ─────────────────────────────────────────────────────────────────────────────

/** The only SequenceTypes a perio send writes row by row. NEVER CAL — Open Dental derives it. */
export const PerioSendSequenceTypeSchema = z.enum(["Probing", "BleedSupPlaqCalc", "SkipTooth"]);
export type PerioSendSequenceType = z.infer<typeof PerioSendSequenceTypeSchema>;

/** One `POST /periomeasures` body, minus the PerioExamNum it learns once the exam exists. */
export interface PerioMeasureBody {
  ToothValue: number;
  MBvalue: number;
  Bvalue: number;
  DBvalue: number;
  MLvalue: number;
  Lvalue: number;
  DLvalue: number;
}

export interface PerioMeasurePlan {
  tooth: number;
  sequenceType: PerioSendSequenceType;
  body: PerioMeasureBody;
}

export const PerioCursorSchema = z.object({ tooth: z.number().int(), surface: ToothSurfaceSchema });

export const PerioArchPathSchema = z.enum(["string", "per_row", "empty"]);
export type PerioArchPath = z.infer<typeof PerioArchPathSchema>;

export const PerioArchPlanSchema = z.object({
  field: PerioArchStringFieldSchema,
  label: z.string(),
  path: PerioArchPathSchema,
  reason: z.enum(["deep", "gap", "flag_without_depth", "partner"]).nullable(),
  at: z.array(PerioCursorSchema),
  /** Charted sites on this arch. */
  sites: z.number().int(),
  /** One sentence for the confirm dialog. */
  detail: z.string(),
});
export type PerioArchPlan = z.infer<typeof PerioArchPlanSchema>;

export interface PerioSendPlan {
  /** Exactly the strings `POST /perioexams` carries. An arch absent here sends none. */
  strings: Partial<Record<PerioArchStringField, string>>;
  arches: PerioArchPlan[];
  /** Every `POST /periomeasures` after the exam, in tooth order. */
  rows: PerioMeasurePlan[];
  /** Every charted site of 10 mm or more, anywhere. */
  deepSites: PerioCursor[];
}

function siteName(c: PerioCursor): string {
  return `#${c.tooth} ${c.surface}`;
}

function listSites(sites: PerioCursor[]): string {
  const shown = sites.slice(0, 3).map(siteName).join(", ");
  return sites.length > 3 ? `${shown} and ${sites.length - 3} more` : shown;
}

function archDetail(plan: Omit<PerioArchPlan, "detail" | "label">, chart: PerioChart): string {
  if (plan.path === "empty") return "Nothing charted on this arch, so nothing is sent for it.";
  if (plan.path === "string") return `One request with the exam: ${plan.sites} sites.`;
  const first = plan.at[0];
  switch (plan.reason) {
    case "deep":
      return (
        `Row by row: ${listSites(plan.at)} ${plan.at.length === 1 ? "reads" : "read"} 10 mm or more, ` +
        "which a string cannot carry."
      );
    case "gap":
      return first && perioTooth(chart, first.tooth).skipped
        ? `Row by row: #${first.tooth} is skipped but a later tooth on this arch is charted.`
        : `Row by row: ${first ? siteName(first) : "a site"} is not charted but a later site is.`;
    case "flag_without_depth":
      return `Row by row: ${first ? siteName(first) : "a site"} has a flag but no depth.`;
    case "partner":
      return "Row by row with the other side of this jaw, so no tooth is written two ways.";
    default:
      return "Row by row.";
  }
}

const ALL_SURFACES: ToothSurface[] = ["DB", "B", "MB", "DL", "L", "ML"];

function chartedSitesOn(chart: PerioChart, field: PerioArchStringField): number {
  return PERIO_ARCH_STRING_SITES[field].filter((c) => isCharted(chart, c)).length;
}

/**
 * What a staged chart becomes: the strings, the rows, and why each arch took
 * the path it did. Pure. The server builds the send from THIS, from the staged
 * chart, and never from anything a client sends.
 *
 *   skipped tooth (any jaw)          → one SkipTooth row (ToothValue 1, sites -1)
 *   tooth in a row-by-row jaw:
 *     any depth                      → one Probing row, -1 where not charted
 *     any flag                       → one BleedSupPlaqCalc row
 *   tooth in a string jaw            → nothing here; the string carried it
 */
export function planPerioSend(chart: PerioChart): PerioSendPlan {
  const normalized = normalizePerioChart(chart);
  const verdicts = PERIO_ARCH_STRING_FIELDS.map((field) => perioArchVerdict(normalized, field));

  const perRowJaws = new Set<PerioJaw>();
  for (const v of verdicts) if (v.status === "per_row") perRowJaws.add(perioJawOfField(v.field));

  const strings: Partial<Record<PerioArchStringField, string>> = {};
  const arches: PerioArchPlan[] = verdicts.map((v) => {
    const base = { field: v.field, sites: chartedSitesOn(normalized, v.field) };
    let partial: Omit<PerioArchPlan, "detail" | "label">;
    if (v.status === "per_row") {
      partial = { ...base, path: "per_row", reason: v.reason, at: v.at };
    } else if (v.status === "empty") {
      partial = { ...base, path: "empty", reason: null, at: [] };
    } else if (perRowJaws.has(perioJawOfField(v.field))) {
      partial = { ...base, path: "per_row", reason: "partner", at: [] };
    } else {
      strings[v.field] = v.string;
      partial = { ...base, path: "string", reason: null, at: [] };
    }
    return { ...partial, label: PERIO_ARCH_STRING_LABELS[v.field], detail: archDetail(partial, normalized) };
  });

  const rows: PerioMeasurePlan[] = [];
  const deepSites: PerioCursor[] = [];
  for (let tooth = 1; tooth <= PERIO_TOOTH_COUNT; tooth += 1) {
    const t = normalized.teeth[String(tooth)];
    if (!t) continue;
    if (t.skipped) {
      rows.push({
        tooth,
        sequenceType: "SkipTooth",
        body: { ToothValue: 1, MBvalue: -1, Bvalue: -1, DBvalue: -1, MLvalue: -1, Lvalue: -1, DLvalue: -1 },
      });
      continue;
    }
    for (const surface of ALL_SURFACES) {
      const depth = t.sites[surface].depth;
      if (depth !== null && depth > PERIO_STRING_MAX_DEPTH) deepSites.push({ tooth, surface });
    }
    if (!perRowJaws.has(perioJawOfTooth(tooth))) continue;

    // -1 is Open Dental's "no measurement". An uncharted site is -1, NEVER 0.
    const depth = (s: ToothSurface) => t.sites[s].depth ?? -1;
    if (ALL_SURFACES.some((s) => t.sites[s].depth !== null)) {
      rows.push({
        tooth,
        sequenceType: "Probing",
        body: {
          ToothValue: -1,
          MBvalue: depth("MB"),
          Bvalue: depth("B"),
          DBvalue: depth("DB"),
          MLvalue: depth("ML"),
          Lvalue: depth("L"),
          DLvalue: depth("DL"),
        },
      });
    }
    // A flag value for a site: its bits when flagged, 0 ("examined, no flags")
    // when it has a depth, and -1 when nobody recorded anything there.
    const bits = (s: ToothSurface) => {
      const b = bleedSupPlaqCalcBits(t.sites[s]);
      return b > 0 ? b : t.sites[s].depth !== null ? 0 : -1;
    };
    if (ALL_SURFACES.some((s) => hasFlag(t.sites[s]))) {
      rows.push({
        tooth,
        sequenceType: "BleedSupPlaqCalc",
        body: {
          ToothValue: -1,
          MBvalue: bits("MB"),
          Bvalue: bits("B"),
          DBvalue: bits("DB"),
          MLvalue: bits("ML"),
          Lvalue: bits("L"),
          DLvalue: bits("DL"),
        },
      });
    }
  }

  return { strings, arches, rows, deepSites };
}

/** Rows posted per step before the next read. ~15s of wall clock at one request a second. */
export const PERIO_SEND_BATCH = 12;

/** Open Dental serves about one request a second per credential. */
export const OD_SECONDS_PER_REQUEST = 1;

/**
 * Requests still to go — an estimate, and the screen says "about".
 *
 * The exam: the patient's exams before, the POST, the exams after. Each batch
 * of rows: one read, then its POSTs. Then one read to verify every site.
 */
export function estimatePerioSendRequests({
  examCreated,
  rowsRemaining,
}: {
  examCreated: boolean;
  rowsRemaining: number;
}): number {
  const rows = Math.max(0, rowsRemaining);
  return (examCreated ? 0 : 3) + rows + Math.ceil(rows / PERIO_SEND_BATCH) + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// The read-back
// ─────────────────────────────────────────────────────────────────────────────

export const PerioMismatchKindSchema = z.enum(["depth", "flags", "skipped", "duplicate"]);

export const PerioMismatchSchema = z.object({
  tooth: z.number().int(),
  /** null for a whole-tooth difference (skipped, or a duplicate row). */
  surface: ToothSurfaceSchema.nullable(),
  kind: PerioMismatchKindSchema,
  /** What the staged chart says, in words. */
  expected: z.string(),
  /** What Open Dental holds, in words. */
  found: z.string(),
});
export type PerioMismatch = z.infer<typeof PerioMismatchSchema>;

function depthWords(depth: number | null): string {
  return depth === null ? "not charted" : `${depth} mm`;
}

function flagWords(site: PerioSite): string {
  const on = PERIO_FLAGS.filter((flag) => site[flag]).map((flag) => PERIO_FLAG_LABELS[flag].toLowerCase());
  return on.length === 0 ? "no flags" : on.join(", ");
}

/**
 * EVERY site of the staged chart against what Open Dental holds for the exam.
 *
 * Both sides are charts: the server turns Open Dental's rows into one with
 * `odPerio.chartFromMeasures`, where `-1` is `null` and never zero. A site the
 * chart left uncharted must read back uncharted — a number there is the shifted
 * string finding 4 describes, and it is a mismatch, not noise. A skipped tooth
 * must come back skipped and carry no readings.
 */
export function comparePerioReadback(expected: PerioChart, found: PerioChart): PerioMismatch[] {
  const want = normalizePerioChart(expected);
  const have = normalizePerioChart(found);
  const out: PerioMismatch[] = [];
  for (let tooth = 1; tooth <= PERIO_TOOTH_COUNT; tooth += 1) {
    const e = perioTooth(want, tooth);
    const f = perioTooth(have, tooth);
    if (e.skipped !== f.skipped) {
      out.push({
        tooth,
        surface: null,
        kind: "skipped",
        expected: e.skipped ? "skipped" : "not skipped",
        found: f.skipped ? "skipped" : "not skipped",
      });
    }
    for (const surface of ALL_SURFACES) {
      // A skipped tooth's readings are KEPT on the chart (one key undoes a
      // skip) but never sent, so what must read back there is nothing.
      const wantSite = e.skipped
        ? { depth: null, bleeding: false, suppuration: false, plaque: false, calculus: false }
        : e.sites[surface];
      const haveSite = f.sites[surface];
      if (wantSite.depth !== haveSite.depth) {
        out.push({
          tooth,
          surface,
          kind: "depth",
          expected: depthWords(wantSite.depth),
          found: depthWords(haveSite.depth),
        });
      }
      if (flagWords(wantSite) !== flagWords(haveSite)) {
        out.push({ tooth, surface, kind: "flags", expected: flagWords(wantSite), found: flagWords(haveSite) });
      }
    }
  }
  return out;
}

/** "#3 DB: the chart says 4 mm, Open Dental holds 1 mm" */
export function perioMismatchLine(m: PerioMismatch): string {
  const where = m.surface === null ? `#${m.tooth}` : `#${m.tooth} ${m.surface}`;
  if (m.kind === "duplicate") return `${where}: ${m.found} in Open Dental where there should be ${m.expected}`;
  return `${where}: the chart says ${m.expected}, Open Dental holds ${m.found}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The wire
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/hyg/visit/:aptNum/perio/send — the confirmation.
 *
 * NO PAYLOAD. The fingerprint of the preview she read, and the two facts the
 * dialog showed that the preview does not carry. The server re-derives all
 * three and refuses on any difference.
 */
export const PerioSendRequestSchema = z
  .object({
    previewFingerprint: z.string().min(1).max(200),
    examDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    provNum: z.number().int().positive(),
  })
  .strict();
export type PerioSendRequest = z.infer<typeof PerioSendRequestSchema>;

/**
 * POST /api/hyg/visit/:aptNum/perio/send/delete-exam — the undo.
 *
 * The exam number is REPEATED by the client as an explicit confirmation of
 * which exam is about to be destroyed; the server refuses unless it is exactly
 * the exam this send created.
 */
export const PerioDeleteExamRequestSchema = z
  .object({ examNum: z.number().int().positive() })
  .strict();
export type PerioDeleteExamRequest = z.infer<typeof PerioDeleteExamRequestSchema>;

/**
 *   posting     the exam POST has not been confirmed yet. Nothing is known to exist.
 *   filling     the exam exists; rows are being written or the chart verified.
 *   written     every site read back and matched. The staged write is Written.
 *   incomplete  the exam exists and does NOT match the chart. Loud, and undoable.
 *   refused     Open Dental refused the exam. Nothing was created.
 *   deleted     the exam this send created was deleted by the undo.
 */
export const PERIO_SEND_STATES = ["posting", "filling", "written", "incomplete", "refused", "deleted"] as const;
export const PerioSendStateSchema = z.enum(PERIO_SEND_STATES);
export type PerioSendState = z.infer<typeof PerioSendStateSchema>;

export const PerioSendViewSchema = z.object({
  sendId: z.string(),
  state: PerioSendStateSchema,
  examNum: z.number().int().nullable(),
  examDate: z.string(),
  provNum: z.number().int(),
  arches: z.array(PerioArchPlanSchema),
  rowsPlanned: z.number().int(),
  rowsWritten: z.number().int(),
  deepSites: z.number().int(),
  mismatches: z.array(PerioMismatchSchema),
  errorMessage: z.string().nullable(),
  requestsRemaining: z.number().int(),
  startedBy: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  deletedBy: z.string().nullable(),
  deletedAt: z.string().nullable(),
  /** An exam this send created, while the send is unfinished. The only exam the undo may touch. */
  canDelete: z.boolean(),
});
export type PerioSendView = z.infer<typeof PerioSendViewSchema>;

/** Every perio-send route answers with this. `send` is null before one starts. */
export const HygPerioSendResponseSchema = z.object({
  success: z.literal(true),
  office: OfficeIdSchema,
  aptNum: z.number().int(),
  stagedWrite: StagedWriteSchema.nullable(),
  send: PerioSendViewSchema.nullable(),
  /**
   * Why this step stopped short without finishing — Open Dental did not answer,
   * or another tab is mid-step. Nothing was lost; the next step reads first.
   */
  paused: z.string().nullable(),
});
export type HygPerioSendResponse = z.infer<typeof HygPerioSendResponseSchema>;
