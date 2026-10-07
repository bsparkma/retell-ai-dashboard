/**
 * ITEM 37: the finals the staging field test captured from the voice lab's free
 * mode — Azure's DISPLAY text, verbatim — each with the command it must parse
 * to. Synthetic perio commands; no patient data. Shared by the parser and page
 * suites, so it lives outside either test file.
 */
import type { VoiceCommand } from "@/features/hyg/perio/voiceGrammar";

export const CAPTURED_FINALS: ReadonlyArray<readonly [string, VoiceCommand]> = [
  ["Jump to tooth 14", { type: "jump", tooth: 14 }],
  ["Jump to tooth 21", { type: "jump", tooth: 21 }],
  ["Jump to tooth 30", { type: "jump", tooth: 30 }],
  ["Jump to tooth 5", { type: "jump", tooth: 5 }],
  // ITN glued "to tooth <N>" into a clock time.
  ["Jump to 2:30", { type: "jump", tooth: 30 }],
  ["Jump to 2:14", { type: "jump", tooth: 14 }],
  // "tooth" dropped.
  ["Jump to 21", { type: "jump", tooth: 21 }],
  // Capitals and commas.
  ["Jump back to tooth 3, mesial, buccal", { type: "goBack", tooth: 3, surface: "MB" }],
  // "to" → "two".
  ["Jump back two tooth 3 mesial", { type: "goBack", tooth: 3, surface: "mesial" }],
  // "mesial" → "missile", and "tooth" → "two".
  ["Jump back to two three missile", { type: "goBack", tooth: 3, surface: "mesial" }],
  // "tooth" dropped.
  ["Jump back to three mesial", { type: "goBack", tooth: 3, surface: "mesial" }],
];
