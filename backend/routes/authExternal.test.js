'use strict';

/**
 * The EXTERNAL sign-in door (S2b) — Entra External ID: Google or an email
 * one-time code, beside the staff Microsoft door.
 *
 * What this suite defends, in the order the callback decides it:
 *
 *   0. DARKNESS. Any missing or malformed setting → /auth/ext/* 404 and
 *      /auth/providers says external:false. Nothing is defaulted.
 *   a. STATE. Only a state minted by /ext/login is redeemable here, once.
 *   b. VERIFIED EMAIL. No email, or email_verified false → refused, no session.
 *   c. THE ROW IS THE GATE. No app_user row, or a disabled one → refused, no
 *      session — and no bootstrap fallback, no domain rule.
 *   d. BINDING. First sign-in binds the row to the token's sub; a different sub
 *      later is refused AND audited into that user's tenant log; a staff
 *      ('entra') row is refused the same way.
 *   e. THE SESSION is the same carein_sso cookie, marked idp:'external'.
 *   +  FAIL CLOSED: control DB down → 503, never a session.
 *   +  THE FALLBACK never applies to an external session, on /auth/me or /api.
 *   +  BACKFILL (round 2): every pre-S2b row is 'entra', so only a row added
 *      after it can be bound here.
 *   +  NO SUPER-ADMIN through this door: platform_admin is ignored for an
 *      external session, on /auth/me and on /api/platform.
 *
 * The MSAL client is replaced at the module seam (extSso.getClient); the token
 * exchange never leaves the process. Synthetic addresses only (@example.test),
 * except the fallback cases, which need the staff domain to prove anything and
 * use an obviously synthetic local part.
 */

// The session key must exist before config/sso.js is first required: it is
// captured at module load, and issueSession signs with it.
process.env.DASHBOARD_SESSION_SECRET = 'test-session-secret-not-a-real-value';

const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;

const express = require('express');

const sso = require('../config/sso');
const extSso = require('../config/extSso');
const registry = require('../platform/registry');
const userContext = require('../platform/userContext');
const auditModule = require('../platform/audit');

// auth.js destructures auditForTenant at require time, so the double must be
// installed BEFORE the router is required. It dispatches to a per-test impl.
/** @type {Array<{ tenantId: string, actor: string|null, action: string, resourceType: string, resourceId: string, result: string }>} */
let auditRows = [];
let auditFails = false;
const savedAuditForTenant = auditModule.auditForTenant;
auditModule.auditForTenant = async (req, tenantId, entry) => {
  if (auditFails) throw new Error('audit store down');
  auditRows.push({ tenantId, actor: req.user ? req.user.email : null, ...entry });
};

const authRouter = require('./auth');
const { requireDashboardAuth } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenantContext');
const { requireSuperAdmin, permissionsForRole } = require('../config/permissions');

const EXT_TENANT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const STAFF_TENANT = 'fb0713b3-53e4-426a-8b0f-e444441bfc29'; // careindent, as the fallback names it
const T1 = 'tenant-one';

const EXT_ENV = {
  DASHBOARD_EXTSSO_TENANT_ID: EXT_TENANT,
  DASHBOARD_EXTSSO_SUBDOMAIN: 'synthetic-practice',
  DASHBOARD_EXTSSO_CLIENT_ID: 'client-id-synthetic',
  DASHBOARD_EXTSSO_CLIENT_SECRET: 'client-secret-synthetic',
};

const PERSON = 'person.one@example.test';
const PLATFORM_ADMIN = 'platform.admin@example.test';

const REGISTRY_KEYS = [
  'getUserByEmail',
  'getPlatformAdminByEmail',
  'getTenantById',
  'getTenantBySlug',
  'getTenantClinics',
  'getEnabledModules',
  'touchUserLogin',
  'getExternalBinding',
  'bindExternalSub',
];
const savedRegistry = {};
for (const k of REGISTRY_KEYS) savedRegistry[k] = registry[k];
const savedGetClient = extSso.getClient;
const savedFallback = process.env.ROLES_BOOTSTRAP_FALLBACK;

// --- the fake control plane --------------------------------------------------

/** @type {Map<string, { user_id: string, tenant_id: string, email: string, role: string, status: string, auth_provider: string|null, external_sub: string|null }>} */
let rows;
let bindCalls;
let controlDbDown;
let bindRaises23505;
/** @type {Set<string>} active platform_admin emails */
let platformAdmins;

