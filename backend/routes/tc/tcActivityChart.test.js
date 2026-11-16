'use strict';

/**
 * AT-2 "Log to chart": a TC activity-feed item written to the patient's Open
 * Dental chart as a commlog under that office's "CareIN TC" type, ONLY by a
 * person who has seen and approved the exact text.
 *
 *   S0 step 0 as a pure function: zero / two / hidden / colliding → refuse
 *   C  config: roland 492 / valley 453 beside call + referral; three families
 *      per office, no number shared across offices or families; unconfigured
 *      and crossing overrides refused with a named reason; registry member;
 *      no DefNum literal in the route or service code
 *   T  the type is proven in-tx against the office's OWN list (and its name)
 *   W  the write: PatNum from the case row, the office's own client and type,
 *      write-time CommDateTime (never backdated), read back, recorded, ONE
 *      audit row (source_ref = item id, no note text)
 *   D  conversation date: in the note text only, never the CommDateTime
 *   B  strict body: smuggled office / PatNum / DefNum / CommDateTime → 400;
 *      not OD-safe / too long / untrimmed → 400; nothing touches Open Dental
 *   K  chart-worthy items only — every refusal code
 *   F  failures: disabled, unconfigured, no PatNum, OD refuses, read-back
 *      mismatch, already on the chart, written-but-unrecorded + retry refused
 *   X  dedupe both layers; cross-office impossibility
 *   V  the feed: "On chart" + chartable + chartWrite; the preview
 *   A  NO AUTOMATIC WRITES: the pinned requirer list
 *
 * Open Dental is FAKED — no request leaves the process. Test patients only:
 * roland 12827 (Test 2, Stedi), valley 7115 (Stedi TestValley).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const odOffices = require('../../config/odOffices');
const officeRegistry = require('../../platform/officeRegistry');
const commlogTypes = require('../../services/commlogTypes');
const openDentalSync = require('../../services/openDentalSync');
const tcChartNote = require('../../services/tc/tcChartNote');
const { verifyTcCommTypes } = require('../../services/tc/tcCommTypeVerify');
const activityChart = require('./activityChart');
const { chartEligibility, REFUSAL_CODES } = require('./activityChartable');
const { TC_DEFNUMS, applyToSeed, shapeCheck } = require('../../migrations/1789700000000_office_commtype_tc');
const { SEED_OFFICES } = require('../../migrations/1789500000000_seed_office_registry');
const tenantMigration = require('../../migrations-tenant/1794700000000_tc_chart_writes');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const NOW = new Date('2026-11-12T16:30:00.000Z'); // 10:30 CST
const BACKEND = path.join(__dirname, '..', '..');
const PATIENTS = { roland: 12827, valley: 7115 };

// ── environment ─────────────────────────────────────────────────────────────

const ENV_KEYS = [
  'OPENDENTAL_CUSTOMER_KEY',
  'OPENDENTAL_CUSTOMER_KEY_VALLEY',
  'OPENDENTAL_WRITE_DISABLED',
  'OPENDENTAL_TC_COMMTYPE_DEFNUM',
  'OPENDENTAL_TC_COMMTYPE_DEFNUM_VALLEY',
  'OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM',
  'OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM_VALLEY',
  'OPENDENTAL_CAREIN_COMMTYPE_DEFNUM',
  'OPENDENTAL_CAREIN_COMMTYPE_DEFNUM_VALLEY',
  'OPENDENTAL_ALLOW_MOCK',
  'OFFICE_TIMEZONE',
];
const savedEnv = {};
test.before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.OPENDENTAL_CUSTOMER_KEY = 'test-roland-customer-key';
  process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = 'test-valley-customer-key';
  odOffices.resetOdOfficeCache();
  commlogTypes.resetCommlogTypeCache();
  activityChart.setClockForTests(() => NOW);
});
test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  odOffices.resetOdOfficeCache();
  commlogTypes.resetCommlogTypeCache();
  activityChart.setClockForTests(null);
});

/** Per test: the value each key had BEFORE the test first touched it. */
const envOriginals = new WeakMap();
/** Set an env var for one test; restored to its pre-test value however often it is set. */
function withEnv(t, key, value) {
  let originals = envOriginals.get(t);
  if (!originals) {
    originals = new Map();
    envOriginals.set(t, originals);
  }
  if (!originals.has(key)) {
    originals.set(key, process.env[key]);
    t.after(() => {
      const before = originals.get(key);
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
      odOffices.resetOdOfficeCache();
      commlogTypes.resetCommlogTypeCache();
    });
  }
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  odOffices.resetOdOfficeCache();
  commlogTypes.resetCommlogTypeCache();
}

// ── the fake Open Dental ────────────────────────────────────────────────────

/** Each practice's commlog types as the 2026-11-12 read found them (abridged). */
const DEFINITIONS = {
  roland: [
    { DefNum: 486, ItemName: 'CareIN AI Call' },
    { DefNum: 491, ItemName: 'Referral' },
    { DefNum: 492, ItemName: 'CareIN TC' },
    { DefNum: 478, ItemName: 'Treatment Coordinator' },
    { DefNum: 401, ItemName: 'ODHQ' },
  ],
  valley: [
    { DefNum: 451, ItemName: 'CareIN AI Call' },
    { DefNum: 452, ItemName: 'Referral' },
    { DefNum: 453, ItemName: 'CareIN TC' },
    { DefNum: 436, ItemName: 'Treatment Coordinator' },
    { DefNum: 401, ItemName: 'Crown by Moolah' },
  ],
};

