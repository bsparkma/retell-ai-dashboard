/**
 * THE PERIO SEND PLAN (item 12) — pure, and pinned to what the probe measured.
 *
 *   1. The position table IS the probe's table: `fixtures/perio-arch-probe-staging.json`
 *      is the read-back of exam 2249 on roland staging, and the chart that run read
 *      back must re-encode to exactly the strings it sent.
 *   2. The expressibility predicate, hard: a 10 anywhere, a gap at position 1, a gap
 *      in the middle, a trailing gap (expressible), an empty arch (no string, not an
 *      empty string), a flag with no depth, a skipped tooth.
 *   3. The jaw rule: one row-by-row arch takes its partner with it.
 *   4. No site that was not charted is ever written as 0.
 *   5. The read-back comparison names every site that differs.
 *
 * NO NETWORK, NO BACKEND, NO PHI.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { type ToothSurface } from "@shared/hyg/contract";
import {
  emptyPerioChart,
  flagsFromBits,
  withPerioSite,
  withPerioSkipped,
  type PerioChart,
} from "@shared/hyg/perio";
import {
  PERIO_ARCH_STRING_FIELDS,
  PERIO_ARCH_STRING_SITES,
  comparePerioReadback,
  isWellFormedArchString,
  perioArchVerdict,
  perioMismatchLine,
  planPerioSend,
  type PerioArchStringField,
} from "@shared/hyg/perioSend";

interface ProbeRow {
  pos: number;
  written: number;
  tooth: number;
  surface: ToothSurface;
  readBack: number | null;
}

interface ProbeFixture {
  verdict: Record<PerioArchStringField, { verdict: string; fit: string; matched: number }>;
  regions: Record<PerioArchStringField, ProbeRow[]>;
  flags: {
    sent: { UpperFacial: string };
    readBack: Record<string, { Probing: Partial<Record<ToothSurface, number>>; BleedSupPlaqCalc: Partial<Record<ToothSurface, number>> }>;
  };
  deep: { sent: { UpperFacial: string } };
  skip: { sent: { UpperFacial: string } };
}

const probe = JSON.parse(
  readFileSync(resolve(process.cwd(), "tests/fixtures/perio-arch-probe-staging.json"), "utf8"),
) as ProbeFixture;

/** Every site of one arch charted at `depth`, in the probe's order. */
function fullArch(chart: PerioChart, field: PerioArchStringField, depth: (i: number) => number): PerioChart {
  let next = chart;
  PERIO_ARCH_STRING_SITES[field].forEach((c, i) => {
    next = withPerioSite(next, c.tooth, c.surface, { depth: depth(i) });
  });
  return next;
}

function fullMouth(depth: (i: number) => number = (i) => (i * 7) % 10): PerioChart {
  let chart = emptyPerioChart();
  for (const field of PERIO_ARCH_STRING_FIELDS) chart = fullArch(chart, field, depth);
  return chart;
}

const site = (field: PerioArchStringField, i: number) => PERIO_ARCH_STRING_SITES[field][i];

