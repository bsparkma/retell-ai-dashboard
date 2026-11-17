'use strict';

/**
 * MT-3 — a public email link resolves to the tenant that MINTED it
 * (platform/publicLinkIndex.js), never to "the deployment's tenant".
 *
 * Pins:
 *   1. tenant A's token opens A's database and never B's (two fake tenants);
 *   2. unknown / expired / wrong-kind / inactive / unentitled → the SAME
 *      response as a bad token, after the same single index lookup, with no
 *      tenant database opened;
 *   3. mint fails closed when the index write fails: no email, no token row
 *      left behind (patient email here; the referral letter in
 *      routes/tc/tcReferralLinks.test.js);
 *   4. the legacy fallback runs only for a hash the index does not know, only
 *      while TC_EMAIL_TENANT_SLUG is set, and logs "[public-link] legacy tenant
 *      fallback";
 *   5. a control plane that cannot be reached is still the route's 503.
 *
 * Fixtures are synthetic: roland 12828, @example.test addresses, tenants
 * 'carein' (T1) and 'bravo' (T2).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const tenantDb = require('../platform/tenantDb');
const registry = require('../platform/registry');
const publicLinkIndex = require('../platform/publicLinkIndex');
const { FakeTenantDb } = require('./tc/tcTestUtils');
const { DONE_PAGE } = require('./emailWebhooks');
const { NEUTRAL_PAGE } = require('./referralLinkWebhooks');
const { bootEmailApp, resetEmailHarness, seedCase, apiJson, unsubscribeUrlOf } = require('./emailTestUtils');

test.afterEach(() => resetEmailHarness());

const T1 = { tenant_id: 'T1', slug: 'carein', display_name: 'CareIN', status: 'active' };
const T2 = { tenant_id: 'T2', slug: 'bravo', display_name: 'Bravo', status: 'active' };

const newToken = () => crypto.randomBytes(32).toString('base64url');

async function post(baseUrl, path, token) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: token }).toString(),
  });
  return { status: res.status, text: await res.text() };
}
const unsubscribe = (baseUrl, token) => post(baseUrl, '/api/webhooks/email/unsubscribe', token);
const referralUse = (baseUrl, token) => post(baseUrl, '/api/webhooks/referral-link/r', token);
async function referralView(baseUrl, token) {
  const res = await fetch(`${baseUrl}/api/webhooks/referral-link/r?t=${encodeURIComponent(token)}`);
  return { status: res.status, text: await res.text() };
}

/** Draft + send one patient email in the harness tenant; returns its token. */
async function sendOne(baseUrl, acsCalls, tcCase, n = 0) {
  const d = await apiJson(baseUrl, 'POST', `/api/tc/messages/draft?office=${tcCase.office_id}`, {
    caseId: tcCase.case_id,
    channel: 'email',
    body: 'Hello from the office.',
    subject: 'Hello',
  });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const s = await apiJson(baseUrl, 'POST', `/api/tc/messages/${d.body.message.messageId}/send?office=${tcCase.office_id}`, {});
  return { draft: d.body.message, send: s, token: s.status === 200 ? new URL(unsubscribeUrlOf(acsCalls, n)).searchParams.get('t') : null };
}

/**
 * Boot the harness (tenant T1, database `db`), then add a second tenant T2
 * with its OWN database. The index knows both tenants; withTenantDb routes by
 * req.tenant.id and records which databases were opened.
 */
async function bootTwoTenants({ t2 = T2, t2Modules = ['tc'], env = {} } = {}) {
  const app = await bootEmailApp({ env });
  const dbB = new FakeTenantDb();
  const opened = [];
  const harnessWithTenantDb = tenantDb.withTenantDb;
  tenantDb.withTenantDb = async (req, fn) => {
    const id = req && req.tenant && req.tenant.id;
    opened.push(id);
    if (id === 'T2') return fn(dbB);
    return harnessWithTenantDb(req, fn);
  };
  const index = publicLinkIndex.createMemoryBackend({
    tenants: (id) => (id === 'T1' ? T1 : id === 'T2' ? t2 : null),
    modules: (id) => (id === 'T2' ? t2Modules : ['tc']),
  });
  publicLinkIndex.setBackendForTests(index);
  return {
    ...app,
    dbA: app.db,
    dbB,
    opened,
    index,
    close: async () => {
      tenantDb.withTenantDb = harnessWithTenantDb;
      await app.close();
    },
  };
}