function fakeOd(t) {
  const od = {
    calls: [],
    charts: { roland: [], valley: [] },
    nextNum: 70001,
    onPost: null,
    alterStored: null,
    failDefinitions: false,
  };
  const saved = [];
  const clients = new Set();
  for (const office of ['roland', 'valley']) {
    const { client } = odOffices.getOdOffice(office);
    assert.ok(!clients.has(client), 'each office must hold its OWN client');
    clients.add(client);
    saved.push([client, { apiGetRaw: client.apiGetRaw, client: client.client, useDatabase: client.useDatabase, pool: client.pool }]);
    client.useDatabase = false;
    client.pool = null;
    client.apiGetRaw = async (p, params = {}) => {
      od.calls.push({ office, method: 'GET', path: p, params });
      if (p === '/definitions') {
        if (od.failDefinitions) return { ok: false, status: 503, data: null, error: 'down' };
        return { ok: true, status: 200, data: DEFINITIONS[office].map((d) => ({ ...d, Category: 27, isHidden: 'false' })) };
      }
      if (p === '/commlogs') {
        const rows = od.charts[office].filter((r) => r.PatNum === Number(params.PatNum));
        const off = Number(params.Offset || 0);
        return { ok: true, status: 200, data: rows.slice(off, off + 100) };
      }
      return { ok: false, status: 404, data: null, error: 'not a valid resource' };
    };
    client.client = {
      post: async (p, body) => {
        od.calls.push({ office, method: 'POST', path: p, body });
        const store = () => {
          const row = { CommlogNum: od.nextNum++, ...body, PatNum: Number(body.PatNum) };
          if (od.alterStored) od.alterStored(row);
          od.charts[office].push(row);
          return row;
        };
        if (od.onPost) return od.onPost({ office, body, store });
        const row = store();
        return { status: 201, data: { CommlogNum: row.CommlogNum } };
      },
    };
  }
  t.after(() => {
    for (const [client, orig] of saved) Object.assign(client, orig);
    commlogTypes.resetCommlogTypeCache();
  });
  commlogTypes.resetCommlogTypeCache();
  od.posts = () => od.calls.filter((c) => c.method === 'POST');
  od.commlogReads = () => od.calls.filter((c) => c.method === 'GET' && c.path === '/commlogs');
  return od;
}

// ── cases and feed items, seeded directly ───────────────────────────────────

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

