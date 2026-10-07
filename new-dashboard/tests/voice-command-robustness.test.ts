/**
 * VOICE COMMAND ROBUSTNESS (item 37) — the parser half.
 *
 *   captures   every final the staging field test captured from the voice lab
 *              (Azure's DISPLAY text) parses to the right tooth and site
 *   lexical    the same commands as the LEXICAL text says them — the form the
 *              sheet now parses. These are PRESUMED lexical forms (the lab did
 *              not show lexical text when the captures were made); the display
 *              captures above are the observed ones.
 *   backstop   the tolerance is navigation-only, all or nothing, and ambiguity
 *              is a refusal
 *   depths     the depth rules are UNTOUCHED, re-pinned here — and a clock token
 *              is never a depth
 *
 * Item 35's own grammar suite (hyg-perio-voice-grammar.test.ts) is left exactly
 * as it was and still runs; this file only adds.
 *
 * Pure functions only: no SDK, no DOM, no network.
 */
import { describe, expect, it } from "vitest";

import { emptyPerioChart } from "@shared/hyg/perio";
import { initialPerioEntry, reducePerioEntry, voiceGoBackSurface, voiceJumpTarget } from "@/features/hyg/perio/entry";
import {
  DEPTH_WORDS,
  PERIO_VOICE_PHRASES,
  VOICE_VOCABULARY,
  parseVoiceFinal,
  textForParser,
  tokenizeVoice,
  type VoiceCommand,
  type VoiceParse,
} from "@/features/hyg/perio/voiceGrammar";
import { CAPTURED_FINALS } from "./fixtures/voiceCaptures";

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

/** The same commands as the recognizer's lexical text would carry them (presumed — see the header). */
const PRESUMED_LEXICAL: ReadonlyArray<readonly [string, VoiceCommand]> = [
  ["jump to tooth fourteen", { type: "jump", tooth: 14 }],
  ["jump to tooth twenty one", { type: "jump", tooth: 21 }],
  ["jump to tooth thirty", { type: "jump", tooth: 30 }],
  ["jump to tooth five", { type: "jump", tooth: 5 }],
  ["jump to two thirty", { type: "jump", tooth: 30 }],
  ["jump to two fourteen", { type: "jump", tooth: 14 }],
  ["jump to twenty one", { type: "jump", tooth: 21 }],
  ["jump back to tooth three mesial buccal", { type: "goBack", tooth: 3, surface: "MB" }],
  ["jump back two tooth three mesial", { type: "goBack", tooth: 3, surface: "mesial" }],
  ["jump back to two three missile", { type: "goBack", tooth: 3, surface: "mesial" }],
  ["jump back to three mesial", { type: "goBack", tooth: 3, surface: "mesial" }],
  // The HUD's own cue, as lexical text spells the letters.
  ["go back to tooth three m b", { type: "goBack", tooth: 3, surface: "MB" }],
];

describe("item 37: every captured final parses to the right tooth and site", () => {
  it.each(CAPTURED_FINALS)("display text %j", (said, expected) => {
    expect(commands(said)).toEqual([expected]);
  });

  it.each(PRESUMED_LEXICAL)("lexical text %j", (said, expected) => {
    expect(commands(said)).toEqual([expected]);
  });

  it("with Azure's trailing period too", () => {
    for (const [said, expected] of CAPTURED_FINALS) expect(commands(`${said}.`), said).toEqual([expected]);
  });

  it("a depth run after a navigation command still charts, in order", () => {
    expect(commands("Jump to 2:30, three two")).toEqual([{ type: "jump", tooth: 30 }, ...depths(3, 2)]);
    expect(commands("jump back to three mesial four")).toEqual([
      { type: "goBack", tooth: 3, surface: "mesial" },
      ...depths(4),
    ]);
    expect(commands("three two jump to 21 four")).toEqual([...depths(3, 2), { type: "jump", tooth: 21 }, ...depths(4)]);
  });
});

