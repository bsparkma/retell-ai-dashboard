/**
 * Photograph the RCM UX dumps produced by tests/rcm-ux-shots.test.tsx.
 *
 *   pnpm exec vite build                                   # the real CSS
 *   RCM_SHOTS=1 pnpm exec vitest run tests/rcm-ux-shots.test.tsx
 *   node scripts/shoot-rcm-ux.mjs
 *
 * FOUR PICTURES PER SCREEN, and that is the point of this script rather than
 * reusing `shoot-rcm-workbench.mjs`: this slice is a UX change, so it has to be
 * reviewed at the widths and in the themes people actually use — 1280 and 1024
 * wide, light and dark. A layout that only holds at 1440 in light mode is not
 * finished, and the seven-across stepper is exactly the kind of thing that
 * quietly wraps into illegibility at 1024.
 *
 * Dark is a `class="dark"` on the root element, which is what ThemeContext sets
 * on the live app. The class never reaches a body dump, so it is stamped here.
 *
 * `--virtual-time-budget` is load-bearing: without it headless Chrome shoots
 * the page before web fonts and the CSS cascade have settled and the result is
 * an unstyled flash of the markup.
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
const outDir = resolve(here, "../../docs/screenshots/rcm-ux");
const tmpDir = resolve(shotsDir, ".render-ux");

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
  "ux-01-overview": [1080, 1320],
  "ux-02-remittance-fresh": [1320, 1640],
  "ux-03-remittance-ready": [1280, 1600],
  "ux-04-claim-confirmed": [1180, 1520],
  "ux-05-posting": [600, 620],
  "ux-06-posting-idle": [420, 440],
  "ux-07-list-filtered": [560, 640],
  "ux-08-list-empty": [520, 600],
  // ── Stage A ──
  "shell-01-today": [1300, 1660],
  "shell-02-checks-set-aside": [560, 660],
  "shell-03-check-ready-to-post": [1060, 1340],
  "shell-04-check-shadow": [1080, 1360],
  "shell-05-set-aside-dialog": [1200, 1520],
  // ── Stage B1: the workbench ──
  "bench-01-verdict-green": [1140, 1460],
  "bench-02-verdict-amber": [1260, 1600],
  "bench-03-verdict-red": [1220, 1560],
  "bench-04-identity-mismatch": [1200, 1520],
  "bench-05-reason-picker": [1260, 1600],
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
  .filter(
    (f) =>
      (f.startsWith("ux-") || f.startsWith("shell-") || f.startsWith("bench-")) &&
      f.endsWith(".html"),
  )
  .sort();
if (dumps.length === 0) {
  console.error("No ux-*.html, shell-*.html or bench-*.html dumps to shoot.");
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
