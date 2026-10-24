#!/usr/bin/env node
'use strict';

/**
 * COUNT pre-auths already linked to a case in ANOTHER office: rows written
 * before the create / PUT routes checked the office (fix/preauth-case-link-office).
 *
 * READ ONLY. One statement (routes/tc/preauthStore.js CROSS_OFFICE_LINKS_SQL)
 * inside a READ ONLY transaction that is always rolled back. It prints COUNTS
 * per (pre-auth office → case office) pair only — never an id, a name or any
 * row value. It changes nothing; a cleanup, if one is needed, is a separate,
 * reviewed step.
 *
 * Usage (backend folder, or /app inside the container):
 *   MIGRATE_TENANT_DB_URL=postgres://... node scripts/tc-preauth-cross-office-links.js
 */

const { Client } = require('pg');

const { countCrossOfficeCaseLinks } = require('../routes/tc/preauthStore');

async function main({ env = process.env, log = console.log } = {}) {
  const url = env.MIGRATE_TENANT_DB_URL || env.TENANT_DB_URL;
  if (!url) {
    console.error('[tc-preauth-cross-office-links] set MIGRATE_TENANT_DB_URL (or TENANT_DB_URL) to the tenant database');
    return 2;
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { total, pairs } = await countCrossOfficeCaseLinks(client);
    log(`cross-office pre-auth → case links: ${total}`);
    for (const p of pairs) log(`  pre-auth ${p.preauthOffice} → case ${p.caseOffice}: ${p.count}`);
    return 0;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error('[tc-preauth-cross-office-links] failed:', err && err.message);
      process.exit(1);
    }
  );
}

module.exports = { main };
