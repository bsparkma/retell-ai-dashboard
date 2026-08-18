/**
 * Photograph the call-detail triage dumps produced by tests/detail-triage-shots.test.tsx.
 *
 *   pnpm exec vite build                                             # the real CSS
 *   DETAIL_TRIAGE_SHOTS=1 pnpm exec vitest run tests/detail-triage-shots.test.tsx
 *   node scripts/shoot-detail-triage.mjs
 *
 * Wraps each dump in the app's OWN built stylesheet — so the picture is the real
 * design system rather than an approximation — and renders it with the Chrome already
 * on the machine.
 *
 * `--virtual-time-budget` is load-bearing: without it headless Chrome screenshots the
 * page before web fonts and the CSS cascade have settled, and the result is an
 * unstyled flash of the markup.
 *
 * NO NETWORK, NO BACKEND, NO PHI. The markup comes from a jsdom render of fixture data
 * that lives in the test file, so a screenshot physically cannot contain a real patient.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shotsDir = resolve(here, "../tests/.shots");
const assetsDir = resolve(here, "../dist/public/assets");
const outDir = resolve(here, "../../docs/screenshots/detail-triage");
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
  console.error(`No dumps in ${shotsDir}. Run the shots test with DETAIL_TRIAGE_SHOTS=1 first.`);
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
 * Frame height per shot. Chrome's --screenshot captures the WINDOW, not the content,
 * so one height for every page leaves a screenful of empty canvas under the short ones.
 * These shots are about the HEADER, so they are cropped to it plus enough of the page
 * below to show the actions sit at the top of a real screen.
 */
const HEIGHT = {
  "01-header-idle": 300,
  "02-done-popover": 470,
  "03-after-done": 300,
  "04-read-only": 300,
};

/**
 * Radix positions a popover with floating-ui at runtime; jsdom measures nothing, so a
 * dumped popper wrapper carries `transform: translate(0px, 0px)` and would render in
 * the top-left corner. Pin it under the Mark done button for the one shot that has one
 * — the MARKUP is the component's own, only the placement is supplied here.
 */
const EXTRA_CSS = {
  "02-done-popover": `
    [data-radix-popper-content-wrapper] {
      position: absolute !important;
      transform: none !important;
      top: 132px !important;
      left: auto !important;
      /* Flush with the Mark done button's right edge, which is where align="end"
         puts it in the browser. */
      right: 282px !important;
    }
  `,
};

const dumps = readdirSync(shotsDir).filter((f) => f.endsWith(".html")).sort();
if (dumps.length === 0) {
  console.error("No .html dumps to shoot.");
  process.exit(1);
}

for (const dump of dumps) {
  const name = dump.replace(/\.html$/, "");
  const body = readFileSync(resolve(shotsDir, dump), "utf8");

  // `light` explicitly: the theme provider's class never makes it into a body dump,
  // and an unset theme renders against a transparent ground.
  const page = `<!doctype html>
<html lang="en" class="light">
<head><meta charset="utf-8"><style>${css}</style>
<style>
  html, body { background: hsl(var(--background)); }
  /* The dumps are page bodies, not app shells — the page already carries its own
     padding, so the frame only needs to not clip it. */
  body { overflow: hidden; }
  ${EXTRA_CSS[name] ?? ""}
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
      `--window-size=1440,${HEIGHT[name] ?? 800}`,
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
