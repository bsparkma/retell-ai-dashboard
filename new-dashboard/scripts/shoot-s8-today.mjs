/**
 * Photograph Today — populated and empty — for the S8 board-fidelity pass.
 *
 *   pnpm exec vite build                                      # the real CSS
 *   RCM_SHOTS=1 pnpm exec vitest run tests/rcm-stage-c-shots.test.tsx
 *   node scripts/shoot-s8-today.mjs before|after
 *
 * It reuses the Stage C dumps rather than growing a second fixture file: those
 * two cases ALREADY render Today populated and Today finished, from synthetic
 * data that lives in the test. A second copy would be a second thing to keep
 * true.
 *
 * It writes ONLY the two Today shots, into `docs/screenshots/rcm-s8-today/`, so
 * running it does not rewrite the whole Stage C gallery the way
 * `shoot-stage-c.mjs` does.
 *
 * NO NETWORK, NO BACKEND, NO PHI — the markup is a jsdom render of fixtures.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const prefix = process.argv[2];
if (prefix !== "before" && prefix !== "after") {
  console.error("usage: node scripts/shoot-s8-today.mjs before|after");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const shotsDir = resolve(here, "../tests/.shots");
const assetsDir = resolve(here, "../dist/public/assets");
const outDir = resolve(here, "../../docs/screenshots/rcm-s8-today");
const tmpDir = resolve(shotsDir, ".render-s8");

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
 * dump name → [output slug, frame height]. Light only; 1280 wide.
 *
 * Chrome's `--screenshot` captures the WINDOW, not the content, so the height
 * is per shot — one figure for all three leaves a screenful of blank canvas
 * under the short ones, which reads as a broken layout rather than a short
 * page. Measured against the AFTER markup; the BEFORE pass reuses them so the
 * two galleries are directly comparable rather than each cropped to fit.
 */
const SHOTS = [
  ["stagec-01-today", "today-populated", 1010],
  ["stagec-10-today-empty", "today-empty", 800],
  // The *Get work in* fold, open — the two dashed zones the artboard draws.
  ["stagec-02-get-work-in", "today-get-work-in", 930],
];

for (const [dump, slug, height] of SHOTS) {
  const file = resolve(shotsDir, `${dump}.html`);
  if (!existsSync(file)) {
    console.error(`No dump at ${file}. Run the shots test with RCM_SHOTS=1 first.`);
    process.exit(1);
  }
  const body = readFileSync(file, "utf8");
  const page = `<!doctype html>
<html lang="en" class="light">
<head><meta charset="utf-8"><style>${css}</style>
<style>
  /* var(--background), NOT hsl(var(--background)) — this system's tokens are
     raw oklch() and Chrome drops the wrapped declaration. */
  html, body { background: var(--background); color: var(--foreground); }
  body { padding: 8px; }
</style>
</head>
<body>${body}</body>
</html>`;
  const htmlPath = resolve(tmpDir, `${prefix}-${slug}.html`);
  writeFileSync(htmlPath, page, "utf8");
  const out = resolve(outDir, `${prefix}-${slug}.png`);
  execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      `--window-size=1280,${height}`,
      "--virtual-time-budget=3000",
      "--screenshot=" + out,
      "file:///" + htmlPath.split("\\").join("/"),
    ],
    { stdio: "ignore" },
  );
  console.log(`wrote ${out}`);
}

rmSync(tmpDir, { recursive: true, force: true });