describe("item 37: the navigation backstop", () => {
  it("the tooth is a word or a numeral 1–32; anything else is refused with item 35's message", () => {
    expect(commands("jump to 1")).toEqual([{ type: "jump", tooth: 1 }]);
    expect(commands("jump to thirty two")).toEqual([{ type: "jump", tooth: 32 }]);
    for (const said of ["jump to 33", "jump to 0", "jump to 07", "jump back to tooth 40 mesial", "jump to thirty three"]) {
      expect(rejection(said).reason, said).toBe("bad_tooth");
      expect(rejection(said).message, said).toMatch(/Teeth are 1–32, so nothing was charted/);
    }
  });

  it("a clock token decodes as tooth YY only for a valid tooth, and only after the misheard “2:”", () => {
    expect(commands("jump to 2:05")).toEqual([{ type: "jump", tooth: 5 }]);
    expect(commands("jump to 2:01")).toEqual([{ type: "jump", tooth: 1 }]);
    expect(commands("jump to 2:32")).toEqual([{ type: "jump", tooth: 32 }]);
    expect(commands("go back to 2:14 lingual")).toEqual([{ type: "goBack", tooth: 14, surface: "L" }]);
    for (const said of ["jump to 2:00", "jump to 2:33", "jump to 2:45", "jump to 3:30", "jump to 12:14"]) {
      const r = rejection(said);
      expect(r.reason, said).toBe("bad_tooth");
      expect(r.heard, said).toBe(said.split(" ").pop());
    }
  });

  it("“to” / “two” / “too” / “2” fill the to-slot; tooth / two / 2 the tooth-slot", () => {
    for (const to of ["to", "two", "too", "2"]) {
      expect(commands(`jump ${to} tooth 14`), to).toEqual([{ type: "jump", tooth: 14 }]);
      expect(commands(`go back ${to} tooth 3 MB`), to).toEqual([{ type: "goBack", tooth: 3, surface: "MB" }]);
    }
    for (const slot of ["tooth", "two", "2"]) {
      expect(commands(`jump to ${slot} 14`), slot).toEqual([{ type: "jump", tooth: 14 }]);
    }
  });

  it("“jump back” is “go back”; both still need a site", () => {
    expect(commands("jump back to tooth 3 DB")).toEqual(commands("go back to tooth 3 DB"));
    const r = rejection("jump back to tooth 3");
    expect(r.reason).toBe("incomplete");
    expect(r.message).toMatch(/and a site/);
    expect(rejection("jump back to tooth 3 four").reason).toBe("incomplete");
  });

  it("a missing target is refused, all or nothing", () => {
    for (const said of ["jump", "jump to", "jump back", "go back", "go back to", "jump 14", "three two jump"]) {
      expect(rejection(said).reason, said).toBe("incomplete");
    }
    // The depths before it are NOT charted either.
    expect(parseVoiceFinal("three two jump to").kind).toBe("rejected");
  });

  it("AMBIGUITY IS A REFUSAL: a two / 2 that could be the tooth or the to-tooth slot", () => {
    for (const said of ["jump to two three", "jump to 2 3", "jump two two four"]) {
      const r = rejection(said);
      expect(r.reason, said).toBe("bad_tooth");
      expect(r.message, said).toMatch(/could name tooth/);
      expect(r.message, said).toMatch(/nothing was charted/);
    }
    // With "tooth" said, it is not ambiguous — item 35's reading stands.
    expect(commands("jump to tooth two three")).toEqual([{ type: "jump", tooth: 2 }, ...depths(3)]);
    expect(commands("jump to tooth two")).toEqual([{ type: "jump", tooth: 2 }]);
    expect(commands("jump to two")).toEqual([{ type: "jump", tooth: 2 }]);
    // A go back needs a site straight after the tooth, which settles it.
    expect(commands("go back to two three mesial")).toEqual([{ type: "goBack", tooth: 3, surface: "mesial" }]);
  });

  it("the sound-alike list is tiny and literal: only missile → mesial, and only inside go back", () => {
    expect(commands("go back to tooth 3 missile buccal")).toEqual([{ type: "goBack", tooth: 3, surface: "MB" }]);
    expect(commands("go back to tooth 3 missile lingual")).toEqual([{ type: "goBack", tooth: 3, surface: "ML" }]);
    // Not fuzzy: near misses are still not sites.
    for (const said of ["go back to tooth 3 missal", "go back to tooth 3 mezial", "go back to tooth 3 distill"]) {
      expect(rejection(said).reason, said).toBe("incomplete");
    }
    // Outside a go back it is just an unknown word.
    expect(rejection("missile").reason).toBe("out_of_vocabulary");
    expect(rejection("three missile").reason).toBe("out_of_vocabulary");
    // And it is never offered to Azure as a hint, nor added to the vocabulary.
    expect(PERIO_VOICE_PHRASES.some((p) => tokenizeVoice(p).includes("missile"))).toBe(false);
    expect(VOICE_VOCABULARY.has("missile")).toBe(false);
  });

  it("no tolerance outside the two commands: scaffolding words alone are what they always were", () => {
    expect(rejection("to").reason).toBe("out_of_vocabulary");
    expect(rejection("too").reason).toBe("out_of_vocabulary");
    expect(rejection("tooth").reason).toBe("out_of_vocabulary");
    expect(commands("two")).toEqual(depths(2));
    expect(commands("2")).toEqual(depths(2));
    expect(rejection("back").reason).toBe("out_of_vocabulary");
    expect(rejection("go").reason).toBe("out_of_vocabulary");
    expect(rejection("mesial").reason).toBe("out_of_vocabulary");
  });
});

