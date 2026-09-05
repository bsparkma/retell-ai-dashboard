/**
 * Photograph the hygiene Day View dumps produced by tests/hyg-shots.test.tsx.
 *
 *   pnpm exec vite build                                  # the real CSS
 *   HYG_SHOTS=1 pnpm exec vitest run tests/hyg-shots.test.tsx
 *   node scripts/shoot-hyg.mjs
 *
 * 1180 × 820, LIGHT AND DARK. That viewport is an iPad in landscape, which is
 * the device this screen is for and the only width worth reviewing it at — a
 * desktop shot would review a layout nobody uses. The height is fixed rather
 * than per-shot for the same reason: the review question is "does this fit on
 * the device", and letting a tall page grow its frame would hide the answer.
 *
 * Everything below is `shoot-stage-c3b.mjs`, adapted, down to the two lessons
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
 * `--virtual-time-budget` is load-bearing: without it headless Chrome shoots
 * the page before web fonts and the CSS cascade have settled.
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
const outDir = resolve(here, "../../docs/screenshots/hyg");
const tmpDir = resolve(shotsDir, ".render-hyg");

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
  console.error(`No dumps in ${shotsDir}. Run the shots test with HYG_SHOTS=1 first.`);
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
 * The device. The WIDTH is not a variable and not per-shot — it is what decides
 * the layout, and a review of a width nobody uses is not a review.
 *
 * The HEIGHT is the iPad's, and a dump may ask for a taller FRAME by ending its
 * name with `@1180x1500`. That is not a different device: it is the same page,
 * scrolled, and it exists because the visit workspace is taller than one screen
 * and a screenshot that does not contain its own subject is not evidence. Every
 * shot still carries its real size in the filename, so nobody has to guess
 * which they are looking at.
 */
const WIDTH = 1180;
const HEIGHT = 820;
const THEMES = ["light", "dark"];

/** `name@1180x1500` → `{ name, width, height }`. */
function frameOf(rawName) {
  const at = rawName.lastIndexOf("@");
  if (at === -1) return { name: rawName, width: WIDTH, height: HEIGHT };
  const size = /^(\d+)x(\d+)$/.exec(rawName.slice(at + 1));
  if (!size) return { name: rawName, width: WIDTH, height: HEIGHT };
  return { name: rawName.slice(0, at), width: Number(size[1]), height: Number(size[2]) };
}

const dumps = readdirSync(shotsDir)
  .filter((f) => f.startsWith("hyg-") && f.endsWith(".html"))
  .sort();
if (dumps.length === 0) {
  console.error("No hyg-*.html dumps to shoot. Run the shots test with HYG_SHOTS=1 first.");
  process.exit(1);
}

for (const dump of dumps) {
  const { name, width, height } = frameOf(dump.replace(/\.html$/, ""));
  const body = readFileSync(resolve(shotsDir, dump), "utf8");

  for (const theme of THEMES) {
    const page = `<!doctype html>
<html lang="en" class="${theme}">
<head><meta charset="utf-8"><style>${css}</style>
<style>
  html, body { background: var(--background); color: var(--foreground); }
  body { padding: 0; }
</style>
</head>
<body>${body}</body>
</html>`;

    const slug = `${name}-${width}x${height}-${theme}`;
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
        `--window-size=${width},${height}`,
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
