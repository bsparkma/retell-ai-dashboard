'use strict';

/**
 * /api/tc/notification-prefs (queue item 51).
 *
 *   1  a preference round-trips per user per event; the office default applies
 *      when the user has none; neither ⇒ banner.
 *   2  (client side: tests/tc-notification-prefs.test.tsx)
 *   3  a user only ever reads/writes THEIR OWN prefs (keyed by the session's
 *      email, never a request field); the office default needs admin.
 *   +  office-scoped defaults; every change audited with a slug prior_state.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeTenantDb, bootTcApp, api, auditRows } = require('./tcTestUtils');

const URL = (office) => `/api/tc/notification-prefs?office=${office}`;
const MINE = (office, event) => `/api/tc/notification-prefs/mine/${event}?office=${office}`;
const OFFICE = (office, event) => `/api/tc/notification-prefs/office/${event}?office=${office}`;

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

function row(body, event) {
  return body.events.find((e) => e.event === event);
}

test('1: nobody has chosen ⇒ every event is banner, from the default', async (t) => {
  const { baseUrl } = await boot(t, { role: 'tc' });
  const r = await api(baseUrl, 'GET', URL('roland'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.events.map((e) => [e.event, e.level, e.source]), [
    ['checkout_handoff', 'banner', 'default'],
    ['referral_signoff', 'banner', 'default'],
  ]);
  assert.equal(r.body.canEditOffice, false, 'a tc user cannot edit the office default');
});

test('1: my override round-trips, and clearing it falls back to the office default', async (t) => {
  const db = new FakeTenantDb();
  // The admin sets the office default to silent…
  const admin = await bootTcApp({ db, role: 'admin', user: { email: 'Boss@CareIN.ai', name: 'Boss', tenantId: 'x' } });
  const set = await api(admin.baseUrl, 'PUT', OFFICE('roland', 'checkout_handoff'), { level: 'silent' });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  await admin.close();

  // …a TC user sees it, then overrides it for themselves.
  const { baseUrl } = await boot(t, { db, role: 'tc' });
  let r = await api(baseUrl, 'GET', URL('roland'));
  assert.deepEqual(row(r.body, 'checkout_handoff'), {
    event: 'checkout_handoff',
    level: 'silent',
    source: 'office',
    mine: null,
    officeDefault: 'silent',
  });
  r = await api(baseUrl, 'PUT', MINE('roland', 'checkout_handoff'), { level: 'sound_banner' });
  assert.equal(r.status, 200);
  assert.equal(row(r.body, 'checkout_handoff').level, 'sound_banner');
  assert.equal(row(r.body, 'checkout_handoff').source, 'user');
  assert.equal(row(r.body, 'referral_signoff').source, 'default', 'per event');

  r = await api(baseUrl, 'PUT', MINE('roland', 'checkout_handoff'), { level: null });
  assert.equal(row(r.body, 'checkout_handoff').level, 'silent');
  assert.equal(row(r.body, 'checkout_handoff').source, 'office');
  assert.equal(db.table('tc_notification_prefs').length, 0, 'cleared, not stored as null');
});

test('3: my prefs are keyed by MY session email (lowercased) — another user is unaffected', async (t) => {
  const db = new FakeTenantDb();
  const a = await bootTcApp({ db, role: 'tc', user: { email: 'Front.Desk@CareIN.ai', name: 'A', tenantId: 'x' } });
  // A request field naming somebody else is refused by the strict body.
  const forged = await api(a.baseUrl, 'PUT', MINE('roland', 'checkout_handoff'), {
    level: 'silent',
    userEmail: 'someone.else@carein.ai',
  });
  assert.equal(forged.status, 400);
  assert.equal((await api(a.baseUrl, 'PUT', MINE('roland', 'checkout_handoff'), { level: 'silent' })).status, 200);
  await a.close();
  assert.equal(db.table('tc_notification_prefs')[0].user_email, 'front.desk@carein.ai');

  const { baseUrl } = await boot(t, { db, role: 'tc', user: { email: 'other@carein.ai', name: 'B', tenantId: 'x' } });
  const r = await api(baseUrl, 'GET', URL('roland'));
  assert.equal(row(r.body, 'checkout_handoff').level, 'banner', "A's override is A's alone");
});

test('3: only an admin may change the office default', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const r = await api(baseUrl, 'PUT', OFFICE('roland', 'checkout_handoff'), { level: 'silent' });
  assert.equal(r.status, 403);
  assert.equal(db.table('tc_notification_defaults').length, 0);
});

test('office defaults are per office', async (t) => {
  const { baseUrl } = await boot(t, { role: 'admin' });
  assert.equal((await api(baseUrl, 'PUT', OFFICE('roland', 'checkout_handoff'), { level: 'sound_banner' })).status, 200);
  const roland = await api(baseUrl, 'GET', URL('roland'));
  const valley = await api(baseUrl, 'GET', URL('valley'));
  assert.equal(row(roland.body, 'checkout_handoff').level, 'sound_banner');
  assert.equal(row(valley.body, 'checkout_handoff').level, 'banner');
  assert.equal(roland.body.canEditOffice, true);
});

test('an unknown event or level is a 400 and stores nothing', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'admin' });
  assert.equal((await api(baseUrl, 'PUT', MINE('roland', 'push_everything'), { level: 'banner' })).status, 400);
  assert.equal((await api(baseUrl, 'PUT', MINE('roland', 'checkout_handoff'), { level: 'siren' })).status, 400);
  assert.equal((await api(baseUrl, 'PUT', OFFICE('roland', 'checkout_handoff'), { level: 'loud' })).status, 400);
  assert.equal(db.table('tc_notification_prefs').length, 0);
  assert.equal(db.table('tc_notification_defaults').length, 0);
});

test('every change is audited with the level it replaced (a slug)', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'admin' });
  await api(baseUrl, 'PUT', MINE('roland', 'checkout_handoff'), { level: 'silent' });
  await api(baseUrl, 'PUT', MINE('roland', 'checkout_handoff'), { level: 'sound_banner' });
  await api(baseUrl, 'PUT', OFFICE('roland', 'referral_signoff'), { level: 'silent' });
  const rows = auditRows(db);
  assert.deepEqual(
    rows.map((a) => [a.resource_type, a.resource_id, a.prior_state]),
    [
      ['tc_notification_pref', 'checkout_handoff', 'unset'],
      ['tc_notification_pref', 'checkout_handoff', 'silent'],
      ['tc_notification_default', 'roland/referral_signoff', 'unset'],
    ]
  );
  for (const a of rows) assert.match(a.prior_state, /^[a-z0-9_]{1,32}(:[a-z0-9_]{1,31})?$/);
});

test('a hygienist (tc.hygiene only) cannot reach it', async (t) => {
  const { baseUrl } = await boot(t, { role: 'hygiene' });
  assert.equal((await api(baseUrl, 'GET', URL('roland'))).status, 403);
});
