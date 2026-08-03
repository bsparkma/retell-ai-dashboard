'use strict';

/**
 * TC legacy data importer — launcher (Slice 2).
 *
 * The importer itself is TypeScript (it consumes the shared/tc contract and
 * mappers), so it lives in new-dashboard/server/tc-import/ and runs under
 * tsx. This shim keeps the repo's script convention: run it like the migrate
 * scripts, from backend/.
 *
 *   node scripts/tc-import.cjs --data-dir "C:\path\to\TC-app\server\data"
 *   node scripts/tc-import.cjs --data-dir ... --execute --blob-account stcareinstaging
 *
 * Dry-run is the DEFAULT — nothing is written without --execute.
 * Execute mode needs TC_IMPORT_DB_URL in the environment (Key Vault → session,
 * never printed, never committed) and an `az login` session for Blob auth.
 * Full option list: new-dashboard/server/tc-import/cli.ts.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const dashboardDir = path.join(__dirname, '..', '..', 'new-dashboard');
const cliPath = path.join(dashboardDir, 'server', 'tc-import', 'cli.ts');

let tsxCli;
try {
  tsxCli = require.resolve('tsx/cli', { paths: [dashboardDir] });
} catch {
  console.error('tsx not found — run `pnpm install` in new-dashboard/ first.');
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsxCli, cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: dashboardDir,
});
process.exit(result.status === null ? 1 : result.status);
