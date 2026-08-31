/**
 * THE WORDS A BILLER READS — enforced, not hoped for.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS TEST EXISTS
 * ═════════════════════════════════════════════════════════════════════════════
 * On 2026-08-30 the person who commissioned this product read these screens cold
 * and could not parse them. His words: *"the term drain, I don't understand —
 * that does not make any sense to me."* The Roland biller — his wife — starts on
 * this product shortly, and his conclusion was: *"if I present it to her now with
 * this weird language then she will abandon it quickly."*
 *
 * Renaming the strings once fixes today. It does not fix the next slice, where
 * somebody implementing `postingDrain.js` writes a sentence in the vocabulary
 * they have been reading all afternoon and nothing objects. Vocabulary drift is
 * not a bug that crashes; it is a product slowly reverting to the language of
 * its own implementation.
 *
 * So the rule is a test.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT SCANS, AND WHAT IT DELIBERATELY DOES NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * ONLY RENDERED STRINGS. Machine slugs, columns, types, route paths, test ids,
 * class names and code comments are UNCHANGED by this whole effort and must
 * stay that way — `drain_step`, `canDrain`, `POST /posting/drain` and
 * `withdrawn` are the vocabulary the server and the schema speak, and renaming
 * those to match a biller's ear would be a large, risky change that buys nothing.
 *
 * So the scan walks the TypeScript AST rather than grepping, and skips:
 *
 *   · import/export module specifiers          `from "@/features/rcm/api"`
 *   · object literal KEYS                       `{ drain_step: … }`
 *   · property access                           `row.drainEnabled`
 *   · a fixed list of machine-valued JSX attrs  className, data-testid, href, …
 *   · SLUG-SHAPED strings — no space, no capital letter. `drain_disabled_for_office`,
 *     `/rcm/posting`, `post-this-check-button`. A sentence a person reads has a
 *     space or a capital in it; a machine value does not. This is the one
 *     heuristic here and it is deliberately conservative: it can only ever let a
 *     lowercase single word through, and "drain" as a whole rendered label is
 *     exactly what §1 renamed, so the tests below cover that case directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ALLOW-LIST
 * ─────────────────────────────────────────────────────────────────────────────
 * Empty. Every entry would have to be a place where a banned word is genuinely
 * the right word for a biller, justified in the PR. Nothing in this slice needed
 * one — which is itself the useful result, because the banned list was drawn up
 * from what a real reader could not parse.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(__dirname, "..");
const SCANNED = [
  "client/src/pages/rcm",
  "client/src/features/rcm",
  "client/src/components/rcm",
];

/**
 * The words, and why each one is out.
 *
 * `plan` is here on the strength of §1's parenthesis — *"never 'plan' — in a
 * dental office that means treatment plan or insurance plan"* — which is the
 * sharpest one on the list: it is not jargon a biller has never met, it is a
 * word she has met meaning something else entirely, so it does not read as
 * confusing, it reads as WRONG.
 *
 * Word-boundary regexes, never `includes`. "Admin → Offices" contains
 * "Admin → Office", and a substring test once passed on exactly the drift it was
 * written to catch (PR #123). `drain` must not fire on "drainage" and `batch`
 * must not fire on "batches" — no, it must: a plural is the same word to a
 * reader, so the patterns take their own plurals explicitly.
 */
const BANNED: { pattern: RegExp; instead: string }[] = [
  { pattern: /\bdrains?\b/i, instead: "Post to Open Dental" },
  { pattern: /\bdraining\b/i, instead: "posting" },
  { pattern: /\bdrained\b/i, instead: "posted" },
  { pattern: /\bread[- ]backs?\b/i, instead: "Confirmed in Open Dental" },
  { pattern: /\bposting plans?\b/i, instead: "this check / posting" },
  { pattern: /\bwithheld\b/i, instead: "not ready yet / held back" },
  { pattern: /\brecoupments?\b/i, instead: "takeback" },
  { pattern: /\bbatch(es)?\b/i, instead: "check / remittance" },
  {
    pattern: /\bplans?\b/i,
    instead: "check / posting — 'plan' means treatment plan or insurance plan at a dental office",
  },
];

/**
 * JSX attributes whose value is a machine identifier rather than prose.
 *
 * Not a heuristic — an explicit list, so an attribute that starts carrying copy
 * (a future `aria-label`, say) is scanned by default rather than exempt by
 * accident. `aria-label` and `title` are NOT here, deliberately: a screen reader
 * user reads them, so they are prose.
 */
const MACHINE_ATTRS = new Set([
  "className",
  "class",
  "data-testid",
  "testId",
  "href",
  "to",
  "id",
  "key",
  "name",
  "type",
  "role",
  "value",
  "htmlFor",
  "aria-controls",
  "aria-labelledby",
  "aria-describedby",
  "style",
  "src",
  "target",
  "rel",
]);

/** A machine value: no space and no capital letter. See the header. */
const SLUG = /^[^A-Z\s]*$/;