describe("the position table is the probe's table", () => {
  it("has every arch UNIQUE at 48/48 in the fixture, and matches it position for position", () => {
    for (const field of PERIO_ARCH_STRING_FIELDS) {
      expect(probe.verdict[field]).toMatchObject({ verdict: "UNIQUE", matched: 48 });
      expect(PERIO_ARCH_STRING_SITES[field]).toHaveLength(48);
      expect(PERIO_ARCH_STRING_SITES[field]).toEqual(
        probe.regions[field].map((r) => ({ tooth: r.tooth, surface: r.surface })),
      );
    }
  });

  it("re-encodes the chart the probe READ BACK into exactly the four strings the probe SENT", () => {
    let chart = emptyPerioChart();
    for (const field of PERIO_ARCH_STRING_FIELDS) {
      for (const row of probe.regions[field]) {
        expect(row.readBack).toBe(row.written); // the fixture is a 48/48 run
        chart = withPerioSite(chart, row.tooth, row.surface, { depth: row.readBack });
      }
    }
    const plan = planPerioSend(chart);
    const sent = Object.fromEntries(
      PERIO_ARCH_STRING_FIELDS.map((f) => [f, probe.regions[f].map((r) => r.written).join("")]),
    );
    expect(plan.strings).toEqual(sent);
    expect(plan.rows).toEqual([]);
    expect(plan.arches.map((a) => a.path)).toEqual(["string", "string", "string", "string"]);
  });

  it("states the sweep in the probe's words: upper 1→16, lower 32→17, site order flipping at the midline", () => {
    const uf = PERIO_ARCH_STRING_SITES.UpperFacial;
    expect([uf[0], uf[47]]).toEqual([{ tooth: 1, surface: "DB" }, { tooth: 16, surface: "DB" }]);
    expect(uf.slice(21, 27).map((c) => `${c.tooth}${c.surface}`)).toEqual(["8DB", "8B", "8MB", "9MB", "9B", "9DB"]);
    const ll = PERIO_ARCH_STRING_SITES.LowerLingual;
    expect([ll[0], ll[47]]).toEqual([{ tooth: 32, surface: "DL" }, { tooth: 17, surface: "DL" }]);
    expect(ll.slice(21, 27).map((c) => `${c.tooth}${c.surface}`)).toEqual(["25DL", "25L", "25ML", "24ML", "24L", "24DL"]);
  });

  it("re-encodes the flags experiment's read-back into its exact string, flags riding their depth", () => {
    let chart = emptyPerioChart();
    for (const [tooth, rows] of Object.entries(probe.flags.readBack)) {
      for (const [surface, depth] of Object.entries(rows.Probing) as [ToothSurface, number][]) {
        const flags = flagsFromBits(rows.BleedSupPlaqCalc[surface]);
        expect(flags).not.toBeNull();
        chart = withPerioSite(chart, Number(tooth), surface, { depth, ...flags });
      }
    }
    expect(perioArchVerdict(chart, "UpperFacial")).toEqual({
      field: "UpperFacial",
      status: "string",
      string: probe.flags.sent.UpperFacial,
      sites: 7,
    });
  });

  it("would never build either string the probe showed to corrupt a chart", () => {
    expect(isWellFormedArchString(probe.deep.sent.UpperFacial)).toBe(false); // "10 11 19 3"
    expect(isWellFormedArchString(probe.skip.sent.UpperFacial)).toBe(false); // "3x3-3_3 3X3"
    expect(isWellFormedArchString(probe.flags.sent.UpperFacial)).toBe(true);
    expect(isWellFormedArchString("")).toBe(false);
    expect(isWellFormedArchString("b3")).toBe(false);
    expect(isWellFormedArchString("3bb")).toBe(false);
    expect(isWellFormedArchString("3sb")).toBe(false);
    expect(isWellFormedArchString("4".repeat(48))).toBe(true);
    expect(isWellFormedArchString("4".repeat(49))).toBe(false);
    expect(isWellFormedArchString("4bspc".repeat(48))).toBe(true);
  });
});