// --- the fake External ID authority -----------------------------------------

/** @type {Record<string, unknown> | null} */
let nextClaims;
/** @type {Record<string, unknown> | null} */
let lastAuthUrlRequest;

beforeEach(() => {
  for (const [k, v] of Object.entries(EXT_ENV)) process.env[k] = v;
  delete process.env.ROLES_BOOTSTRAP_FALLBACK; // unset = ON, the riskiest state
  userContext.clearCache();

  rows = new Map([
    [PERSON, { user_id: 'U1', tenant_id: T1, email: PERSON, role: 'tc', status: 'active', auth_provider: null, external_sub: null }],
  ]);
  bindCalls = [];
  controlDbDown = false;
  bindRaises23505 = false;
  platformAdmins = new Set();
  auditRows = [];
  auditFails = false;
  nextClaims = null;
  lastAuthUrlRequest = null;

  const down = () => {
    if (controlDbDown) throw new Error('connect ECONNREFUSED');
  };
  registry.getUserByEmail = async (email) => {
    down();
    const r = rows.get(String(email).toLowerCase());
    return r ? { user_id: r.user_id, tenant_id: r.tenant_id, email: r.email, role: r.role, status: r.status, last_login_at: null, home_office: null } : null;
  };
  registry.getPlatformAdminByEmail = async (email) => {
    down();
    const e = String(email).toLowerCase();
    return platformAdmins.has(e) ? { email: e, status: 'active' } : null;
  };
  registry.getTenantById = async (id) => ({ tenant_id: id, slug: 'demo', display_name: 'Demo Dental', status: 'active' });
  registry.getTenantBySlug = async (slug) => ({ tenant_id: 'T-STAFF', slug, display_name: 'Staff', status: 'active' });
  registry.getTenantClinics = async () => [];
  registry.getEnabledModules = async () => ['voice'];
  registry.touchUserLogin = async () => {};
  registry.getExternalBinding = async (tenantId, email) => {
    down();
    const r = rows.get(String(email).toLowerCase());
    return r && r.tenant_id === tenantId ? { auth_provider: r.auth_provider, external_sub: r.external_sub } : null;
  };
  registry.bindExternalSub = async (tenantId, email, sub) => {
    down();
    bindCalls.push({ tenantId, email, sub });
    if (bindRaises23505) {
      const err = new Error('duplicate key value violates unique constraint "app_user_external_sub_key"');
      // @ts-expect-error — pg error shape
      err.code = '23505';
      throw err;
    }
    const r = rows.get(String(email).toLowerCase());
    if (!r || r.tenant_id !== tenantId || r.external_sub !== null) return false;
    if (r.auth_provider !== null && r.auth_provider !== 'external') return false;
    r.external_sub = sub;
    r.auth_provider = 'external';
    return true;
  };

  extSso.getClient = () =>
    /** @type {never} */ ({
      getAuthCodeUrl: async (request) => {
        lastAuthUrlRequest = request;
        return `https://synthetic-practice.ciamlogin.com/authorize?state=${encodeURIComponent(request.state)}`;
      },
      acquireTokenByCode: async () => (nextClaims ? { idTokenClaims: nextClaims } : null),
    });
});

afterEach(() => {
  for (const k of Object.keys(EXT_ENV)) delete process.env[k];
  for (const k of REGISTRY_KEYS) registry[k] = savedRegistry[k];
  extSso.getClient = savedGetClient;
  if (savedFallback === undefined) delete process.env.ROLES_BOOTSTRAP_FALLBACK;
  else process.env.ROLES_BOOTSTRAP_FALLBACK = savedFallback;
  userContext.clearCache();
});

test.after(() => {
  auditModule.auditForTenant = savedAuditForTenant;
});

// --- harness -------------------------------------------------------------------

/** Minimal req.cookies shim so the test doesn't depend on cookie-parser. */
function cookieShim(req, _res, next) {
  req.cookies = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) req.cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  next();
}

/** Mount /auth, plus a tenant-gated /api probe, the way server.js orders them. */
async function boot() {
  const app = express();
  app.use(cookieShim);
  app.use('/auth', authRouter);
  app.use('/api', requireDashboardAuth(), tenantContext());
  app.get('/api/probe', (req, res) => res.json({ tenant: req.tenant.id, role: req.userRole }));
  // The platform tier, guarded exactly as server.js mounts it.
  app.use('/api/platform', requireSuperAdmin(), (_req, res) => res.json({ ok: true }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base,
        get: (path, cookie) =>
          fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} }),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** The session cookie a response set, or null. */
