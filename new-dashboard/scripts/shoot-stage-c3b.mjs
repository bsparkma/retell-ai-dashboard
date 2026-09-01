/**
 * Photograph the Stage C-3b dumps produced by tests/rcm-stage-c3b-shots.test.tsx.
 *
 *   pnpm exec vite build                                           # the real CSS
 *   RCM_SHOTS=1 pnpm exec vitest run tests/rcm-stage-c3b-shots.test.tsx
 *   node scripts/shoot-stage-c3b.mjs
 *
 * TWO PICTURES — 1280 wide, light and dark. C-3b adds a line to a list row
 * rather than reflowing anything, so the review width is the one the brief
 * named and there is no second width to learn from.
 *
 * Everything below is `shoot-stage-c3.mjs`, unchanged, down to the two lessons
 * that file records and this one would otherwise have to relearn:
 *
 *   · dark is a `class="dark"` on the root element, which is what ThemeContext
 *     sets on the live app. The class never reaches a body dump, so it is
 *     stamped here.
 *   · `var(--background)`, NOT `hsl(var(--background))` — this design system's
 *     tokens are raw `oklch()` values, so wrapping one in `hsl()` produces an
 *     invalid declaration Chrome drops and a dark shot comes out as near-white
 *     text on white.
 *
 * `--virtual-time-budget` is load-bearing: without it headless Chrome shoots the
 * page before web fonts and the CSS cascade have settled.
 *
 * NO NETWORK, NO BACKEND, NO PHI. The markup comes from a jsdom render of
 * fixture data that lives in the test file.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shotsDir = resolve(here, "../tests/.shots");
const assetsDir = resolve(here, "../dist/public/assets");
const outDir = resolve(here, "../../docs/screenshots/rcm-stage-c3b");
const tmpDir = resolve(shotsDir, ".render-stage-c3b");

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

/**
 * Frame height per shot. Chrome's --screenshot captures the WINDOW, not the
 * content, so one height for every page leaves a screenful of empty canvas
 * under the short ones — which reads as a broken layout rather than a short page.
 */
const HEIGHT = {
  "c3b-01-checks-patient-names": 660,
};
const DEFAULT_HEIGHT = 1200;

const WIDTH = 1280;
const THEMES = ["light", "dark"];

const dumps = readdirSync(shotsDir)
  .filter((f) => f.startsWith("c3b-") && f.endsWith(".html"))
  .sort();
if (dumps.length === 0) {
  console.error("No c3b-*.html dumps to shoot. Run the shots test with RCM_SHOTS=1 first.");
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
