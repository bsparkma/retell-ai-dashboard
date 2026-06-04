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
  // [user_id, tenant_id, action, resource_type, resource_id, ip, result, endpoint]
  assert.deepEqual(captured.params, [
    'staff@carein.ai',
    'T1',
    'READ',
    'patient',
    '123', // stringified ID — never a PHI value
    '203.0.113.7',
    'SUCCESS',
    '/api/opendental/patients/123',
  ]);
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