/** A sent patient email in T2's database, its hash indexed to `indexAs`. */
async function seedT2Email(dbB, index, { indexAs = 'T2', address = 'bravo.patient@example.test' } = {}) {
  const token = newToken();
  const hash = publicLinkIndex.hashToken(token);
  dbB.table('tc_messages').push({
    message_id: crypto.randomUUID(),
    office_id: 'roland',
    case_id: crypto.randomUUID(),
    channel: 'email',
    direction: 'outbound',
    to_address: address,
    status: 'sent',
    unsubscribe_token_hash: hash,
  });
  await index.insert(indexAs, [{ hash, kind: 'unsubscribe', expiresAt: null }]);
  return token;
}

// ── 1. tenant A's token → A's database, never B's ───────────────────────────

test("tenant A's token opens A's database and never B's; B's token opens B's and never A's", async () => {
  const app = await bootTwoTenants();
  try {
    const c = seedCase(app.dbA);
    const { token: tokenA } = await sendOne(app.baseUrl, app.acsCalls, c);
    assert.ok(tokenA);
    const tokenB = await seedT2Email(app.dbB, app.index);

    app.opened.length = 0;
    const a = await unsubscribe(app.baseUrl, tokenA);
    assert.equal(a.status, 200);
    assert.equal(app.dbA.table('tc_contact_consent').length, 1, "A's opt-out is in A's database");
    assert.equal(app.dbB.table('tc_contact_consent').length, 0, "and nothing in B's");
    assert.ok(app.opened.length > 0 && app.opened.every((id) => id === 'T1'), `only T1 opened: ${app.opened}`);

    app.opened.length = 0;
    const b = await unsubscribe(app.baseUrl, tokenB);
    assert.equal(b.status, 200);
    assert.equal(app.dbB.table('tc_contact_consent').length, 1, "B's opt-out is in B's database");
    assert.equal(app.dbA.table('tc_contact_consent').length, 1, "A's is unchanged");
    assert.ok(app.opened.length > 0 && app.opened.every((id) => id === 'T2'), `only T2 opened: ${app.opened}`);
  } finally {
    await app.close();
  }
});

test("a hash the index assigns to A is looked up ONLY in A's database, even when B's database holds it", async () => {
  const app = await bootTwoTenants();
  try {
    const token = await seedT2Email(app.dbB, app.index, { indexAs: 'T1' });
    app.opened.length = 0;
    const r = await unsubscribe(app.baseUrl, token);
    assert.equal(r.text, DONE_PAGE);
    assert.equal(app.dbB.table('tc_contact_consent').length, 0, "B's row was never reached");
    assert.ok(!app.opened.includes('T2'));
  } finally {
    await app.close();
  }
});

test("a referral link indexed to B opens B's database (and only B's)", async () => {
  const app = await bootTwoTenants();
  try {
    const token = newToken();
    await app.index.insert('T2', [
      { hash: publicLinkIndex.hashToken(token), kind: 'referral_link', expiresAt: new Date(Date.now() + 86400000).toISOString() },
    ]);
    app.opened.length = 0;
    const r = await referralView(app.baseUrl, token);
    assert.equal(r.status, 200);
    assert.equal(r.text, NEUTRAL_PAGE, "B's database has no such token row, so it is dead");
    assert.ok(app.opened.length > 0 && app.opened.every((id) => id === 'T2'), `only T2 opened: ${app.opened}`);
  } finally {
    await app.close();
  }
});

// ── 2. every unresolvable token: one answer ─────────────────────────────────

