/**
 * Photograph the dumps produced by tests/rcm-match-layout-archive-shots.test.tsx.
 *
 *   pnpm exec vite build                                           # the real CSS
 *   RCM_SHOTS=1 pnpm exec vitest run tests/rcm-match-layout-archive-shots.test.tsx
 *   node scripts/shoot-match-layout-archive.mjs
 *
 * The split shot (mla-01) is photographed at TWO WIDTHS, because the widths are
 * the claim: 1440 is ≥1280 and must show the document and the figures side by
 * side, each at full height; 1024 is below the breakpoint and must show them
 * stacked, document first. Everything else shoots at 1280, the practice
 * laptop's width.
 *
 * Everything below is `shoot-flow-fix.mjs`, unchanged, including its two
 * recorded lessons: dark is a `class="dark"` stamped on the root here (the
 * class never reaches a body dump), and the page background is
 * `var(--background)` raw — wrapping this design system's oklch tokens in
 * `hsl()` produces a declaration Chrome drops.
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
const outDir = resolve(here, "../../docs/screenshots/rcm-match-layout-archive");
const tmpDir = resolve(shotsDir, ".render-match-layout-archive");

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

const HEIGHT = 900;

/** Which widths and themes each dump earns. The split's widths ARE its claim. */
function plans(name) {
  if (name.startsWith("mla-01")) {
    return [
      { width: 1440, themes: ["light", "dark"] },
      { width: 1024, themes: ["light"] },
    ];
  }
  return [{ width: 1280, themes: ["light"] }];
}

const dumps = readdirSync(shotsDir)
  .filter((f) => f.startsWith("mla-") && f.endsWith(".html"))
  .sort();
if (dumps.length === 0) {
  console.error("No mla-*.html dumps to shoot. Run the shots test with RCM_SHOTS=1 first.");
  process.exit(1);
}

for (const dump of dumps) {
  const name = dump.replace(/\.html$/, "");
  const body = readFileSync(resolve(shotsDir, dump), "utf8");

  for (const { width, themes } of plans(name)) {
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

      const slug = `${name}-${width}x${HEIGHT}-${theme}`;
      const htmlPath = resolve(tmpDir, `${slug}.html`);
      writeFileSync(htmlPath, page, "utf8");

      const out = resolve(outDir, `${slug}.png`);
      execFileSync(
        CHROME,
        [
          "--headless=new",
          "--disable-gpu",
          "--force-device-scale-factor=2",
          `--window-size=${width},${HEIGHT}`,
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