interface Hit {
  file: string;
  line: number;
  text: string;
  instead: string;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Every string a PERSON could read in one file.
 *
 * String literals, no-substitution templates, the cooked chunks of a template
 * expression, and JSX text — with the exclusions in the header applied at the
 * node's PARENT, which is the only place the distinction is knowable.
 */
function renderedStrings(file: string, source: string): { text: string; line: number }[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: { text: string; line: number }[] = [];

  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  function excluded(node: ts.Node): boolean {
    const parent = node.parent;
    if (!parent) return false;
    // `from "…"` and `import("…")`
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
    if (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) {
      return true;
    }
    // `{ someKey: … }` and `obj["someKey"]` — identifiers, not copy.
    if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
    if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
    if (ts.isLiteralTypeNode(parent)) return true;
    // A JSX attribute on the machine list.
    if (ts.isJsxAttribute(parent) && MACHINE_ATTRS.has(parent.name.getText(sf))) return true;
    if (
      ts.isJsxExpression(parent) &&
      parent.parent &&
      ts.isJsxAttribute(parent.parent) &&
      MACHINE_ATTRS.has(parent.parent.name.getText(sf))
    ) {
      return true;
    }
    return false;
  }

  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!excluded(node)) found.push({ text: node.text, line: lineOf(node.getStart(sf)) });
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      found.push({ text: node.text, line: lineOf(node.getStart(sf)) });
    } else if (ts.isJsxText(node)) {
      const text = node.text.trim();
      if (text) found.push({ text, line: lineOf(node.getStart(sf)) });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const dir of SCANNED) {
    for (const file of walkFiles(join(ROOT, dir))) {
      const source = readFileSync(file, "utf8");
      for (const { text, line } of renderedStrings(file, source)) {
        // A machine value, not a sentence. See the header.
        if (SLUG.test(text)) continue;
        for (const { pattern, instead } of BANNED) {
          if (pattern.test(text)) {
            hits.push({
              file: relative(ROOT, file).replace(/\\/g, "/"),
              line,
              text: text.length > 120 ? `${text.slice(0, 117)}…` : text,
              instead,
            });
            break;
          }
        }
      }
    }
  }
  return hits;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * A SECOND, TIGHTER LIST — the shadow-mode comparison (Stage C-2)
 * ═════════════════════════════════════════════════════════════════════════════
 * The list above is about a biller not understanding the words. This one is
 * about a biller understanding them perfectly and answering less honestly
 * because of it.
 *
 * C-2 asks her, on every approved check while posting is switched off, whether
 * what the app worked out came out the same as what she put into Open Dental by
 * hand. **She is checking the software. She is not being graded.** The moment
 * that copy reads as a measurement of her — a proportion, a rating, a run she is
 * keeping up — the honest answer starts to carry a cost, and an honest answer is
 * the entire product of the shadow period. There is no second source for it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS SCOPED TO FILES RATHER THAN ADDED TO `BANNED`
 * ─────────────────────────────────────────────────────────────────────────────
 * Because three of these words are RIGHT elsewhere in this module, and banning
 * them everywhere would either break working screens or need an allow-list that
 * hollows the rule out:
 *
 *   · `score` is what the Open Dental matcher produces — "A score, not a
 *     decision. Read the evidence below." is the candidate card telling the
 *     truth about a ranking.
 *   · `correct` appears in "The payment itself posted correctly and is
 *     unaffected" and "Nothing here can post until that is corrected" — both
 *     about a payment and a claim, neither about a person.
 *
 * The rule being enforced is not "this module never says score". It is "the
 * comparison never grades the biller", and its scope is the surface that asks
 * her. So: an explicit file list, and a test below that fails if one of those
 * files is renamed or moved — a guard pointed at a path that no longer exists
 * passes forever.
 */
const COMPARISON_FILES = [
  "client/src/components/rcm/CheckComparison.tsx",
  "client/src/features/rcm/comparison.ts",
  "client/src/pages/admin/RcmShadowComparisonCard.tsx",
];

/**
 * Banned on the comparison surface, and why each one is out.
 *
 * `correct` is here in every form — it is the most tempting and the worst. "Did
 * the app get this correct" invites "and how often are YOU correct", and the
 * shipped copy asks "did the app get this check right?" precisely to keep the
 * subject the software.
 */
const COMPARISON_BANNED: { pattern: RegExp; instead: string }[] = [
  { pattern: /\baccura(cy|te)\b/i, instead: "say what happened — 'came out the same'" },
  { pattern: /\bscores?\b|\bscoring\b|\bscored\b/i, instead: "nothing — do not keep a score here" },
  { pattern: /\bgrades?\b|\bgraded\b|\bgrading\b/i, instead: "nothing — she is not being graded" },
  {
    pattern: /\bcorrect(ly|ed|ion|ness)?\b|\bincorrect(ly)?\b/i,
    instead: "'right' about the app, or 'the same' about the two figures",
  },
  { pattern: /\bstreaks?\b/i, instead: "nothing — a run is the admin's number, not hers" },
  { pattern: /\b\d+\s*%|\bpercent(age)?\b/i, instead: "counts — a proportion cannot answer this" },
  { pattern: /\berror rate\b|\bhit rate\b|\bpass rate\b/i, instead: "counts" },
];

