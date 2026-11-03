/**
 * Print template styling (CO-3b). Beau's ruling, 2026-11-02: CURATED OPTIONS
 * ONLY — no free-form designer. Per office, per template:
 *
 *   accentColor    a hex colour for the LETTERHEAD TEXT and the RULE under it,
 *                  nothing else. Body text is black whatever is chosen
 *                  (readability is not configurable), and a colour too light to
 *                  read on white paper is refused by name (see ACCENT_MIN_CONTRAST).
 *   fontPair       one of five heading + body pairs: the built-in Helvetica the
 *                  printouts have always used, or four openly-licensed families
 *                  BUNDLED with the app (backend/assets/print-fonts) and EMBEDDED
 *                  in the PDF, so a printout is the same on every machine.
 *   logoPlacement  left | center | right
 *   logoSize       small | medium
 *   layout         classic_letterhead | centered_formal | compact_card — fixed
 *                  arrangements of the same blocks. A layout changes WHERE things
 *                  go, never WHAT is printed.
 *
 * ONE ENGINE, TWO RENDERERS. `layoutPrintDocument` turns a composed printout
 * (composePrintDocument) and its styling into positioned drawing operations in
 * PDF points. The server's PDF writer serialises those operations and the
 * Settings preview draws the SAME operations as an SVG page, so the preview's
 * geometry is the printout's geometry by construction, not by resemblance.
 *
 * THE DEFAULTS ARE TODAY'S PRINTOUT. A template with no styling saved (every
 * template that exists today) lays out through exactly the arithmetic the CO-3
 * renderer used — character-count wrapping, the same constants, the same op
 * order — and its PDF is byte-identical to before (pinned by SHA-256 in
 * backend/test/printStylingDefaults.test.js). Nothing shipped changes until an
 * office manager opts in.
 */
import { z } from "zod";

import type { PrintDocument } from "./printTemplates";

// ── the curated options ───────────────────────────────────────────────────

/**
 * Every font face the printouts can use. `file` is the bundled TrueType file
 * (null: a PDF base-14 face, not embedded — the face printed until CO-3b).
 * `widths` are advance widths in 1/1000 em for ASCII 32..126 — the only codes a
 * printout carries (asciiSafe). For the bundled faces they are read from the
 * files' hmtx tables and a backend test re-derives them from the bundled files,
 * so they cannot drift; for Helvetica they are Adobe's Core 14 metrics, with
 * codes 39 and 96 taken as WinAnsi's quotesingle and grave.
 */