test('unknown, expired, wrong-kind, inactive-tenant and unentitled-tenant tokens get identical answers, one lookup each, no tenant DB', async () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 86400000).toISOString();
  /** Each case: how to make the token, and the tenant row/modules T2 has. */
  const cases = [
    { name: 'unknown', make: async () => newToken() },
    {
      name: 'expired',
      make: async (index, kind) => {
        if (kind !== 'referral_link') return null; // unsubscribe links never expire
        const t = newToken();
        await index.insert('T2', [{ hash: publicLinkIndex.hashToken(t), kind, expiresAt: past }]);
        return t;
      },
    },
    {
      name: 'wrong kind',
      make: async (index, kind) => {
        const t = newToken();
        const other = kind === 'unsubscribe' ? 'referral_link' : 'unsubscribe';
        await index.insert('T2', [{ hash: publicLinkIndex.hashToken(t), kind: other, expiresAt: other === 'referral_link' ? future : null }]);
        return t;
      },
    },
    { name: 'inactive tenant', t2: { ...T2, status: 'suspended' } },
    { name: 'unentitled tenant', t2Modules: ['voice'] },
  ];

  for (const [kind, hit, expected] of [
    ['unsubscribe', unsubscribe, { status: 200, text: DONE_PAGE }],
    ['referral_link', referralUse, { status: 200, text: NEUTRAL_PAGE }],
    ['referral_link', referralView, { status: 200, text: NEUTRAL_PAGE }],
  ]) {
    for (const c of cases) {
      // No legacy fallback: an unknown hash must not open any tenant either.
      const app = await bootTwoTenants({ t2: c.t2 || T2, t2Modules: c.t2Modules || ['tc'], env: { TC_EMAIL_TENANT_SLUG: undefined } });
      try {
        let token;
        if (c.make) token = await c.make(app.index, kind);
        else {
          token = newToken();
          await app.index.insert('T2', [
            { hash: publicLinkIndex.hashToken(token), kind, expiresAt: kind === 'referral_link' ? future : null },
          ]);
        }
        if (token == null) continue;
        app.opened.length = 0;
        const lookupsBefore = app.index.state.lookups;
        const r = await hit(app.baseUrl, token);
        const label = `${kind} ${hit.name} ${c.name}`;
        assert.equal(r.status, expected.status, label);
        assert.equal(r.text, expected.text, label);
        assert.equal(app.index.state.lookups - lookupsBefore, 1, `${label}: exactly one index lookup`);
        assert.deepEqual(app.opened, [], `${label}: no tenant database opened`);
      } finally {
        await app.close();
        resetEmailHarness();
      }
    }
  }
});

// ── 3. mint fails closed ────────────────────────────────────────────────────

test('patient email: a failed index write sends nothing, leaves the draft a draft and stores no token hash', async () => {
  const { baseUrl, db, acsCalls, linkIndex, close } = await bootEmailApp();
  try {
    const c = seedCase(db);
    linkIndex.state.failInsert = true;
    const { draft, send } = await sendOne(baseUrl, acsCalls, c);
    assert.equal(send.status, 502, JSON.stringify(send.body));
    assert.equal(send.body.code, 'SEND_FAILED');
    assert.match(send.body.error, /could not be registered, so nothing was sent/);
    assert.equal(acsCalls.filter((x) => x.method === 'POST').length, 0, 'nothing handed to ACS');
    const row = db.table('tc_messages').find((m) => m.message_id === draft.messageId);
    assert.equal(row.status, 'draft');
    assert.equal(row.unsubscribe_token_hash ?? null, null, 'no hash stored on the tenant row');
    assert.equal(linkIndex.rows.size, 0);

    // The office can try again once the control plane is back.
    linkIndex.state.failInsert = false;
    const again = await apiJson(baseUrl, 'POST', `/api/tc/messages/${draft.messageId}/send?office=roland`, {});
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(linkIndex.rows.size, 1);
    const [[hash, entry]] = [...linkIndex.rows];
    assert.equal(entry.tenant_id, 'T1');
    assert.equal(entry.kind, 'unsubscribe');
    assert.equal(entry.expires_at, null);
    assert.equal(db.table('tc_messages').find((m) => m.message_id === draft.messageId).unsubscribe_token_hash, hash);
  } finally {
    await close();
  }
});

test('register() refuses without a tenant, and refuses malformed entries before writing', async () => {
  const mem = publicLinkIndex.createMemoryBackend();
  publicLinkIndex.setBackendForTests(mem);
  try {
    const hash = publicLinkIndex.hashToken(newToken());
    await assert.rejects(publicLinkIndex.register({}, [{ hash, kind: 'unsubscribe', expiresAt: null }]), publicLinkIndex.PublicLinkIndexError);
    const req = { tenant: { id: 'T1' } };
    for (const bad of [
      [],
      [{ hash: 'not-a-hash', kind: 'unsubscribe', expiresAt: null }],
      [{ hash, kind: 'other', expiresAt: null }],
      [{ hash, kind: 'referral_link', expiresAt: null }],
      [{ hash, kind: 'unsubscribe', expiresAt: new Date().toISOString() }],
    ]) {
      await assert.rejects(publicLinkIndex.register(req, /** @type {any} */ (bad)), publicLinkIndex.PublicLinkIndexError);
    }
    assert.equal(mem.state.inserts, 0);
    mem.state.failInsert = true;
    await assert.rejects(publicLinkIndex.register(req, [{ hash, kind: 'unsubscribe', expiresAt: null }]), publicLinkIndex.PublicLinkIndexError);
  } finally {
    publicLinkIndex.resetBackendForTests();
  }
});

