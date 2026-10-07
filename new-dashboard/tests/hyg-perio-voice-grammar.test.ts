/**
 * PERIO VOICE GRAMMAR (item 35) — acceptance row 4: the parser rejects the
 * lab's three confusions, and every command is covered. Plus the reducer half:
 * a parsed final lands on the sheet's own charting order, all or nothing.
 *
 * Pure functions only: no SDK, no DOM, no network.
 */
import { describe, expect, it } from "vitest";

import {
  chartingOrder,
  emptyPerioChart,
  perioSite,
  perioTooth,
  withPerioSite,
  withPerioSkipped,
} from "@shared/hyg/perio";
import { initialPerioEntry, reducePerioEntry, voiceJumpTarget, type PerioEntryState } from "@/features/hyg/perio/entry";
import {
  DEPTH_WORDS,
  PERIO_VOICE_PHRASES,
  VOICE_MAX_DEPTH,
  VOICE_VOCABULARY,
  describeVoiceCommands,
  parseVoiceFinal,
  tokenizeVoice,
  type VoiceCommand,
  type VoiceParse,
} from "@/features/hyg/perio/voiceGrammar";

function commands(text: string): VoiceCommand[] {
  const parsed = parseVoiceFinal(text);
  if (parsed.kind !== "commands") throw new Error(`expected commands for "${text}", got ${JSON.stringify(parsed)}`);
  return parsed.commands;
}

function rejection(text: string): Extract<VoiceParse, { kind: "rejected" }> {
  const parsed = parseVoiceFinal(text);
  if (parsed.kind !== "rejected") throw new Error(`expected a rejection for "${text}", got ${JSON.stringify(parsed)}`);
  return parsed;
}

const depths = (...values: number[]): VoiceCommand[] => values.map((value) => ({ type: "depth", value }));

describe("depths 0–12", () => {
  it("reads every depth word 0–12, and every single-digit numeral 0–9", () => {
    expect(VOICE_MAX_DEPTH).toBe(12);
    DEPTH_WORDS.forEach((word, value) => {
      expect(commands(word)).toEqual(depths(value));
      if (value <= 9) expect(commands(String(value))).toEqual(depths(value));
    });
  });

  it("REFUSES the numerals 10, 11, 12: Azure writes 'one one' as '11' too, and a silent 11 mm would be a wrong depth", () => {
    for (const heard of ["10", "11", "12"]) {
      const r = rejection(heard);
      expect(r.reason, heard).toBe("concatenated");
      expect(r.message).toMatch(/one number/);
      expect(r.message, "says how to chart it instead").toMatch(/key it, or say/);
    }
    expect(rejection("three 11 four").heard).toBe("11");
  });

  it("reads a run of depths in the order said, in either form, through Azure's punctuation", () => {
    expect(commands("three two three")).toEqual(depths(3, 2, 3));
    expect(commands("3 2 3")).toEqual(depths(3, 2, 3));
    expect(commands("3, 2, 3.")).toEqual(depths(3, 2, 3));
    expect(commands("Four, five, twelve!")).toEqual(depths(4, 5, 12));
    expect(commands("ten eleven twelve")).toEqual(depths(10, 11, 12));
  });
});

describe("ACCEPTANCE 4: the lab's three confusions are REJECTED, and nothing is charted", () => {
  it("confusion 1 — a depth past 12, as a word or a numeral", () => {
    for (const heard of ["thirteen", "nineteen", "13", "15", "19"]) {
      const r = rejection(heard);
      expect(r.reason, heard).toBe("over_max");
      expect(r.heard).toBe(heard);
      expect(r.message).toMatch(/nothing was charted/i);
    }
    for (const heard of ["twenty", "eighty", "hundred"]) expect(rejection(heard).reason, heard).toBe("over_max");
  });

  it("confusion 2 — two depths glued into one number: 1010, 80, and their kin", () => {
    for (const heard of ["1010", "80", "323", "44", "20", "05", "00"]) {
      const r = rejection(heard);
      expect(r.reason, heard).toBe("concatenated");
      expect(r.heard).toBe(heard);
      expect(r.message).toMatch(/one number/);
    }
    // Joined by a decimal point or a thousands comma: refused BEFORE punctuation
    // turns them into separate depths ("3.5" must not become a three and a five).
    expect(rejection("3.5").reason).toBe("concatenated");
    expect(rejection("1,010").reason).toBe("concatenated");
    expect(rejection("three 2.4 five").heard).toBe("2.4");
  });

  it("confusion 3 — a word outside the vocabulary, including a homophone of a number", () => {
    for (const heard of ["banana", "for", "to", "too", "won", "ate", "okay", "bleed", "probe"]) {
      const r = rejection(heard);
      expect(r.reason, heard).toBe("out_of_vocabulary");
      expect(r.message).toMatch(/not a depth, a flag or a command/);
    }
  });

  it("one bad word refuses the WHOLE final — a dropped word would shift every depth after it", () => {
    expect(rejection("three two 1010 four").reason).toBe("concatenated");
    expect(rejection("three um four").reason).toBe("out_of_vocabulary");
    expect(rejection("three fourteen four").reason).toBe("over_max");
    expect(rejection("bleeding banana").heard).toBe("banana");
  });
});

