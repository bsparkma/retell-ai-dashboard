/**
 * Voice lab scoring — PURE. No SDK, no DOM, no network, no clock.
 *
 * The scripted run records one tuple per prompt: what the page asked for,
 * what Azure finally recognised, and two latencies. Everything the results
 * panel shows (median + p95 latency, accuracy %, the confusion list, the
 * copyable text) is derived here from that recorded sequence, so it can be
 * tested without a microphone.
 */

/** The words the run prompts for, and the phrase list's digit half. */
export const DIGIT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
] as const;

export type DigitWord = (typeof DIGIT_WORDS)[number];

/** The phrase list handed to Azure: the digit words plus the perio findings. */
export const PHRASE_LIST: readonly string[] = [...DIGIT_WORDS, "bleeding", "suppuration", "plaque", "calculus"];

export const SCRIPTED_RUN_LENGTH = 50;

/** One scripted prompt's outcome. */
export interface Trial {
  prompted: DigitWord;
  /** The final recognised text, raw. Empty string when nothing was recognised. */
  recognized: string;
  /** End of speech → final result, ms. Null when no final arrived. */
  finalMs: number | null;
  /** Start of speech → first partial, ms. Null when no partial arrived. */
  firstPartialMs: number | null;
}

export interface LatencyStats {
  count: number;
  medianMs: number | null;
  p95Ms: number | null;
}

export interface Confusion {
  prompted: DigitWord;
  /** The normalised recognition, or "(nothing)" when the final was empty. */
  heard: string;
  count: number;
}

export interface RunSummary {
  trials: number;
  correct: number;
  /** 0–100, one decimal. Null for an empty run. */
  accuracyPct: number | null;
  final: LatencyStats;
  firstPartial: LatencyStats;
  confusions: Confusion[];
}

const NUMERAL_TO_WORD: Record<string, DigitWord> = Object.fromEntries(
  DIGIT_WORDS.map((w, i) => [String(i), w]),
) as Record<string, DigitWord>;

/**
 * Reduce a recognition to the form it is compared in: lower case, trailing
 * punctuation stripped, and a bare numeral ("5", "12") read as its word —
 * Azure's display text often writes a spoken digit as a numeral, and that is
 * the right answer, not a miss.
 */
export function normalizeRecognized(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[.,!?;:"'`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return NUMERAL_TO_WORD[cleaned] ?? cleaned;
}

export function isCorrect(trial: Trial): boolean {
  return normalizeRecognized(trial.recognized) === trial.prompted;
}

/**
 * Percentile by the nearest-rank method: the smallest value with at least
 * p% of the sample at or below it. On 50 samples the p95 is the 48th
 * smallest. Nearest-rank never invents a value that was not measured.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/** Median: the middle value, or the mean of the two middle values. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function latencyStats(values: ReadonlyArray<number | null>): LatencyStats {
  const measured = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return { count: measured.length, medianMs: median(measured), p95Ms: percentile(measured, 95) };
}

/** Confusion pairs (prompted → heard), misses only, most frequent first. */
export function confusions(trials: readonly Trial[]): Confusion[] {
  const counts = new Map<string, Confusion>();
  for (const t of trials) {
    if (isCorrect(t)) continue;
    const heard = normalizeRecognized(t.recognized) || "(nothing)";
    const key = `${t.prompted}\u0000${heard}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { prompted: t.prompted, heard, count: 1 });
  }
  return Array.from(counts.values()).sort(
    (a, b) => b.count - a.count || a.prompted.localeCompare(b.prompted) || a.heard.localeCompare(b.heard),
  );
}

export function summarize(trials: readonly Trial[]): RunSummary {
  const correct = trials.filter(isCorrect).length;
  return {
    trials: trials.length,
    correct,
    accuracyPct: trials.length === 0 ? null : Math.round((correct / trials.length) * 1000) / 10,
    final: latencyStats(trials.map((t) => t.finalMs)),
    firstPartial: latencyStats(trials.map((t) => t.firstPartialMs)),
    confusions: confusions(trials),
  };
}

function ms(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value)} ms`;
}

/**
 * The results as plain text, for the Copy button. Digit words and numbers
 * only — there is nothing else in a run to copy.
 */
export function formatSummary(summary: RunSummary, header = "CareIN voice lab — scripted run"): string {
  const lines = [
    header,
    `Prompts: ${summary.trials}`,
    `Accuracy: ${summary.accuracyPct === null ? "n/a" : `${summary.accuracyPct}%`} (${summary.correct}/${summary.trials})`,
    `End of speech → final: median ${ms(summary.final.medianMs)}, p95 ${ms(summary.final.p95Ms)} (n=${summary.final.count})`,
    `Start of speech → first partial: median ${ms(summary.firstPartial.medianMs)}, p95 ${ms(summary.firstPartial.p95Ms)} (n=${summary.firstPartial.count})`,
    "Confusions:",
    ...(summary.confusions.length === 0
      ? ["  none"]
      : summary.confusions.map((c) => `  ${c.prompted} → ${c.heard} ×${c.count}`)),
  ];
  return lines.join("\n");
}

/**
 * `n` prompts drawn uniformly from the digit words. `random` is injectable so
 * tests are deterministic; the page passes Math.random.
 */
export function pickPrompts(n: number, random: () => number): DigitWord[] {
  const out: DigitWord[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.min(DIGIT_WORDS.length - 1, Math.floor(random() * DIGIT_WORDS.length));
    out.push(DIGIT_WORDS[idx]);
  }
  return out;
}

/**
 * Latencies from the SDK's timestamps.
 *
 * Azure reports each result's audio position (`offset`, `duration`, in 100 ns
 * ticks from the start of the stream) and, on a final, the SDK's own
 * end-of-speech → final latency (`RecognitionLatencyMs`: from the last audio
 * fragment that contributed to the result to the moment the result arrived).
 *
 * That pins the stream's start on the page clock:
 *   streamStart = finalArrival − latency − (offset + duration)
 * and from there, the moment speech started is streamStart + offset, so:
 *   firstPartialMs = firstPartialArrival − (streamStart + offset)
 *
 * When the SDK does not report a latency, end of speech is estimated from the
 * stream start recorded when recognition began (`fallbackStreamStartMs`).
 * All times are page-clock milliseconds (performance.now()).
 */
export function deriveLatencies(args: {
  offsetTicks: number;
  durationTicks: number;
  finalArrivalMs: number;
  sdkLatencyMs: number | null;
  firstPartialArrivalMs: number | null;
  fallbackStreamStartMs: number;
}): { finalMs: number; firstPartialMs: number | null } {
  const offsetMs = args.offsetTicks / 10_000;
  const durationMs = args.durationTicks / 10_000;
  const finalMs =
    args.sdkLatencyMs !== null && Number.isFinite(args.sdkLatencyMs)
      ? args.sdkLatencyMs
      : args.finalArrivalMs - (args.fallbackStreamStartMs + offsetMs + durationMs);
  const streamStart = args.finalArrivalMs - finalMs - offsetMs - durationMs;
  const firstPartialMs =
    args.firstPartialArrivalMs === null ? null : args.firstPartialArrivalMs - (streamStart + offsetMs);
  return { finalMs, firstPartialMs };
}