function realTransactions(db) {
  let snapshot = null;
  db.onQuery(/^BEGIN$/, () => {
    snapshot = new Map([...db.tables].map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
    return { rows: [], rowCount: 0 };
  });
  db.onQuery(/^ROLLBACK$/, () => {
    if (snapshot) {
      for (const [k, rows] of snapshot) {
        const live = db.table(k);
        live.length = 0;
        live.push(...rows);
      }
    }
    return { rows: [], rowCount: 0 };
  });
}

function seedCase(db, office = 'roland', over = {}) {
  const row = {
    case_id: randomUUID(),
    office_id: office,
    patient_name: office === 'roland' ? 'Test 2, Stedi' : 'Stedi TestValley',
    phone: null,
    email: null,
    od_patient_id: PATIENTS[office],
    notes: '',
    status: 'pending_tc',
    lost_reason: null,
    updated_at: new Date('2026-11-01T12:00:00Z').toISOString(),
    ...over,
  };
  db.table('tc_cases').push(row);
  return row;
}

function seedEvent(db, c, over = {}) {
  const row = {
    event_id: randomUUID(),
    case_id: c.case_id,
    office_id: c.office_id,
    ts: new Date('2026-11-10T15:00:00Z').toISOString(),
    type: 'note_added',
    description: 'Patient wants to think about the bridge until after the holidays.',
    actor: 'tc@carein.ai',
    detail: null,
    source_call_id: null,
    ...over,
  };
  db.table('tc_case_events').push(row);
  return row;
}

function seedMessage(db, c, over = {}) {
  const row = {
    message_id: randomUUID(),
    case_id: c.case_id,
    office_id: c.office_id,
    direction: 'outbound',
    channel: 'sms',
    body: 'Hi, this is the office following up on your treatment plan.',
    subject: null,
    status: 'sent',
    created_by: 'tc@carein.ai',
    sent_by: 'tc@carein.ai',
    created_at: new Date('2026-11-09T15:00:00Z').toISOString(),
    sent_at: new Date('2026-11-09T15:00:05Z').toISOString(),
    from_address: null,
    ...over,
  };
  db.table('tc_messages').push(row);
  return row;
}

const CHART = (caseId, itemId, office = 'roland') =>
  `/api/tc/cases/${caseId}/activity/${encodeURIComponent(itemId)}/chart?office=${office}`;
const write = (baseUrl, caseId, itemId, body, office = 'roland') => api(baseUrl, 'POST', CHART(caseId, itemId, office), body);
const previewOf = (baseUrl, caseId, itemId, office = 'roland') => api(baseUrl, 'GET', CHART(caseId, itemId, office));
const TEXT = 'CareIN TC - Note: patient will call back after the holidays.';
const writes = (db) => db.table('tc_chart_writes');
const chartAudits = (db) => auditRows(db).filter((a) => a.resource_type === 'commlog');

// ── S0: step 0 as a pure function ───────────────────────────────────────────

test('S0: the live read passes — exactly one visible CareIN TC per office, colliding with nothing', () => {
  const lists = {
    roland: DEFINITIONS.roland.map((d) => ({ ...d, Category: 27, isHidden: 'false' })),
    valley: DEFINITIONS.valley.map((d) => ({ ...d, Category: 27, isHidden: 'false' })),
  };
  const known = { roland: { call: 486, referral: 491 }, valley: { call: 451, referral: 452 } };
  const out = verifyTcCommTypes(lists, known);
  assert.deepEqual(out.problems, []);
  assert.equal(out.ok, true);
  assert.deepEqual(
    [out.offices.roland.defNum, out.offices.roland.call.itemName, out.offices.roland.referral.itemName],
    [492, 'CareIN AI Call', 'Referral']
  );
  assert.equal(out.offices.valley.defNum, 453);
  assert.equal(out.offices.valley.isHidden, false);
});

test('S0: zero, two, hidden and colliding are each refused', () => {
  const known = { roland: { call: 486, referral: 491 }, valley: { call: 451, referral: 452 } };
  const base = (o) => DEFINITIONS[o].map((d) => ({ ...d, Category: 27, isHidden: 'false' }));
  const without = (o) => base(o).filter((d) => d.ItemName !== 'CareIN TC');
  const cases = {
    zero: { roland: without('roland'), valley: base('valley') },
    two: { roland: [...base('roland'), { DefNum: 499, ItemName: 'CareIN TC', Category: 27, isHidden: 'false' }], valley: base('valley') },
    hidden: { roland: base('roland').map((d) => (d.DefNum === 492 ? { ...d, isHidden: 'true' } : d)), valley: base('valley') },
    collidesCall: { roland: [...without('roland'), { DefNum: 486, ItemName: 'CareIN TC', Category: 27 }], valley: base('valley') },
    collidesOtherReferral: { roland: [...without('roland'), { DefNum: 452, ItemName: 'CareIN TC', Category: 27 }], valley: base('valley') },
    collidesOtherTc: { roland: [...without('roland'), { DefNum: 453, ItemName: 'CareIN TC', Category: 27 }], valley: base('valley') },
  };
  const expect = {
    zero: /no "CareIN TC"/,
    two: /2 "CareIN TC"/,
    hidden: /is hidden/,
    collidesCall: /equals roland's call/,
    collidesOtherReferral: /equals valley's referral/,
    collidesOtherTc: /equals valley's "CareIN TC"/,
  };
  for (const [name, lists] of Object.entries(cases)) {
    const out = verifyTcCommTypes(lists, known);
    assert.equal(out.ok, false, name);
    assert.ok(out.problems.some((p) => expect[name].test(p)), `${name}: ${out.problems.join('; ')}`);
  }
});

// ── C: config ───────────────────────────────────────────────────────────────

test('C: roland 492 / valley 453 beside call and referral — three families per office, nothing shared', () => {
  const r = odOffices.getOdOffice('roland');
  const v = odOffices.getOdOffice('valley');
  const families = {
    roland: [r.commTypeDefNum, r.referralCommTypeDefNum, r.tcCommTypeDefNum],
    valley: [v.commTypeDefNum, v.referralCommTypeDefNum, v.tcCommTypeDefNum],
  };
  assert.deepEqual(families, { roland: [486, 491, 492], valley: [451, 452, 453] });
  const all = [...families.roland, ...families.valley];
  assert.equal(new Set(all).size, all.length, 'no number shared across offices or families');
  assert.deepEqual(
    [odOffices.OFFICE_OD_SETTINGS.roland.tcCommTypeEnv, odOffices.OFFICE_OD_SETTINGS.valley.tcCommTypeEnv],
    ['OPENDENTAL_TC_COMMTYPE_DEFNUM', 'OPENDENTAL_TC_COMMTYPE_DEFNUM_VALLEY']
  );
  assert.equal(odOffices.tcChartNoteBlockReason('roland'), null);
  assert.equal(odOffices.tcChartNoteBlockReason('valley'), null);
  assert.deepEqual([...odOffices.COMMTYPE_KINDS], ['call', 'referral', 'tc']);
});

test("C: an override is one office's only; a crossing override (a valley number for roland) is REFUSED, not served", (t) => {
  withEnv(t, 'OPENDENTAL_TC_COMMTYPE_DEFNUM', '777');
  assert.equal(odOffices.getOdOffice('roland').tcCommTypeDefNum, 777);
  assert.equal(odOffices.getOdOffice('valley').tcCommTypeDefNum, 453);
  for (const crossing of ['453', '451', '452', '486', '491']) {
    withEnv(t, 'OPENDENTAL_TC_COMMTYPE_DEFNUM', crossing);
    assert.equal(odOffices.getOdOffice('roland').tcCommTypeDefNum, null, crossing);
    assert.equal(odOffices.tcChartNoteBlockReason('roland').code, 'TC_COMMTYPE_NOT_CONFIGURED', crossing);
  }
  withEnv(t, 'OPENDENTAL_TC_COMMTYPE_DEFNUM', 'junk');
  assert.equal(odOffices.getOdOffice('roland').tcCommTypeDefNum, 492, 'a junk override falls back');
});

test('C: an unconfigured office is null with a named reason — never the call or referral type', (t) => {
  const s = odOffices.OFFICE_OD_SETTINGS.valley;
  const keep = s.defaultTcCommTypeDefNum;
  s.defaultTcCommTypeDefNum = null;
  odOffices.resetOdOfficeCache();
  t.after(() => {
    s.defaultTcCommTypeDefNum = keep;
    odOffices.resetOdOfficeCache();
  });
  const v = odOffices.getOdOffice('valley');
  assert.equal(v.tcCommTypeDefNum, null);
  assert.deepEqual([v.commTypeDefNum, v.referralCommTypeDefNum], [451, 452], 'still there, and NOT used');
  assert.equal(odOffices.tcChartNoteBlockReason('valley').code, 'TC_COMMTYPE_NOT_CONFIGURED');
  assert.equal(odOffices.tcChartNoteBlockReason('roland'), null);
});

test('C: the registry gains exactly a third member, tc, equal to the code maps; the shape CHECK names all three', () => {
  assert.deepEqual(TC_DEFNUMS, { roland: 492, valley: 453 });
  const patched = applyToSeed(SEED_OFFICES).map((r) => officeRegistry.mapRow(/** @type {any} */ (r)));
  assert.deepEqual(patched, officeRegistry.codeOffices());
  for (const o of patched) assert.deepEqual(Object.keys(o.commTypeDefNums), ['call', 'referral', 'tc']);
  const check = shapeCheck(['call', 'referral', 'tc']);
  assert.match(check, /\?& ARRAY\['call', 'referral', 'tc'\]/);
  assert.match(check, /- 'call' - 'referral' - 'tc'\) = '\{\}'::jsonb/);
  assert.doesNotMatch(check, /SELECT/i, 'Postgres refuses a subquery in a CHECK');
  // A registry row with no tc member reads as UNCONFIGURED, never a guess.
  assert.equal(officeRegistry.mapRow(/** @type {any} */ ({ ...SEED_OFFICES[0] })).commTypeDefNums.tc, null);
});