describe("flags", () => {
  it("reads all four, alone or after a depth", () => {
    for (const flag of ["bleeding", "suppuration", "plaque", "calculus"] as const) {
      expect(commands(flag)).toEqual([{ type: "flag", flag }]);
    }
    expect(commands("four bleeding plaque")).toEqual([
      { type: "depth", value: 4 },
      { type: "flag", flag: "bleeding" },
      { type: "flag", flag: "plaque" },
    ]);
  });
});

describe("commands — full coverage", () => {
  it("skip this tooth / missing / undo", () => {
    expect(commands("skip this tooth")).toEqual([{ type: "skipTooth" }]);
    expect(commands("Skip this tooth.")).toEqual([{ type: "skipTooth" }]);
    expect(commands("missing")).toEqual([{ type: "missing" }]);
    expect(commands("undo")).toEqual([{ type: "undo" }]);
    // "skip" on its own is not the command.
    expect(rejection("skip").reason).toBe("out_of_vocabulary");
    expect(rejection("skip tooth").reason).toBe("out_of_vocabulary");
  });

  it("jump to tooth <N> — numerals, words, compound words, 'number' and '#'", () => {
    expect(commands("jump to tooth 14")).toEqual([{ type: "jump", tooth: 14 }]);
    expect(commands("Jump to tooth fourteen.")).toEqual([{ type: "jump", tooth: 14 }]);
    expect(commands("jump to tooth number 3")).toEqual([{ type: "jump", tooth: 3 }]);
    expect(commands("jump to tooth #30")).toEqual([{ type: "jump", tooth: 30 }]);
    expect(commands("jump to tooth twenty-one")).toEqual([{ type: "jump", tooth: 21 }]);
    expect(commands("jump to tooth thirty two")).toEqual([{ type: "jump", tooth: 32 }]);
    expect(commands("jump to tooth twenty")).toEqual([{ type: "jump", tooth: 20 }]);
    // A tooth then depths: the tooth number takes what it can, then depths resume.
    expect(commands("jump to tooth 14 three two")).toEqual([{ type: "jump", tooth: 14 }, ...depths(3, 2)]);
  });

  it("go back to tooth <N> <site> — every site, by every name", () => {
    const sites: Array<[string, string]> = [
      ["distobuccal", "DB"],
      ["disto buccal", "DB"],
      ["disto-buccal", "DB"],
      ["distal buccal", "DB"],
      ["distofacial", "DB"],
      ["DB", "DB"],
      ["buccal", "B"],
      ["facial", "B"],
      ["B", "B"],
      ["mesiobuccal", "MB"],
      ["mesio buccal", "MB"],
      ["mesial buccal", "MB"],
      ["mesiofacial", "MB"],
      ["MB", "MB"],
      ["distolingual", "DL"],
      ["disto lingual", "DL"],
      ["DL", "DL"],
      ["lingual", "L"],
      ["L", "L"],
      ["mesiolingual", "ML"],
      ["mesio lingual", "ML"],
      ["ML", "ML"],
    ];
    for (const [said, surface] of sites) {
      expect(commands(`go back to tooth 3 ${said}`), said).toEqual([{ type: "goBack", tooth: 3, surface }]);
    }
    expect(commands("Go back to tooth nineteen mesiolingual, four")).toEqual([
      { type: "goBack", tooth: 19, surface: "ML" },
      { type: "depth", value: 4 },
    ]);
  });

  it("a command missing its tooth or site, or naming a tooth past 32, is refused", () => {
    expect(rejection("jump to tooth").reason).toBe("incomplete");
    expect(rejection("jump to tooth banana").reason).toBe("incomplete");
    expect(rejection("go back to tooth 3").reason).toBe("incomplete");
    expect(rejection("go back to tooth 3").message).toMatch(/and a site/);
    expect(rejection("go back to tooth 3 four").reason).toBe("incomplete");
    for (const t of ["0", "33", "143", "07"]) expect(rejection(`jump to tooth ${t}`).reason, t).toBe("bad_tooth");
    expect(rejection("go back to tooth 40 buccal").reason).toBe("bad_tooth");
  });

  it("several commands in one final, in order", () => {
    expect(commands("three two missing jump to tooth 5 undo")).toEqual([
      ...depths(3, 2),
      { type: "missing" },
      { type: "jump", tooth: 5 },
      { type: "undo" },
    ]);
  });
});

