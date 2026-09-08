'use strict';

/**
 * Permission map + guard tests (Roles PR A).
 *
 * The map is authorization configuration, so the tests assert the SHAPE of the
 * whole map (every action resolves, every role listed is a real role) as well
 * as the behavior of the guards. A typo'd role string in the map would
 * otherwise be a silent permanent denial.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PERMISSIONS,
  TENANT_ROLES,
  roleHasPermission,
  permissionsForRole,
  requirePermission,
  requireReadWrite,
  requireSuperAdmin,
  isMachineCaller,
} = require('./permissions');

// --- test doubles ----------------------------------------------------------

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
}

function makeNext() {
  const calls = { count: 0 };
  const next = () => {
    calls.count += 1;
  };
  next.calls = calls;
  return next;
}

/** Run a guard and report whether it called next() or what it refused with. */
function run(mw, req) {
  const res = makeRes();
  const next = makeNext();
  mw({ path: '/x', method: 'GET', ...req }, res, next);
  return { passed: next.calls.count === 1, res };
}

// --- map shape -------------------------------------------------------------

test('every action resolves to a non-empty list of known roles', () => {
  const actions = Object.keys(PERMISSIONS);
  assert.ok(actions.length > 0, 'the map must not be empty');

  for (const action of actions) {
    const roles = PERMISSIONS[action];
    assert.ok(Array.isArray(roles), `${action}: roles must be an array`);
    assert.ok(roles.length > 0, `${action}: must list at least one role`);
    for (const role of roles) {
      assert.ok(
        TENANT_ROLES.includes(role),
        `${action}: '${role}' is not a known tenant role (${TENANT_ROLES.join(', ')})`
      );
    }
    // No duplicates — a duplicate is a merge artifact, not a meaning.
    assert.equal(new Set(roles).size, roles.length, `${action}: duplicate role entries`);
  }
});

test('the map is frozen — authorization config cannot be mutated at runtime', () => {
  assert.ok(Object.isFrozen(PERMISSIONS));
  assert.ok(Object.isFrozen(PERMISSIONS['admin.all']));
});

test('admin holds every action; office holds everything except the two admin ones', () => {
  for (const action of Object.keys(PERMISSIONS)) {
    assert.ok(roleHasPermission('admin', action), `admin should hold ${action}`);
  }
  /*
   * `rcm.settings` joined `admin.all` here when the shadow gate landed. Running
   * the day and deciding what the day is allowed to do are different
   * authorities: an `office` user presses Drain (`rcm.post`), an `admin` decides
   * whether pressing it may reach a chart at all.
   */
  const ADMIN_ONLY = ['admin.all', 'rcm.settings'];
  for (const action of ADMIN_ONLY) {
    assert.equal(roleHasPermission('office', action), false, `office must NOT hold ${action}`);
  }
  for (const action of Object.keys(PERMISSIONS)) {
    if (ADMIN_ONLY.includes(action)) continue;
    assert.ok(roleHasPermission('office', action), `office should hold ${action}`);
  }
});

test("tc is read-only on voice: reads yes, every voice write no", () => {
  assert.ok(roleHasPermission('tc', 'voice.read'));
  for (const action of ['voice.write', 'voice.sync', 'voice.transcribe', 'voice.chart_write', 'voice.send_to_tc']) {
    assert.equal(roleHasPermission('tc', action), false, `tc must NOT hold ${action}`);
  }
  assert.ok(roleHasPermission('tc', 'tc.full'));
});

test('hygiene holds its own two surfaces and NOTHING else', () => {
  // The TC handoff screens (tc.hygiene) and the hyg module (hyg.read/write).
  // The point of the assertion is the exhaustive list, not its length: a
  // hygienist gaining voice.read, tc.full or anything rcm.* by accident is the
  // failure this catches, and it catches it whichever action leaks in.
  const held = permissionsForRole('hygiene');
  assert.deepEqual(held, ['hyg.read', 'hyg.write', 'tc.hygiene']);
});

test('the hyg module is not reachable by the roles it was not built for', () => {
  for (const role of ['tc', 'reviewer', 'rcm_biller']) {
    for (const action of ['hyg.read', 'hyg.write']) {
      assert.equal(roleHasPermission(role, action), false, `${role} must NOT hold ${action}`);
    }
  }
  // ... and IS reachable by the three that were.
  for (const role of ['admin', 'office', 'hygiene']) {
    assert.ok(roleHasPermission(role, 'hyg.read'), `${role} must hold hyg.read`);
  }
});

test('unknown action denies for every role, including admin', () => {
  for (const role of TENANT_ROLES) {
    assert.equal(roleHasPermission(role, 'voice.nope'), false);
    assert.equal(roleHasPermission(role, ''), false);
  }
});

test('unknown / null / non-string role denies everything', () => {
  for (const role of ['staff', 'superuser', '', null, undefined, 42, {}]) {
    assert.equal(roleHasPermission(role, 'voice.read'), false, `role ${String(role)} must be denied`);
  }
});

test('prototype keys are not actions (hasOwnProperty guard)', () => {
  assert.equal(roleHasPermission('admin', 'constructor'), false);
  assert.equal(roleHasPermission('admin', 'toString'), false);
  assert.equal(roleHasPermission('admin', '__proto__'), false);
});