test('C: the tenant table — UNIQUE(office_id, feed_item_id), append-only grant, clean down()', () => {
  const calls = [];
  const pgm = new Proxy({}, { get: (_t, k) => (...a) => calls.push([k, ...a]) || { func: (s) => s } });
  pgm.func = (s) => s;
  tenantMigration.up(/** @type {any} */ (pgm));
  const unique = calls.find((c) => c[0] === 'addConstraint' && c[2] === 'tc_chart_writes_item_unique');
  assert.deepEqual(unique[3], { unique: ['office_id', 'feed_item_id'] });
  const grant = calls.find((c) => c[0] === 'sql')[1];
  assert.match(grant, /GRANT SELECT, INSERT ON TABLE tc_chart_writes/);
  assert.doesNotMatch(grant, /UPDATE|DELETE/);
  const downCalls = [];
  tenantMigration.down(/** @type {any} */ (new Proxy({}, { get: (_t, k) => (...a) => downCalls.push([k, ...a]) })));
  assert.deepEqual(downCalls, [['dropTable', 'tc_chart_writes', { ifExists: true }]]);
});

test('C: no DefNum literal in the route, the classifier, or the service (comments stripped)', () => {
  for (const f of ['routes/tc/activityChart.js', 'routes/tc/activityChartable.js', 'routes/tc/cases.js', 'services/tc/tcChartNote.js', 'services/tc/chartCommlogReadBack.js']) {
    const code = fs
      .readFileSync(path.join(BACKEND, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\b(486|451|491|452|492|453)\b/, `${f} must not hardcode a DefNum`);
  }
});

// ── W: the write ────────────────────────────────────────────────────────────

test('W: roland — PatNum from the case row, type 492, write-time date, read back, recorded, one audit row', async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db, 'roland');
  const ev = seedEvent(db, c);
  const spy = t.mock.method(openDentalSync, 'createCommLog');

  const r = await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: TEXT });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(spy.mock.callCount(), 1, "through the voice module's writer");
  const [post] = od.posts();
  assert.equal(post.office, 'roland');
  assert.deepEqual(post.body, {
    PatNum: 12827,
    Note: TEXT,
    // WRITE time (16:30Z = 10:30 CST) — not the note's own 11/10 time.
    CommDateTime: '2026-11-12 10:30:00',
    Mode_: 'None',
    SentOrReceived: 'Neither',
    CommType: 492,
  });
  assert.equal(od.commlogReads().length, 2, 'read before (no duplicate) and after (the claim)');
  assert.ok(od.calls.every((x) => x.office === 'roland'), 'valley never touched');
  assert.deepEqual(r.body.chart, { onChart: true, via: 'tc', commLogNum: 70001 });

  const [row] = writes(db);
  assert.deepEqual(
    [row.office_id, row.case_id, row.feed_item_id, row.od_patient_id, row.commlog_num, row.commtype_defnum, row.note_text, row.conversation_date, row.written_by, row.written_at],
    ['roland', c.case_id, `case_event:${ev.event_id}`, 12827, 70001, 492, TEXT, null, 'tc@carein.ai', NOW.toISOString()]
  );
  const audits = chartAudits(db);
  assert.equal(audits.length, 1, 'one audit row per write');
  assert.deepEqual(
    [audits[0].action, audits[0].resource_id, audits[0].office, audits[0].source_ref, audits[0].result],
    ['CREATE', '70001', 'roland', `case_event:${ev.event_id}`, 'SUCCESS']
  );
  assert.ok(!JSON.stringify(audits[0]).includes('holidays'), 'no note text in the audit row');
});

test("W: valley — 7115 in Riley's chart with 453 through valley's own client; Roland's sees nothing", async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db, 'valley');
  const ev = seedEvent(db, c, { type: 'contact_attempt', description: 'Left a voicemail.', detail: { channel: 'phone', outcome: 'voicemail' } });
  const r = await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: 'CareIN TC - Contact attempt: left a voicemail.' }, 'valley');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(od.calls.length > 0 && od.calls.every((x) => x.office === 'valley'), 'roland never touched');
  const [post] = od.posts();
  assert.equal(post.body.PatNum, 7115);
  assert.equal(post.body.CommType, 453);
  assert.equal(od.charts.roland.length, 0);
});

// ── D: the conversation date ────────────────────────────────────────────────

test('D: a conversation date goes into the note text ONLY; CommDateTime stays the write time', async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const ev = seedEvent(db, c);
  const r = await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: TEXT, conversationDate: '2026-11-10' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const [post] = od.posts();
  assert.equal(post.body.Note, `${TEXT}\n[Conversation date: 11/10/2026]`);
  assert.equal(post.body.CommDateTime, '2026-11-12 10:30:00', 'never backdated');
  assert.equal(writes(db)[0].conversation_date, '2026-11-10');
  assert.equal(writes(db)[0].note_text, post.body.Note);
});

test('D: a future, impossible or malformed conversation date is a 400; nothing touches Open Dental', async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const ev = seedEvent(db, c);
  for (const d of ['2026-11-13', '2026-02-30', '11/10/2026', '2026-1-1']) {
    const r = await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: TEXT, conversationDate: d });
    assert.equal(r.status, 400, d);
  }
  assert.equal(od.calls.length, 0);
  assert.equal(activityChart.finalNoteText('x', null), 'x');
});

// ── B: strict body ──────────────────────────────────────────────────────────

test('B: office / PatNum / DefNum / CommDateTime smuggled in the body → 400, Open Dental untouched', async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const ev = seedEvent(db, c);
  const smuggles = [
    { office: 'valley' },
    { office_id: 'valley' },
    { patNum: 7115 },
    { PatNum: 7115 },
    { od_patient_id: 7115 },
    { defNum: 453 },
    { commType: 453 },
    { CommType: 486 },
    { commDateTime: '2026-11-01 09:00:00' },
    { CommDateTime: '2026-11-01 09:00:00' },
    { actor: 'someone@else' },
  ];
  for (const extra of smuggles) {
    const r = await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: TEXT, ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.equal(r.body.code, 'VALIDATION_ERROR');
  }
  assert.equal((await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, {})).status, 400);
  assert.equal(od.calls.length, 0);
  assert.equal(writes(db).length, 0);
});

