/**
 * CDT categories — the ten sections a payer fee schedule is actually printed in.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY SECTIONS AT ALL
 * ═════════════════════════════════════════════════════════════════════════════
 * A real payer schedule is 300–500 rows. Reviewing one as a single list means
 * scrolling past three hundred codes to check the four crowns, and it gives the
 * reader no way to say "I have checked restorative". Every fee schedule the
 * office has ever seen on paper is already grouped this way, so grouping is not
 * a new organising idea — it is the one they arrived with.
 *
 * THE FIRST DIGIT IS THE CATEGORY. That is how CDT is defined, how Open Dental
 * groups its own fee windows, and how every payer PDF in the corpus prints. So
 * the bucket is a substring, not a lookup table that would need maintaining as
 * the ADA publishes codes each year: a D-code released next January lands in
 * the right section on the day it appears, with nothing to update.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TWO BUCKETS HOLD MORE THAN THEIR NAME SAYS
 * ═════════════════════════════════════════════════════════════════════════════
 * D5 is removable prosthodontics (D5000–D5899) AND maxillofacial prosthetics
 * (D5900–D5999). D6 is implant services (D6000–D6199) AND fixed prosthodontics
 * (D6200–D6999). Splitting either would mean a range table, and ranges are
 * exactly the thing that goes stale silently — a code added just past a
 * boundary would file itself in the wrong place with nothing to notice. The
 * labels below say both halves out loud instead, which is honest about the
 * grouping without pretending to a precision it would not keep.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE CONSTANT, THREE READERS
 * ═════════════════════════════════════════════════════════════════════════════
 * The section headers, the jump menu, and the per-section counts all read this
 * array. If any of them carried its own list, a menu entry could name a section
 * that does not exist on the page, or a section could render with no way to
 * jump to it — and the reader would have no way to tell which was wrong.
 */

import type { FeesImportRow } from "./api";

export interface CdtCategory {
  /** The leading digit, which is also the section's DOM id suffix. */
  digit: string;
  /** What the section header says. */
  label: string;
}

/**
 * The ten sections, in code order. This IS the display order: sections sort by
 * their digit rather than by how many rows fall in them, because a schedule
 * read in code order is a schedule somebody can compare against the paper one
 * on their desk.
 */
export const CDT_CATEGORIES: readonly CdtCategory[] = [
  { digit: "0", label: "D0 · Diagnostic" },
  { digit: "1", label: "D1 · Preventive" },
  { digit: "2", label: "D2 · Restorative" },
  { digit: "3", label: "D3 · Endodontics" },
  { digit: "4", label: "D4 · Periodontics" },
  { digit: "5", label: "D5 · Prosthodontics, removable" },
  { digit: "6", label: "D6 · Implants & fixed prosthodontics" },
  { digit: "7", label: "D7 · Oral & maxillofacial surgery" },
  { digit: "8", label: "D8 · Orthodontics" },
  { digit: "9", label: "D9 · Adjunctive general services" },
] as const;

/**
 * Anything whose code does not start `D` plus a digit.
 *
 * The column CHECK makes this unreachable — `fees_import_row.proc_code` is
 * `D` + four digits and the parser normalises before storing. It exists so that
 * a row can never be dropped from the page by a grouping function: a fee that
 * is in the batch but in no section would be a fee somebody posts without ever
 * having seen it, which is the failure this whole screen is built against.
 */
export const CDT_UNCATEGORISED: CdtCategory = { digit: "other", label: "Other codes" };

/** Which section a procedure code belongs to. */
export function cdtCategoryFor(procCode: string): CdtCategory {
  const digit = /^D(\d)/.exec(procCode.toUpperCase())?.[1];
  return CDT_CATEGORIES.find((c) => c.digit === digit) ?? CDT_UNCATEGORISED;
}

/** The DOM id a section header carries, so the jump menu can reach it. */
export function cdtSectionId(category: CdtCategory): string {
  return `fees-section-${category.digit}`;
}

export interface CdtSection {
  category: CdtCategory;
  /** The section's rows, IN FILE ORDER — see below. */
  rows: FeesImportRow[];
  /** Rows carrying a warning nobody has answered yet. Drives the jump menu's badge. */
  unresolvedCount: number;
}

/**
 * Split a batch's rows into sections.
 *
 * FILE ORDER IS PRESERVED INSIDE A SECTION. The rows arrive in the order the
 * parser read them out of the file, and that order is evidence: a reader
 * checking a row against the PDF on their desk finds it where the PDF has it.
 * Sorting within a section — by code, by fee — would break the one
 * correspondence the preview has with the document it came from.
 *
 * EMPTY SECTIONS ARE DROPPED. A schedule that lists no orthodontics should not
 * render an orthodontics heading; a heading with nothing under it reads as a
 * section that failed to load.
 */
export function groupRowsByCategory(rows: readonly FeesImportRow[]): CdtSection[] {
  const byDigit = new Map<string, FeesImportRow[]>();
  for (const row of rows) {
    const { digit } = cdtCategoryFor(row.procCode);
    const bucket = byDigit.get(digit);
    if (bucket) bucket.push(row);
    else byDigit.set(digit, [row]);
  }

  const ordered = [...CDT_CATEGORIES, CDT_UNCATEGORISED];
  const sections: CdtSection[] = [];
  for (const category of ordered) {
    const found = byDigit.get(category.digit);
    if (!found || found.length === 0) continue;
    sections.push({
      category,
      rows: found,
      unresolvedCount: found.filter(isUnresolved).length,
    });
  }
  return sections;
}

/**
 * Does this row still need a human?
 *
 * WARNED AND UNDECIDED — the same predicate the server's posting gate uses
 * (`jsonb_array_length(parse_warnings) > 0 AND decision = 'pending'`). A clean
 * row never needs a decision and never counts here, which is why a hundred-row
 * file with two flagged rows shows "2" and not "100".
 *
 * `edited` counts as resolved, like `accepted` and `excluded`: somebody who
 * typed the fee they hold has answered the warning at least as completely as
 * somebody who accepted the parsed number.
 *
 * This is the COURTESY count. The server decides whether the batch can post,
 * and the chip reaching zero is a reflection of that rather than a second
 * opinion about it.
 */
export function isUnresolved(row: FeesImportRow): boolean {
  return row.warnings.length > 0 && row.decision === "pending";
}

/**
 * Every unresolved row, in the order they appear on the page.
 *
 * Section order, then file order within a section — the same order the eye
 * travels — so "next warning" moves down the screen rather than jumping
 * backwards to a row the reader has already passed.
 */
export function unresolvedRowIds(sections: readonly CdtSection[]): string[] {
  const ids: string[] = [];
  for (const section of sections) {
    for (const row of section.rows) {
      if (isUnresolved(row)) ids.push(row.rowId);
    }
  }
  return ids;
}
