#!/usr/bin/env node
'use strict';

/**
 * AT-1: run the Activity feed's REAL statements against a real migrated tenant
 * schema, with synthetic rows in every source — the sibling of the other
 * *-verify-queries.js scripts, for the same reason.
 *
 * The unit suite's database is a Map: it accepts any column name and any
 * parameter type, so it cannot prove that each source's SELECT names columns
 * that exist, that `uuid = ANY($n)` / `bigint = $n` / `timestamptz <= $n` type
 * cleanly, or that the mappers cope with what node-pg really returns (Date
 * objects, bigint as a string, jsonb as an object). This script seeds one row
 * or more in every source, calls THE REAL buildActivityPage for both scopes,
 * pages through with a small limit, and asserts what comes back.
 *
 * Read-only feature, so the seeding is the only write — and EVERYTHING RUNS
 * INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK. No Open Dental.
 *
 * Usage (CI runs it after `migrate-tenant.js up`, beside the other verifiers):
 *   MIGRATE_TENANT_DB_URL=postgres://... node scripts/at1-activity-verify-queries.js
 */

const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

const activityFeed = require('../routes/tc/activityFeed');

const OFFICE = 'roland';
/** The synthetic roland fixture PatNum ("Test 2, Stedi"). */
const PATNUM = 12827;

function fail(msg) {
  throw new Error(msg);
}
function check(cond, msg) {
  if (!cond) fail(msg);
}

async function insert(client, table, row) {
  const cols = Object.keys(row);
  const vals = cols.map((c) => {
    const v = row[c];
    return v != null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
  });
  await client.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    vals
  );
}