test('B: text Open Dental would change, too long, or untrimmed → 400, Open Dental untouched', async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const ev = seedEvent(db, c);
  const id = `case_event:${ev.event_id}`;
  assert.equal((await write(baseUrl, c.case_id, id, { text: 'Patient said “maybe later” — call back' })).body.code, 'CHART_NOTE_NOT_OD_SAFE');
  assert.equal((await write(baseUrl, c.case_id, id, { text: ' padded ' })).body.code, 'CHART_NOTE_NOT_TRIMMED');
  assert.equal((await write(baseUrl, c.case_id, id, { text: 'x'.repeat(2001) })).status, 400);
  const nearly = 'x'.repeat(1990);
  const r = await write(baseUrl, c.case_id, id, { text: nearly, conversationDate: '2026-11-10' });
  assert.equal(r.body.code, 'CHART_NOTE_TOO_LONG', 'the date line counts toward the 2000');
  assert.equal(od.calls.length, 0);
});

// ── K: chart-worthy items only ──────────────────────────────────────────────

test('K: the classifier — every refusal code, and the chart-worthy kinds', () => {
  const ok = (over) => ({ source: 'case_event', kind: 'note', scope: 'case', actor: { system: false }, body: 'x', completeness: 'full', chart: { onChart: false }, ...over });
  const code = (over) => chartEligibility(ok(over)).code;
  assert.equal(chartEligibility(ok({})).eligible, true);
  for (const [source, kind] of [
    ['case_event', 'contact_attempt'],
    ['case_event', 'status_change'],
    ['case_event', 'followup_completed'],
    ['case_event', 'notes_revision'],
    ['objection', 'objection'],
    ['followup', 'followup_skipped'],
    ['checkout', 'checkout_outcome'],
    ['checkout', 'checkout_dismissed'],
    ['message', 'sms_out'],
    ['message', 'sms_in'],
    ['message', 'email_out'],
    ['message', 'email_in'],
  ]) {
    assert.equal(chartEligibility(ok({ source, kind })).eligible, true, `${source}/${kind}`);
  }
  const seen = new Set([
    code({ chart: { onChart: true, via: 'tc' } }),
    code({ source: 'case_notes', kind: 'notes_current', completeness: 'current_value_only' }),
    code({ source: 'voice_call', kind: 'call' }),
    code({ source: 'referral_event', kind: 'chart_note' }),
    code({ source: 'hygiene_intake', kind: 'hygiene_intake' }),
    code({ actor: { system: true } }),
    code({ scope: 'patient' }),
    code({ source: 'message', kind: 'sms_in', alwaysShow: true }),
    code({ source: 'message', kind: 'sms_out', pending: true }),
    code({ kind: 'case_created' }),
    code({ kind: 'nurture_enrolled' }),
    code({ source: 'email_log', kind: 'email_out' }),
    code({ source: 'preauth', kind: 'preauth_updated' }),
    code({ source: 'case_event', kind: 'objection' }),
    code({ body: '   ' }),
  ]);
  assert.deepEqual([...seen].sort(), [...REFUSAL_CODES].sort(), 'every code is reachable');
  assert.equal(code({ source: 'hygiene_intake', kind: 'hygiene_intake' }), 'NOT_CHARTABLE_CHARTED_ELSEWHERE');
  assert.equal(code({ source: 'voice_call', kind: 'call', chart: { onChart: true, via: 'voice' } }), 'ALREADY_ON_CHART');
});