describe("the expressibility predicate", () => {
  it("a full arch of 0–9 is ONE string of 48 digits, and 0 is written as the reading it is", () => {
    const chart = fullArch(emptyPerioChart(), "UpperFacial", (i) => i % 10);
    const v = perioArchVerdict(chart, "UpperFacial");
    expect(v).toMatchObject({ status: "string", sites: 48 });
    expect(v.status === "string" && v.string).toBe(Array.from({ length: 48 }, (_, i) => i % 10).join(""));
  });

  it.each([0, 29, 47])("a 10 at position %i puts the whole arch row by row, naming the site", (pos) => {
    let chart = fullArch(emptyPerioChart(), "LowerFacial", () => 3);
    const c = site("LowerFacial", pos);
    chart = withPerioSite(chart, c.tooth, c.surface, { depth: 10 });
    expect(perioArchVerdict(chart, "LowerFacial")).toEqual({
      field: "LowerFacial",
      status: "per_row",
      reason: "deep",
      at: [c],
    });
  });

  it("names EVERY deep site, and 9 is still a string", () => {
    let chart = fullArch(emptyPerioChart(), "UpperLingual", () => 9);
    expect(perioArchVerdict(chart, "UpperLingual").status).toBe("string");
    const a = site("UpperLingual", 4);
    const b = site("UpperLingual", 40);
    chart = withPerioSite(withPerioSite(chart, a.tooth, a.surface, { depth: 12 }), b.tooth, b.surface, { depth: 19 });
    const v = perioArchVerdict(chart, "UpperLingual");
    expect(v).toMatchObject({ status: "per_row", reason: "deep" });
    expect(v.status === "per_row" && v.at).toEqual([a, b]);
  });

  it("a gap at position 1 is not expressible", () => {
    let chart = fullArch(emptyPerioChart(), "UpperFacial", () => 2);
    const first = site("UpperFacial", 0);
    chart = withPerioSite(chart, first.tooth, first.surface, { depth: null });
    expect(perioArchVerdict(chart, "UpperFacial")).toEqual({
      field: "UpperFacial",
      status: "per_row",
      reason: "gap",
      at: [first],
    });
  });

  it("a gap in the middle is not expressible, and names the first missing site", () => {
    let chart = fullArch(emptyPerioChart(), "LowerLingual", () => 4);
    const hole = site("LowerLingual", 20);
    chart = withPerioSite(chart, hole.tooth, hole.surface, { depth: null });
    expect(perioArchVerdict(chart, "LowerLingual")).toMatchObject({ status: "per_row", reason: "gap", at: [hole] });
  });

  it("a trailing gap IS expressible — the string simply stops", () => {
    const chart = fullArch(emptyPerioChart(), "UpperFacial", () => 3);
    let partial = chart;
    for (const c of PERIO_ARCH_STRING_SITES.UpperFacial.slice(19)) {
      partial = withPerioSite(partial, c.tooth, c.surface, { depth: null });
    }
    expect(perioArchVerdict(partial, "UpperFacial")).toEqual({
      field: "UpperFacial",
      status: "string",
      string: "3".repeat(19),
      sites: 19,
    });
  });

  it("an empty arch sends NO string — not an empty string", () => {
    const chart = fullArch(emptyPerioChart(), "UpperFacial", () => 3);
    expect(perioArchVerdict(chart, "UpperLingual")).toEqual({ field: "UpperLingual", status: "empty" });
    const plan = planPerioSend(chart);
    expect(Object.keys(plan.strings)).toEqual(["UpperFacial"]);
    expect("UpperLingual" in plan.strings).toBe(false);
    expect(planPerioSend(emptyPerioChart()).strings).toEqual({});
  });

  it("a flag on a site with no depth has no digit to follow, so the arch goes row by row", () => {
    let chart = fullArch(emptyPerioChart(), "UpperFacial", () => 3);
    const last = site("UpperFacial", 47);
    chart = withPerioSite(chart, last.tooth, last.surface, { depth: null, bleeding: true });
    expect(perioArchVerdict(chart, "UpperFacial")).toMatchObject({
      status: "per_row",
      reason: "flag_without_depth",
      at: [last],
    });
  });

  it("a skipped tooth before a charted one is a gap; a skipped LAST tooth is not", () => {
    const chart = fullArch(emptyPerioChart(), "UpperFacial", () => 3);
    expect(perioArchVerdict(withPerioSkipped(chart, 1, true), "UpperFacial")).toMatchObject({
      status: "per_row",
      reason: "gap",
      at: [{ tooth: 1, surface: "DB" }],
    });
    const skippedLast = withPerioSkipped(chart, 16, true);
    expect(perioArchVerdict(skippedLast, "UpperFacial")).toMatchObject({ status: "string", sites: 45 });
    // …and the skip itself still goes in, as a row.
    expect(planPerioSend(skippedLast).rows).toEqual([
      {
        tooth: 16,
        sequenceType: "SkipTooth",
        body: { ToothValue: 1, MBvalue: -1, Bvalue: -1, DBvalue: -1, MLvalue: -1, Lvalue: -1, DLvalue: -1 },
      },
    ]);
  });
});