function scanComparison(): Hit[] {
  const hits: Hit[] = [];
  for (const rel of COMPARISON_FILES) {
    const file = join(ROOT, rel);
    const source = readFileSync(file, "utf8");
    for (const { text, line } of renderedStrings(file, source)) {
      if (SLUG.test(text)) continue;
      for (const { pattern, instead } of COMPARISON_BANNED) {
        if (pattern.test(text)) {
          hits.push({ file: rel, line, text, instead });
          break;
        }
      }
    }
  }
  return hits;
}

describe("the RCM screens speak a biller's language", () => {
  it("scans something — a scanner that found no files would pass forever", () => {
    let n = 0;
    for (const dir of SCANNED) n += walkFiles(join(ROOT, dir)).length;
    expect(n).toBeGreaterThan(10);
  });

  it("recognises prose and ignores machine values", () => {
    // The heuristic, asserted directly, because everything below depends on it.
    const sample = `
      const a = "drain_disabled_for_office";
      const b = "/rcm/posting";
      const c = "post-this-check-button";
      const d = "Nothing waiting to drain";
      const e = { drain_step: 1 };
      import x from "./drain";
      const f = <div className="drain-x" data-testid="drain-y" title="Drain it" />;
    `;
    const strings = renderedStrings("sample.tsx", sample)
      .filter((s) => !SLUG.test(s.text))
      .map((s) => s.text);
    expect(strings).toContain("Nothing waiting to drain");
    // `title` is prose — a screen-reader user reads it.
    expect(strings).toContain("Drain it");
    // …and none of the machine values came through.
    expect(strings).not.toContain("drain_disabled_for_office");
    expect(strings).not.toContain("/rcm/posting");
    expect(strings).not.toContain("drain-x");
    expect(strings).not.toContain("./drain");
  });

  it("has no banned word in any string a person reads", () => {
    const hits = scan();
    const report = hits
      .map((h) => `  ${h.file}:${h.line}\n    "${h.text}"\n    → say: ${h.instead}`)
      .join("\n");
    expect(
      hits,
      hits.length === 0
        ? ""
        : `\n${hits.length} string(s) still speak the implementation's language:\n\n${report}\n\n` +
            `Machine slugs, columns, types and route paths do NOT change — only what a person reads.\n`,
    ).toEqual([]);
  });
});

describe("the shadow-mode comparison never grades the biller", () => {
  it("points at files that exist — a guard aimed at a moved file passes forever", () => {
    for (const rel of COMPARISON_FILES) {
      expect(statSync(join(ROOT, rel)).isFile(), `${rel} — did this file move?`).toBe(true);
    }
  });

  it("finds the copy it is supposed to be guarding", () => {
    // The scan must be reading real sentences off these files, or every
    // assertion below is vacuous.
    const strings = COMPARISON_FILES.flatMap((rel) =>
      renderedStrings(join(ROOT, rel), readFileSync(join(ROOT, rel), "utf8"))
        .map((s) => s.text)
        .filter((t) => !SLUG.test(t)),
    );
    expect(strings).toContain("Did the app get this check right?");
    expect(strings.some((s) => s.includes("same as I did by hand"))).toBe(true);
  });

  it("catches the words it bans", () => {
    // The patterns, asserted directly, so a typo in one cannot make the rule
    // silently vacuous.
    const offenders = [
      "94% accuracy this month",
      "Your score so far",
      "How the app graded out",
      "Did the app get this correct?",
      "17 in a row — keep the streak going",
    ];
    for (const text of offenders) {
      expect(
        COMPARISON_BANNED.some((b) => b.pattern.test(text)),
        `"${text}" should have been caught`,
      ).toBe(true);
    }
    // …and does not fire on the copy that actually shipped.
    for (const text of [
      "Did the app get this check right?",
      "Yes — same as I did by hand",
      "No — something was off",
      "So far: 18 checks compared, you marked 17 the same and 1 off.",
    ]) {
      expect(
        COMPARISON_BANNED.some((b) => b.pattern.test(text)),
        `"${text}" is the shipped copy and must pass`,
      ).toBe(false);
    }
  });

  it("has no scoring, rating or grading language anywhere on the comparison surface", () => {
    const hits = scanComparison();
    const report = hits
      .map((h) => `  ${h.file}:${h.line}\n    "${h.text}"\n    → instead: ${h.instead}`)
      .join("\n");
    expect(
      hits,
      hits.length === 0
        ? ""
        : `\n${hits.length} string(s) read as though the BILLER were the thing being measured:\n\n` +
            `${report}\n\nShe is checking the software. If the copy grades her, she stops ` +
            `answering honestly — and the honest answer is the only product of the shadow period.\n`,
    ).toEqual([]);
  });
});