export const PRINT_FONT_FACES = {
  helvetica: {
    file: null,
    postscriptName: "Helvetica",
    cssFamily: "Helvetica, Arial, sans-serif",
    cssWeight: 400,
    widths: [
      278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556,
      556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778,
      722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
      500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
    ],
  },
  helvetica_bold: {
    file: null,
    postscriptName: "Helvetica-Bold",
    cssFamily: "Helvetica, Arial, sans-serif",
    cssWeight: 700,
    widths: [
      278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556,
      556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778,
      722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
      556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
    ],
  },
  lato_regular: {
    file: "Lato-Regular.ttf",
    postscriptName: "Lato-Regular",
    cssFamily: '"CareIN Print Lato Regular"',
    cssWeight: 400,
    widths: [
      256, 269, 371, 580, 580, 802, 712, 204, 267, 267, 425, 580, 227, 372, 236, 452, 580, 580, 580, 580, 580, 580, 580,
      580, 580, 580, 250, 262, 580, 580, 580, 448, 837, 677, 647, 668, 761, 578, 566, 731, 764, 280, 423, 663, 514, 929,
      764, 801, 601, 801, 627, 543, 591, 736, 677, 1036, 649, 624, 602, 306, 452, 306, 580, 459, 400, 497, 560, 478, 560,
      528, 351, 520, 558, 240, 240, 508, 236, 823, 558, 567, 561, 560, 364, 433, 359, 558, 516, 786, 498, 516, 452, 301,
      251, 301, 580,
    ],
  },
  lato_bold: {
    file: "Lato-Bold.ttf",
    postscriptName: "Lato-Bold",
    cssFamily: '"CareIN Print Lato Bold"',
    cssWeight: 400,
    widths: [
      243, 281, 396, 580, 580, 820, 724, 212, 275, 275, 425, 580, 234, 373, 238, 466, 580, 580, 580, 580, 580, 580, 580,
      580, 580, 580, 258, 271, 580, 580, 580, 460, 844, 695, 659, 662, 761, 575, 566, 726, 771, 297, 430, 686, 520, 945,
      771, 808, 619, 808, 643, 549, 600, 743, 695, 1051, 671, 648, 606, 314, 466, 314, 580, 467, 400, 508, 568, 482, 568,
      534, 359, 528, 564, 254, 254, 535, 249, 838, 564, 575, 568, 568, 373, 440, 372, 564, 528, 803, 522, 528, 460, 306,
      261, 306, 580,
    ],
  },
  pt_serif_regular: {
    file: "PT_Serif-Web-Regular.ttf",
    postscriptName: "PTSerif-Regular",
    cssFamily: '"CareIN Print PT Serif Regular"',
    cssWeight: 400,
    widths: [
      243, 327, 380, 533, 533, 807, 869, 222, 343, 343, 465, 533, 283, 425, 279, 344, 533, 533, 533, 533, 533, 533, 533, 533, 533,
      533, 327, 332, 533, 533, 533, 473, 1064, 683, 615, 644, 708, 582, 544, 688, 728, 352, 341, 646, 549, 867, 732, 740, 596, 740,
      637, 536, 619, 672, 684, 934, 670, 644, 610, 307, 382, 307, 500, 410, 328, 505, 545, 466, 555, 503, 342, 526, 587, 301, 288,
      516, 301, 863, 594, 553, 566, 548, 384, 433, 371, 574, 507, 728, 519, 505, 488, 348, 237, 348, 530,
    ],
  },
  pt_serif_bold: {
    file: "PT_Serif-Web-Bold.ttf",
    postscriptName: "PTSerif-Bold",
    cssFamily: '"CareIN Print PT Serif Bold"',
    cssWeight: 400,
    widths: [
      270, 344, 416, 565, 565, 848, 896, 240, 375, 375, 463, 565, 306, 414, 296, 344, 565, 565, 565, 565, 565, 565, 565, 565, 565,
      565, 343, 348, 565, 565, 565, 486, 1064, 729, 649, 652, 736, 604, 575, 709, 769, 372, 365, 710, 583, 930, 758, 754, 640, 754,
      697, 558, 667, 715, 734, 1033, 728, 698, 634, 324, 382, 324, 498, 410, 351, 557, 588, 484, 599, 537, 372, 564, 640, 332, 320,
      583, 332, 924, 644, 594, 609, 589, 431, 452, 399, 622, 539, 784, 560, 528, 516, 354, 235, 354, 530,
    ],
  },
  pt_sans_regular: {
    file: "PT_Sans-Web-Regular.ttf",
    postscriptName: "PTSans-Regular",
    cssFamily: '"CareIN Print PT Sans Regular"',
    cssWeight: 400,
    widths: [
      267, 305, 335, 545, 545, 773, 814, 218, 280, 280, 351, 505, 225, 360, 214, 354, 545, 545, 545, 545, 545, 545, 545, 545, 545,
      545, 219, 256, 505, 505, 505, 436, 1064, 585, 584, 571, 654, 536, 517, 612, 672, 291, 291, 610, 517, 791, 673, 684, 559, 684,
      595, 531, 555, 652, 568, 828, 618, 558, 545, 304, 380, 304, 500, 408, 280, 496, 540, 451, 538, 508, 319, 537, 547, 268, 267,
      479, 292, 812, 547, 536, 541, 537, 340, 421, 339, 539, 482, 735, 515, 466, 447, 346, 238, 346, 505,
    ],
  },
  crimson_regular: {
    file: "CrimsonText-Regular.ttf",
    postscriptName: "CrimsonText-Regular",
    cssFamily: '"CareIN Print Crimson Text Regular"',
    cssWeight: 400,
    widths: [
      224, 273, 340, 465, 479, 664, 655, 182, 315, 314, 434, 568, 233, 366, 228, 414, 504, 369, 473, 448, 473, 474, 473,
      472, 473, 473, 228, 238, 522, 558, 522, 357, 800, 668, 578, 641, 705, 558, 538, 698, 690, 311, 314, 677, 555, 889,
      704, 711, 532, 707, 645, 479, 653, 702, 692, 1051, 672, 634, 586, 353, 420, 353, 435, 457, 184, 413, 487, 396, 485,
      420, 294, 463, 518, 275, 258, 484, 245, 781, 530, 498, 499, 478, 371, 351, 307, 505, 481, 717, 456, 443, 404, 316,
      258, 317, 563,
    ],
  },
  crimson_bold: {
    file: "CrimsonText-Bold.ttf",
    postscriptName: "CrimsonText-Bold",
    cssFamily: '"CareIN Print Crimson Text Bold"',
    cssWeight: 400,
    widths: [
      204, 188, 315, 462, 453, 645, 685, 195, 302, 302, 406, 520, 214, 317, 199, 415, 503, 374, 464, 445, 480, 438, 449, 459, 453,
      442, 197, 210, 453, 518, 456, 342, 763, 703, 591, 623, 707, 584, 540, 688, 710, 338, 361, 703, 584, 886, 759, 687, 559, 713,
      666, 472, 649, 716, 712, 1068, 750, 653, 620, 303, 403, 303, 379, 517, 241, 475, 551, 441, 541, 450, 371, 474, 577, 319, 298,
      605, 326, 867, 591, 511, 554, 504, 454, 383, 356, 585, 583, 859, 591, 531, 420, 320, 152, 320, 557,
    ],
  },
} as const;
export type PrintFontFace = keyof typeof PRINT_FONT_FACES;