describe("the plan", () => {
  it("a full 0–9 mouth is four strings and not one row", () => {
    const plan = planPerioSend(fullMouth());
    expect(Object.keys(plan.strings)).toEqual([...PERIO_ARCH_STRING_FIELDS]);
    expect(plan.rows).toEqual([]);
    expect(plan.deepSites).toEqual([]);
  });

  it("one row-by-row arch takes its partner with it, and only that jaw goes row by row", () => {
    let chart = fullMouth(() => 3);
    chart = withPerioSite(chart, 3, "DB", { depth: 12 });
    const plan = planPerioSend(chart);

    expect(plan.arches.map((a) => [a.field, a.path, a.reason])).toEqual([
      ["UpperFacial", "per_row", "deep"],
      ["UpperLingual", "per_row", "partner"],
      ["LowerLingual", "string", null],
      ["LowerFacial", "string", null],
    ]);
    expect(Object.keys(plan.strings)).toEqual(["LowerLingual", "LowerFacial"]);
    expect(plan.deepSites).toEqual([{ tooth: 3, surface: "DB" }]);
    // One Probing row per upper tooth, carrying BOTH sides. Nothing for the lower jaw.
    expect(plan.rows.map((r) => r.tooth)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(plan.rows.every((r) => r.sequenceType === "Probing")).toBe(true);
    expect(plan.rows[2].body).toMatchObject({ DBvalue: 12, Bvalue: 3, MLvalue: 3 });
    expect(plan.arches[0].detail).toMatch(/#3 DB reads 10 mm or more/);
  });

  it("NO SITE THAT WAS NOT CHARTED IS EVER WRITTEN AS 0", () => {
    // A mid-arch gap with flags scattered around it: the row-by-row path.
    let chart = fullMouth((i) => (i % 5) + 1);
    chart = withPerioSite(chart, 5, "B", { depth: null });
    chart = withPerioSite(chart, 6, "L", { depth: null, plaque: true });
    chart = withPerioSite(chart, 7, "MB", { bleeding: true });
    const plan = planPerioSend(chart);
    expect(plan.arches[0]).toMatchObject({ path: "per_row", reason: "gap" });

    const keys = { MBvalue: "MB", Bvalue: "B", DBvalue: "DB", MLvalue: "ML", Lvalue: "L", DLvalue: "DL" } as const;
    for (const row of plan.rows) {
      for (const [key, surface] of Object.entries(keys) as [keyof typeof keys, ToothSurface][]) {
        const s = chart.teeth[String(row.tooth)]?.sites[surface];
        const value = row.body[key];
        if (row.sequenceType === "Probing") {
          expect(value).toBe(s?.depth ?? -1);
          if (s?.depth === null || s === undefined) expect(value).not.toBe(0);
        }
        if (row.sequenceType === "BleedSupPlaqCalc" && (s === undefined || (s.depth === null && value <= 0))) {
          expect(value).toBe(-1);
        }
      }
    }
    const bleed6 = plan.rows.find((r) => r.tooth === 6 && r.sequenceType === "BleedSupPlaqCalc");
    expect(bleed6?.body).toMatchObject({ Lvalue: 4, Bvalue: 0 });
    const probing5 = plan.rows.find((r) => r.tooth === 5 && r.sequenceType === "Probing");
    expect(probing5?.body.Bvalue).toBe(-1);
  });
});

describe("the read-back comparison", () => {
  it("an identical chart has no mismatch", () => {
    const chart = fullMouth();
    expect(comparePerioReadback(chart, chart)).toEqual([]);
  });

  it("names a shifted reading — the corruption finding 4 describes — site by site", () => {
    let expected = fullArch(emptyPerioChart(), "UpperFacial", () => 3);
    expected = withPerioSite(expected, 1, "DB", { depth: 10 });
    // What "10" would have done in a string: 1 on DB, 0 on B, and every later site shifted.
    let found = withPerioSite(expected, 1, "DB", { depth: 1 });
    found = withPerioSite(found, 1, "B", { depth: 0 });
    const m = comparePerioReadback(expected, found);
    expect(m).toEqual([
      { tooth: 1, surface: "DB", kind: "depth", expected: "10 mm", found: "1 mm" },
      { tooth: 1, surface: "B", kind: "depth", expected: "3 mm", found: "0 mm" },
    ]);
    expect(perioMismatchLine(m[0])).toBe("#1 DB: the chart says 10 mm, Open Dental holds 1 mm");
  });

  it("a 0 where the chart has nothing is a mismatch, because 0 is a reading", () => {
    const expected = emptyPerioChart();
    const found = withPerioSite(emptyPerioChart(), 30, "L", { depth: 0 });
    expect(comparePerioReadback(expected, found)).toEqual([
      { tooth: 30, surface: "L", kind: "depth", expected: "not charted", found: "0 mm" },
    ]);
  });

  it("flags, and a tooth that should be skipped, are compared too", () => {
    const expected = withPerioSkipped(withPerioSite(emptyPerioChart(), 4, "MB", { depth: 3, bleeding: true }), 1, true);
    const found = withPerioSite(emptyPerioChart(), 4, "MB", { depth: 3 });
    expect(comparePerioReadback(expected, found)).toEqual([
      { tooth: 1, surface: null, kind: "skipped", expected: "skipped", found: "not skipped" },
      { tooth: 4, surface: "MB", kind: "flags", expected: "bleeding", found: "no flags" },
    ]);
  });
});
