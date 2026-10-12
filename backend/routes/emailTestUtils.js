'use strict';

/**
 * Test harness for TC email (queue item 40). NOT a test file.
 *
 * Boots, over one ephemeral HTTP server and one FakeTenantDb, exactly what
 * server.js mounts for email: the body parsers (raw capture on both), the
 * PUBLIC unsubscribe router at /api/webhooks/email, then the signed-in /api/tc
 * stack (tenantContext + requireModule('tc')). The registry is stubbed and ACS
 * is a FAKE transport that records every request; nothing reaches a network.
 *
 * Fixtures: roland 12827 / 12828, valley 7115. Names are synthetic; addresses
 * are @example.test.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const express = require('express');

const registry = require('../platform/registry');
const tenantDb = require('../platform/tenantDb');
const userContext = require('../platform/userContext');
const { tenantContext, requireModule } = require('../middleware/tenantContext');
const { FakeTenantDb } = require('./tc/tcTestUtils');
const messaging = require('../services/messaging');
const consent = require('../services/messaging/consent');
const adapters = require('../services/messaging/adapters');
const acsClient = require('../services/messaging/acs/client');
const tcEmail = require('../config/tcEmail');

const PUBLIC_BASE = 'https://dashboard.example.test';
const ACS_ENDPOINT = 'https://acs-carein-test.communication.azure.com';
const DAY = new Date('2026-10-08T17:00:00Z'); // 12:00 CDT
const NIGHT = new Date('2026-10-09T03:00:00Z'); // 22:00 CDT: quiet hours for SMS

const ENV = {
  TC_EMAIL_ENABLED: 'true',
  ACS_EMAIL_AUTH_MODE: 'managed_identity',
  ACS_EMAIL_ENDPOINT: ACS_ENDPOINT,
  ACS_EMAIL_FROM_ROLAND: 'donotreply@roland.example.test',
  ACS_EMAIL_FROM_VALLEY: undefined,
  ACS_EMAIL_FROM: undefined,
  ACS_EMAIL_REPLY_TO_ROLAND: 'front@roland.example.test',
  TC_EMAIL_PUBLIC_BASE_URL: PUBLIC_BASE,
  TC_EMAIL_TENANT_SLUG: 'carein',
};
const SAVED_ENV = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));

const REGISTRY_KEYS = [
  'getUserByEmail',
  'getTenantById',
  'getTenantBySlug',
  'getTenantClinics',
  'getEnabledModules',
  'getPlatformAdminByEmail',
  'getPlatformSetting',
  'touchUserLogin',
];

function applyEnv(env) {
  for (const [k, v] of Object.entries({ ...ENV, ...env })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/**
 * @param {{ env?: Record<string, string|undefined>, modules?: string[], tenant?: object|null,
 *           acsStatus?: string, acsPolls?: Array<object|Error>, now?: Date }} [opts]
 */
