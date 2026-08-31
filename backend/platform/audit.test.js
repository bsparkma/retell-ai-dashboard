'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { afterEach } = test;

const tenantDb = require('./tenantDb');
const registry = require('./registry');
const audit = require('./audit');

const original = {
  withTenantDb: tenantDb.withTenantDb,
  listTenants: registry.listTenants,
  nodeEnv: process.env.NODE_ENV,
};

afterEach(() => {
  tenantDb.withTenantDb = original.withTenantDb;
  registry.listTenants = original.listTenants;
  if (original.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = original.nodeEnv;
});

/** Capture the INSERT a successful audit write would run. */
function captureQuery() {
  const captured = {};
  tenantDb.withTenantDb = async (req, fn) => {
    const pool = {
      query: async (text, params) => {
        captured.text = text;
        captured.params = params;
        return { rowCount: 1 };
      },
    };
    return fn(pool);
  };
  return captured;
}

test('writes one audit row with the expected column order and values', async () => {
  const captured = captureQuery();
  const req = {
    user: { email: 'staff@carein.ai' },
    tenant: { id: 'T1' },
    ip: '203.0.113.7',
    originalUrl: '/api/opendental/patients/123',
  };

  await audit.audit(req, { action: 'READ', resourceType: 'patient', resourceId: 123, result: 'SUCCESS' });

  assert.match(captured.text, /INSERT INTO audit_log/);
  // [user_id, tenant_id, action, resource_type, resource_id, ip, result, endpoint,
  //  office, origin_office, source_ref, prior_state]
  assert.deepEqual(captured.params, [
    'staff@carein.ai',
    'T1',
    'READ',
    'patient',
    '123', // stringified ID — never a PHI value
    '203.0.113.7',
    'SUCCESS',
    '/api/opendental/patients/123',
    null, // office omitted → NULL ("not an office-scoped action"), never a guess
    null, // origin_office omitted → NULL ("no origin distinct from the target")
    null, // source_ref omitted → NULL ("no recorded external cause"), same rule
    null, // prior_state omitted → NULL ("this action replaced nothing"), same rule
  ]);
});

test('records what an action REPLACED, when it replaced a decision', async () => {
  const captured = captureQuery();
  const req = {
    user: { email: 'staff@carein.ai' },
    tenant: { id: 'T1' },
    ip: '203.0.113.7',
    originalUrl: '/api/rcm/remittances/b-1/comparison',
  };

  await audit.audit(req, {
    action: 'UPDATE',
    resourceType: 'rcm_remittance_comparison',
    resourceId: 'b-1',
    office: 'roland',
    priorState: 'differed:write_off',
    result: 'SUCCESS',
  });

  // A revision counter says an answer CHANGED; only this says which way. The
  // column is slug-shaped by CHECK constraint (1788000000000), so it cannot
  // become a copy of the sentence a person typed — which is the rule that keeps
  // free text out of this table at all.
  assert.equal(captured.params[11], 'differed:write_off');
});

test('records the external cause when one is given', async () => {
  const captured = captureQuery();
  const req = {
    user: { email: 'staff@carein.ai' },
    tenant: { id: 'T1' },
    ip: '203.0.113.7',
    originalUrl: '/api/tc/cases/from-call',
  };

  await audit.audit(req, {
    action: 'CREATE',
    resourceType: 'tc_case',
    resourceId: 'c-1',
    office: 'roland',
    sourceRef: 'mango_call_9',
    result: 'SUCCESS',
  });

  // tc_case_events is normal CRUD; audit_log is append-only. This is the copy
  // of "which call caused this case" that survives.
  assert.equal(captured.params[10], 'mango_call_9');
});

test('records both offices when a chart action crosses practices', async () => {
  const captured = captureQuery();
  const req = {
    user: { email: 'staff@carein.ai' },
    tenant: { id: 'T1' },
    ip: '203.0.113.7',
    originalUrl: '/api/unified-calls/abc/resolve-patient',
  };

  await audit.audit(req, {
    action: 'CREATE',
    resourceType: 'commlog',
    resourceId: 9001,
    office: 'roland',
    originOffice: 'valley',
    result: 'SUCCESS',
  });

  // "Why is there a Roland chart note from a call that rang at Riley?" has to be
  // answerable from the row itself — office is the chart, origin_office is the call.
  assert.equal(captured.params[8], 'roland');
  assert.equal(captured.params[9], 'valley');
});

test('records the office key when the action is office-scoped', async () => {
  const captured = captureQuery();
  const req = {
    user: { email: 'staff@carein.ai' },
    tenant: { id: 'T1' },
    ip: '203.0.113.7',
    originalUrl: '/api/unified-calls/abc/resolve-patient',
  };

  await audit.audit(req, {
    action: 'CREATE', resourceType: 'commlog', resourceId: 9001, office: 'valley', result: 'SUCCESS',
  });

  // Without the office, "commlog against PatNum 7115" is ambiguous across practices.
  assert.equal(captured.params[8], 'valley');
});

test('scrubs PHI from the recorded endpoint and never stores the phone number', async () => {
  const captured = captureQuery();
  const req = {
    user: { email: 'staff@carein.ai' },
    tenant: { id: 'T1' },
    ip: '203.0.113.7',
    originalUrl: '/api/unified-calls/phone/+14795551212',
  };

  await audit.audit(req, { action: 'READ', resourceType: 'call', resourceId: null, result: 'SUCCESS' });

  const [, , , , resourceId, , , endpoint] = captured.params;
  assert.equal(resourceId, null);
  assert.equal(endpoint, '/api/unified-calls/phone/[REDACTED]');
  assert.ok(!endpoint.includes('4795551212'), 'phone number must not appear in the audit endpoint');
});

test('throws without a tenant (no per-tenant store to write to)', async () => {
  await assert.rejects(
    () => audit.audit({ user: { email: 'x@carein.ai' } }, { action: 'READ', resourceType: 'patient', result: 'SUCCESS' }),
    (err) => err.name === 'AuditError'
  );
});

test('fail-closed: a failed audit write throws AuditError', async () => {
  tenantDb.withTenantDb = async () => { throw new Error('db unreachable'); };
  await assert.rejects(
    () => audit.audit({ tenant: { id: 'T1' } }, { action: 'CREATE', resourceType: 'appointment', resourceId: 9, result: 'SUCCESS' }),
    (err) => err.name === 'AuditError' && /db unreachable/.test(err.message)
  );
});

test('assertReady is a no-op outside production', async () => {
  process.env.NODE_ENV = 'development';
  registry.listTenants = async () => { throw new Error('should not be called in dev'); };
  await assert.doesNotReject(() => audit.assertReady());
});

test('assertReady fails closed in production when an active tenant audit store is unreachable', async () => {
  process.env.NODE_ENV = 'production';
  registry.listTenants = async () => [{ tenant_id: 'T1', slug: 'carein', status: 'active' }];
  tenantDb.withTenantDb = async () => { throw new Error('no audit_log'); };

  await assert.rejects(
    () => audit.assertReady(),
    (err) => /audit store unreachable for active tenant 'carein'/.test(err.message)
  );
});
