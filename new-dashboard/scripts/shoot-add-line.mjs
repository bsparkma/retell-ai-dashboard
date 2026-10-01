/**
 * Photograph the add-a-line dumps produced by tests/rcm-add-line-shots.test.tsx.
 *
 *   pnpm exec vite build                                      # the real CSS
 *   RCM_SHOTS=1 pnpm exec vitest run tests/rcm-add-line-shots.test.tsx
 *   node scripts/shoot-add-line.mjs
 *
 * FIVE STATES: the gap named, the form open with the missing line typed in, the
 * added line marked and attributed with the claim now adding up, a figure just
 * confirmed with the work moved on, and a line struck as not on the page.
 *
 * ONE VIEWPORT, 1280x900, light and dark. The two-height pair belongs to the
 * one-scroll-per-page audit in `shoot-flow-fix.mjs`; nothing here changes the
 * scroll geometry, and shooting the same layout twice would prove it twice.
 *
 * Everything below is `shoot-flow-fix.mjs`, unchanged, down to the two lessons
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
const outDir = resolve(here, "../../docs/screenshots/rcm-confirm-in-place");
const tmpDir = resolve(shotsDir, ".render-add-line");

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
/*
 * TWO VIEWPORT HEIGHTS — item 2's proof.
 *
 * 800 is the brief's own figure and the one a practice laptop actually has; 560
 * is deliberately shorter than the content, which is where a second scrollbar
 * would show itself. The page must scroll ONCE at both.
 *
 * Light only at the short height: what is being shown there is the scroll
 * behaviour, and a second theme of the same geometry proves nothing twice.
 */
const HEIGHTS = [{ px: 900, suffix: "page", themes: ["light", "dark"] }];

const WIDTH = 1280;

const dumps = readdirSync(shotsDir)
  .filter((f) => f.startsWith("al-") && f.endsWith(".html"))
  .sort();
if (dumps.length === 0) {
  console.error("No al-*.html dumps to shoot. Run the shots test with RCM_SHOTS=1 first.");
  process.exit(1);
}

for (const dump of dumps) {
  const name = dump.replace(/\.html$/, "");
  const body = readFileSync(resolve(shotsDir, dump), "utf8");

  for (const { px, suffix, themes } of HEIGHTS) {
    for (const theme of themes) {
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

      const slug = `${name}-${WIDTH}x${px}-${suffix}-${theme}`;
      const htmlPath = resolve(tmpDir, `${slug}.html`);
      writeFileSync(htmlPath, page, "utf8");

      const out = resolve(outDir, `${slug}.png`);
      execFileSync(
        CHROME,
        [
          "--headless=new",
          "--disable-gpu",
          /*
           * SCROLLBARS ARE THE POINT of the short shot, so they are NOT hidden
           * here — `--hide-scrollbars` is exactly the flag that would erase the
           * evidence this pair exists to show.
           */
          "--force-device-scale-factor=2",
          `--window-size=${WIDTH},${px}`,
          "--virtual-time-budget=3000",
          "--screenshot=" + out,
          "file:///" + htmlPath.replace(/\\/g, "/"),
        ],
        { stdio: "ignore" },
      );

      console.log(`wrote ${out}`);
    }
  }
}

rmSync(tmpDir, { recursive: true, force: true });
