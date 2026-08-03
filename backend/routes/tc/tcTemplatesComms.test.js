'use strict';

/**
 * /api/tc/templates + /api/tc/communications — template CRUD with block
 * validation and seed protection; communications log reads; the whole send
 * pipeline FEATURE_DISABLED.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { bootTcApp, api } = require('./tcTestUtils');

const BLOCKS = [
  { id: 'b1', type: 'header', logoUrl: null, headline: 'Roland Family Dental' },
  { id: 'b2', type: 'text', html: '<p>Hi {{patient.firstName}},</p>' },
];

const TEMPLATE = {
  name: 'Consult follow-up',
  category: 'consult_followup',
  subject: 'Following up on your visit',
  blocks: BLOCKS,
};

test('template create/update/duplicate round-trip; blocks validate strictly', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    const created = await api(baseUrl, 'POST', '/api/tc/templates?office=roland', TEMPLATE);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const tpl = created.body.template;
    assert.equal(tpl.isSeed, false);
    assert.equal(tpl.blocks.length, 2);

    const badBlocks = await api(baseUrl, 'POST', '/api/tc/templates?office=roland', {
      ...TEMPLATE,
      blocks: [{ id: 'x', type: 'marquee', content: 'nope' }],
    });
    assert.equal(badBlocks.status, 400, 'unknown block type must be rejected');

    const updated = await api(baseUrl, 'PUT', `/api/tc/templates/${tpl.templateId}?office=roland`, {
      subject: 'Updated subject',
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.template.subject, 'Updated subject');

    const dup = await api(baseUrl, 'POST', `/api/tc/templates/${tpl.templateId}/duplicate?office=roland`);
    assert.equal(dup.status, 201);
    assert.equal(dup.body.template.name, 'Consult follow-up (copy)');
    assert.notEqual(dup.body.template.templateId, tpl.templateId);

    const list = await api(baseUrl, 'GET', '/api/tc/templates?office=roland');
    assert.equal(list.body.templates.length, 2);
    const crossOffice = await api(baseUrl, 'GET', '/api/tc/templates?office=valley');
    assert.equal(crossOffice.body.templates.length, 0);
  } finally {
    await close();
  }
});

test('seeded templates cannot be deleted (409); user templates can', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const created = await api(baseUrl, 'POST', '/api/tc/templates?office=roland', TEMPLATE);
    const userId = created.body.template.templateId;

    // Seed row planted directly (the importer/seeder writes these).
    const seedId = randomUUID();
    db.table('tc_email_templates').push({
      template_id: seedId,
      legacy_id: 'tpl_seed1',
      office_id: 'roland',
      name: 'Seed template',
      category: 'general',
      subject: 'Seed',
      preheader: '',
      blocks: BLOCKS,
      is_seed: true,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const seedDelete = await api(baseUrl, 'DELETE', `/api/tc/templates/${seedId}?office=roland`);
    assert.equal(seedDelete.status, 409);
    assert.equal(seedDelete.body.code, 'SEED_TEMPLATE_PROTECTED');

    const userDelete = await api(baseUrl, 'DELETE', `/api/tc/templates/${userId}?office=roland`);
    assert.equal(userDelete.status, 200);
  } finally {
    await close();
  }
});

test('communications: office-scoped log reads with caseId filter and limit', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const caseId = randomUUID();
    const mkComm = (office, forCase, minutesAgo) => ({
      comm_id: randomUUID(),
      legacy_id: null,
      office_id: office,
      case_id: forCase,
      template_id: null,
      template_name: '',
      sender: 'holly',
      sender_name: 'Holly',
      to_email: 'patient@example.com',
      subject: 'Your treatment plan',
      status: 'sent',
      provider_message_id: null,
      error: null,
      sent_at: new Date(Date.now() - minutesAgo * 60000),
      created_at: new Date(),
      updated_at: new Date(),
    });
    db.table('tc_communications').push(mkComm('roland', caseId, 5), mkComm('roland', null, 10), mkComm('valley', null, 1));

    const all = await api(baseUrl, 'GET', '/api/tc/communications?office=roland');
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.equal(all.body.communications.length, 2, 'valley rows must not leak');

    const byCase = await api(baseUrl, 'GET', `/api/tc/communications?office=roland&caseId=${caseId}`);
    assert.equal(byCase.body.communications.length, 1);

    const badLimit = await api(baseUrl, 'GET', '/api/tc/communications?office=roland&limit=500');
    assert.equal(badLimit.status, 400, 'limit above 200 is rejected');
  } finally {
    await close();
  }
});

test('the send pipeline is uniformly FEATURE_DISABLED (501)', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    for (const path of ['/render', '/test-send', '/send']) {
      const res = await api(baseUrl, 'POST', `/api/tc/communications${path}?office=roland`, {});
      assert.equal(res.status, 501, path);
      assert.equal(res.body.code, 'FEATURE_DISABLED');
    }
    assert.equal(db.table('tc_communications').length, 0, 'disabled endpoints must write nothing');
  } finally {
    await close();
  }
});
