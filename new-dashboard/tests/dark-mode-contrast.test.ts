/**
 * Dark-mode contrast guard (source scan).
 *
 * The 4b token flip derived a dark palette, so any element still carrying a
 * hardcoded light background bypasses it and stays light in dark mode — the
 * bug Beau's visual pass found (segmented-control pills were `white` with
 * `color: var(--foreground)`, i.e. white-on-white once --foreground inverts).
 *
 * This scans the client source for hardcoded light backgrounds instead of
 * rendering, because the breakage is in the stylesheet layer: jsdom computes
 * no cascade, so a render test would pass while the real page is unreadable.
 *
 * Allowed exceptions are listed explicitly with the reason they are correct.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CLIENT_SRC = path.resolve(import.meta.dirname, "..", "client", "src");

/**
 * Files whose light backgrounds are CORRECT and must not be tokenized:
 *  - the email preview/blocks render a real email, which the recipient's mail
 *    client shows on white regardless of our app theme,
 *  - the chart primitive matches recharts' own stroke="#fff" attributes; those
 *    are selectors, not colours we set.
 */
const ALLOWED = [
  path.join("features", "tc", "email", "EmailPreview.tsx"),
  path.join("features", "tc", "email", "blockFactory.ts"),
  path.join("components", "ui", "chart.tsx"),
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function offendingLines(file: string): string[] {
  const rel = path.relative(CLIENT_SRC, file);
  if (ALLOWED.some((a) => rel.endsWith(a))) return [];
  const hits: string[] = [];
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      // Inline styles: backgroundColor/background set to literal white.
      const inlineWhite = /(backgroundColor|background)\s*:\s*["'`]?(white|#fff(fff)?)\b/i.test(line);
      // Tailwind bg-white without a dark: counterpart. `bg-white/10` and
      // friends are translucent tints (used on the always-dark sidebar) and
      // read correctly over any surface, so they are not flagged.
      const bareBgWhite = /\bbg-white\b(?!\/)/.test(line) && !/dark:bg-/.test(line);
      if (inlineWhite || bareBgWhite) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  return hits;
}

describe("dark-mode contrast", () => {
  it("has no hardcoded light backgrounds outside the documented exceptions", () => {
    const offenders = sourceFiles(CLIENT_SRC).flatMap(offendingLines);
    expect(offenders).toEqual([]);
  });

  it("keeps segmented-control pills on a surface token, not a literal", () => {
    // These four were the reported bug: an active pill painted `white` while
    // its label used var(--foreground), which inverts to near-white in dark.
    const files = [
      path.join("features", "calendar", "components", "OpenSlots.tsx"),
      path.join("pages", "Analytics.tsx"),
      path.join("pages", "Callbacks.tsx"),
      path.join("pages", "calls", "CallWorklist.tsx"),
    ];
    for (const rel of files) {
      const src = readFileSync(path.join(CLIENT_SRC, rel), "utf8");
      expect(src, `${rel} should paint the active pill with var(--card)`).toMatch(
        /backgroundColor:[^\n]*var\(--card\)/,
      );
    }
  });

  it("never pairs a foreground-token label with a literal white background", () => {
    // The precise failure mode: same element, literal white + var(--foreground).
    const offenders: string[] = [];
    for (const file of sourceFiles(CLIENT_SRC)) {
      const rel = path.relative(CLIENT_SRC, file);
      if (ALLOWED.some((a) => rel.endsWith(a))) continue;
      const src = readFileSync(file, "utf8");
      const re = /backgroundColor\s*:[^;\n]*["'`]white["'`][^}]*?color\s*:[^;\n]*var\(--foreground\)/gs;
      if (re.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