/** The bundled files, for the font route's allow-list. */
export const PRINT_FONT_FILES: readonly string[] = Object.values(PRINT_FONT_FACES)
  .map((f) => f.file)
  .filter((f): f is NonNullable<typeof f> => f !== null);

/** The five curated pairs, in the order the picker shows them. */
export const PRINT_FONT_PAIRS = {
  standard: { label: "Standard — Helvetica (as printed today)", heading: "helvetica_bold", body: "helvetica" },
  modern: { label: "Modern — Lato", heading: "lato_bold", body: "lato_regular" },
  traditional: { label: "Traditional — PT Serif", heading: "pt_serif_bold", body: "pt_serif_regular" },
  serif_sans: { label: "Serif headings, clean text — PT Serif + PT Sans", heading: "pt_serif_bold", body: "pt_sans_regular" },
  book: { label: "Book — Crimson Text", heading: "crimson_bold", body: "crimson_regular" },
} as const satisfies Record<string, { label: string; heading: PrintFontFace; body: PrintFontFace }>;
export type PrintFontPair = keyof typeof PRINT_FONT_PAIRS;

export const PRINT_LAYOUTS = {
  classic_letterhead: { label: "Classic letterhead", hint: "Letterhead at the top left, everything left-aligned (as printed today)" },
  centered_formal: { label: "Centered formal", hint: "Letterhead, heading and signature centered" },
  compact_card: { label: "Compact card", hint: "Name and contact details on one band, tighter spacing, a framed page" },
} as const;
export type PrintLayout = keyof typeof PRINT_LAYOUTS;

export const PRINT_LOGO_PLACEMENTS = { left: "Left", center: "Center", right: "Right" } as const;
export type PrintLogoPlacement = keyof typeof PRINT_LOGO_PLACEMENTS;

/** The logo's box, a side in points: medium is the one inch CO-3 printed. */
export const PRINT_LOGO_SIZES = { small: { label: "Small", box: 48 }, medium: { label: "Medium", box: 72 } } as const;
export type PrintLogoSize = keyof typeof PRINT_LOGO_SIZES;

const keysOf = <T extends Record<string, unknown>>(o: T) => Object.keys(o) as [keyof T & string, ...Array<keyof T & string>];

