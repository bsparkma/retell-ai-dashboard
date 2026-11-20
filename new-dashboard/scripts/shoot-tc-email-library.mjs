/**
 * Photograph the EL-1 patient email library dumps produced by
 * tests/tc-email-library-shots.test.tsx (/admin/patient-emails).
 *
 *   pnpm exec vite build                                        # the real CSS
 *   TC_SHOTS=1 pnpm exec vitest run tests/tc-email-library-shots.test.tsx
 *   node scripts/shoot-tc-email-library.mjs
 *
 * 1280 x 1400, LIGHT AND DARK: a desk, tall enough to show the questionnaire
 * beside the preview. Output goes to docs/screenshots/tc/.
 *
 * shoot-tc-sms.mjs, adapted (same dark-mode class stamp, var(--background), and
 * --virtual-time-budget lessons; see that file).
 *
 * NO NETWORK, NO BACKEND, NO PHI. The markup is a jsdom render of sample office
 * answers composed by the library itself.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shotsDir = resolve(here, "../tests/.shots");
const assetsDir = resolve(here, "../dist/public/assets");
const outDir = resolve(here, "../../docs/screenshots/tc");
const tmpDir = resolve(shotsDir, ".render-tcemlib");

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
  console.error(`No dumps in ${shotsDir}. Run the shots test with TC_SHOTS=1 first.`);
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

/** The desk. Not per-shot, so every state is compared at one size. */
const WIDTH = 1280;
const HEIGHT = 1400;
const THEMES = ["light", "dark"];

const dumps = readdirSync(shotsDir)
  .filter((f) => f.startsWith("tcemlib-") && f.endsWith(".html"))
  .sort();
if (dumps.length === 0) {
  console.error("No tcemlib-*.html dumps to shoot. Run the shots test with TC_SHOTS=1 first.");
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
  body { padding: 0; }
  /*
   * Land every entry animation on its END state.
   *
   * The dialog shots come out washed out otherwise: Radix stamps a
   * data-state=open attribute and Tailwind's animate-in / fade-in-0 starts that
   * element at opacity 0, so a still photographed part-way through the keyframe
   * shows a ghost of the copy a reviewer is meant to read. The virtual-time
   * budget advances the clock but did not settle these.
   *
   * NOTE: no backticks anywhere in this comment. It lives inside a JS template
   * literal, and one would end the string.
   * A screenshot is of a settled screen, so the transient is removed rather
   * than waited out.
   */
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition: none !important;
  }
</style>
</head>
<body>${body}</body>
</html>`;

    const slug = `${name}-${WIDTH}x${HEIGHT}-${theme}`;
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
        `--window-size=${WIDTH},${HEIGHT}`,
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
