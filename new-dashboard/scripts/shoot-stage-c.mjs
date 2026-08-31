/**
 * Photograph the Stage C dumps produced by tests/rcm-stage-c-shots.test.tsx.
 *
 *   pnpm exec vite build                                       # the real CSS
 *   RCM_SHOTS=1 pnpm exec vitest run tests/rcm-stage-c-shots.test.tsx
 *   node scripts/shoot-stage-c.mjs
 *
 * FOUR PICTURES PER SCREEN — 1280 and 1024 wide, light and dark. Stage C is a
 * layout pass, so it has to be reviewed at the widths and in the themes people
 * actually use: a layout that only holds at 1440 in light mode is not finished,
 * and a six-column triage table is exactly the kind of thing that quietly wraps
 * into illegibility at 1024.
 *
 * Dark is a `class="dark"` on the root element, which is what ThemeContext sets
 * on the live app. The class never reaches a body dump, so it is stamped here.
 *
 * `--virtual-time-budget` is load-bearing: without it headless Chrome shoots the
 * page before web fonts and the CSS cascade have settled, and the result is an
 * unstyled flash of the markup.
 *
 * `var(--background)`, NOT `hsl(var(--background))` — this design system's
 * tokens are raw `oklch()` values, so wrapping one in `hsl()` produces an
 * invalid declaration Chrome drops, and a dark shot comes out as near-white text
 * on white. Learned by `shoot-rcm-ux.mjs`, kept here.
 *
 * NO NETWORK, NO BACKEND, NO PHI. The markup comes from a jsdom render of
 * fixture data that lives in the test file, so a screenshot physically cannot
 * contain a real patient.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shotsDir = resolve(here, "../tests/.shots");
const assetsDir = resolve(here, "../dist/public/assets");
const outDir = resolve(here, "../../docs/screenshots/rcm-stage-c");
const tmpDir = resolve(shotsDir, ".render-stage-c");

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
 * under the short ones — which reads as a broken layout rather than a short
 * page. Sized per screen; the narrow frame gets more, because everything
 * reflows taller.
 */
const HEIGHT = {
  "stagec-01-today": [1180, 1560],
  "stagec-02-bring-in": [820, 920],
  "stagec-03-checks-waiting-on": [620, 800],
  "stagec-04-check-triage": [1180, 1560],
  "stagec-05-approve": [1160, 1540],
  "stagec-06-set-aside": [1240, 1660],
  "stagec-07-posted": [1300, 1720],
  "stagec-08-stuck": [1700, 2240],
  "stagec-09-shadow": [1560, 2060],
  "stagec-10-today-empty": [900, 1180],
};

/** A dump with no measured height still gets shot, generously. */
const DEFAULT_HEIGHT = [1400, 1700];

/** The two widths a practice actually uses, and the index into HEIGHT. */
const WIDTHS = [
  [1280, 0],
  [1024, 1],
];
const THEMES = ["light", "dark"];

const dumps = readdirSync(shotsDir)
  .filter((f) => f.startsWith("stagec-") && f.endsWith(".html"))
  .sort();
if (dumps.length === 0) {
  console.error("No stagec-*.html dumps to shoot. Run the shots test with RCM_SHOTS=1 first.");
  process.exit(1);
}

for (const dump of dumps) {
  const name = dump.replace(/\.html$/, "");
  const body = readFileSync(resolve(shotsDir, dump), "utf8");

  for (const [width, heightIndex] of WIDTHS) {
    for (const theme of THEMES) {
      // The theme class explicitly: it lives on the root element in the live
      // app and never makes it into a body dump, and an unset theme renders
      // against a transparent ground.
      const page = `<!doctype html>
<html lang="en" class="${theme}">
<head><meta charset="utf-8"><style>${css}</style>
<style>
  /*
    var(--background), NOT hsl(var(--background)).
    This design system's tokens are raw oklch() values, so wrapping one in
    hsl() produces an invalid declaration that Chrome drops — the page then
    keeps its default WHITE while the cards paint themselves dark, and a dark
    shot comes out as near-white text on white. shoot-rcm-workbench.mjs has
    the same line and never noticed, because it only ever shot light.
  */
  html, body { background: var(--background); color: var(--foreground); }
  /* The dumps are page bodies, not app shells — give them the padding the
     real layout would, so nothing sits flush against the frame. */
  body { padding: 8px; }
</style>
</head>
<body>${body}</body>
</html>`;

      const slug = `${name}-${width}-${theme}`;
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
          `--window-size=${width},${(HEIGHT[name] ?? DEFAULT_HEIGHT)[heightIndex]}`,
          // Let the cascade and fonts settle before the shutter.
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
