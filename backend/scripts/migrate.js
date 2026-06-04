'use strict';

/**
 * Control-plane migration runner.
 *
 * Migrates the `carein_control` Postgres database with node-pg-migrate, while
 * honoring the same configuration flow the rest of the backend uses:
 *
 *   Development (NODE_ENV != production):
 *     - CONTROL_DB_URL comes from backend/.env (loaded by dotenv below).
 *
 *   Production (NODE_ENV = production):
 *     - loadSecrets() authenticates to Key Vault with the connector certificate
 *       and writes the `control-db-url` secret onto process.env.CONTROL_DB_URL.
 *
 * Because node-pg-migrate's bundled CLI never calls loadSecrets(), we drive it
 * programmatically through this wrapper so the prod (Key Vault) path is honored
 * exactly like the app's own startup.
 *
 * Usage:
 *   node scripts/migrate.js up          # apply all pending migrations
 *   node scripts/migrate.js down        # roll back the most recent migration
 *   node scripts/migrate.js down 3      # roll back the last 3 migrations
 *   node scripts/migrate.js redo        # down 1 then up 1
 *
 * The Azure Postgres URL should request TLS, e.g.
 *   postgres://user:pass@host:5432/carein_control?sslmode=require
 */

require('dotenv').config();
const path = require('path');
const { loadSecrets } = require('../config/secrets');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const MIGRATIONS_TABLE = 'pgmigrations';

/**
 * Resolve node-pg-migrate's runner across CJS/ESM-interop shapes. Older builds
 * set module.exports = runner; newer builds expose it on `.default`.
 * @returns {Function}
 */
function resolveRunner() {
  const mod = require('node-pg-migrate');
  return typeof mod === 'function' ? mod : mod.default;
}

/**
 * Parse argv into a node-pg-migrate direction + count.
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ direction: 'up' | 'down', count: number, redo: boolean }}
 */
function parseArgs(argv) {
  const verb = (argv[0] || 'up').toLowerCase();
  const rawCount = argv[1] !== undefined ? parseInt(argv[1], 10) : NaN;

  if (verb === 'redo') {
    return { direction: 'up', count: 1, redo: true };
  }

  const direction = verb === 'down' ? 'down' : 'up';
  // Up: default to "all pending" (Infinity). Down: default to a single step.
  const fallback = direction === 'down' ? 1 : Infinity;
  const count = Number.isFinite(rawCount) && rawCount >= 0 ? rawCount : fallback;
  return { direction, count, redo: false };
}

async function main() {
  // Prod: pull control-db-url from Key Vault onto process.env. Dev: no-op.
  await loadSecrets();

  const databaseUrl = process.env.CONTROL_DB_URL;
  if (!databaseUrl) {
    console.error(
      '[migrate] CONTROL_DB_URL is not set.\n' +
        '  - Dev:  add CONTROL_DB_URL to backend/.env\n' +
        "  - Prod: create the 'control-db-url' secret in Key Vault kv-carein-core"
    );
    process.exit(1);
  }

  const runner = resolveRunner();
  if (typeof runner !== 'function') {
    console.error('[migrate] could not load node-pg-migrate runner');
    process.exit(1);
  }

  const { direction, count, redo } = parseArgs(process.argv.slice(2));

  /** @type {import('node-pg-migrate').RunnerOption} */
  const baseOptions = {
    databaseUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: MIGRATIONS_TABLE,
    // Wrap the whole batch in one transaction so a failure leaves no partial
    // schema behind.
    singleTransaction: true,
    verbose: true,
  };

  if (redo) {
    await runner({ ...baseOptions, direction: 'down', count: 1 });
    await runner({ ...baseOptions, direction: 'up', count: 1 });
  } else {
    await runner({ ...baseOptions, direction, count });
  }

  console.log(`[migrate] ${redo ? 'redo' : direction} complete`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[migrate] failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