export const PrintStyling = z
  .object({
    accentColor: z.string().regex(/^#[0-9a-f]{6}$/),
    fontPair: z.enum(keysOf(PRINT_FONT_PAIRS)),
    logoPlacement: z.enum(keysOf(PRINT_LOGO_PLACEMENTS)),
    logoSize: z.enum(keysOf(PRINT_LOGO_SIZES)),
    layout: z.enum(keysOf(PRINT_LAYOUTS)),
  })
  .strict();
export type PrintStyling = z.infer<typeof PrintStyling>;

/** Today's printout. A template with no styling saved prints exactly this. */
export const PRINT_STYLING_DEFAULTS: PrintStyling = Object.freeze({
  accentColor: "#000000",
  fontPair: "standard",
  logoPlacement: "left",
  logoSize: "medium",
  layout: "classic_letterhead",
});

const STYLING_KEYS = Object.keys(PRINT_STYLING_DEFAULTS) as Array<keyof PrintStyling>;

export function isDefaultStyling(s: PrintStyling): boolean {
  return STYLING_KEYS.every((k) => s[k] === PRINT_STYLING_DEFAULTS[k]);
}

// ── the accent colour's floor ─────────────────────────────────────────────

/**
 * THE READABILITY FLOOR: an accent must reach 4.5 : 1 contrast against white
 * paper — WCAG 2.x's AA threshold for normal-size text, which the letterhead's
 * 10 pt address and phone lines are. In relative-luminance terms that is a CAP
 * of L ≤ 0.1833 (since (1.0 + 0.05) / (L + 0.05) ≥ 4.5). Pure black is 21 : 1;
 * a mid grey like #777777 (4.48 : 1) is just refused, #767676 (4.54 : 1) just
 * passes.
 */
export const ACCENT_MIN_CONTRAST = 4.5;

/** WCAG relative luminance of `#rrggbb`. Pure. */
export function relativeLuminance(hex: string): number {
  const n = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * n(1) + 0.7152 * n(3) + 0.0722 * n(5);
}

/** Contrast ratio of `#rrggbb` against white paper. Pure. */
export function contrastOnWhite(hex: string): number {
  return 1.05 / (relativeLuminance(hex) + 0.05);
}

// ── validation, with named refusals ───────────────────────────────────────

export type PrintStylingProblemCode =
  | "PRINT_STYLE_NOT_AN_OBJECT"
  | "PRINT_STYLE_UNKNOWN_KEY"
  | "PRINT_STYLE_MISSING_KEY"
  | "PRINT_STYLE_INVALID_COLOR"
  | "PRINT_STYLE_ACCENT_TOO_LIGHT"
  | "PRINT_STYLE_UNKNOWN_OPTION";

export interface PrintStylingProblem {
  code: PrintStylingProblemCode;
  field: string | null;
  message: string;
}

const OPTION_SETS: Record<Exclude<keyof PrintStyling, "accentColor">, Record<string, unknown>> = {
  fontPair: PRINT_FONT_PAIRS,
  logoPlacement: PRINT_LOGO_PLACEMENTS,
  logoSize: PRINT_LOGO_SIZES,
  layout: PRINT_LAYOUTS,
};

/**
 * A styling object against the CLOSED schema. Unknown keys are refused (never
 * dropped), a colour must be `#rrggbb` and dark enough to read, and every other
 * value must be one of its curated options. The editor runs this as you choose
 * and the server runs it on save. Pure.
 */
export function validatePrintStyling(
  raw: unknown,
): { ok: true; styling: PrintStyling } | { ok: false; problems: PrintStylingProblem[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, problems: [{ code: "PRINT_STYLE_NOT_AN_OBJECT", field: null, message: "Styling must be an object of the five style settings." }] };
  }
  const obj = raw as Record<string, unknown>;
  const problems: PrintStylingProblem[] = [];
  for (const key of Object.keys(obj)) {
    if (!(STYLING_KEYS as string[]).includes(key)) {
      problems.push({ code: "PRINT_STYLE_UNKNOWN_KEY", field: key, message: `"${key}" is not a style setting. Settings: ${STYLING_KEYS.join(", ")}.` });
    }
  }
  for (const key of STYLING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      problems.push({ code: "PRINT_STYLE_MISSING_KEY", field: key, message: `The style setting "${key}" is missing.` });
    }
  }
  const color = obj.accentColor;
  if (Object.prototype.hasOwnProperty.call(obj, "accentColor")) {
    if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      problems.push({ code: "PRINT_STYLE_INVALID_COLOR", field: "accentColor", message: `The accent colour must be a hex colour like #1f4e79 (got ${JSON.stringify(color)}).` });
    } else {
      const ratio = contrastOnWhite(color.toLowerCase());
      if (ratio < ACCENT_MIN_CONTRAST) {
        problems.push({
          code: "PRINT_STYLE_ACCENT_TOO_LIGHT",
          field: "accentColor",
          message: `${color.toLowerCase()} is too light to read on white paper (${ratio.toFixed(2)} : 1; at least ${ACCENT_MIN_CONTRAST} : 1 is needed). Choose a darker colour.`,
        });
      }
    }
  }
  for (const [key, options] of Object.entries(OPTION_SETS)) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const v = obj[key];
    if (typeof v !== "string" || !Object.prototype.hasOwnProperty.call(options, v)) {
      problems.push({ code: "PRINT_STYLE_UNKNOWN_OPTION", field: key, message: `${JSON.stringify(v)} is not an option for ${key}. Options: ${Object.keys(options).join(", ")}.` });
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  const parsed = PrintStyling.safeParse({ ...obj, accentColor: (color as string).toLowerCase() });
  if (!parsed.success) {
    return { ok: false, problems: [{ code: "PRINT_STYLE_NOT_AN_OBJECT", field: null, message: "Styling is not valid." }] };
  }
  return { ok: true, styling: parsed.data };
}