describe("anything else is ignored", () => {
  it("an empty final (breath, a cough, punctuation) does nothing at all", () => {
    for (const text of ["", "   ", ".", "?!", "…"]) {
      expect(parseVoiceFinal(text), JSON.stringify(text)).toEqual({ kind: "ignored" });
    }
  });
});

describe("the phrase list carries the FULL vocabulary", () => {
  it("every word the parser accepts appears in some phrase, and every phrase is made of accepted words", () => {
    const phraseWords = new Set(PERIO_VOICE_PHRASES.flatMap((p) => tokenizeVoice(p)));
    for (const word of VOICE_VOCABULARY) {
      // Single-letter and two-letter site abbreviations are said as letters;
      // they are read when heard but are not useful recognition hints.
      if (word.length <= 2) continue;
      expect(phraseWords.has(word), word).toBe(true);
    }
    for (const word of phraseWords) expect(VOICE_VOCABULARY.has(word), word).toBe(true);
  });

  it("includes every depth, flag, command, tooth 1–32 and site name", () => {
    for (const p of [
      "zero",
      "twelve",
      "bleeding",
      "suppuration",
      "plaque",
      "calculus",
      "skip this tooth",
      "missing",
      "undo",
      "jump to tooth",
      "go back to tooth",
      "thirty two",
      "twenty one",
      "nineteen",
      "distobuccal",
      "mesio lingual",
    ]) {
      expect(PERIO_VOICE_PHRASES, p).toContain(p);
    }
  });

  it("echoes commands, never the transcript", () => {
    expect(describeVoiceCommands(commands("three two bleeding jump to tooth 5 go back to tooth 3 DB undo"))).toBe(
      "3, 2, bleeding, jump to #5, back to #3 DB, undo",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE REDUCER: where a spoken final lands
// ─────────────────────────────────────────────────────────────────────────────

function fresh(): PerioEntryState {
  return initialPerioEntry(emptyPerioChart());
}

function say(state: PerioEntryState, text: string): PerioEntryState {
  return reducePerioEntry(state, { type: "voice", commands: commands(text) });
}

describe("a spoken final on the sheet (the entry reducer's `voice` action)", () => {
  it("depths auto-advance through the sheet's EXISTING charting order — the same order the keyboard walks", () => {
    const order = chartingOrder(emptyPerioChart().sweep);
    const spoken = say(fresh(), "three two three four five six");
    let typed = fresh();
    for (const v of [3, 2, 3, 4, 5, 6]) typed = reducePerioEntry(typed, { type: "number", value: v });
    expect(spoken.chart).toEqual(typed.chart);
    expect(spoken.cursor).toEqual(typed.cursor);
    [3, 2, 3, 4, 5, 6].forEach((v, i) => expect(perioSite(spoken.chart, order[i].tooth, order[i].surface).depth).toBe(v));
    expect(spoken.cursor).toEqual(order[6]);
  });

  it("a flag lands on the site just charted, and SETS rather than toggles", () => {
    const order = chartingOrder(emptyPerioChart().sweep);
    let s = say(fresh(), "three two four bleeding");
    expect(perioSite(s.chart, order[2].tooth, order[2].surface).bleeding).toBe(true);
    s = say(s, "bleeding");
    expect(perioSite(s.chart, order[2].tooth, order[2].surface).bleeding, "said twice, still on").toBe(true);
    expect(perioSite(s.chart, order[1].tooth, order[1].surface).bleeding).toBe(false);
  });

  it("skip this tooth / missing skip the current tooth and move on — and never un-skip", () => {
    const start = fresh();
    const tooth = start.cursor.tooth;
    const s = say(start, "skip this tooth");
    expect(perioTooth(s.chart, tooth).skipped).toBe(true);
    expect(s.cursor.tooth).not.toBe(tooth);
    const m = say(s, "missing");
    expect(perioTooth(m.chart, s.cursor.tooth).skipped).toBe(true);
    expect(perioTooth(m.chart, tooth).skipped, "the first stays skipped").toBe(true);
  });

  it("jump to tooth N lands on its first OPEN site in charting order", () => {
    let s = say(fresh(), "jump to tooth 14");
    expect(s.cursor).toEqual(voiceJumpTarget(s.chart, 14));
    expect(s.cursor.tooth).toBe(14);
    s = say(s, "five");
    const first = s.cursor;
    s = say(s, "jump to tooth 14");
    expect(s.cursor, "resumes past the charted site").toEqual(first);
  });

  it("go back to tooth N site selects exactly that site, and the next depth lands there", () => {
    let s = say(fresh(), "three three three");
    s = say(s, "go back to tooth 1 mesiobuccal six");
    expect(perioSite(s.chart, 1, "MB").depth).toBe(6);
  });

  it("END OF THE CHART: a depth past the last site is refused, never written over the last reading", () => {
    const order = chartingOrder(emptyPerioChart().sweep);
    const last = order[order.length - 1];
    const start = { ...fresh(), cursor: last };
    const one = say(start, "four");
    expect(perioSite(one.chart, last.tooth, last.surface).depth).toBe(4);
    // Within one final: all or nothing, so the four is not kept either.
    const run = say(start, "four five");
    expect(run.chart).toEqual(start.chart);
    expect(run.refusal).toMatch(/end of the chart/);
    // Across finals: the next one cannot overwrite it.
    const next = say(one, "five");
    expect(perioSite(next.chart, last.tooth, last.surface).depth).toBe(4);
    expect(next.refusal).toMatch(/end of the chart/);
    // Moving there deliberately still lets her correct it.
    const corrected = say(one, `go back to tooth ${last.tooth} ${last.surface} five`);
    expect(perioSite(corrected.chart, last.tooth, last.surface).depth).toBe(5);
  });

  it("undo with nothing to undo is refused, and clears nothing", () => {
    const chart = withPerioSite(emptyPerioChart(), 1, "DB", { depth: 4 });
    const start = initialPerioEntry(chart);
    const order = chartingOrder(chart.sweep);
    const atFirst = { ...start, cursor: order[0], lastEntered: null };
    const after = say(atFirst, "undo");
    expect(after.chart).toEqual(atFirst.chart);
    expect(after.refusal).toMatch(/nothing to undo/);
  });

  it("undo is Backspace: the last reading is taken back and the cursor returns to it", () => {
    const order = chartingOrder(emptyPerioChart().sweep);
    let s = say(fresh(), "three two");
    s = say(s, "undo");
    expect(perioSite(s.chart, order[1].tooth, order[1].surface).depth).toBeNull();
    expect(perioSite(s.chart, order[0].tooth, order[0].surface).depth).toBe(3);
    expect(s.cursor).toEqual(order[1]);
  });

  it("ALL OR NOTHING: a final that cannot fully apply leaves the chart exactly as it was, and says why", () => {
    const order = chartingOrder(emptyPerioChart().sweep);
    const skipped5 = { ...fresh(), chart: withPerioSkipped(emptyPerioChart(), 5, true) };
    const after = say(skipped5, "three two jump to tooth 5 four");
    expect(after.chart).toEqual(skipped5.chart);
    expect(after.cursor).toEqual(skipped5.cursor);
    expect(after.refusal).toMatch(/#5 is skipped/);
    expect(perioSite(after.chart, order[0].tooth, order[0].surface).depth).toBeNull();
  });

  it("voice is DEPTH ONLY: in another mode the whole final is refused, not read as a recession or grade", () => {
    for (const mode of ["gm", "mobility", "furcation"] as const) {
      const start = reducePerioEntry(fresh(), { type: "mode", mode });
      const after = say(start, "three");
      expect(after.chart, mode).toEqual(start.chart);
      expect(after.refusal).toMatch(/depths only/);
    }
  });

  it("a depth onto a skipped tooth is refused (the cursor sits there after 'go back')", () => {
    const chart = withPerioSite(withPerioSkipped(emptyPerioChart(), 2, true), 1, "DB", { depth: 3 });
    const start = { ...initialPerioEntry(chart), cursor: { tooth: 2, surface: "DB" as const } };
    const after = say(start, "four");
    expect(after.chart).toEqual(start.chart);
    expect(after.refusal).toMatch(/#2 is skipped/);
  });
});
