/**
 * Photograph the TC email (ACS) dumps produced by tests/tc-email-shots.test.tsx (item 40),
 * plus the PUBLIC unsubscribe pages exactly as the backend serves them.
 *
 *   pnpm exec vite build                                        # the real CSS
 *   TC_SHOTS=1 pnpm exec vitest run tests/tc-email-shots.test.tsx
 *   node scripts/shoot-tc-email.mjs
 *
 * 1280 x 900, LIGHT AND DARK — the TC works the case view at a desk.
 * Output goes to docs/screenshots/tc/ (TC's folder; hygiene slices use hyg/).
 *
 * Everything below is `shoot-hyg-switch.mjs`, adapted, down to the two lessons
 * that file records and this one would otherwise have to relearn:
 *
 *   . dark is a `class="dark"` on the root element, which is what ThemeContext
 *     sets on the live app. The class never reaches a body dump, so it is
 *     stamped here.
 *   . `var(--background)`, NOT `hsl(var(--background))` - this design system's
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
const outDir = resolve(here, "../../docs/screenshots/tc");
const tmpDir = resolve(shotsDir, ".render-tcemail");

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
const HEIGHT = 900;
const THEMES = ["light", "dark"];

const dumps = readdirSync(shotsDir)
  .filter((f) => f.startsWith("tcemail-") && f.endsWith(".html"))
  .sort();
if (dumps.length === 0) {
  console.error("No tcemail-*.html dumps to shoot. Run the shots test with TC_SHOTS=1 first.");
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

// The PUBLIC unsubscribe pages, exactly as the backend serves them: its own
// router, mounted on its own express, read over a loopback request. They carry
// their own inline style (a patient's browser never sees the app CSS) and have
// no dark variant, so they are shot once, light. The token is a fake one: the
// GET page reads no database, which is the point.
{
  const { createRequire } = await import("node:module");
  const backendRequire = createRequire(resolve(here, "../../backend/server.js"));
  const express = backendRequire("express");
  const router = backendRequire("./routes/emailWebhooks.js");
  const app = express();
  app.use("/api/webhooks/email", router);
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const { port } = server.address();
  const fakeToken = "A".repeat(43);
  const confirm = await (await fetch(`http://127.0.0.1:${port}/api/webhooks/email/unsubscribe?t=${fakeToken}`)).text();
  server.close();
  for (const [name, html] of [
    ["tcemail-05-unsubscribe-confirm", confirm],
    ["tcemail-06-unsubscribe-done", router.DONE_PAGE],
  ]) {
    const htmlPath = resolve(tmpDir, `${name}.html`);
    writeFileSync(htmlPath, html, "utf8");
    const out = resolve(outDir, `${name}-${WIDTH}x${HEIGHT}-light.png`);
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
