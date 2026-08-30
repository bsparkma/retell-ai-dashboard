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
