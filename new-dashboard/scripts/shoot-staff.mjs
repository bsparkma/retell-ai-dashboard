/**
 * Photograph the Practice staff page dumps produced by
 * tests/admin-staff-shots.test.tsx.
 *
 *   pnpm exec vite build                                  # the real CSS
 *   STAFF_SHOTS=1 pnpm exec vitest run tests/admin-staff-shots.test.tsx
 *   node scripts/shoot-staff.mjs
 *
 * scripts/shoot-tc-checkout.mjs, pointed at the staff- dumps and at
 * docs/screenshots/platform/. Light AND dark; a dump may ask for a taller frame
 * with an `@1280x1100` suffix.
 *
 * NO NETWORK, NO BACKEND. The markup is a jsdom render of synthetic staff.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shotsDir = resolve(here, "../tests/.shots");
const assetsDir = resolve(here, "../dist/public/assets");
const outDir = resolve(here, "../../docs/screenshots/platform");
const tmpDir = resolve(shotsDir, ".render-staff");

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
  console.error(`No dumps in ${shotsDir}. Run the shots test with STAFF_SHOTS=1 first.`);
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
const WIDTH = 1280;
const HEIGHT = 900;
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
  .filter((f) => f.startsWith("staff-") && f.endsWith(".html"))
  .sort();
if (dumps.length === 0) {
  console.error("No staff-*.html dumps to shoot. Run the shots test with STAFF_SHOTS=1 first.");
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
  /*
    FREEZE ENTRY ANIMATIONS. A Radix dialog opens from opacity 0, and headless
    Chrome photographs it mid-keyframe even with a virtual-time budget — the
    confirm shot came out washed out until this was added. Harmless everywhere
    else: a still of a finished animation is what every other shot wanted too.
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
