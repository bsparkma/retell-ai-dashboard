/**
 * Voice lab scoring (queue item 34, acceptance row 5) — pure functions over a
 * recorded sequence of (prompted, recognized, ms) tuples.
 */
import { describe, expect, it } from "vitest";
import {
  DIGIT_WORDS,
  PHRASE_LIST,
  confusions,
  deriveLatencies,
  formatSummary,
  latencyStats,
  median,
  normalizeRecognized,
  percentile,
  pickPrompts,
  summarize,
  type DigitWord,
  type Trial,
} from "@/pages/voicelab/scoring";

function t(prompted: DigitWord, recognized: string, finalMs: number | null, firstPartialMs: number | null = null): Trial {
  return { prompted, recognized, finalMs, firstPartialMs };
}

describe("the vocabulary", () => {
  it("prompts for zero…nineteen and the phrase list adds the four perio findings", () => {
    expect(DIGIT_WORDS).toHaveLength(20);
    expect(DIGIT_WORDS[0]).toBe("zero");
    expect(DIGIT_WORDS[19]).toBe("nineteen");
    expect(PHRASE_LIST).toEqual([...DIGIT_WORDS, "bleeding", "suppuration", "plaque", "calculus"]);
  });
});

describe("normalizeRecognized", () => {
  it("lower-cases, strips punctuation, and reads a bare numeral as its word", () => {
    expect(normalizeRecognized("Five.")).toBe("five");
    expect(normalizeRecognized("5")).toBe("five");
    expect(normalizeRecognized("12")).toBe("twelve");
    expect(normalizeRecognized("  Nineteen! ")).toBe("nineteen");
    expect(normalizeRecognized("three four five")).toBe("three four five");
    expect(normalizeRecognized("20")).toBe("20"); // not a prompt word — stays as heard
  });
});

describe("latency statistics", () => {
  it("median handles odd and even samples", () => {
    expect(median([300, 100, 200])).toBe(200);
    expect(median([100, 200, 300, 400])).toBe(250);
    expect(median([])).toBeNull();
  });

  it("p95 is nearest-rank: on 1..100 it is 95, on 50 samples it is the 48th smallest", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 95)).toBe(95);
    const fifty = Array.from({ length: 50 }, (_, i) => (i + 1) * 10); // 10..500
    expect(percentile(fifty, 95)).toBe(480);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([], 95)).toBeNull();
  });

  it("ignores prompts with no measurement instead of counting them as zero", () => {
    expect(latencyStats([400, null, 200, null])).toEqual({ count: 2, medianMs: 300, p95Ms: 400 });
  });
});

describe("a recorded run", () => {
  // 10 prompts: 7 right (one as a numeral), five→nine twice, eleven→seven once.
  const run: Trial[] = [
    t("five", "nine", 410, 120),
    t("three", "Three.", 300, 90),
    t("five", "9", 520, 150),
    t("eleven", "seven", 600, 200),
    t("zero", "zero", 250, 80),
    t("two", "2", 280, 100),
    t("nineteen", "nineteen", 350, 110),
    t("twelve", "twelve", 330, 95),
    t("four", "four", 290, 85),
    t("eight", "eight", 310, null),
  ];

  it("accuracy counts a numeral as the word it names", () => {
    const s = summarize(run);
    expect(s.trials).toBe(10);
    expect(s.correct).toBe(7);
    expect(s.accuracyPct).toBe(70);
  });

  it("latency median and p95 come from the recorded milliseconds", () => {
    const s = summarize(run);
    // sorted finals: 250 280 290 300 310 330 350 410 520 600
    expect(s.final).toEqual({ count: 10, medianMs: 320, p95Ms: 600 });
    // sorted partials (9 measured): 80 85 90 95 100 110 120 150 200
    expect(s.firstPartial).toEqual({ count: 9, medianMs: 100, p95Ms: 200 });
  });

  it("confusion pairs are misses only, most frequent first", () => {
    expect(confusions(run)).toEqual([
      { prompted: "five", heard: "nine", count: 2 },
      { prompted: "eleven", heard: "seven", count: 1 },
    ]);
  });

  it("a skipped prompt is a miss heard as (nothing), with no latency", () => {
    const s = summarize([t("six", "", null, null), t("six", "six", 300, 100)]);
    expect(s.accuracyPct).toBe(50);
    expect(s.confusions).toEqual([{ prompted: "six", heard: "(nothing)", count: 1 }]);
    expect(s.final.count).toBe(1);
  });

  it("the copyable text carries the numbers and the confusion list", () => {
    const text = formatSummary(summarize(run));
    expect(text).toContain("Accuracy: 70% (7/10)");
    expect(text).toContain("End of speech → final: median 320 ms, p95 600 ms (n=10)");
    expect(text).toContain("five → nine ×2");
    expect(text).toContain("eleven → seven ×1");
  });

  it("an empty run reports n/a, not NaN", () => {
    const s = summarize([]);
    expect(s.accuracyPct).toBeNull();
    expect(formatSummary(s)).toContain("Accuracy: n/a");
    expect(formatSummary(s)).not.toContain("NaN");
  });
});

describe("pickPrompts", () => {
  it("draws n digit words with the injected random source", () => {
    const seq = [0, 0.999, 0.5, 0.25];
    let i = 0;
    const prompts = pickPrompts(4, () => seq[i++]);
    expect(prompts).toEqual(["zero", "nineteen", "ten", "five"]);
    expect(pickPrompts(50, Math.random)).toHaveLength(50);
  });
});

describe("deriveLatencies", () => {
  it("uses the SDK's end-of-speech latency and anchors the first partial to speech start", () => {
    // Utterance at 2.0s–2.5s of the stream; final arrived at page time 10_800 with
    // a reported 300 ms latency ⇒ stream started at 10_800 − 300 − 2_500 = 8_000,
    // speech started at 10_000, the first partial arrived at 10_250.
    const r = deriveLatencies({
      offsetTicks: 2_000 * 10_000,
      durationTicks: 500 * 10_000,
      finalArrivalMs: 10_800,
      sdkLatencyMs: 300,
      firstPartialArrivalMs: 10_250,
      fallbackStreamStartMs: 0,
    });
    expect(r).toEqual({ finalMs: 300, firstPartialMs: 250 });
  });

  it("falls back to the recorded stream start when the SDK reports no latency", () => {
    const r = deriveLatencies({
      offsetTicks: 1_000 * 10_000,
      durationTicks: 400 * 10_000,
      finalArrivalMs: 5_900,
      sdkLatencyMs: null,
      firstPartialArrivalMs: null,
      fallbackStreamStartMs: 4_000,
    });
    // end of speech at 4_000 + 1_000 + 400 = 5_400 ⇒ 500 ms
    expect(r).toEqual({ finalMs: 500, firstPartialMs: null });
  });
});
