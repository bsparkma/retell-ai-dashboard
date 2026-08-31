/**
 * Photograph the Stage C-2 dumps produced by
 * tests/rcm-shadow-comparison-shots.test.tsx.
 *
 *   pnpm exec vite build                                              # the real CSS
 *   RCM_SHOTS=1 pnpm exec vitest run tests/rcm-shadow-comparison-shots.test.tsx
 *   node scripts/shoot-shadow-comparison.mjs
 *
 * TWO PICTURES PER STATE — 1280 wide, light and dark. This slice adds one panel
 * to a screen Stage C already photographs at both widths, so the review question
 * here is the panel's own copy and its two themes rather than reflow.
 *
 * Every load-bearing detail below is inherited from `shoot-stage-c.mjs` and its
 * header explains each one:
 *   · the theme is a `class` on the root element, stamped here because it never
 *     reaches a body dump;
 *   · `var(--background)`, NOT `hsl(var(--background))` — these tokens are raw
 *     `oklch()`, and the hsl() wrapper makes Chrome drop the declaration, which
 *     renders a dark shot as near-white text on white;
 *   · `--virtual-time-budget` so the shutter waits for the cascade.
 *
 * NO NETWORK, NO BACKEND, NO PHI.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shotsDir = resolve(here, "../tests/.shots");
const assetsDir = resolve(here, "../dist/public/assets");
const outDir = resolve(here, "../../docs/screenshots/rcm-shadow-comparison");
const tmpDir = resolve(shotsDir, ".render-c2");

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => existsSync(p));

if (!CHROME) {
  console.error("No Chrome found. Install one, or point CHROME at a binary.");
  process.exit(1);
}
if (!existsSync(shotsDir)) {
  console.error(`No dumps in ${shotsDir}. Run the shots test with RCM_SHOTS=1 first.`);
  process.exit(1);
}

const cssFile = existsSync(assetsDir)
  ? readdirSync(assetsDir).find((f) => f.endsWith(".css"))
  : null;
if (!cssFile) {
  console.error(`No built CSS in ${assetsDir}. Run \`pnpm exec vite build\` first.`);
  process.exit(1);
}
const css = readFileSync(resolve(assetsDir, cssFile), "utf8");

mkdirSync(outDir, { recursive: true });
mkdirSync(tmpDir, { recursive: true });

/** Chrome shoots the WINDOW, not the content, so each state gets its own height. */
const HEIGHT = {
  "c2-01-ask": 280,
  "c2-02-form": 620,
  "c2-03-answered": 320,
};
const DEFAULT_HEIGHT = 600;
const THEMES = ["light", "dark"];
const WIDTH = 1280;

const dumps = readdirSync(shotsDir)
  .filter((f) => f.startsWith("c2-") && f.endsWith(".html"))
  .sort();
if (dumps.length === 0) {
  console.error("No c2-*.html dumps to shoot. Run the shots test with RCM_SHOTS=1 first.");
  process.exit(1);
}

for (const dump of dumps) {
  const name = dump.replace(/\.html$/, "");
  const body = readFileSync(resolve(shotsDir, dump), "utf8");

  for (const theme of THEMES) {
    const page = `<!doctype html>
<html lang="en" class="${theme}">
<head><meta charset="utf-8"><style>${css}</style>
<style>
  html, body { background: var(--background); color: var(--foreground); }
  body { padding: 8px; }
</style>
</head>
<body>${body}</body>
</html>`;

    const slug = `${name}-${WIDTH}-${theme}`;
    const htmlPath = resolve(tmpDir, `${slug}.html`);
    writeFileSync(htmlPath, page, "utf8");

    const out = resolve(outDir, `${slug}.png`);
    execFileSync(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=2",
        `--window-size=${WIDTH},${HEIGHT[name] ?? DEFAULT_HEIGHT}`,
        "--virtual-time-budget=3000",
        "--screenshot=" + out,
        "file:///" + htmlPath.replace(/\\/g, "/"),
      ],
      { stdio: "ignore" },
    );

    console.log(`wrote ${out}`);
  }
}

rmSync(tmpDir, { recursive: true, force: true });