async function seed(client) {
  const caseA = randomUUID();
  const caseB = randomUUID();
  const caseV = randomUUID();
  const kase = (id, office, extra = {}) => ({
    case_id: id,
    office_id: office,
    patient_name: 'Test 2, Stedi',
    phone: '479-555-0100',
    email: 'stedi.test@example.com',
    od_patient_id: PATNUM,
    category: 'single_tooth',
    status: 'pending_tc',
    urgency: 'medium',
    notes: '',
    ...extra,
  });
  await insert(client, 'tc_cases', kase(caseA, OFFICE, { notes: 'Box as it is now' }));
  await insert(client, 'tc_cases', kase(caseB, OFFICE));
  await insert(client, 'tc_cases', kase(caseV, 'valley'));

  const ev = (caseId, office, ts, type, description, extra = {}) =>
    insert(client, 'tc_case_events', {
      event_id: randomUUID(),
      case_id: caseId,
      office_id: office,
      ts,
      type,
      description,
      actor: 'tc@carein.ai',
      ...extra,
    });
  await ev(caseA, OFFICE, '2026-11-01T12:00:00Z', 'case_created', 'Case created');
  await ev(caseA, OFFICE, '2026-11-02T12:00:00Z', 'status_change', 'pending_tc → presented: Walked through it');
  await ev(caseA, OFFICE, '2026-11-02T13:00:00Z', 'objection_logged', 'Objection logged: timing');
  await ev(caseA, OFFICE, '2026-11-03T12:00:00Z', 'notes_updated', 'Case notes edited', { detail: { notes: 'Version one' } });
  await ev(caseA, OFFICE, '2026-11-03T12:00:00Z', 'note_added', 'Tie at the same instant');
  await ev(caseA, OFFICE, '2026-11-03T12:00:00Z', 'note_added', 'Another tie');
  await ev(caseA, OFFICE, '2026-11-04T12:00:00Z', 'voice_handoff', 'Sent to TC from a CareIN call', {
    source_call_id: 'verify-call-1',
    detail: { callUrl: null, callSummary: 'Summary kept.', attached: false },
  });
  await ev(caseB, OFFICE, '2026-11-02T14:00:00Z', 'note_added', 'Other case note');
  await ev(caseV, 'valley', '2026-11-02T15:00:00Z', 'note_added', 'VALLEY NOTE');

  await insert(client, 'tc_case_objections', {
    objection_id: randomUUID(),
    case_id: caseA,
    office_id: OFFICE,
    category: 'cost',
    note: 'Wants to phase it',
    patient_words: 'More than I expected',
    logged_at: '2026-11-02T11:00:00Z',
  });

  await insert(client, 'tc_followups', {
    followup_id: randomUUID(),
    case_id: caseA,
    office_id: OFFICE,
    kind: 'followup',
    due_date: '2026-11-05',
    channel: 'phone_call',
    source: 'manual',
    status: 'skipped',
    outcome_note: 'Asked not to call',
    completed_at: '2026-11-05T12:00:00Z',
    completed_by: 'tc@carein.ai',
  });

  await insert(client, 'tc_hygiene_intakes', {
    intake_id: randomUUID(),
    case_id: caseA,
    office_id: OFFICE,
    submitted_by: 'hyg@carein.ai',
    submitted_by_name: 'Hygiene User',
    submitted_at: '2026-11-01T15:00:00Z',
    visit_date: '2026-11-01',
    chief_concern: 'Sensitivity',
    hygienist_recommendation: 'Crown',
  });

  await insert(client, 'tc_checkout_handoffs', {
    handoff_id: randomUUID(),
    office_id: OFFICE,
    source_key: `verify:${randomUUID()}`,
    od_patient_id: PATNUM,
    patient_name: 'Test 2, Stedi',
    visit_date: '2026-11-01',
    payload: {},
    submitted_by: 'hyg@carein.ai',
    status: 'dismissed',
    dismissed_reason: 'Duplicate card',
    dismissed_by: 'tc@carein.ai',
    dismissed_at: '2026-11-06T12:00:00Z',
  });

  const msg = (extra) =>
    insert(client, 'tc_messages', {
      message_id: randomUUID(),
      office_id: OFFICE,
      channel: 'sms',
      to_address: '+14795550100',
      from_address: '+14795550199',
      body: 'Hello',
      created_by: 'tc@carein.ai',
      ...extra,
    });
  await msg({ case_id: caseA, direction: 'outbound', status: 'sent', sent_by: 'tc@carein.ai', sent_at: '2026-11-06T13:00:00Z', body: 'Verbatim outbound' });
  await msg({ case_id: caseA, direction: 'outbound', status: 'draft', body: 'DRAFT ONLY' });
  await msg({ case_id: caseA, direction: 'inbound', status: 'received', to_address: '+14795550199', from_address: '+14795550100', body: 'Thanks', created_by: null });
  await msg({ case_id: null, direction: 'inbound', status: 'received', to_address: '+14795550199', from_address: '+14795550100', body: 'Unlinked inbound', created_by: null });

  await insert(client, 'tc_communications', {
    comm_id: randomUUID(),
    office_id: OFFICE,
    case_id: caseA,
    to_email: 'stedi.test@example.com',
    sender: 'tc@carein.ai',
    subject: 'Your treatment plan',
    status: 'sent',
    sent_at: '2026-11-06T14:00:00Z',
  });

  const referralId = randomUUID();
  await insert(client, 'tc_referrals', {
    referral_id: referralId,
    office_id: OFFICE,
    od_patient_id: PATNUM,
    patient_name: 'Test 2, Stedi',
    tc_case_id: caseA,
    specialty: 'endodontics',
    reason: 'Evaluate #14',
    status: 'sent',
    created_by: 'tc@carein.ai',
    status_changed_by: 'tc@carein.ai',
  });
  const rev = (extra) =>
    insert(client, 'tc_referral_events', { event_id: randomUUID(), office_id: OFFICE, referral_id: referralId, actor: 'tc@carein.ai', ...extra });
  const sent = () => ({
    from_status: 'approved',
    to_status: 'sent',
    verb: 'send',
    acs_message_id: `verify-${randomUUID()}`,
    recipient_address: 'specialist@example.com',
    unsubscribe_token_hash: `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`,
  });
  await rev({ ...sent(), at: '2026-11-07T12:00:00Z' });
  await rev({ from_status: 'sent', to_status: 'sent', verb: 'correspondence', at: '2026-11-07T12:30:00Z', note: 'Specialist called', correspondence_direction: 'from', correspondence_party: 'specialist', correspondence_channel: 'phone' });
  await rev({ from_status: 'sent', to_status: 'sent', verb: 'chart_note_written', at: '2026-11-07T12:40:00Z', note: 'Chart note filed', chart_note_milestone: 'sent', chart_note_commlog_num: 5551, chart_note_comm_type: 491 });
  await rev({
    ...sent(),
    at: '2026-11-07T13:00:00Z',
    letter_snapshot: { audience: 'specialist', subject: 'Referral', text: 'The letter as sent.', withheld: ['insurance'] },
  });

  const preauthId = randomUUID();
  await insert(client, 'tc_preauth_cases', {
    preauth_id: preauthId,
    office_id: OFFICE,
    case_id: caseA,
    patient_name: 'Test 2, Stedi',
    od_patient_id: PATNUM,
    preauth_type: 'treatment',
    status: 'submitted',
  });
  await insert(client, 'tc_preauth_events', {
    event_id: randomUUID(),
    office_id: OFFICE,
    preauth_id: preauthId,
    ts: '2026-11-08T12:00:00Z',
    actor: 'tc@carein.ai',
    type: 'status_change',
    changes: { status: { from: 'draft', to: 'submitted' } },
  });

  await insert(client, 'tc_contact_consent', {
    consent_id: randomUUID(),
    office_id: OFFICE,
    channel: 'sms',
    address: '+14795550100',
    state: 'opted_out',
    source: 'stop_keyword',
    updated_by: 'system:inbound',
  });

  return { caseA };
}

