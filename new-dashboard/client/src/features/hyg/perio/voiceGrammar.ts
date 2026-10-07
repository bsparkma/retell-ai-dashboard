/**
 * Perio voice grammar (queue item 35) — what a spoken FINAL means, as a PURE
 * function. No SDK, no DOM, no network, no clock, no chart.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SHAPE OF IT
 * ═════════════════════════════════════════════════════════════════════════════
 * Azure hands the page one final per utterance ("3 2 3 bleeding", "Jump to
 * tooth 14."). `parseVoiceFinal` turns that text into a list of commands, or
 * refuses it, or ignores it. It never looks at the chart: WHERE a depth lands
 * is the entry reducer's job (features/hyg/perio/entry.ts, action `voice`), so
 * voice and the keyboard walk the same charting order by construction.
 *
 *   depths     0–12 as words ("seven"), or 0–9 as numerals ("7") — a two-digit
 *              numeral is ambiguous, see `numeralDepth`; each one lands on the
 *              current site and the cursor steps to the next in charting order
 *   flags      bleeding / suppuration / plaque / calculus — on the site just
 *              charted (the same target the B S P C keys use)
 *   commands   "skip this tooth"  "missing"           → skip the current tooth
 *              "jump to tooth <N>"                     → its first open site
 *              "go back to tooth <N> <site>"           → that exact site
 *              "undo"                                  → Backspace: take back the
 *                                                        last reading, go back to it
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A FINAL IS ALL OR NOTHING
 * ═════════════════════════════════════════════════════════════════════════════
 * Depths auto-advance, so dropping one bad word from the middle of "three two
 * ten-ten four" would put the four on the wrong site. One word this grammar
 * cannot read refuses the WHOLE final: nothing is charted and the sheet says
 * what it heard and why. The hygienist says it again.
 *
 * The three ways the lab (item 34) mis-heard a depth, each refused here and
 * each pinned by a test:
 *   over_max          a depth past 12 ("thirteen", "15") — voice charts 0–12;
 *                     a deeper pocket is keyed by hand, where Shift+digit is
 *                     deliberate rather than a mis-hearing
 *   concatenated      two spoken depths written as one number ("ten ten" →
 *                     "1010", "eight zero" → "80", "3.5", "1,010", "05") — it
 *                     cannot be told which depths were said, so none is charted
 *   out_of_vocabulary any other word ("banana", "for", "to") — a homophone of a
 *                     number is NOT read as one
 *
 * Two more refusals belong to the commands: a tooth outside 1–32 (bad_tooth)
 * and a command missing its tooth or site (incomplete).
 *
 * "Anything else is ignored": an EMPTY final — Azure hearing breath or a
 * cough, punctuation only — is no utterance at all and does nothing, silently.
 */
import type { ToothSurface } from "@shared/hyg/contract";
import { PERIO_FLAGS, PERIO_TOOTH_COUNT, type PerioFlag } from "@shared/hyg/perio";

/** Voice charts probing depths 0–12. The keyboard still takes 13–19. */
export const VOICE_MAX_DEPTH = 12;

export type VoiceCommand =
  | { type: "depth"; value: number }
  | { type: "flag"; flag: PerioFlag }
  | { type: "skipTooth" }
  | { type: "missing" }
  | { type: "jump"; tooth: number }
  | { type: "goBack"; tooth: number; surface: ToothSurface }
  | { type: "undo" };

export const VOICE_REJECT_REASONS = [
  "over_max",
  "concatenated",
  "out_of_vocabulary",
  "bad_tooth",
  "incomplete",
] as const;
export type VoiceRejectReason = (typeof VOICE_REJECT_REASONS)[number];

export type VoiceParse =
  | { kind: "ignored" }
  | { kind: "commands"; commands: VoiceCommand[] }
  | { kind: "rejected"; reason: VoiceRejectReason; heard: string; message: string };

// ─────────────────────────────────────────────────────────────────────────────
// THE VOCABULARY — one set of tables; the phrase list is built FROM them
// ─────────────────────────────────────────────────────────────────────────────

/** zero … twelve: the depth words, index = value. */
export const DEPTH_WORDS = [
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
] as const;

/** Number words that are never a depth here, but ARE tooth numbers (13–19). */
const TEEN_WORDS = ["thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"] as const;

