/**
 * Photograph the S8 flow-speed slice AT THE FOLD.
 *
 *   pnpm exec vite build                                    # the real CSS
 *   RCM_SHOTS=1 pnpm exec vitest run tests/rcm-ux-shots.test.tsx \
 *     tests/rcm-stage-c3-shots.test.tsx tests/rcm-workbench-shots.test.tsx
 *   node scripts/shoot-s8-flow-speed.mjs before|after
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SHOOTER IS 1280x800 AND THE OTHERS ARE 1280xTALL
 * ─────────────────────────────────────────────────────────────────────────────
 * Every other shooter in this folder sizes the window to the whole page, which
 * is the right thing when the subject is a layout. The subject HERE is the fold
 * — whether the next press is in reach — so the window is the screen a person
 * actually has, and a picture that scrolled to fit would photograph away the
 * only thing being claimed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND WHY THE DUMP IS WRAPPED IN A SCROLL BOX
 * ─────────────────────────────────────────────────────────────────────────────
 * `DashboardLayout` scrolls the page inside `<main class="flex-1 overflow-y-auto">`,
 * not on the document — so that element, not the viewport, is what
 * `position: sticky` resolves against in the real app. A bare dump on `body`
 * has no such ancestor and the bar rests wherever the document puts it, which
 * is a picture of a shell this app does not have. The wrapper below is that
 * `main`: one element, the viewport's height, `overflow-y: auto`.
 *
 * `scrollTo` per shot is how the fold is proved rather than asserted: the same
 * screen photographed at the top and part-way down, with the bar in both.
 *
 * NO NETWORK, NO BACKEND, NO PHI — the markup is a jsdom render of fixtures.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const prefix = process.argv[2];
if (prefix !== "before" && prefix !== "after") {
  console.error("usage: node scripts/shoot-s8-flow-speed.mjs before|after");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const shotsDir = resolve(here, "../tests/.shots");
const assetsDir = resolve(here, "../dist/public/assets");
const outDir = resolve(here, "../../docs/screenshots/rcm-s8-flow-speed");
const tmpDir = resolve(shotsDir, ".render-s8-flow-speed");

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
 * dump → [slug, scrollTop, openFoldTestId?]
 *
 * `scrollTop` is where the reader is when the picture is taken. 0 is arrival;
 * anything else is the claim this slice is about — a person part-way down the
 * evidence, which before this slice is exactly where the button was not.
 */
const SHOTS = [
  ["stagec-04-check-triage", "check-top", 0, null],
  ["stagec-04-check-triage", "check-scrolled", 420, null],
  ["c3-02-claim-linked", "claim-top", 0, null],
  ["c3-02-claim-linked", "claim-scrolled", 900, null],
  ["c3-01-claim-pre-link", "match-account-open", 260, "match-guidance-account"],
  ["s8-match-ambiguous", "match-account-candidates", 320, "match-guidance-account-53862"],
  ["approve-03-partial", "approve-onward-claim", 1100, null],
  ["s8-approve-onward-post", "approve-onward-post", 1100, null],
];

for (const [dump, slug, scrollTop, openFold] of SHOTS) {
  const file = resolve(shotsDir, `${dump}.html`);
  if (!existsSync(file)) {
    console.warn(`skipped ${slug}: no dump at ${file}`);
    continue;
  }
  const body = readFileSync(file, "utf8");
  const page = `<!doctype html>
<html lang="en" class="light">
<head><meta charset="utf-8"><style>${css}</style>
<style>
  /* var(--background), NOT hsl(var(--background)) — this system's tokens are
     raw oklch() and Chrome drops the wrapped declaration. */
  html, body { background: var(--background); color: var(--foreground); margin: 0; }
  /* THE APP'S OWN SCROLL BOX — see this file's header. */
  #shell { height: 800px; overflow-y: auto; }
</style>
</head>
<body><div id="shell">${body}</div>
<script>
  window.addEventListener("load", function () {
    var fold = ${JSON.stringify(openFold)};
    if (fold) {
      var el = document.querySelector('[data-testid="' + fold + '"]');
      if (el) el.setAttribute("open", "");
    }
    document.getElementById("shell").scrollTop = ${scrollTop};
  });
</script>
</body>
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
      "--window-size=1280,800",
      "--virtual-time-budget=3000",
      "--screenshot=" + out,
      "file:///" + htmlPath.split("\\").join("/"),
    ],
    { stdio: "ignore" },
  );
  console.log(`wrote ${out}`);
}

rmSync(tmpDir, { recursive: true, force: true });