async function header(client, caseId) {
  const res = await client.query(
    `SELECT case_id, office_id, phone, email, od_patient_id, notes, updated_at FROM tc_cases WHERE office_id = $1 AND case_id = $2`,
    [OFFICE, caseId]
  );
  return res.rows[0];
}

async function readAll(client, caseId, scope) {
  const all = [];
  let cursor = null;
  const h = await header(client, caseId);
  // A pruned stub so the voice path runs on real rows too.
  const store = {
    calls: new Map([
      ['verify-call-1', { id: 'verify-call-1', record_kind: 'stub', source: 'retell', office: OFFICE, call_date: '2026-11-04T11:55:00Z' }],
    ]),
  };
  for (let i = 0; i < 100; i += 1) {
    const page = await activityFeed.buildActivityPage(client, {
      office: OFFICE,
      header: h,
      scope,
      cursor,
      limit: 3,
      voice: { entitled: true, store },
    });
    all.push(...page.items);
    if (!page.nextCursor) return all;
    cursor = activityFeed.decodeCursor(page.nextCursor);
    check(cursor, 'the cursor the page handed out decodes');
  }
  fail('paging did not terminate');
}

async function main() {
  const url = process.env.MIGRATE_TENANT_DB_URL;
  if (!url) fail('MIGRATE_TENANT_DB_URL is required');
  const client = new Client({ connectionString: url });
  await client.connect();
  let passed = 0;
  try {
    await client.query('BEGIN');
    const { caseA } = await seed(client);

    const caseItems = await readAll(client, caseA, 'case');
    const ids = caseItems.map((i) => i.id);
    check(new Set(ids).size === ids.length, 'no duplicate across pages (case scope)');
    for (let i = 1; i < caseItems.length; i += 1) {
      const [a, b] = [caseItems[i - 1], caseItems[i]];
      check(a.at > b.at || (a.at === b.at && a.id > b.id), `ordered (at DESC, id DESC): ${a.id} / ${b.id}`);
    }
    passed += 2;

    const sources = new Set(caseItems.map((i) => i.source));
    for (const s of ['case_event', 'case_notes', 'objection', 'followup', 'hygiene_intake', 'checkout', 'message', 'email_log', 'referral_event', 'preauth', 'voice_call', 'consent']) {
      check(sources.has(s), `source ${s} reached the feed on real rows`);
      passed += 1;
    }
    check(caseItems.every((i) => i.scope === 'case' || /not linked to this case/.test(i.title)), 'case scope: only this case (+ unlinked inbound)');
    check(!caseItems.some((i) => i.body === 'Other case note'), 'case scope leaves the other case out');
    check(!caseItems.some((i) => /DRAFT ONLY/.test(i.body || '')), 'drafts excluded');
    check(caseItems.some((i) => i.title === 'Objection (since removed)'), 'the orphan objection event');
    check(caseItems.some((i) => /letter as sent was not stored/.test(i.title)), 'pre-AT-0 send honesty label');
    check(caseItems.some((i) => i.body && i.body.includes('The letter as sent.')), 'snapshot send shows the letter');
    check(caseItems.some((i) => i.title === 'Call record pruned; summary kept on handoff'), 'pruned stub placeholder');
    const corr = caseItems.find((i) => i.kind === 'correspondence');
    check(corr && corr.direction === 'inbound' && /from the specialist/.test(corr.title), 'correspondence direction read from the real column values');
    const chart = caseItems.find((i) => i.kind === 'chart_note');
    check(chart && chart.chart.onChart && chart.chart.commLogNum === 5551, 'chart note on chart with its CommLogNum (bigint read back)');
    passed += 2;
    check(caseItems.filter((i) => i.completeness === 'current_value_only').length === 3, 'notes box, pre-auth, consent are current value only');
    passed += 8;

    const patientItems = await readAll(client, caseA, 'patient');
    check(patientItems.some((i) => i.body === 'Other case note' && i.scope === 'patient'), 'patient scope adds the other case');
    check(!JSON.stringify(patientItems).includes('VALLEY NOTE'), 'another office never joins');
    check(new Set(patientItems.map((i) => i.id)).size === patientItems.length, 'no duplicate across pages (patient scope)');
    passed += 3;

    console.log(`AT-1 activity verification passed: ${passed} checks; ${caseItems.length} case items, ${patientItems.length} patient items`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

main().catch((err) => {
  console.error(`AT-1 activity verification FAILED: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