/** Tens words, for teeth 20–32. */
const TENS: Readonly<Record<string, number>> = Object.freeze({ twenty: 20, thirty: 30 });

/** Words that name a number past 12 and so are an over-depth when said as a depth. */
const OVER_MAX_WORDS: ReadonlySet<string> = new Set([
  ...TEEN_WORDS,
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
]);

const NUMBER_WORD_VALUE: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries([
    ...DEPTH_WORDS.map((w, i) => [w, i] as const),
    ...TEEN_WORDS.map((w, i) => [w, 13 + i] as const),
  ]),
);

/**
 * The six sites, by every name a hygienist says them. Multi-word names first
 * within each surface so the longest match wins. "Facial" is the buccal family.
 */
const SITE_NAMES: ReadonlyArray<readonly [readonly string[], ToothSurface]> = [
  [["disto", "buccal"], "DB"],
  [["distal", "buccal"], "DB"],
  [["disto", "facial"], "DB"],
  [["distobuccal"], "DB"],
  [["distofacial"], "DB"],
  [["db"], "DB"],
  [["mesio", "buccal"], "MB"],
  [["mesial", "buccal"], "MB"],
  [["mesio", "facial"], "MB"],
  [["mesiobuccal"], "MB"],
  [["mesiofacial"], "MB"],
  [["mb"], "MB"],
  [["disto", "lingual"], "DL"],
  [["distal", "lingual"], "DL"],
  [["distolingual"], "DL"],
  [["dl"], "DL"],
  [["mesio", "lingual"], "ML"],
  [["mesial", "lingual"], "ML"],
  [["mesiolingual"], "ML"],
  [["ml"], "ML"],
  [["buccal"], "B"],
  [["facial"], "B"],
  [["b"], "B"],
  [["lingual"], "L"],
  [["l"], "L"],
];

const SKIP_PHRASE = ["skip", "this", "tooth"] as const;
const JUMP_PHRASE = ["jump", "to", "tooth"] as const;
const GO_BACK_PHRASE = ["go", "back", "to", "tooth"] as const;

/** The words that may be said, in any position. Built from the tables above. */
export const VOICE_VOCABULARY: ReadonlySet<string> = new Set<string>([
  ...DEPTH_WORDS,
  ...TEEN_WORDS,
  ...Object.keys(TENS),
  ...PERIO_FLAGS,
  ...SKIP_PHRASE,
  ...JUMP_PHRASE,
  ...GO_BACK_PHRASE,
  "number",
  "missing",
  "undo",
  ...SITE_NAMES.flatMap(([words]) => words),
]);

/** Spoken tooth numbers 1–32, the way they are said. */
function toothWords(): string[] {
  const out: string[] = [];
  for (let n = 1; n <= PERIO_TOOTH_COUNT; n += 1) {
    if (n < 20) out.push(DEPTH_WORDS[n] ?? TEEN_WORDS[n - 13]);
    else {
      const tens = n < 30 ? "twenty" : "thirty";
      const ones = n % 10;
      out.push(ones === 0 ? tens : `${tens} ${DEPTH_WORDS[ones]}`);
    }
  }
  return out;
}

/**
 * The phrase list handed to Azure: the FULL vocabulary, as the phrases it is
 * said in. A phrase list biases recognition towards these words; it does not
 * restrict it, which is why the parser still refuses everything else.
 */