/**
 * What a stored value prints as: NULL (nothing saved, every template before
 * CO-3b) is the defaults. A stored value that no longer validates — an option
 * retired after it was saved — also prints as the defaults rather than failing
 * a printout. Pure.
 */
export function effectivePrintStyling(stored: unknown): PrintStyling {
  if (stored === null || stored === undefined) return { ...PRINT_STYLING_DEFAULTS };
  const v = validatePrintStyling(stored);
  return v.ok ? v.styling : { ...PRINT_STYLING_DEFAULTS };
}

// ── text: the printable subset and its widths ─────────────────────────────

/**
 * The transliteration a printout's text goes through (services/hyg/slipPdf.js's
 * asciiSafe — a backend test pins the two equal): ASCII 32..126 as is, a few
 * typographic marks to their ASCII look-alikes, anything else "?".
 */
const TRANSLITERATE: ReadonlyMap<string, string> = new Map([
  ["—", "-"],
  ["–", "-"],
  ["·", "-"],
  ["’", "'"],
  ["‘", "'"],
  ["“", '"'],
  ["”", '"'],
  ["…", "..."],
  ["½", "1/2"],
  [" ", " "],
]);

export function printableAscii(value: string): string {
  let out = "";
  for (const ch of String(value)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 && code <= 126) {
      out += ch;
      continue;
    }
    const mapped = TRANSLITERATE.get(ch);
    out += mapped !== undefined ? mapped : "?";
  }
  return out;
}

/** Width of printable text in points. Pure. */
export function textWidth(face: PrintFontFace, size: number, text: string): number {
  const widths = PRINT_FONT_FACES[face].widths;
  let units = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    units += c >= 32 && c <= 126 ? widths[c - 32] : widths[31];
  }
  return (units * size) / 1000;
}

/**
 * CO-3's wrap, kept exactly: by CHARACTER COUNT (a long unbroken token is cut).
 * Only the default layout with the default font uses it, which is what keeps an
 * untouched template's PDF byte-identical.
 */
export function wrapToChars(line: string, width: number): string[] {
  const safe = printableAscii(line);
  if (safe.length <= width) return [safe];
  const out: string[] = [];
  let rest = safe;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut <= 0) cut = width;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** Wrap by MEASURED width in points, with the face's own metrics. Pure. */
