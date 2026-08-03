'use strict';

/**
 * /api/tc module-gate wiring + fail-closed behavior.
 *
 * Source scan: server.js mounts /api/tc exactly once, behind requireModule('tc').
 * Behavioral: unentitled → 403 MODULE_NOT_ENTITLED; no tenant context → 403;
 * entitled but missing/invalid office → 400 INVALID_OFFICE.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { bootTcApp, api } = require('./tcTestUtils');

test('server.js mounts /api/tc exactly once, behind requireModule(tc)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const mounts = src.match(/app\.use\(\s*'\/api\/tc'[^\n]*/g) || [];
  assert.equal(mounts.length, 1, `expected exactly one /api/tc mount, got: ${mounts.join(' | ')}`);
  assert.match(mounts[0], /requireModule\('tc'\)/, `/api/tc mount must carry the tc module guard: ${mounts[0]}`);
});

test('unentitled tenant → 403 MODULE_NOT_ENTITLED (module: tc)', async () => {
  const { baseUrl, close } = await bootTcApp({ modules: ['voice'] }); // has a tenant, lacks tc
  try {
    const res = await api(baseUrl, 'GET', '/api/tc/cases?office=roland');
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
    assert.equal(res.body.module, 'tc');
  } finally {
    await close();
  }
});

test('no tenant context → 403 (fail closed, not 500, not pass-through)', async () => {
  const { baseUrl, close } = await bootTcApp({ user: null });
  try {
    const res = await api(baseUrl, 'GET', '/api/tc/cases?office=roland');
    assert.equal(res.status, 403);
    assert.equal(res.body.success, false);
  } finally {
    await close();
  }
});

test('entitled but missing or unknown office → 400 INVALID_OFFICE', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    for (const qs of ['', '?office=riley', '?office=ROLAND']) {
      const res = await api(baseUrl, 'GET', `/api/tc/cases${qs}`);
      assert.equal(res.status, 400, `office '${qs}' must 400`);
      assert.equal(res.body.code, 'INVALID_OFFICE');
    }
  } finally {
    await close();
  }
});