async function bootEmailApp({ env = {}, modules = ['tc'], tenant, acsStatus = 'Succeeded', acsPolls = [], now = DAY } = {}) {
  applyEnv(env);

  const db = new FakeTenantDb();
  const originals = {
    registry: Object.fromEntries(REGISTRY_KEYS.map((k) => [k, registry[k]])),
    withTenantDb: tenantDb.withTenantDb,
  };
  const tenantRow =
    tenant === undefined ? { tenant_id: 'T1', slug: 'carein', display_name: 'CareIN', status: 'active' } : tenant;
  registry.getUserByEmail = async (email) => ({ user_id: 'U1', tenant_id: 'T1', email, role: 'admin', status: 'active' });
  registry.getTenantById = async () => tenantRow;
  registry.getTenantBySlug = async (slug) => (tenantRow && slug === tenantRow.slug ? tenantRow : null);
  registry.getTenantClinics = async () => [];
  registry.getEnabledModules = async () => modules;
  registry.getPlatformAdminByEmail = async () => null;
  registry.getPlatformSetting = async () => null; // kill switch: the env fallback answers
  registry.touchUserLogin = async () => {};
  userContext.clearCache();
  const seenTenantIds = [];
  tenantDb.withTenantDb = async (req, fn) => {
    seenTenantIds.push(req && req.tenant && req.tenant.id);
    if (!req || !req.tenant || !req.tenant.id) throw new Error('no tenant');
    return fn(db);
  };
  tcEmail.resetCacheForTests();
  messaging.setClockForTests(() => now);
  consent.setOdPatientReaderForTests(async (_office, patNum) => ({ PatNum: patNum, TxtMsgOk: 'Yes' }));

  /** Every request ACS received: { method, url, headers, body } */
  const acsCalls = [];
  const polls = [...acsPolls];
  let nextOp = 1;
  acsClient.setTokenProviderForTests(async () => 'fake-entra-token');
  acsClient.setWaitForTests(async () => undefined);
  acsClient.setFetchForTests(async (url, init) => {
    assert.ok(String(url).startsWith(`${ACS_ENDPOINT}/`), `unexpected URL ${url}`);
    acsCalls.push({
      method: init.method,
      url: String(url),
      headers: init.headers,
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    if (init.method === 'POST') {
      return new Response(JSON.stringify({ id: `op-${nextOp++}`, status: acsStatus }), { status: 202 });
    }
    const next = polls.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next || { status: 'Succeeded' }), { status: 200 });
  });

  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { if (buf && buf.length) req.rawBody = buf.toString('utf8'); } }));
  app.use(express.urlencoded({ extended: true, verify: (req, _res, buf) => { if (buf && buf.length) req.rawBody = buf.toString('utf8'); } }));
  app.use('/api/webhooks/email', require('./emailWebhooks'));
  app.use('/api', (req, _res, next) => {
    req.user = { email: 'tc@carein.ai', name: 'TC User', tenantId: 'x' };
    next();
  });
  app.use('/api', tenantContext());
  app.use('/api/tc', requireModule('tc'), require('./tc'));

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        db,
        acsCalls,
        seenTenantIds,
        close: () =>
          new Promise((r) => {
            for (const k of REGISTRY_KEYS) registry[k] = originals.registry[k];
            tenantDb.withTenantDb = originals.withTenantDb;
            server.close(r);
          }),
      });
    });
  });
}

function resetEmailHarness() {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  messaging.resetClock();
  consent.resetOdPatientReader();
  adapters.resetAdapters();
  acsClient.resetForTests();
  tcEmail.resetCacheForTests();
}

function seedCase(db, overrides = {}) {
  const row = {
    case_id: crypto.randomUUID(),
    office_id: 'roland',
    patient_name: 'MangoTest Test',
    phone: '(479) 555-0101',
    email: 'Patient.One@Example.test',
    od_patient_id: 12828,
    status: 'presented',
    nurture_unsubscribed: false,
    ...overrides,
  };
  db.table('tc_cases').push(row);
  return row;
}

function seedTemplate(db, overrides = {}) {
  const row = {
    template_id: crypto.randomUUID(),
    legacy_id: null,
    office_id: 'roland',
    name: 'Consult follow-up',
    category: 'consult_followup',
    subject: 'Following up, {{patient.firstName}}',
    preheader: 'A note from {{practice.name}}',
    blocks: [
      { id: 'h1', type: 'header', logoUrl: null, headline: 'Hi {{patient.firstName}}' },
      { id: 't1', type: 'text', html: '<p>Thanks for coming in to {{practice.name}}.</p><p>Questions? Just reply.</p>' },
      { id: 'hl', type: 'highlight' },
      { id: 's1', type: 'signature', source: 'tc' },
    ],
    is_seed: false,
    ...overrides,
  };
  db.table('tc_email_templates').push(row);
  return row;
}

async function apiJson(baseUrl, method, path, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

/** The unsubscribe URL ACS was handed for the Nth POSTed email. */
function unsubscribeUrlOf(acsCalls, n = 0) {
  const posts = acsCalls.filter((c) => c.method === 'POST');
  const header = posts[n].body.headers['List-Unsubscribe'];
  return header.slice(1, -1);
}

module.exports = {
  PUBLIC_BASE,
  ACS_ENDPOINT,
  DAY,
  NIGHT,
  bootEmailApp,
  resetEmailHarness,
  seedCase,
  seedTemplate,
  apiJson,
  unsubscribeUrlOf,
};