test('K: through the route — system / nurture / OD-sync events, drafts, failed and queued sends, current values, voice, other cases → 409; nothing written', async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const other = seedCase(db);
  const refusals = [
    [`case_event:${seedEvent(db, c, { type: 'nurture_enrolled', description: 'Enrolled', actor: 'system:nurture' }).event_id}`, 'NOT_CHARTABLE_SYSTEM'],
    [`case_event:${seedEvent(db, c, { type: 'status_change', description: 'pending_tc → scheduled: Synced from Open Dental', actor: 'system:od_sync' }).event_id}`, 'NOT_CHARTABLE_SYSTEM'],
    [`case_event:${seedEvent(db, c, { type: 'case_created', description: 'Case created' }).event_id}`, 'NOT_CHARTABLE_KIND'],
    [`case_event:${seedEvent(db, c, { type: 'voice_handoff', description: 'From a call', actor: 'front@carein.ai' }).event_id}`, 'NOT_CHARTABLE_KIND'],
    [`case_event:${seedEvent(db, c, { type: 'status_change', description: 'pending_tc → nurture' }).event_id}`, 'NOT_CHARTABLE_EMPTY'],
    [`message:${seedMessage(db, c, { status: 'draft', sent_at: null }).message_id}`, 'NOT_CHARTABLE_NOT_SENT'],
    [`message:${seedMessage(db, c, { status: 'failed', sent_at: null }).message_id}`, 'NOT_CHARTABLE_NOT_SENT'],
    [`message:${seedMessage(db, c, { status: 'queued', sent_at: null }).message_id}`, 'NOT_CHARTABLE_NOT_SENT'],
    [`message:${seedMessage(db, c, { created_by: 'system:nurture', sent_by: 'system:nurture' }).message_id}`, 'NOT_CHARTABLE_SYSTEM'],
    [`message:${seedMessage(db, c, { case_id: null, direction: 'inbound', status: 'received', sent_at: null }).message_id}`, 'NOT_CHARTABLE_OTHER_CASE'],
    [`message:${seedMessage(db, other).message_id}`, 'NOT_CHARTABLE_OTHER_CASE'],
    [`case_notes:${c.case_id}`, 'NOT_CHARTABLE_CURRENT_VALUE'],
    [`consent:${randomUUID()}`, 'NOT_CHARTABLE_CURRENT_VALUE'],
    [`preauth:${randomUUID()}:current`, 'NOT_CHARTABLE_CURRENT_VALUE'],
    [`preauth:${randomUUID()}`, 'NOT_CHARTABLE_KIND'],
    [`voice_call:${randomUUID()}`, 'NOT_CHARTABLE_CHARTED_ELSEWHERE'],
    [`referral_event:${randomUUID()}`, 'NOT_CHARTABLE_CHARTED_ELSEWHERE'],
    [`hygiene_intake:${randomUUID()}`, 'NOT_CHARTABLE_CHARTED_ELSEWHERE'],
    [`email_log:${randomUUID()}`, 'NOT_CHARTABLE_KIND'],
  ];
  for (const [id, expected] of refusals) {
    const r = await write(baseUrl, c.case_id, id, { text: TEXT });
    assert.equal(r.status, 409, `${id}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, expected, id);
  }
  // Another case's event, an unknown id, a bad id: not on this case.
  const elsewhere = seedEvent(db, other);
  for (const id of [`case_event:${elsewhere.event_id}`, `case_event:${randomUUID()}`, 'case_event:not-a-uuid', 'nonsense', 'bogus_source:1']) {
    assert.equal((await write(baseUrl, c.case_id, id, { text: TEXT })).status, 404, id);
  }
  assert.equal(od.posts().length, 0);
  assert.equal(writes(db).length, 0);
});

test('K: objection (with the patient\'s verbatim words), skipped follow-up, checkout outcome, sent text and inbound reply each chart', async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const objection = { objection_id: randomUUID(), case_id: c.case_id, office_id: 'roland', category: 'cost', note: 'Worried about price.', patient_words: 'I can’t afford that this year', logged_at: '2026-11-08T15:00:00.000Z', created_at: '2026-11-08T15:00:00.000Z' };
  db.table('tc_case_objections').push(objection);
  const followup = { followup_id: randomUUID(), case_id: c.case_id, office_id: 'roland', status: 'skipped', kind: 'call', channel: 'phone', talking_point: 'Check in', outcome_note: 'Patient asked us to wait a month.', completed_at: '2026-11-07T15:00:00.000Z', completed_by: 'tc@carein.ai' };
  db.table('tc_followups').push(followup);
  const handoff = { handoff_id: randomUUID(), case_id: c.case_id, office_id: 'roland', od_patient_id: 12827, status: 'nothing_needed', outcome_by: 'front@carein.ai', outcome_at: '2026-11-06T15:00:00.000Z', appointment_note: 'Recall booked; no treatment discussed.', dismissed_reason: null, dismissed_by: null, dismissed_at: null, reopened_from: null, updated_at: '2026-11-06T15:00:00.000Z' };
  db.table('tc_checkout_handoffs').push(handoff);
  const sent = seedMessage(db, c);
  const reply = seedMessage(db, c, { direction: 'inbound', status: 'received', sent_at: null, created_by: null, sent_by: null, body: 'Thanks, I will call next week.' });

  const ids = [`objection:${objection.objection_id}`, `followup:${followup.followup_id}`, `checkout:${handoff.handoff_id}:outcome`, `message:${sent.message_id}`, `message:${reply.message_id}`];
  for (const id of ids) {
    const p = await previewOf(baseUrl, c.case_id, id);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.chartable.eligible, true, id);
    const r = await write(baseUrl, c.case_id, id, { text: p.body.defaultText });
    assert.equal(r.status, 201, `${id}: ${JSON.stringify(r.body)}`);
  }
  const notes = od.posts().map((x) => x.body.Note);
  // The patient's own words, verbatim — only the curly apostrophe is made OD-safe.
  assert.match(notes[0], /Patient said: "I can't afford that this year"/);
  assert.match(notes[0], /Worried about price\./);
  assert.match(notes[1], /Patient asked us to wait a month\./);
  assert.match(notes[2], /Recall booked; no treatment discussed\./);
  assert.match(notes[3], /following up on your treatment plan/);
  assert.match(notes[4], /I will call next week/);
  assert.equal(writes(db).length, 5);
});

test('K: a status change into lost carries the lost reason in the default text — only while it is the latest and the case is still lost', async (t) => {
  fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db, 'roland', { status: 'lost', lost_reason: 'went_elsewhere' });
  const ev = seedEvent(db, c, { type: 'status_change', description: 'nurture → lost: Moving out of state.' });
  const p = await previewOf(baseUrl, c.case_id, `case_event:${ev.event_id}`);
  assert.match(p.body.defaultText, /Moving out of state\.\nLost reason: went elsewhere$/);
  seedEvent(db, c, { type: 'status_change', description: 'lost → nurture: Changed mind.', ts: '2026-11-11T15:00:00.000Z' });
  const later = await previewOf(baseUrl, c.case_id, `case_event:${ev.event_id}`);
  assert.doesNotMatch(later.body.defaultText, /Lost reason/, 'a later status change makes the current lost reason not this event\'s');
});

// ── F: refusals and failures ────────────────────────────────────────────────

test('F: OPENDENTAL_WRITE_DISABLED → 403 before anything; an unconfigured office → 409 TC_COMMTYPE_NOT_CONFIGURED', async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const ev = seedEvent(db, c);
  withEnv(t, 'OPENDENTAL_WRITE_DISABLED', 'true');
  const off = await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: TEXT });
  assert.deepEqual([off.status, off.body.code], [403, 'OD_WRITE_DISABLED']);
  withEnv(t, 'OPENDENTAL_WRITE_DISABLED', undefined);
  withEnv(t, 'OPENDENTAL_TC_COMMTYPE_DEFNUM', '453'); // valley's: crossing ⇒ refused
  const crossed = await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: TEXT });
  assert.deepEqual([crossed.status, crossed.body.code], [409, 'TC_COMMTYPE_NOT_CONFIGURED']);
  assert.equal(od.calls.length, 0);
});

test('T: a configured number that is not "CareIN TC" in the office\'s OWN list is refused in-tx before writing', async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  // Set WITHOUT resetting the office cache: getOdOffice re-freezes the handle
  // around the SAME (faked) client when only a DefNum changes.
  const key = 'OPENDENTAL_TC_COMMTYPE_DEFNUM';
  const keep = process.env[key];
  t.after(() => {
    if (keep === undefined) delete process.env[key];
    else process.env[key] = keep;
    odOffices.resetOdOfficeCache();
  });
  for (const bad of ['401', '478', '999']) {
    // 401 is a real type in BOTH practices meaning different things; 478 is
    // roland's "Treatment Coordinator" (close, not it); 999 is in neither.
    process.env[key] = bad;
    const ev = seedEvent(db, c);
    const r = await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: TEXT });
    assert.deepEqual([r.status, r.body.code], [409, 'TC_COMMTYPE_INVALID'], bad);
  }
  assert.equal(od.posts().length, 0);
  assert.equal(od.commlogReads().length, 0, 'not even a chart read');
  assert.ok(od.calls.every((x) => x.office === 'roland' && x.path === '/definitions'), "only roland's own list was consulted");
  od.failDefinitions = true;
  delete process.env[key];
  commlogTypes.resetCommlogTypeCache();
  const ev = seedEvent(db, c);
  const r = await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: TEXT });
  assert.deepEqual([r.status, r.body.code], [503, 'COMMLOG_TYPE_UNVERIFIABLE']);
  assert.equal(writes(db).length, 0);
});

test('F: a case with no PatNum → 409 CASE_NO_PATIENT; an unknown case → 404', async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db, 'roland', { od_patient_id: null });
  const ev = seedEvent(db, c);
  const r = await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: TEXT });
  assert.deepEqual([r.status, r.body.code], [409, 'CASE_NO_PATIENT']);
  assert.equal((await write(baseUrl, randomUUID(), `case_event:${ev.event_id}`, { text: TEXT })).status, 404);
  assert.equal(od.calls.length, 0);
});

test('F: Open Dental refuses → 502 CHART_NOTE_WRITE_FAILED; nothing recorded; the attempt is audited', async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const ev = seedEvent(db, c);
  od.onPost = () => {
    const e = new Error('Request failed with status code 400');
    e.response = { status: 400, data: 'PatNum is invalid' };
    throw e;
  };
  const r = await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: TEXT });
  assert.deepEqual([r.status, r.body.code], [502, 'CHART_NOTE_WRITE_FAILED']);
  assert.equal(writes(db).length, 0);
  const audits = chartAudits(db);
  assert.deepEqual([audits.length, audits[0].result, audits[0].source_ref], [1, 'ERROR', `case_event:${ev.event_id}`]);
});

test('F: a read-back that differs → 502 CHART_NOTE_UNCONFIRMED with the CommlogNum; nothing recorded', async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const ev = seedEvent(db, c);
  od.alterStored = (row) => {
    row.Note = `${row.Note} (edited)`;
  };
  const r = await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: TEXT });
  assert.deepEqual([r.status, r.body.code, r.body.commLogNum], [502, 'CHART_NOTE_UNCONFIRMED', 70001]);
  assert.equal(writes(db).length, 0);
});

test('F: written but not recorded → 500 TC_CHART_WRITTEN_UNRECORDED, "do not write again"; a same-text retry is refused', async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const ev = seedEvent(db, c);
  realTransactions(db);
  let failInsert = true;
  db.onQuery(/^INSERT INTO tc_chart_writes/, () => {
    if (failInsert) throw new Error('tenant db down');
    return undefined;
  });
  const r = await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: TEXT });
  assert.deepEqual([r.status, r.body.code, r.body.commLogNum], [500, 'TC_CHART_WRITTEN_UNRECORDED', 70001]);
  assert.match(r.body.error, /Do not write it again/);
  assert.equal(writes(db).length, 0, 'rolled back');
  assert.equal(chartAudits(db).length, 0, 'rolled back with it');
  failInsert = false;
  const retry = await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: TEXT });
  assert.deepEqual([retry.status, retry.body.code, retry.body.commLogNum], [409, 'CHART_NOTE_ALREADY_IN_CHART', 70001]);
  assert.equal(od.posts().length, 1, 'one note on the chart, not two');
});

test('F: a direct-DB office client is refused before anything is written', async () => {
  const od = { officeKey: 'roland', client: { useDatabase: true, apiGetRaw: async () => assert.fail('no read'), client: { post: async () => assert.fail('no write') } } };
  const out = await tcChartNote.writeTcChartNote(/** @type {any} */ (od), { patNum: 12827, note: TEXT, commType: 1, at: NOW.toISOString() });
  assert.deepEqual([out.ok, out.code, out.written], [false, 'CHART_NOTE_API_MODE_ONLY', false]);
});

// ── X: dedupe both layers, cross-office ─────────────────────────────────────

test('X: CareIN layer — a second write of the same item is 409 ALREADY_ON_CHART, even with different text', async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const ev = seedEvent(db, c);
  const id = `case_event:${ev.event_id}`;
  assert.equal((await write(baseUrl, c.case_id, id, { text: TEXT })).status, 201);
  const again = await write(baseUrl, c.case_id, id, { text: `${TEXT} Again.` });
  assert.deepEqual([again.status, again.body.code, again.body.commLogNum, again.body.writtenBy], [409, 'ALREADY_ON_CHART', 70001, 'tc@carein.ai']);
  assert.equal(od.posts().length, 1);
});

test('X: Open Dental layer — an identical note already on the chart refuses; nothing recorded', async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const ev = seedEvent(db, c);
  od.charts.roland.push({ CommlogNum: 69999, PatNum: 12827, CommType: 492, Note: TEXT });
  const r = await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: TEXT });
  assert.deepEqual([r.status, r.body.code, r.body.commLogNum], [409, 'CHART_NOTE_ALREADY_IN_CHART', 69999]);
  assert.equal(od.posts().length, 0);
  assert.equal(writes(db).length, 0);
});

test("X: another office's case is a 404 from this office — no chart of either office is touched", async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db, 'roland');
  const ev = seedEvent(db, c);
  const r = await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: TEXT }, 'valley');
  assert.equal(r.status, 404, JSON.stringify(r.body));
  const p = await previewOf(baseUrl, c.case_id, `case_event:${ev.event_id}`, 'valley');
  assert.equal(p.status, 404);
  assert.equal(od.calls.length, 0);
});

test('X: a doctor (no tc.full) is refused at the mount', async (t) => {
  const od = fakeOd(t);
  const admin = await boot(t);
  const c = seedCase(admin.db);
  const ev = seedEvent(admin.db, c);
  const doc = await boot(t, { role: 'doctor', user: { email: 'doctor@carein.ai', name: 'Doc', tenantId: 'x' }, db: admin.db });
  const r = await write(doc.baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: TEXT });
  assert.equal(r.status, 403);
  assert.equal(od.calls.length, 0);
});

// ── V: the feed and the preview ─────────────────────────────────────────────

test('V: the feed marks chartable items, then "On chart · TC" with the CommlogNum; chartWrite says whether it can write', async (t) => {
  fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const ev = seedEvent(db, c);
  seedEvent(db, c, { type: 'nurture_enrolled', description: 'Enrolled', actor: 'system:nurture', ts: '2026-11-09T15:00:00.000Z' });
  const feed = async () => (await api(baseUrl, 'GET', `/api/tc/cases/${c.case_id}/activity?office=roland`)).body;
  const before = await feed();
  assert.deepEqual(before.chartWrite, { available: true, code: null, message: null });
  const note = before.items.find((i) => i.id === `case_event:${ev.event_id}`);
  assert.deepEqual(note.chartable, { eligible: true, code: null, reason: null });
  assert.equal(before.items.find((i) => i.kind === 'nurture_enrolled').chartable.code, 'NOT_CHARTABLE_SYSTEM');
  assert.equal(note.pending, undefined, 'helper flags never reach the wire');

  assert.equal((await write(baseUrl, c.case_id, note.id, { text: TEXT })).status, 201);
  const after = (await feed()).items.find((i) => i.id === note.id);
  assert.deepEqual(after.chart, { onChart: true, via: 'tc', commLogNum: 70001 });
  assert.equal(after.chartable.code, 'ALREADY_ON_CHART');

  withEnv(t, 'OPENDENTAL_WRITE_DISABLED', 'true');
  assert.equal((await feed()).chartWrite.code, 'OD_WRITE_DISABLED');
});

test('V: the preview — default text (OD-safe), the office, the type, availability; audited as a READ with the item id', async (t) => {
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const ev = seedEvent(db, c, { description: 'Patient said “next year” — will call.' });
  const p = await previewOf(baseUrl, c.case_id, `case_event:${ev.event_id}`);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.defaultText, 'CareIN TC - Note 11/10/2026 9:00 AM by tc@carein.ai\nPatient said "next year" -- will call.');
  assert.deepEqual(p.body.office, { id: 'roland', name: odOffices.describeOffice('roland').officeName });
  assert.deepEqual(p.body.commType, { name: 'CareIN TC' });
  assert.equal(p.body.maxLength, 2000);
  assert.deepEqual(p.body.availability, { available: true, code: null, message: null });
  assert.equal(p.body.onChart, null);
  assert.equal(od.calls.length, 0, 'a preview never reaches Open Dental');
  const reads = auditRows(db).filter((a) => a.resource_type === 'tc_case_activity');
  assert.deepEqual([reads.length, reads[0].action, reads[0].source_ref], [1, 'READ', `case_event:${ev.event_id}`]);
  // The default, sent as-is, is accepted: what the person saw is what lands.
  assert.equal((await write(baseUrl, c.case_id, `case_event:${ev.event_id}`, { text: p.body.defaultText })).status, 201);
  assert.equal(od.posts()[0].body.Note, p.body.defaultText);
});

// ── A: NO AUTOMATIC WRITES ──────────────────────────────────────────────────

function backendSources() {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.js') && !ent.name.endsWith('.test.js') && !p.includes(`${path.sep}test${path.sep}`)) out.push(p);
    }
  };
  walk(BACKEND);
  return out.map((p) => ({ rel: path.relative(BACKEND, p).split(path.sep).join('/'), src: fs.readFileSync(p, 'utf8') }));
}

test('A: the writer has ONE caller, which has ONE caller, used only inside the POST handler; nothing schedules or reacts', () => {
  const files = backendSources();
  const requirers = (re) => files.filter((f) => re.test(f.src)).map((f) => f.rel).sort();

  assert.deepEqual(requirers(/require\([^)]*services\/tc\/tcChartNote['"]\)/), ['routes/tc/activityChart.js'], 'the Open Dental half has one caller');
  assert.deepEqual(requirers(/require\([^)]*['"]\.\/activityChart['"]\)/), ['routes/tc/cases.js'], 'the route module has one caller');
  assert.deepEqual(requirers(/\bwriteTcChartNote\(/), ['routes/tc/activityChart.js', 'services/tc/tcChartNote.js']);

  const cases = files.find((f) => f.rel === 'routes/tc/cases.js').src;
  const uses = [...cases.matchAll(/activityChart\.writeFromFeed\(/g)];
  assert.equal(uses.length, 1, 'writeFromFeed is called once');
  const handlerStart = cases.indexOf("router.post(\n  '/:caseId/activity/:itemId/chart'");
  assert.ok(handlerStart > -1, 'the POST route exists');
  const handler = cases.slice(handlerStart, cases.indexOf('\n);\n', handlerStart));
  assert.match(handler, /activityChart\.writeFromFeed\(/, 'and only inside that handler');

  const chartSrc = files.find((f) => f.rel === 'routes/tc/activityChart.js').src;
  assert.equal([...chartSrc.matchAll(/tcChartNote\.writeTcChartNote\(/g)].length, 1);

  for (const rel of ['routes/tc/activityChart.js', 'routes/tc/activityChartable.js', 'services/tc/tcChartNote.js', 'services/tc/chartCommlogReadBack.js']) {
    const src = files.find((f) => f.rel === rel).src;
    assert.doesNotMatch(src, /setTimeout|setInterval|cron|schedule\(|\.on\(|EventEmitter|process\.nextTick|setImmediate/, rel);
  }
  // No scheduler, timer, webhook or nurture module even names the new code.
  for (const f of files) {
    if (['routes/tc/activityChart.js', 'routes/tc/cases.js', 'services/tc/tcChartNote.js'].includes(f.rel)) continue;
    assert.doesNotMatch(f.src, /activityChart['"]|tcChartNote['"]|writeFromFeed|writeTcChartNote/, f.rel);
  }
  // The Open Dental half holds no transport of its own: the voice writer is the one.
  const service = files.find((f) => f.rel === 'services/tc/tcChartNote.js').src;
  assert.doesNotMatch(service, /\.post\(|apiWriteRaw|client\.client|axios/);
  assert.match(service, /openDentalSync\.createCommLog\(/);
});