function sessionCookie(res) {
  const raw = res.headers.get('set-cookie') || '';
  const m = raw.match(new RegExp(`${sso.cookieName}=([^;]+)`));
  return m ? m[1] : null;
}

/** Start at /ext/login, then come back to /ext/callback carrying `claims`. */
async function signIn(srv, claims) {
  const login = await srv.get('/auth/ext/login');
  assert.equal(login.status, 302, 'login redirects to the authority');
  const state = String(lastAuthUrlRequest && lastAuthUrlRequest.state);
  nextClaims = claims;
  return srv.get(`/auth/ext/callback?code=synthetic-code&state=${encodeURIComponent(state)}`);
}

const googleClaims = (over = {}) => ({
  sub: 'ext-sub-AAA',
  oid: 'ext-oid-AAA',
  name: 'Person One',
  email: PERSON,
  email_verified: true,
  idp: 'google.com',
  ...over,
});

// --- 0. darkness -----------------------------------------------------------------

test('DARK: with no external settings, providers says false and both routes 404', async () => {
  for (const k of Object.keys(EXT_ENV)) delete process.env[k];
  const srv = await boot();
  try {
    assert.deepEqual(await (await srv.get('/auth/providers')).json(), { microsoft: true, external: false });
    assert.equal((await srv.get('/auth/ext/login')).status, 404);
    assert.equal((await srv.get('/auth/ext/callback?code=c&state=s')).status, 404);
  } finally {
    await srv.close();
  }
});

test('DARK: any ONE missing or malformed setting keeps the door dark — nothing is defaulted', () => {
  const cases = [
    ['DASHBOARD_EXTSSO_TENANT_ID', ''],
    ['DASHBOARD_EXTSSO_TENANT_ID', 'not-a-guid'],
    ['DASHBOARD_EXTSSO_SUBDOMAIN', ''],
    ['DASHBOARD_EXTSSO_SUBDOMAIN', 'evil.example.test/x'],
    ['DASHBOARD_EXTSSO_CLIENT_ID', ''],
    ['DASHBOARD_EXTSSO_CLIENT_SECRET', ''],
  ];
  for (const [key, value] of cases) {
    for (const [k, v] of Object.entries(EXT_ENV)) process.env[k] = v;
    process.env[key] = value;
    assert.equal(extSso.isConfigured(), false, `${key}=${JSON.stringify(value)} must read as not configured`);
    assert.equal(extSso.authority(), null);
    assert.equal(extSso.tenantId(), null);
  }
});