describe("item 37: DEPTH STRICTNESS IS UNTOUCHED (re-pinned)", () => {
  it("depth words 0–12 still chart", () => {
    DEPTH_WORDS.forEach((word, value) => expect(commands(word)).toEqual(depths(value)));
    expect(commands("ten eleven twelve")).toEqual(depths(10, 11, 12));
  });

  it("two-digit numeral depths are still refused, 10–12 included", () => {
    for (const heard of ["10", "11", "12", "20", "44"]) expect(rejection(heard).reason, heard).toBe("concatenated");
    for (const heard of ["13", "19"]) expect(rejection(heard).reason, heard).toBe("over_max");
  });

  it("the glue confusions are still refused: 1010, 1011, 80, a0", () => {
    for (const heard of ["1010", "1011", "80"]) {
      const r = rejection(heard);
      expect(r.reason, heard).toBe("concatenated");
      expect(r.heard).toBe(heard);
    }
    expect(rejection("a0").reason).toBe("out_of_vocabulary");
    expect(rejection("three two 1010 four").reason).toBe("concatenated");
  });

  it("A CLOCK TOKEN IS NEVER A DEPTH, wherever it sits", () => {
    for (const said of ["2:30", "2:05", "3:14", "12:00", "three 2:30", "three two 2:30 four", "2:30."]) {
      const r = rejection(said);
      expect(r.reason, said).toBe("concatenated");
      expect(r.heard, said).toMatch(/^\d{1,2}:\d{2}$/);
      expect(r.message, said).toMatch(/one number/);
    }
  });

  it("the tokenizer keeps a clock time whole, and changes nothing else", () => {
    expect(tokenizeVoice("Jump to 2:30.")).toEqual(["jump", "to", "2:30"]);
    expect(tokenizeVoice("Jump back to tooth 3, mesial, buccal")).toEqual([
      "jump",
      "back",
      "to",
      "tooth",
      "3",
      "mesial",
      "buccal",
    ]);
    expect(tokenizeVoice("mesio-buccal #14 twenty-one")).toEqual(["mesio", "buccal", "14", "twenty", "one"]);
    expect(tokenizeVoice("3, 2, 3.")).toEqual(["3", "2", "3"]);
  });
});

describe("item 37: what text the parser reads", () => {
  it("the lexical form when there is one; the display text otherwise", () => {
    expect(textForParser({ text: "Jump to 2:30", lexical: "jump to two thirty" })).toBe("jump to two thirty");
    expect(textForParser({ text: "Jump to 2:30", lexical: null })).toBe("Jump to 2:30");
    expect(textForParser({ text: "Jump to 2:30", lexical: "  " })).toBe("Jump to 2:30");
    expect(textForParser({ text: "Jump to 2:30" })).toBe("Jump to 2:30");
  });

  it("lexical text is why 10–12 spoken as words now reach the parser as words", () => {
    // Display "11" is refused (it could be "one one"); lexical says what was spoken.
    expect(parseVoiceFinal(textForParser({ text: "11", lexical: "eleven" }))).toEqual({
      kind: "commands",
      commands: depths(11),
    });
    expect(parseVoiceFinal(textForParser({ text: "11", lexical: "one one" }))).toEqual({
      kind: "commands",
      commands: depths(1, 1),
    });
  });
});

describe("item 37: a bare mesial / distal lands on the pass the cursor is on", () => {
  const fresh = initialPerioEntry(emptyPerioChart());
  const lingual = reducePerioEntry(fresh, { type: "select", cursor: { tooth: 5, surface: "L" } });

  it("resolves facial → MB / DB, lingual → ML / DL; a named site is left alone", () => {
    expect(voiceGoBackSurface({ tooth: 1, surface: "B" }, "mesial")).toBe("MB");
    expect(voiceGoBackSurface({ tooth: 1, surface: "DB" }, "distal")).toBe("DB");
    expect(voiceGoBackSurface({ tooth: 1, surface: "L" }, "mesial")).toBe("ML");
    expect(voiceGoBackSurface({ tooth: 1, surface: "ML" }, "distal")).toBe("DL");
    expect(voiceGoBackSurface({ tooth: 1, surface: "L" }, "MB")).toBe("MB");
  });

  it("through the sheet's reducer, for every captured go back", () => {
    for (const [said, expected] of CAPTURED_FINALS) {
      if (expected.type !== "goBack") continue;
      const facial = reducePerioEntry(fresh, { type: "voice", commands: commands(said) });
      expect(facial.refusal, said).toBeNull();
      expect(facial.cursor, said).toEqual({ tooth: 3, surface: "MB" });
      const onLingual = reducePerioEntry(lingual, { type: "voice", commands: commands(said) });
      expect(onLingual.cursor, said).toEqual({ tooth: 3, surface: expected.surface === "MB" ? "MB" : "ML" });
    }
  });

  it("through the sheet's reducer, for every captured jump", () => {
    for (const [said, expected] of CAPTURED_FINALS) {
      if (expected.type !== "jump") continue;
      const s = reducePerioEntry(fresh, { type: "voice", commands: commands(said) });
      expect(s.refusal, said).toBeNull();
      expect(s.cursor, said).toEqual(voiceJumpTarget(fresh.chart, expected.tooth));
    }
  });
});