test('permissionsForRole: super_admin holds every action regardless of tenant role', () => {
  const all = Object.keys(PERMISSIONS).sort();
  assert.deepEqual(permissionsForRole(null, { isSuperAdmin: true }), all);
  assert.deepEqual(permissionsForRole('hygiene', { isSuperAdmin: true }), all);
});

test('permissionsForRole: no role → empty list', () => {
  assert.deepEqual(permissionsForRole(null), []);
  assert.deepEqual(permissionsForRole('staff'), []);
});

// --- requirePermission -----------------------------------------------------

test('requirePermission: allowed role passes', () => {
  const { passed } = run(requirePermission('voice.sync'), { userRole: 'office' });
  assert.ok(passed);
});

test('requirePermission: denied role gets 403 with the failing action, no redirect', () => {
  const { passed, res } = run(requirePermission('voice.sync'), { userRole: 'tc' });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
  assert.equal(res.body.action, 'voice.sync');
  assert.equal(res.body.success, false);
});

test('requirePermission: super_admin passes everything, even with no tenant role', () => {
  for (const action of Object.keys(PERMISSIONS)) {
    const { passed } = run(requirePermission(action), { userRole: null, isSuperAdmin: true });
    assert.ok(passed, `super_admin should pass ${action}`);
  }
});

test('requirePermission: super_admin passes even when the tenant role would be denied', () => {
  const { passed } = run(requirePermission('admin.all'), { userRole: 'hygiene', isSuperAdmin: true });
  assert.ok(passed);
});

test('requirePermission: machine token (no user identity) passes', () => {
  const { passed } = run(requirePermission('admin.all'), { authMethod: 'token' });
  assert.ok(passed);
});

test('requirePermission: a SESSION user is never treated as a machine caller', () => {
  const req = { authMethod: 'session', user: { email: 'someone@carein.ai' }, userRole: 'hygiene' };
  assert.equal(isMachineCaller(req), false);
  const { passed, res } = run(requirePermission('admin.all'), req);
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
});

test('requirePermission: a token request that ALSO carries a user identity is gated by role', () => {
  // The loopback TC client forwards whichever credential the caller used. If a
  // request somehow has both, the human identity wins — a bearer token must not
  // launder a hygienist into an admin.
  const req = { authMethod: 'token', user: { email: 'someone@carein.ai' }, userRole: 'hygiene' };
  assert.equal(isMachineCaller(req), false);
  const { passed } = run(requirePermission('admin.all'), req);
  assert.equal(passed, false);
});

test('requirePermission: no role at all (disabled / unresolved) is denied', () => {
  const { passed, res } = run(requirePermission('voice.read'), { userRole: null });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
});

test('requirePermission: unknown action throws at CONSTRUCTION, not at request time', () => {
  assert.throws(() => requirePermission('voice.does_not_exist'), /unknown action/);
  assert.throws(() => requirePermission(''), /non-empty action name/);
  assert.throws(() => requirePermission(undefined), /non-empty action name/);
});

test('requirePermission: exempt paths bypass the gate', () => {
  const mw = requirePermission('voice.read', { exempt: [/^\/sync-status$/] });
  const exempt = run(mw, { path: '/sync-status', userRole: 'hygiene' });
  assert.ok(exempt.passed, 'exempt path should pass for a role that lacks the action');

  const guarded = run(mw, { path: '/', userRole: 'hygiene' });
  assert.equal(guarded.passed, false, 'non-exempt path on the same mount still enforces');
});

// --- requireReadWrite ------------------------------------------------------

test('requireReadWrite: GET uses the read action, POST/PATCH/DELETE use the write action', () => {
  const mw = requireReadWrite('voice.read', 'voice.write');

  assert.ok(run(mw, { method: 'GET', userRole: 'tc' }).passed, 'tc may read');
  assert.ok(run(mw, { method: 'HEAD', userRole: 'tc' }).passed, 'HEAD is a read');
  assert.ok(run(mw, { method: 'OPTIONS', userRole: 'tc' }).passed, 'OPTIONS is a read');

  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const { passed, res } = run(mw, { method, userRole: 'tc' });
    assert.equal(passed, false, `tc must not ${method}`);
    assert.equal(res.body.action, 'voice.write');
  }

  assert.ok(run(mw, { method: 'POST', userRole: 'office' }).passed, 'office may write');
});

test('requireReadWrite: hygiene is denied the voice surface in both directions', () => {
  const mw = requireReadWrite('voice.read', 'voice.write');
  assert.equal(run(mw, { method: 'GET', userRole: 'hygiene' }).passed, false);
  assert.equal(run(mw, { method: 'POST', userRole: 'hygiene' }).passed, false);
});

// --- requireSuperAdmin -----------------------------------------------------

test('requireSuperAdmin: only a platform admin passes', () => {
  assert.ok(run(requireSuperAdmin(), { isSuperAdmin: true }).passed);

  for (const role of TENANT_ROLES) {
    const { passed, res } = run(requireSuperAdmin(), { userRole: role });
    assert.equal(passed, false, `tenant role ${role} must not pass requireSuperAdmin`);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.action, 'platform.admin');
  }
});

test('requireSuperAdmin: a machine token does NOT pass', () => {
  // Deliberate asymmetry with requirePermission: tenant-level admin-equivalence
  // for an existing shared credential is pragmatic; letting it edit the tenant
  // catalog is not.
  const { passed, res } = run(requireSuperAdmin(), { authMethod: 'token' });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
});