export const PERIO_VOICE_PHRASES: readonly string[] = Object.freeze(
  Array.from(
    new Set<string>([
      ...DEPTH_WORDS,
      ...PERIO_FLAGS,
      SKIP_PHRASE.join(" "),
      "missing",
      "undo",
      JUMP_PHRASE.join(" "),
      GO_BACK_PHRASE.join(" "),
      `${JUMP_PHRASE.join(" ")} number`,
      `${GO_BACK_PHRASE.join(" ")} number`,
      ...toothWords(),
      ...SITE_NAMES.map(([words]) => words.join(" ")).filter((p) => p.length > 2),
    ]),
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// THE PARSER
// ─────────────────────────────────────────────────────────────────────────────

/** Two digits joined by a decimal point or a thousands comma: "3.5", "1,010". */
const JOINED_NUMBER = /\d[.,]\d+/;

/**
 * Lower case, with the punctuation Azure's display text adds turned into
 * spaces. Hyphens split ("mesio-buccal", "twenty-one"), and "#14" reads as "14".
 */
export function tokenizeVoice(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‐-―-]/g, " ")
    .replace(/[#.,!?;:"'`()‘’“”…]+/g, " ")
    .split(/\s+/)
    .filter((t) => t !== "");
}

function rejected(reason: VoiceRejectReason, heard: string): VoiceParse {
  return { kind: "rejected", reason, heard, message: rejectionMessage(reason, heard) };
}

/** What the sheet says. Every one ends the same way: nothing was charted. */
export function rejectionMessage(reason: VoiceRejectReason, heard: string): string {
  switch (reason) {
    case "over_max":
      return `Heard “${heard}”. Voice charts depths 0–12, so nothing was charted. Key a deeper reading by hand.`;
    case "concatenated":
      return `Heard “${heard}” as one number, so it could be more than one depth. Nothing was charted — say them again, one at a time${
        /^1[0-2]$/.test(heard) ? ` (for ${heard} mm, key it, or say “${DEPTH_WORDS[Number(heard)]}” clearly)` : ""
      }.`;
    case "out_of_vocabulary":
      return `Heard “${heard}”, which is not a depth, a flag or a command. Nothing was charted.`;
    case "bad_tooth":
      return `Heard tooth “${heard}”. Teeth are 1–${PERIO_TOOTH_COUNT}, so nothing was charted.`;
    case "incomplete":
      return `“${heard}” needs a tooth number${heard.startsWith("go back") ? " and a site" : ""}. Nothing was charted.`;
  }
}

/** Does `tokens` start with `phrase` at `at`? */
function startsWith(tokens: readonly string[], at: number, phrase: readonly string[]): boolean {
  return phrase.every((w, k) => tokens[at + k] === w);
}

/** A bare numeral as a DEPTH: a value, or why it is not one. */
function numeralDepth(token: string): { value: number } | { reason: "over_max" | "concatenated" } {
  // "05" is "zero five" run together, not five.
  if (token.length > 1 && token.startsWith("0")) return { reason: "concatenated" };
  // A TWO-DIGIT numeral is never trusted, even 10–12. Azure's display text
  // writes "one one" as "11" exactly as it writes "eleven", so "11" cannot be
  // told from a 1 then a 1 — and reading it as eleven would chart a wrong depth
  // SILENTLY, the worst thing this grammar can do. 10–12 are charted from the
  // WORDS ("ten", "eleven", "twelve") or by hand. Single digits 0–9 are safe.
  if (token.length > 1) {
    const n = Number(token);
    return n >= 13 && n <= 19 ? { reason: "over_max" } : { reason: "concatenated" };
  }
  const n = Number(token);
  if (n <= VOICE_MAX_DEPTH) return { value: n };
  // 13–19 is one spoken number that is simply too deep. Anything wider ("80",
  // "1010", "323") is how two or more spoken depths come back glued together.
  if (n <= 19) return { reason: "over_max" };
  return { reason: "concatenated" };
}

type ToothRead = { ok: true; tooth: number; next: number } | { ok: false; reason: "bad_tooth" | "incomplete"; heard: string };

/** A tooth number at `at` (optionally after "number"): "14", "fourteen", "twenty one". */
function readTooth(tokens: readonly string[], at: number): ToothRead {
  let i = at;
  if (tokens[i] === "number") i += 1;
  const t = tokens[i];
  if (t === undefined) return { ok: false, reason: "incomplete", heard: "" };

  let value: number;
  let next = i + 1;
  if (/^\d+$/.test(t)) {
    value = t.length > 1 && t.startsWith("0") ? NaN : Number(t);
  } else if (t in TENS) {
    value = TENS[t];
    const ones = tokens[next];
    if (ones !== undefined && DEPTH_WORDS.indexOf(ones as (typeof DEPTH_WORDS)[number]) >= 1) {
      const v = DEPTH_WORDS.indexOf(ones as (typeof DEPTH_WORDS)[number]);
      if (v <= 9) {
        value += v;
        next += 1;
      }
    }
  } else if (t in NUMBER_WORD_VALUE) {
    value = NUMBER_WORD_VALUE[t];
  } else {
    return { ok: false, reason: "incomplete", heard: t };
  }
  if (!Number.isInteger(value) || value < 1 || value > PERIO_TOOTH_COUNT) {
    return { ok: false, reason: "bad_tooth", heard: tokens.slice(i, next).join(" ") };
  }
  return { ok: true, tooth: value, next };
}

/** A site name at `at`, longest match first. */
function readSite(tokens: readonly string[], at: number): { surface: ToothSurface; next: number } | null {
  let best: { surface: ToothSurface; next: number } | null = null;
  for (const [words, surface] of SITE_NAMES) {
    if (startsWith(tokens, at, words) && (best === null || at + words.length > best.next)) {
      best = { surface, next: at + words.length };
    }
  }
  return best;
}

const FLAG_SET: ReadonlySet<string> = new Set(PERIO_FLAGS);

/**
 * One final → commands, a refusal, or nothing.
 *
 * PURE: the same text always parses the same way, whatever the chart says.
 */
export function parseVoiceFinal(text: string): VoiceParse {
  // Checked on the RAW text, before punctuation becomes spaces and turns "3.5"
  // into a three and a five.
  const joined = JOINED_NUMBER.exec(text);
  if (joined) {
    const start = text.slice(0, joined.index).search(/\d+$/);
    const heard = text.slice(start >= 0 ? start : joined.index, joined.index + joined[0].length);
    return rejected("concatenated", heard);
  }

  const tokens = tokenizeVoice(text);
  if (tokens.length === 0) return { kind: "ignored" };

  const commands: VoiceCommand[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];

    if (startsWith(tokens, i, GO_BACK_PHRASE)) {
      const tooth = readTooth(tokens, i + GO_BACK_PHRASE.length);
      if (!tooth.ok) {
        return tooth.reason === "bad_tooth"
          ? rejected("bad_tooth", tooth.heard)
          : rejected("incomplete", tokens.slice(i, i + GO_BACK_PHRASE.length + 1).join(" "));
      }
      const site = readSite(tokens, tooth.next);
      if (!site) return rejected("incomplete", tokens.slice(i, tooth.next + 1).join(" "));
      commands.push({ type: "goBack", tooth: tooth.tooth, surface: site.surface });
      i = site.next;
      continue;
    }

    if (startsWith(tokens, i, JUMP_PHRASE)) {
      const tooth = readTooth(tokens, i + JUMP_PHRASE.length);
      if (!tooth.ok) {
        return tooth.reason === "bad_tooth"
          ? rejected("bad_tooth", tooth.heard)
          : rejected("incomplete", tokens.slice(i, i + JUMP_PHRASE.length + 1).join(" "));
      }
      commands.push({ type: "jump", tooth: tooth.tooth });
      i = tooth.next;
      continue;
    }

    if (startsWith(tokens, i, SKIP_PHRASE)) {
      commands.push({ type: "skipTooth" });
      i += SKIP_PHRASE.length;
      continue;
    }

    if (t === "missing") {
      commands.push({ type: "missing" });
      i += 1;
      continue;
    }

    if (t === "undo") {
      commands.push({ type: "undo" });
      i += 1;
      continue;
    }

    if (FLAG_SET.has(t)) {
      commands.push({ type: "flag", flag: t as PerioFlag });
      i += 1;
      continue;
    }

    const word = DEPTH_WORDS.indexOf(t as (typeof DEPTH_WORDS)[number]);
    if (word >= 0) {
      commands.push({ type: "depth", value: word });
      i += 1;
      continue;
    }

    if (/^\d+$/.test(t)) {
      const read = numeralDepth(t);
      if ("reason" in read) return rejected(read.reason, t);
      commands.push({ type: "depth", value: read.value });
      i += 1;
      continue;
    }

    if (OVER_MAX_WORDS.has(t)) return rejected("over_max", t);
    return rejected("out_of_vocabulary", t);
  }

  return { kind: "commands", commands };
}

/** The commands, as the sheet echoes them back: "3, 2, 3, bleeding". Never the raw transcript. */
export function describeVoiceCommands(commands: readonly VoiceCommand[]): string {
  return commands
    .map((c) => {
      switch (c.type) {
        case "depth":
          return String(c.value);
        case "flag":
          return c.flag;
        case "skipTooth":
          return "skip tooth";
        case "missing":
          return "missing";
        case "jump":
          return `jump to #${c.tooth}`;
        case "goBack":
          return `back to #${c.tooth} ${c.surface}`;
        case "undo":
          return "undo";
      }
    })
    .join(", ");
}