test('LIT: providers says true, the authority is <subdomain>.ciamlogin.com/<tenant>, and login goes there', async () => {
  assert.equal(extSso.authority(), `https://synthetic-practice.ciamlogin.com/${EXT_TENANT}`);
  const srv = await boot();
  try {
    assert.deepEqual(await (await srv.get('/auth/providers')).json(), { microsoft: true, external: true });
    const res = await srv.get('/auth/ext/login');
    assert.equal(res.status, 302);
    assert.match(String(res.headers.get('location')), /^https:\/\/synthetic-practice\.ciamlogin\.com\//);
    assert.match(String(lastAuthUrlRequest && lastAuthUrlRequest.redirectUri), /\/auth\/ext\/callback$/);
    assert.equal(lastAuthUrlRequest && lastAuthUrlRequest.codeChallengeMethod, 'S256');
  } finally {
    await srv.close();
  }
});

// --- a. state ----------------------------------------------------------------------

test('STATE: an unknown state, a replayed state, and a provider error are all refused without a session', async () => {
  const srv = await boot();
  try {
    const unknown = await srv.get('/auth/ext/callback?code=c&state=never-issued');
    assert.equal(unknown.status, 400);
    assert.equal(sessionCookie(unknown), null);

    const first = await signIn(srv, googleClaims());
    assert.equal(first.status, 302);
    const state = String(lastAuthUrlRequest && lastAuthUrlRequest.state);
    const replay = await srv.get(`/auth/ext/callback?code=c&state=${encodeURIComponent(state)}`);
    assert.equal(replay.status, 400, 'a state is redeemable once');

    const cancelled = await srv.get('/auth/ext/callback?error=access_denied&state=x');
    assert.equal(cancelled.status, 401);
    assert.equal(sessionCookie(cancelled), null);
  } finally {
    await srv.close();
  }
});

// --- b. verified email ----------------------------------------------------------------

test('VERIFIED EMAIL: no email claim, email_verified false (bool or string), or no sub → refused, no session, no lookup', async () => {
  let lookups = 0;
  const realLookup = registry.getUserByEmail;
  registry.getUserByEmail = async (e) => {
    lookups += 1;
    return realLookup(e);
  };
  const srv = await boot();
  try {
    for (const claims of [
      googleClaims({ email: undefined }),
      googleClaims({ email: '' }),
      googleClaims({ email_verified: false }),
      googleClaims({ email_verified: 'false' }),
      googleClaims({ sub: undefined }),
    ]) {
      const res = await signIn(srv, claims);
      assert.equal(res.status, 403, JSON.stringify(claims));
      assert.equal(sessionCookie(res), null);
      assert.match(await res.text(), /couldn't confirm the email address/);
    }
    assert.equal(lookups, 0, 'an untrusted address never reaches the app_user lookup');
  } finally {
    await srv.close();
  }
});

test('VERIFIED EMAIL: an email one-time-code sign-in (no idp, no email_verified) is accepted', async () => {
  const srv = await boot();
  try {
    const res = await signIn(srv, { sub: 'ext-sub-OTP', email: PERSON, name: 'Person One' });
    assert.equal(res.status, 302);
    assert.ok(sessionCookie(res));
  } finally {
    await srv.close();
  }
});

// --- c. the row is the gate -------------------------------------------------------------

test('NO ROW: an address with no app_user row gets the friendly page and no session', async () => {
  const srv = await boot();
  try {
    const res = await signIn(srv, googleClaims({ email: 'stranger@example.test' }));
    assert.equal(res.status, 403);
    assert.equal(sessionCookie(res), null);
    assert.match(await res.text(), /doesn't have access yet\. Ask your practice administrator to add you\./);
    assert.equal(bindCalls.length, 0);
  } finally {
    await srv.close();
  }
});

test('NO ROW: no domain rule and no fallback — even a staff-domain address with no row is refused here', async () => {
  const srv = await boot();
  try {
    const res = await signIn(srv, googleClaims({ email: 'synthetic.person@carein.ai' }));
    assert.equal(res.status, 403);
    assert.equal(sessionCookie(res), null);
  } finally {
    await srv.close();
  }
});

test('DISABLED: a disabled row is refused exactly like no row', async () => {
  rows.get(PERSON).status = 'disabled';
  const srv = await boot();
  try {
    const res = await signIn(srv, googleClaims());
    assert.equal(res.status, 403);
    assert.equal(sessionCookie(res), null);
    assert.match(await res.text(), /doesn't have access yet/);
    assert.equal(bindCalls.length, 0, 'a disabled row is never bound');
  } finally {
    await srv.close();
  }
});

// --- d. binding -----------------------------------------------------------------------------

test('BIND: the first sign-in binds the row to the token sub; the same sub signs in again without rebinding', async () => {
  const srv = await boot();
  try {
    const first = await signIn(srv, googleClaims());
    assert.equal(first.status, 302);
    assert.deepEqual(bindCalls, [{ tenantId: T1, email: PERSON, sub: 'ext-sub-AAA' }]);
    assert.equal(rows.get(PERSON).external_sub, 'ext-sub-AAA');
    assert.equal(rows.get(PERSON).auth_provider, 'external');

    const again = await signIn(srv, googleClaims());
    assert.equal(again.status, 302);
    assert.equal(bindCalls.length, 1, 'an already-bound row is checked, not rebound');
    assert.equal(auditRows.length, 0);
  } finally {
    await srv.close();
  }
});

test('BIND: a DIFFERENT identity for a bound address is refused (409, generic) and audited into that tenant', async () => {
  rows.get(PERSON).external_sub = 'ext-sub-AAA';
  rows.get(PERSON).auth_provider = 'external';
  const srv = await boot();
  try {
    const res = await signIn(srv, googleClaims({ sub: 'ext-sub-ZZZ' }));
    assert.equal(res.status, 409);
    assert.equal(sessionCookie(res), null);
    const body = await res.text();
    assert.match(body, /can't be used to sign in here/);
    assert.ok(!body.includes('ext-sub-AAA'), 'the stored identity is never disclosed');
    assert.equal(rows.get(PERSON).external_sub, 'ext-sub-AAA', 'the binding is not overwritten');
    assert.deepEqual(auditRows, [
      { tenantId: T1, actor: PERSON, action: 'UPDATE', resourceType: 'app_user', resourceId: PERSON, result: 'UNAUTHORIZED' },
    ]);
  } finally {
    await srv.close();
  }
});

test('BIND: a staff (entra) row can never be taken over through this door', async () => {
  rows.get(PERSON).auth_provider = 'entra';
  const srv = await boot();
  try {
    const res = await signIn(srv, googleClaims());
    assert.equal(res.status, 409);
    assert.equal(sessionCookie(res), null);
    assert.equal(bindCalls.length, 0, 'not even attempted');
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].result, 'UNAUTHORIZED');
  } finally {
    await srv.close();
  }
});

test('BACKFILL: a pre-S2b row (marked entra by 1789300000000) is refused; a row added after it binds', async () => {
  // The backfill leaves every row that existed before this slice 'entra' —
  // here, an admin row a mailbox-holder would most like to claim.
  rows.get(PERSON).auth_provider = 'entra';
  rows.get(PERSON).role = 'admin';
  const NEWCOMER = 'person.two@example.test';
  rows.set(NEWCOMER, { user_id: 'U2', tenant_id: T1, email: NEWCOMER, role: 'tc', status: 'active', auth_provider: null, external_sub: null });

  const srv = await boot();
  try {
    const old = await signIn(srv, googleClaims());
    assert.equal(old.status, 409);
    assert.equal(sessionCookie(old), null);
    assert.equal(rows.get(PERSON).auth_provider, 'entra', 'the staff row is untouched');
    assert.equal(rows.get(PERSON).external_sub, null);
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].result, 'UNAUTHORIZED');

    const added = await signIn(srv, googleClaims({ sub: 'ext-sub-NEW', email: NEWCOMER }));
    assert.equal(added.status, 302);
    assert.ok(sessionCookie(added));
    assert.equal(rows.get(NEWCOMER).auth_provider, 'external');
    assert.deepEqual(bindCalls, [{ tenantId: T1, email: NEWCOMER, sub: 'ext-sub-NEW' }]);
  } finally {
    await srv.close();
  }
});

test('BIND: an identity that already owns another row (unique violation) is refused, not granted', async () => {
  bindRaises23505 = true;
  const srv = await boot();
  try {
    const res = await signIn(srv, googleClaims());
    assert.equal(res.status, 409);
    assert.equal(sessionCookie(res), null);
  } finally {
    await srv.close();
  }
});

test('BIND: a refusal stays a refusal when its audit write fails — nothing is granted', async () => {
  rows.get(PERSON).external_sub = 'ext-sub-AAA';
  rows.get(PERSON).auth_provider = 'external';
  auditFails = true;
  const srv = await boot();
  try {
    const res = await signIn(srv, googleClaims({ sub: 'ext-sub-ZZZ' }));
    assert.equal(res.status, 409);
    assert.equal(sessionCookie(res), null);
  } finally {
    await srv.close();
  }
});

// --- fail closed ------------------------------------------------------------------------------

test('FAIL CLOSED: control DB unreachable → 503 and never a session', async () => {
  controlDbDown = true;
  const srv = await boot();
  try {
    const res = await signIn(srv, googleClaims());
    assert.equal(res.status, 503);
    assert.equal(sessionCookie(res), null);
    const body = await res.text();
    assert.match(body, /temporarily unavailable/);
    assert.ok(!/ECONNREFUSED|Error|at /.test(body), 'no stack or driver text on the page');
  } finally {
    await srv.close();
  }
});

// --- e. the session ------------------------------------------------------------------------------

test('SESSION: the same carein_sso JWT shape, marked idp external, tid = the External ID tenant', async () => {
  const srv = await boot();
  try {
    const res = await signIn(srv, googleClaims());
    const token = sessionCookie(res);
    assert.ok(token);
    const claims = sso.verifySession(String(token));
    assert.ok(claims);
    assert.equal(claims.email, PERSON);
    assert.equal(claims.sub, 'ext-sub-AAA');
    assert.equal(claims.oid, 'ext-oid-AAA');
    assert.equal(claims.name, 'Person One');
    assert.equal(claims.tid, EXT_TENANT);
    assert.equal(claims.idp, 'external');
    assert.match(String(res.headers.get('set-cookie')), /HttpOnly/i);

    // /auth/me reads it like any other session: role from the row.
    const me = await (await srv.get('/auth/me', `${sso.cookieName}=${token}`)).json();
    assert.equal(me.authenticated, true);
    assert.equal(me.role, 'tc');
    assert.deepEqual(me.user, { name: 'Person One', email: PERSON, tenantId: EXT_TENANT });
  } finally {
    await srv.close();
  }
});

// --- the fallback never applies to an external session ---------------------------------------------

test('FALLBACK: an external session with no row resolves role null with the flag ON — on /auth/me and /api', async () => {
  // The worst case: staff domain AND careindent tid in the cookie, flag unset
  // (= on). Only the idp claim stands between this and an 'office' role.
  const email = 'synthetic.person@carein.ai';
  const external = sso.issueSession({ sub: 's', oid: 'o', name: 'n', email, tid: STAFF_TENANT, idp: 'external' });
  const staff = sso.issueSession({ sub: 's', oid: 'o', name: 'n', email, tid: STAFF_TENANT });

  const srv = await boot();
  try {
    const extMe = await (await srv.get('/auth/me', `${sso.cookieName}=${external}`)).json();
    assert.equal(extMe.role, null, 'no fallback role for an external session');
    assert.equal(extMe.tenant, null);
    assert.deepEqual(extMe.permissions, []);

    const extApi = await srv.get('/api/probe', `${sso.cookieName}=${external}`);
    assert.equal(extApi.status, 403, 'and /api refuses it — no tenant resolves');

    // Control: the SAME cookie minus the idp claim is a staff session, and the
    // fallback still behaves exactly as before for it.
    const staffMe = await (await srv.get('/auth/me', `${sso.cookieName}=${staff}`)).json();
    assert.equal(staffMe.role, 'office');
    const staffApi = await srv.get('/api/probe', `${sso.cookieName}=${staff}`);
    assert.equal(staffApi.status, 200);
    assert.equal((await staffApi.json()).role, 'office');
  } finally {
    await srv.close();
  }
});

// --- no super-admin through the external door ------------------------------------------------------

test('SUPER-ADMIN: a platform_admin signed in externally is NOT a super_admin — /auth/me false, /api/platform 403', async () => {
  platformAdmins.add(PLATFORM_ADMIN);
  rows.set(PLATFORM_ADMIN, { user_id: 'U9', tenant_id: T1, email: PLATFORM_ADMIN, role: 'admin', status: 'active', auth_provider: null, external_sub: null });

  const srv = await boot();
  try {
    // Through the real door, end to end.
    const res = await signIn(srv, googleClaims({ sub: 'ext-sub-PA', email: PLATFORM_ADMIN }));
    assert.equal(res.status, 302);
    const token = String(sessionCookie(res));
    const cookie = `${sso.cookieName}=${token}`;

    const me = await (await srv.get('/auth/me', cookie)).json();
    assert.equal(me.isSuperAdmin, false);
    assert.equal(me.role, 'admin', 'the practice role from the row still holds');
    assert.deepEqual(me.permissions, permissionsForRole('admin'), "an admin's permissions, not the super_admin's");

    const platform = await srv.get('/api/platform/practices', cookie);
    assert.equal(platform.status, 403);
    assert.equal((await platform.json()).action, 'platform.admin');

    // The practice side is unaffected.
    assert.equal((await srv.get('/api/probe', cookie)).status, 200);
  } finally {
    await srv.close();
  }
});

test('SUPER-ADMIN: the same email through the STAFF door keeps it — /auth/me true, /api/platform 200', async () => {
  platformAdmins.add(PLATFORM_ADMIN);
  rows.set(PLATFORM_ADMIN, { user_id: 'U9', tenant_id: T1, email: PLATFORM_ADMIN, role: 'admin', status: 'active', auth_provider: 'entra', external_sub: null });

  // A staff session: no idp claim, exactly as /auth/callback mints it.
  const staff = sso.issueSession({ sub: 's', oid: 'o', name: 'n', email: PLATFORM_ADMIN, tid: STAFF_TENANT });
  const cookie = `${sso.cookieName}=${staff}`;

  const srv = await boot();
  try {
    const me = await (await srv.get('/auth/me', cookie)).json();
    assert.equal(me.isSuperAdmin, true);
    assert.equal((await srv.get('/api/platform/practices', cookie)).status, 200);
  } finally {
    await srv.close();
  }
});