export function wrapToWidth(line: string, face: PrintFontFace, size: number, maxWidth: number): string[] {
  const safe = printableAscii(line);
  if (textWidth(face, size, safe) <= maxWidth) return [safe];
  const out: string[] = [];
  let current = "";
  const pushLongWord = (word: string) => {
    let piece = "";
    for (const ch of word) {
      if (piece !== "" && textWidth(face, size, piece + ch) > maxWidth) {
        out.push(piece);
        piece = "";
      }
      piece += ch;
    }
    return piece;
  };
  for (const word of safe.split(" ").filter((w) => w !== "")) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (textWidth(face, size, candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current !== "") out.push(current);
    current = textWidth(face, size, word) <= maxWidth ? word : pushLongWord(word);
  }
  if (current !== "") out.push(current);
  return out.length > 0 ? out : [""];
}

// ── the layout engine ─────────────────────────────────────────────────────

export const PRINT_PAGE = { width: 612, height: 792, margin: 54 } as const;

/** Which of the pair's two faces a run is drawn in: the PDF's /F1 and /F2. */
export type PrintFontSlot = "body" | "heading";
export type PrintTextRole = "letterhead" | "heading" | "body" | "signature";

export type PrintOp =
  | { kind: "text"; role: PrintTextRole; slot: PrintFontSlot; size: number; x: number; y: number; text: string; color: string | null }
  | { kind: "rule"; role: "letterhead" | "signature"; x1: number; x2: number; y: number; color: string | null }
  | { kind: "image"; x: number; y: number; w: number; h: number }
  | { kind: "frame"; x: number; y: number; w: number; h: number };

export interface PrintLayoutResult {
  styling: PrintStyling;
  faces: { body: PrintFontFace; heading: PrintFontFace };
  /** One op list per page, in PDF points (origin bottom-left), in drawing order. */
  pages: PrintOp[][];
}

interface LayoutPlan {
  letterhead: "left" | "center" | "split";
  heading: "left" | "center";
  signature: "left" | "center";
  frame: boolean;
  nameSize: number;
  smallSize: number;
  headingSize: number;
  bodySize: number;
  leading: number;
  afterRule: number;
  afterHeading: number;
  paragraphGap: number;
}

/** CO-3's constants are the classic letterhead's, unchanged. */
const PLANS: Record<PrintLayout, LayoutPlan> = {
  classic_letterhead: {
    letterhead: "left",
    heading: "left",
    signature: "left",
    frame: false,
    nameSize: 14,
    smallSize: 10,
    headingSize: 16,
    bodySize: 11,
    leading: 15,
    afterRule: 34,
    afterHeading: 30,
    paragraphGap: 8,
  },
  centered_formal: {
    letterhead: "center",
    heading: "center",
    signature: "center",
    frame: false,
    nameSize: 14,
    smallSize: 10,
    headingSize: 16,
    bodySize: 11,
    leading: 15,
    afterRule: 34,
    afterHeading: 30,
    paragraphGap: 8,
  },
  compact_card: {
    letterhead: "split",
    heading: "left",
    signature: "left",
    frame: true,
    nameSize: 13,
    smallSize: 10,
    headingSize: 14,
    bodySize: 11,
    leading: 14,
    afterRule: 24,
    afterHeading: 22,
    paragraphGap: 6,
  },
};

/** The compact card's frame, 18 pt outside the text margins. */
const FRAME_INSET = 36;
const LOGO_GAP = 14;
const SIGNATURE_RULE = 252;
/** CO-3's body wrap: 88 characters of Helvetica 11 pt in 504 pt. */
const LEGACY_BODY_CHARS = 88;

/**
 * Lay a composed printout out on US Letter. Pure and deterministic: the same
 * document, styling and logo size give the same operations, on the server and
 * in the browser.
 *
 * @param logo  the logo's pixel size, or null when there is none (the logo
 *              section is then simply absent, whatever its placement)
 */
