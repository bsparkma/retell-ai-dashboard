/**
 * Drift guard for the backend's committed contract bundle (PR #26 review
 * item 2).
 *
 * The CommonJS backend consumes the shared/tc contract through a COMMITTED
 * esbuild bundle (backend/tc/contract.gen.cjs) because it has no build step.
 * If shared/tc changes without a re-bundle, the backend silently validates
 * with yesterday's contract — this test makes that a red build instead of a
 * discovery: it re-bundles with the exact documented options (including the
 * load-bearing zod alias) and fails on any diff.
 *
 * Runs here (not in backend node --test) because esbuild is this package's
 * pinned devDependency — the CLI regen command and this test therefore use
 * the same esbuild version.
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const dashboardRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(dashboardRoot, "..");
const entry = path.join(repoRoot, "backend", "tc", "contract.entry.ts");
const committed = path.join(repoRoot, "backend", "tc", "contract.gen.cjs");

const REGEN =
  "cd new-dashboard && pnpm exec esbuild ../backend/tc/contract.entry.ts " +
  "--bundle --platform=node --format=cjs --alias:zod=./node_modules/zod " +
  "--outfile=../backend/tc/contract.gen.cjs";

test("backend/tc/contract.gen.cjs is in sync with shared/tc", async () => {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    // Same alias as the CLI regen command — without it the bundle resolves a
    // SECOND zod from backend/node_modules (transitive via openai) and schema
    // composition breaks at first parse.
    alias: { zod: path.join(dashboardRoot, "node_modules", "zod") },
    absWorkingDir: dashboardRoot,
  });
  const outputs = result.outputFiles;
  expect(outputs).toHaveLength(1);

  // Normalize line endings so a core.autocrlf checkout can't fake a drift.
  const fresh = outputs[0].text.replace(/\r\n/g, "\n");
  const onDisk = readFileSync(committed, "utf8").replace(/\r\n/g, "\n");

  expect(
    onDisk === fresh,
    `backend/tc/contract.gen.cjs is STALE against shared/tc. Regenerate and commit it:\n  ${REGEN}`,
  ).toBe(true);
});
