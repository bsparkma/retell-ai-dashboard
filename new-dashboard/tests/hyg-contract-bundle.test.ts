/**
 * Drift guard for the backend's committed hygiene contract bundle (H1 slice 2).
 *
 * The CommonJS backend consumes shared/hyg through a COMMITTED esbuild bundle
 * (backend/hyg/contract.gen.cjs) because it has no build step. If shared/hyg
 * changes without a re-bundle, the backend silently validates request bodies
 * with yesterday's contract — and those bodies become chart writes one slice
 * later. This makes that a red build instead of a discovery: it re-bundles with
 * the exact documented options (including the load-bearing zod alias) and fails
 * on any diff.
 *
 * Runs here rather than in `node --test` because esbuild is this package's
 * pinned devDependency, so the CLI regen command and this test use the same
 * esbuild version. Identical in shape to tests/tc-contract-bundle.test.ts, on
 * purpose: two guards that behave differently are two guards to reason about.
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const dashboardRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(dashboardRoot, "..");
const entry = path.join(repoRoot, "backend", "hyg", "contract.entry.ts");
const committed = path.join(repoRoot, "backend", "hyg", "contract.gen.cjs");

const REGEN =
  "cd new-dashboard && pnpm exec esbuild ../backend/hyg/contract.entry.ts " +
  "--bundle --platform=node --format=cjs --alias:zod=./node_modules/zod " +
  "--outfile=../backend/hyg/contract.gen.cjs";

test("backend/hyg/contract.gen.cjs is in sync with shared/hyg", async () => {
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
    `backend/hyg/contract.gen.cjs is STALE against shared/hyg. Regenerate and commit it:\n  ${REGEN}`,
  ).toBe(true);
});
