'use strict';

/**
 * One door per person, end to end: a name and licence entered on the Users
 * page (PUT /api/users/:email/signature) print on that person's staged hygiene
 * note — with no sign-in typed anywhere, because the sign-in IS their app_user
 * email.
 *
 * Two apps over ONE fake practice database, in sequence:
 *   1. /api/users, mounted as server.js mounts it (admin.all gate), where the
 *      office manager saves the signature;
 *   2. the assembled hygiene app (hygTestUtils.bootHygApp), where the
 *      hygienist signed in with that email stages the note.
 *
 * signatureFor / signatureBlock are not touched by this slice; this pins that
 * the row the Users door writes is one they match. Synthetic staff only; Roland
 * 12827 is the fixture patient. No Open Dental call is made by the Users door.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const registry = require('../platform/registry');
const auditModule = require('../platform/audit');
const tenantDb = require('../platform/tenantDb');
const userContext = require('../platform/userContext');
const { requirePermission } = require('../config/permissions');
const { FakeHygDb, FakeOd, bootHygApp, api, apptRow, patientRow, operatoryRow } = require('./hyg/hygTestUtils');
const { useSyntheticStaff } = require('../config/hygStaff.fixture');

useSyntheticStaff();

const DATE = '2026-09-08';
const HYGIENIST = 'avery.example@carein.ai';

function od() {
  return new FakeOd({
    '/appointments': [apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' })],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow(),
    '/procedurelogs': [],
    '/procedurelogs/GroupNotes': [],
    '/definitions': [{ DefNum: 473, ItemName: 'Routers' }],
  });
}

/** The Users door over `db`, as an admin; returns the PUT's response. */
async function saveViaUsersDoor(db, email, body) {
  const saved = {
    getTenantUser: registry.getTenantUser,
    getPlatformAdminByEmail: registry.getPlatformAdminByEmail,
    withTenantDb: tenantDb.withTenantDb,
    audit: auditModule.audit,
  };
  registry.getTenantUser = async (tenantId, e) =>
    tenantId === 'T1' && String(e).toLowerCase() === HYGIENIST
      ? { tenant_id: 'T1', email: HYGIENIST, role: 'hygiene', status: 'active', home_office: 'roland' }
      : null;
  registry.getPlatformAdminByEmail = async () => null;
  tenantDb.withTenantDb = async (_req, fn) => fn(db);
  auditModule.audit = async (_req, entry) => {
    db.audit.push({ resource_type: entry.resourceType, ...entry });
  };

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = { email: 'om@carein.ai', name: 'Office Manager' };
    req.tenant = { id: 'T1', slug: 'carein', modules: ['hyg'], clinics: [] };
    req.userRole = 'admin';
    req.isSuperAdmin = false;
    next();
  });
  delete require.cache[require.resolve('./users')];
  app.use('/api/users', requirePermission('admin.all'), require('./users'));
  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/users/${encodeURIComponent(email)}/signature`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((r) => server.close(r));
    Object.assign(registry, { getTenantUser: saved.getTenantUser, getPlatformAdminByEmail: saved.getPlatformAdminByEmail });
    tenantDb.withTenantDb = saved.withTenantDb;
    auditModule.audit = saved.audit;
    userContext.clearCache();
  }
}

/** Stage the note as the signed-in hygienist; return the typed-name line. */
async function noteNameLine(db, user) {
  const app = await bootHygApp({ db, od: od(), user: { ...user, tenantId: 'x' }, role: 'hygiene' });
  try {
    const q = '?office=roland&date=' + DATE;
    assert.equal((await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + q)).status, 200);
    const staged = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + q, { body: { kind: 'note' } });
    assert.equal(staged.status, 201, JSON.stringify(staged.body));
    const preview = staged.body.visit.stagedWrites.find((w) => w.kind === 'note').preview;
    const unsigned = preview.findIndex((l) => /Unsigned\./.test(l));
    return preview[unsigned - 1];
  } finally {
    await app.close();
  }
}

test('a licence entered on the Users page prints on that person’s staged note', async () => {
  const db = new FakeHygDb();
  const saved = await saveViaUsersDoor(db, HYGIENIST, { fullName: 'Avery Example', license: '7777' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  // Her SSO display name is unrelated to the roster's — the email alone matches.
  const line = await noteNameLine(db, { email: HYGIENIST, name: 'A. Ex' });
  assert.equal(line, 'Avery Example RDH #7777');
});

test('no licence entered: the full name prints alone — never a placeholder', async () => {
  const db = new FakeHygDb();
  assert.equal((await saveViaUsersDoor(db, HYGIENIST, { fullName: 'Avery Example', license: '' })).status, 200);
  assert.equal(await noteNameLine(db, { email: HYGIENIST, name: 'A. Ex' }), 'Avery Example');
});

test('cleared on the Users page: the note no longer prints that licence', async () => {
  const db = new FakeHygDb();
  await saveViaUsersDoor(db, HYGIENIST, { fullName: 'Avery Example', license: '7777' });
  assert.equal((await saveViaUsersDoor(db, HYGIENIST, { fullName: null, license: null })).status, 200);
  const line = await noteNameLine(db, { email: HYGIENIST, name: 'Signed In Name' });
  assert.ok(!/7777/.test(line), line);
  assert.equal(line, 'Signed In Name');
});
