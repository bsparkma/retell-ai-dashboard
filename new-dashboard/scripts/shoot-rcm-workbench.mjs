/**
 * Photograph the RCM workbench dumps produced by tests/rcm-workbench-shots.test.tsx.
 *
 *   pnpm exec vite build                                # produces the real CSS
 *   RCM_SHOTS=1 pnpm exec vitest run tests/rcm-workbench-shots.test.tsx
 *   node scripts/shoot-rcm-workbench.mjs
 *
 * Wraps each dump in the app's OWN built stylesheet — so the picture is the
 * real design system rather than an approximation — and renders it with the
 * Chrome already on the machine.
 *
 * `--virtual-time-budget` is load-bearing: without it headless Chrome
 * screenshots the page before web fonts and the CSS cascade have settled, and
 * the result is an unstyled flash of the markup.
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
const outDir = resolve(here, "../../docs/screenshots/rcm-workbench");
const tmpDir = resolve(shotsDir, ".render");

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
 * page. Sized to each screen instead. Width stays fixed: the list is a grid
 * whose column template only makes sense at a desktop width.
 */
const HEIGHT = {
  "01-remittance-list": 620,
  "02-remittance-detail": 1010,
  "03-claim-match": 1000,
  "04-no-candidate": 700,
};

const dumps = readdirSync(shotsDir).filter((f) => f.endsWith(".html")).sort();
if (dumps.length === 0) {
  console.error("No .html dumps to shoot.");
  process.exit(1);
}

for (const dump of dumps) {
  const name = dump.replace(/\.html$/, "");
  const body = readFileSync(resolve(shotsDir, dump), "utf8");

  // `light` explicitly: the theme provider's class never makes it into a body
  // dump, and an unset theme renders against a transparent ground.
  const page = `<!doctype html>
<html lang="en" class="light">
<head><meta charset="utf-8"><style>${css}</style>
<style>
  html, body { background: hsl(var(--background)); }
  /* The dumps are page bodies, not app shells — give them the padding the
     real layout would, so nothing sits flush against the frame. */
  body { padding: 8px; }
</style>
</head>
<body>${body}</body>
</html>`;

  const htmlPath = resolve(tmpDir, `${name}.html`);
  writeFileSync(htmlPath, page, "utf8");

  const out = resolve(outDir, `${name}.png`);
  execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      `--window-size=1440,${HEIGHT[name] ?? 1200}`,
      // Let the cascade and fonts settle before the shutter (see the header).
      "--virtual-time-budget=3000",
      "--screenshot=" + out,
      "file:///" + htmlPath.replace(/\\/g, "/"),
    ],
    { stdio: "ignore" },
  );

  console.log(`wrote ${out}`);
}

rmSync(tmpDir, { recursive: true, force: true });