// ── 4. the legacy fallback ──────────────────────────────────────────────────

/** Capture console.warn lines while fn runs. */
async function warnings(fn) {
  const lines = [];
  const orig = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return lines;
}

test("legacy fallback: a hash the index does not know uses TC_EMAIL_TENANT_SLUG's tenant, with the log line", async () => {
  const app = await bootTwoTenants();
  try {
    // A pre-index email: its hash is in T1's database, not in the index.
    const c = seedCase(app.dbA);
    const { token } = await sendOne(app.baseUrl, app.acsCalls, c);
    app.index.rows.clear();
    app.opened.length = 0;
    const logs = await warnings(async () => {
      const r = await unsubscribe(app.baseUrl, token);
      assert.equal(r.status, 200);
    });
    assert.ok(logs.some((l) => l.includes(publicLinkIndex.FALLBACK_LOG)), logs.join('\n'));
    assert.equal(app.dbA.table('tc_contact_consent').length, 1, 'recorded in the fallback tenant');
    assert.ok(app.opened.every((id) => id === 'T1'));
  } finally {
    await app.close();
  }
});

test('legacy fallback: never without the setting, and never for a hash the index knows', async () => {
  const app = await bootTwoTenants({ t2: { ...T2, status: 'suspended' } });
  try {
    const c = seedCase(app.dbA);
    const { token } = await sendOne(app.baseUrl, app.acsCalls, c);
    app.index.rows.clear();

    // (a) Unknown hash, setting absent: the bad-token page, nothing opened, no log.
    delete process.env.TC_EMAIL_TENANT_SLUG;
    app.opened.length = 0;
    let logs = await warnings(async () => {
      assert.equal((await unsubscribe(app.baseUrl, token)).text, DONE_PAGE);
    });
    assert.ok(!logs.some((l) => l.includes(publicLinkIndex.FALLBACK_LOG)));
    assert.deepEqual(app.opened, []);
    assert.equal(app.dbA.table('tc_contact_consent').length, 0);

    // (b) Setting present, but the index KNOWS this hash (its tenant is
    // suspended): no fallback to T1, even though T1's database holds the hash.
    process.env.TC_EMAIL_TENANT_SLUG = 'carein';
    await app.index.insert('T2', [{ hash: publicLinkIndex.hashToken(token), kind: 'unsubscribe', expiresAt: null }]);
    app.opened.length = 0;
    logs = await warnings(async () => {
      assert.equal((await unsubscribe(app.baseUrl, token)).text, DONE_PAGE);
    });
    assert.ok(!logs.some((l) => l.includes(publicLinkIndex.FALLBACK_LOG)));
    assert.deepEqual(app.opened, []);
    assert.equal(app.dbA.table('tc_contact_consent').length, 0);
  } finally {
    await app.close();
  }
});

// ── 5. a control plane that cannot be reached ───────────────────────────────

test('control plane unreachable → 503 on both routes, nothing opened', async () => {
  const app = await bootTwoTenants();
  try {
    publicLinkIndex.setBackendForTests({
      insert: async () => {
        throw new Error('down');
      },
      lookup: async () => {
        throw new Error('down');
      },
    });
    app.opened.length = 0;
    assert.equal((await unsubscribe(app.baseUrl, newToken())).status, 503);
    assert.equal((await referralView(app.baseUrl, newToken())).status, 503);
    assert.equal((await referralUse(app.baseUrl, newToken())).status, 503);
    assert.deepEqual(app.opened, []);
  } finally {
    await app.close();
  }
});

test('the fallback path: an unreachable control plane is 503 too, never a guess', async () => {
  const app = await bootTwoTenants();
  const orig = registry.getTenantBySlug;
  try {
    registry.getTenantBySlug = async () => {
      throw new Error('down');
    };
    assert.equal((await unsubscribe(app.baseUrl, newToken())).status, 503);
  } finally {
    registry.getTenantBySlug = orig;
    await app.close();
  }
});