export function layoutPrintDocument(
  doc: PrintDocument,
  styling: PrintStyling,
  logo: { width: number; height: number } | null,
): PrintLayoutResult {
  const plan = PLANS[styling.layout];
  const pair = PRINT_FONT_PAIRS[styling.fontPair];
  const faces = { body: pair.body as PrintFontFace, heading: pair.heading as PrintFontFace };
  // CO-3's arithmetic, kept for the one combination that existed before.
  const legacy = styling.fontPair === "standard" && styling.layout === "classic_letterhead";
  const accent = styling.accentColor === PRINT_STYLING_DEFAULTS.accentColor ? null : styling.accentColor;
  const { width: W, height: H, margin: M } = PRINT_PAGE;
  const L = M;
  const R = W - M;

  const pages: PrintOp[][] = [[]];
  let ops = pages[0];
  if (plan.frame) ops.push({ kind: "frame", x: FRAME_INSET, y: FRAME_INSET, w: W - 2 * FRAME_INSET, h: H - 2 * FRAME_INSET });
  let y = H - M;

  const width = (slot: PrintFontSlot, size: number, t: string) => textWidth(faces[slot], size, t);
  const wrap = (slot: PrintFontSlot, size: number, line: string, room: number, legacyChars: number) =>
    legacy ? wrapToChars(line, legacyChars) : wrapToWidth(line, faces[slot], size, room);
  const xFor = (align: "left" | "center" | "right", left: number, right: number, w: number) =>
    align === "left" ? left : align === "right" ? right - w : (left + right) / 2 - w / 2;

  // ── letterhead ──────────────────────────────────────────────────────────
  let blockBottom = y;
  let textTop = y;
  let area: { left: number; right: number } = { left: L, right: R };
  if (logo) {
    const box = PRINT_LOGO_SIZES[styling.logoSize].box;
    const scale = Math.min(box / logo.width, box / logo.height);
    const w = logo.width * scale;
    const h = logo.height * scale;
    const x = styling.logoPlacement === "left" ? L : styling.logoPlacement === "right" ? R - w : W / 2 - w / 2;
    ops.push({ kind: "image", x, y: y - h, w, h });
    blockBottom = y - h;
    if (styling.logoPlacement === "center") {
      textTop = y - h - 10;
    } else if (plan.letterhead === "center") {
      // Centered text stays centered on the PAGE: clear the logo on both sides.
      area = { left: L + w + LOGO_GAP, right: R - w - LOGO_GAP };
    } else if (styling.logoPlacement === "left") {
      area = { left: L + w + LOGO_GAP, right: R };
    } else {
      area = { left: L, right: R - w - LOGO_GAP };
    }
  }
  const room = area.right - area.left;
  const name = doc.letterhead.name;
  const contact = [...doc.letterhead.addressLines, doc.letterhead.phone].filter(Boolean);

  if (plan.letterhead === "split") {
    // Name on the left, contact details right-aligned on the same band.
    const half = room / 2 - 6;
    let ny = textTop - plan.nameSize;
    let lastName: number | null = null;
    if (name) {
      for (const row of wrap("heading", plan.nameSize, name, half, 0)) {
        ops.push({ kind: "text", role: "letterhead", slot: "heading", size: plan.nameSize, x: area.left, y: ny, text: row, color: accent });
        lastName = ny;
        ny -= plan.nameSize + 2;
      }
    }
    let cy = textTop - plan.smallSize;
    let lastContact: number | null = null;
    for (const line of contact) {
      for (const row of wrap("body", plan.smallSize, line, half, 0)) {
        const w = width("body", plan.smallSize, row);
        ops.push({ kind: "text", role: "letterhead", slot: "body", size: plan.smallSize, x: area.right - w, y: cy, text: row, color: accent });
        lastContact = cy;
        cy -= plan.smallSize + 3;
      }
    }
    const lows = [lastName, lastContact].filter((v): v is number => v !== null);
    const lowest = lows.length > 0 ? Math.min(...lows) - 3 : textTop - plan.nameSize + plan.smallSize;
    blockBottom = Math.min(blockBottom, lowest);
  } else {
    const align = plan.letterhead === "center" ? "center" : "left";
    let ty = textTop - plan.nameSize;
    if (name) {
      // CO-3's generous average widths (bold caps ~0.65 em, digits ~0.56 em).
      for (const row of wrap("heading", plan.nameSize, name, room, Math.floor(room / (plan.nameSize * 0.65)))) {
        const x = legacy ? area.left : xFor(align, area.left, area.right, width("heading", plan.nameSize, row));
        ops.push({ kind: "text", role: "letterhead", slot: "heading", size: plan.nameSize, x, y: ty, text: row, color: accent });
        ty -= plan.nameSize + 2;
      }
      ty += plan.nameSize + 2 - (plan.smallSize + 6);
    }
    for (const line of contact) {
      for (const row of wrap("body", plan.smallSize, line, room, Math.floor(room / (plan.smallSize * 0.56)))) {
        const x = legacy ? area.left : xFor(align, area.left, area.right, width("body", plan.smallSize, row));
        ops.push({ kind: "text", role: "letterhead", slot: "body", size: plan.smallSize, x, y: ty, text: row, color: accent });
        ty -= plan.smallSize + 3;
      }
    }
    blockBottom = Math.min(blockBottom, ty + plan.smallSize);
  }
  y = blockBottom - 10;
  ops.push({ kind: "rule", role: "letterhead", x1: L, x2: R, y, color: accent });
  y -= plan.afterRule;

  // ── heading ─────────────────────────────────────────────────────────────
  if (doc.heading) {
    if (legacy) {
      ops.push({ kind: "text", role: "heading", slot: "heading", size: plan.headingSize, x: L, y, text: printableAscii(doc.heading), color: null });
      y -= plan.afterHeading;
    } else {
      const rows = wrapToWidth(doc.heading, faces.heading, plan.headingSize, R - L);
      rows.forEach((row, i) => {
        const x = xFor(plan.heading, L, R, width("heading", plan.headingSize, row));
        ops.push({ kind: "text", role: "heading", slot: "heading", size: plan.headingSize, x, y, text: row, color: null });
        y -= i === rows.length - 1 ? plan.afterHeading : plan.headingSize + 4;
      });
    }
  }

  // ── body (always black, always left-aligned: readability is not a style) ──
  const newPage = () => {
    ops = [];
    pages.push(ops);
    if (plan.frame) ops.push({ kind: "frame", x: FRAME_INSET, y: FRAME_INSET, w: W - 2 * FRAME_INSET, h: H - 2 * FRAME_INSET });
    y = H - M - plan.bodySize;
  };
  for (const para of doc.paragraphs) {
    for (const line of para) {
      const rows = line.trim() === "" ? [""] : wrap("body", plan.bodySize, line, R - L, LEGACY_BODY_CHARS);
      for (const row of rows) {
        if (y < M + plan.bodySize) newPage();
        if (row) ops.push({ kind: "text", role: "body", slot: "body", size: plan.bodySize, x: L, y, text: row, color: null });
        y -= plan.leading;
      }
    }
    y -= plan.paragraphGap;
  }

  // ── signature line ──────────────────────────────────────────────────────
  if (doc.signatureLine) {
    if (y < M + 60) newPage();
    y -= 36;
    const x1 = plan.signature === "center" ? W / 2 - SIGNATURE_RULE / 2 : L;
    ops.push({ kind: "rule", role: "signature", x1, x2: x1 + SIGNATURE_RULE, y, color: null });
    y -= 14;
    for (const row of wrap("body", plan.smallSize, doc.signatureLine, SIGNATURE_RULE, 60)) {
      const x = legacy ? L : xFor(plan.signature, x1, x1 + SIGNATURE_RULE, width("body", plan.smallSize, row));
      ops.push({ kind: "text", role: "signature", slot: "body", size: plan.smallSize, x, y, text: row, color: null });
      y -= plan.smallSize + 3;
    }
  }

  return { styling, faces, pages };
}

// ── the wire ──────────────────────────────────────────────────────────────

/** PUT /api/platform/print-templates/:type/styling?office= — `null` goes back to the defaults. */
export const PrintStylingSaveRequest = z.object({ styling: z.unknown() }).strict();
