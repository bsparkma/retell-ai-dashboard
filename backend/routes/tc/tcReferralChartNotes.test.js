'use strict';

/**
 * Referrals R6.10: chart notes — a referral milestone written to the patient's
 * Open Dental chart, ONLY by a person who has seen the exact text.
 *
 *   V  the verb: a non-move event verb in the shared vocabulary; the send path
 *      untouched
 *   C  config: the "Referral" DefNum per office (roland 491, valley 452), the
 *      call-note DefNums' mechanism, never crossed; none configured = refusal
 *   W  the write: the voice module's writer, PatNum and office from the row,
 *      the office's own type, Neither, office-local date; READ BACK before it
 *      is claimed; event + audit; status unmoved
 *   D  disabled: no configured type, the environment's write switch, a
 *      configured type not in the office's own list — named, nothing written,
 *      the detail read says why
 *   B  strict body: smuggled PatNum / office / type / date / actor → 400; a
 *      note the sanitizer would change → 400; nothing touches Open Dental
 *   M  milestones: only a reached one; once each (named refusal); each of the
 *      six reachable and dated from its own row
 *   F  failures: OD refuses, no CommlogNum, a read-back that differs, a note
 *      already on the chart, a write that could not be recorded — each named,
 *      no history row, nothing claimed; a retry after an unrecorded write is
 *      refused rather than written twice
 *   A  NO AUTOMATIC WRITES: nothing but the one route reaches the writer
 *      (static), and every other referral action writes nothing (behavioural)
 *   R  role and office: a doctor is refused at the mount; another office's
 *      referral is a 404
 *   S  the OD-safe mirror equals the writer's sanitizer
 *
 * Open Dental is FAKED throughout — no request leaves the process. Test
 * patients only: roland 12827 (Test 2, Stedi), valley 7115 (Stedi TestValley).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcReferrals = require('../../config/tcReferrals');
const odOffices = require('../../config/odOffices');
const commlogTypes = require('../../services/commlogTypes');
const openDentalSync = require('../../services/openDentalSync');
const { sanitizeForOd } = require('../../utils/sanitizeForOd');
const chartNoteService = require('../../services/tc/referralChartNote');
const transitions = require('./referralTransitions');
const contract = require('../../tc/contract.gen.cjs');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const NOW = new Date('2026-10-27T15:00:00.000Z');
const DOCTOR = { email: 'doctor@carein.ai', name: 'Doc', tenantId: 'x' };
const BACKEND = path.join(__dirname, '..', '..');

const PATIENTS = {
  roland: { patNum: 12827, name: 'Test 2, Stedi' },
  valley: { patNum: 7115, name: 'Stedi TestValley' },
};

// ── environment ─────────────────────────────────────────────────────────────

const ENV_KEYS = [
  'OPENDENTAL_CUSTOMER_KEY',
  'OPENDENTAL_CUSTOMER_KEY_VALLEY',
  'OPENDENTAL_WRITE_DISABLED',
  'OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM',
  'OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM_VALLEY',
  'OPENDENTAL_CAREIN_COMMTYPE_DEFNUM',
  'OPENDENTAL_CAREIN_COMMTYPE_DEFNUM_VALLEY',
  'OPENDENTAL_ALLOW_MOCK',
  'OFFICE_TIMEZONE',
  'REFERRAL_SIGNOFF_REQUIRED_ROLAND',
  'REFERRAL_SIGNOFF_REQUIRED_VALLEY',
  'TC_REFERRALS_ENABLED_ROLAND',
  'TC_REFERRALS_ENABLED_VALLEY',
];
const savedEnv = {};
test.before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  // Distinct per office, so each office holds its own client.
  process.env.OPENDENTAL_CUSTOMER_KEY = 'test-roland-customer-key';
  process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = 'test-valley-customer-key';
  odOffices.resetOdOfficeCache();
  commlogTypes.resetCommlogTypeCache();
});
test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  odOffices.resetOdOfficeCache();
  commlogTypes.resetCommlogTypeCache();
});

/** Set an env var for one test; the OD handles are rebuilt so they read it. */
function withEnv(t, key, value) {
  const before = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  odOffices.resetOdOfficeCache();
  commlogTypes.resetCommlogTypeCache();
  t.after(() => {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
    odOffices.resetOdOfficeCache();
    commlogTypes.resetCommlogTypeCache();
  });
}

function switchReferrals(t) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_referrals_enabled' ? { key, value: { roland: true, valley: true }, updated_at: new Date(), updated_by: null } : null;
  tcReferrals.resetCacheForTests();
  transitions.setClockForTests(() => NOW);
  t.after(() => {
    registry.getPlatformSetting = orig;
    tcReferrals.resetCacheForTests();
    transitions.setClockForTests(null);
  });
}

// ── the fake Open Dental: one chart per office, behind that office's client ──

/** Each practice's commlog types, as the 2026-10-28 read found them (abridged). */
const DEFINITIONS = {
  roland: [
    { DefNum: 486, ItemName: 'CareIN AI Call' },
    { DefNum: 491, ItemName: 'Referral' },
    { DefNum: 401, ItemName: 'ODHQ' },
  ],
  valley: [
    { DefNum: 451, ItemName: 'CareIN AI Call' },
    { DefNum: 452, ItemName: 'Referral' },
    { DefNum: 401, ItemName: 'Crown by Moolah' },
  ],
};

/**
 * Install the fake on every office's own client. `od.calls` records every
 * request with its office; `od.charts[office]` is that practice's commlogs.
 * `od.onPost` may answer a POST instead (throw = OD refused; return a response
 * = what OD said, after `od.keep` decides whether the note was stored).
 */
function fakeOd(t) {
  const od = {
    calls: [],
    charts: { roland: [], valley: [] },
    nextNum: 50001,
    onPost: null,
    /** Mutate what is STORED (what a read-back will find), not what was sent. */
    alterStored: null,
  };
  const saved = [];
  const clients = new Set();
  for (const office of ['roland', 'valley']) {
    const { client } = odOffices.getOdOffice(office);
    assert.ok(!clients.has(client), 'each office must hold its OWN client, or nothing here proves anything');
    clients.add(client);
    saved.push([client, { apiGetRaw: client.apiGetRaw, client: client.client, useDatabase: client.useDatabase, pool: client.pool }]);
    client.useDatabase = false;
    client.pool = null;
    client.apiGetRaw = async (p, params = {}) => {
      od.calls.push({ office, method: 'GET', path: p, params });
      if (p === '/definitions') {
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
  });
  od.posts = () => od.calls.filter((c) => c.method === 'POST');
  od.commlogReads = () => od.calls.filter((c) => c.method === 'GET' && c.path === '/commlogs');
  return od;
}

// ── referrals, walked through the real routes ───────────────────────────────

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

const REF = (p = '', office = 'roland') => `/api/tc/referrals${p}?office=${office}`;
const SIGN = (p = '', office = 'roland') => `/api/tc/referrals/signoff${p}?office=${office}`;

function seedCase(db, office) {
  const row = {
    case_id: randomUUID(),
    office_id: office,
    patient_name: PATIENTS[office].name,
    od_patient_id: PATIENTS[office].patNum,
    status: 'pending_tc',
  };
  db.table('tc_cases').push(row);
  return row;
}

const STEPS = {
  draft: [],
  pending_signoff: [[REF, '/submit']],
  approved: [[REF, '/submit'], [SIGN, '/approve']],
  declined: [[REF, '/submit'], [SIGN, '/decline', { reason: 'Not needed yet' }]],
  cancelled: [[REF, '/cancel']],
  sent: [[REF, '/submit'], [SIGN, '/approve'], [REF, '/mark-sent', { how: 'Faxed' }]],
  acknowledged: [[REF, '/submit'], [SIGN, '/approve'], [REF, '/mark-sent', { how: 'Faxed' }], [REF, '/mark-acknowledged']],
  patient_seen: [
    [REF, '/submit'],
    [SIGN, '/approve'],
    [REF, '/mark-sent', { how: 'Faxed' }],
    [REF, '/mark-acknowledged'],
    [REF, '/mark-patient-seen'],
  ],
  closed: [
    [REF, '/submit'],
    [SIGN, '/approve'],
    [REF, '/mark-sent', { how: 'Faxed' }],
    [REF, '/mark-acknowledged'],
    [REF, '/mark-patient-seen'],
    [REF, '/close', { note: 'Treatment complete' }],
  ],
};

/** A referral walked to `status` through the real routes, in `office`. */
async function walkTo(baseUrl, db, status, office = 'roland') {
  const c = seedCase(db, office);
  const r = await api(baseUrl, 'POST', REF('', office), {
    source: { caseId: c.case_id },
    referral: { reason: 'Possible cracked tooth', urgency: 'soon', teeth: [3] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.referral.referralId;
  for (const [base, p, body] of STEPS[status]) {
    const res = await api(baseUrl, 'POST', base(`/${id}${p}`, office), body ?? {});
    assert.equal(res.status, 200, `${p}: ${JSON.stringify(res.body)}`);
  }
  return id;
}

/** Make the fake roll back on ROLLBACK, as Postgres does. */
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

const NOTE = 'Referral sent to the specialist for possible cracked tooth.';
const write = (baseUrl, id, body = { milestone: 'sent', note: NOTE }, office = 'roland') =>
  api(baseUrl, 'POST', REF(`/${id}/chart-notes`, office), body);
const chartEvents = (db) => db.table('tc_referral_events').filter((e) => e.verb === 'chart_note_written');
const chartAudits = (db) => auditRows(db).filter((a) => a.source_ref === 'referral_chart_note');

// ── V: the verb ─────────────────────────────────────────────────────────────

test('V: `chart_note_written` is the last event verb and never a move; the send path is untouched', () => {
  const verbs = [...contract.TcReferralEventVerb.options];
  assert.equal(verbs[verbs.length - 1], 'chart_note_written');
  assert.deepEqual([...contract.TC_REFERRAL_ALL_EVENT_VERBS], [...contract.TC_REFERRAL_R69_EVENT_VERBS, 'chart_note_written']);
  assert.equal(contract.TcReferralVerb.options.includes('chart_note_written'), false, 'not a verb a move route can name');
  // A chart note after a doctor's return does not hide the open question.
  const ev = (over) => ({ eventId: randomUUID(), fromStatus: 'draft', toStatus: 'draft', actor: 'a', at: NOW.toISOString(), note: '', ...over });
  const returned = [ev({ verb: 'return', fromStatus: 'pending_signoff', note: 'Which tooth?' })];
  const noted = [...returned, ev({ verb: 'chart_note_written', chartNote: { milestone: 'sent', commLogNum: 1, commType: 491 } })];
  assert.deepEqual(contract.referralLastReturn(noted), contract.referralLastReturn(returned));
  const send = fs.readFileSync(path.join(__dirname, 'referralSend.js'), 'utf8');
  assert.doesNotMatch(send, /chart_note|chartNote|referralChartNote/, 'the send path knows nothing of it');
});

// ── C: the per-office "Referral" DefNum ─────────────────────────────────────

test('C: roland writes 491 and valley 452 — the same mechanism as the call-note DefNums, never crossed', () => {
  const roland = odOffices.getOdOffice('roland');
  const valley = odOffices.getOdOffice('valley');
  assert.equal(roland.referralCommTypeDefNum, 491);
  assert.equal(valley.referralCommTypeDefNum, 452);
  // The call-note types are unchanged and separate.
  assert.equal(roland.commTypeDefNum, 486);
  assert.equal(valley.commTypeDefNum, 451);
  assert.deepEqual(
    [odOffices.OFFICE_OD_SETTINGS.roland.referralCommTypeEnv, odOffices.OFFICE_OD_SETTINGS.valley.referralCommTypeEnv],
    ['OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM', 'OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM_VALLEY'],
    'bare name for Roland, _VALLEY for every other office (the house convention)'
  );
  assert.equal(odOffices.referralChartNoteBlockReason('roland'), null);
  assert.equal(odOffices.referralChartNoteBlockReason('valley'), null);
});

test("C: one office's override never reaches the other; a junk override falls back to the default", (t) => {
  withEnv(t, 'OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM', '777');
  assert.equal(odOffices.getOdOffice('roland').referralCommTypeDefNum, 777);
  assert.equal(odOffices.getOdOffice('valley').referralCommTypeDefNum, 452, 'valley untouched by Roland\'s override');
  withEnv(t, 'OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM_VALLEY', 'not-a-number');
  assert.equal(odOffices.getOdOffice('valley').referralCommTypeDefNum, 452);
  withEnv(t, 'OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM_VALLEY', '-4');
  assert.equal(odOffices.getOdOffice('valley').referralCommTypeDefNum, 452, 'never a non-positive DefNum');
});

test('C: an office with no referral DefNum configured is null, with a named reason — never a fallback to another type', (t) => {
  const settings = odOffices.OFFICE_OD_SETTINGS.valley;
  const keep = settings.defaultReferralCommTypeDefNum;
  settings.defaultReferralCommTypeDefNum = null;
  odOffices.resetOdOfficeCache();
  t.after(() => {
    settings.defaultReferralCommTypeDefNum = keep;
    odOffices.resetOdOfficeCache();
  });
  assert.equal(odOffices.getOdOffice('valley').referralCommTypeDefNum, null);
  assert.equal(odOffices.getOdOffice('valley').commTypeDefNum, 451, 'the call-note type is still there — and is NOT used');
  assert.equal(odOffices.referralChartNoteBlockReason('valley').code, 'REFERRAL_COMMTYPE_NOT_CONFIGURED');
  assert.match(odOffices.referralChartNoteBlockReason('valley').message, /Riley|valley/i);
  assert.equal(odOffices.referralChartNoteBlockReason('roland'), null, 'roland unaffected');
});

test('C: DefNums appear in config only — never in the routes or the service', () => {
  for (const f of ['routes/tc/referralChartNotes.js', 'routes/tc/referrals.js', 'services/tc/referralChartNote.js']) {
    // Code only: the headers explain the per-office numbers, and may.
    const code = fs
      .readFileSync(path.join(BACKEND, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\b(491|452|486|451)\b/, `${f} must not hardcode a DefNum`);
  }
});

// ── W: the write ────────────────────────────────────────────────────────────

test('W: roland — the voice writer, PatNum from the row, type 491, Neither, office-local date; read back; event + audit', async (t) => {
  switchReferrals(t);
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'sent');
  const spy = t.mock.method(openDentalSync, 'createCommLog');

  const r = await write(baseUrl, id);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(spy.mock.callCount(), 1, 'through the voice module\'s writer');

  const posts = od.posts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].office, 'roland');
  assert.deepEqual(posts[0].body, {
    PatNum: 12827,
    Note: NOTE,
    // The milestone's own moment (15:00Z), as Roland's wall clock (CDT).
    CommDateTime: '2026-10-27 10:00:00',
    Mode_: 'None',
    SentOrReceived: 'Neither',
    CommType: 491,
  });
  // Read before (no duplicate) and after (the claim).
  assert.equal(od.commlogReads().length, 2);
  assert.ok(od.calls.every((c) => c.office === 'roland'), 'valley never touched');

  assert.equal(r.body.commLogNum, 50001);
  assert.equal(r.body.milestone, 'sent');
  assert.equal(r.body.referral.status, 'sent', 'the status did not move');
  const last = r.body.referral.events.at(-1);
  assert.deepEqual(
    [last.verb, last.fromStatus, last.toStatus, last.note, last.actor, last.at],
    ['chart_note_written', 'sent', 'sent', NOTE, 'tc@carein.ai', NOW.toISOString()]
  );
  assert.deepEqual(last.chartNote, { milestone: 'sent', commLogNum: 50001, commType: 491 });
  assert.equal(contract.TcReferral.safeParse(r.body.referral).success, true);

  const audits = chartAudits(db);
  assert.equal(audits.length, 1);
  assert.deepEqual(
    [audits[0].action, audits[0].resource_type, audits[0].resource_id, audits[0].office, audits[0].prior_state, audits[0].result],
    ['CREATE', 'commlog', '50001', 'roland', 'sent', 'SUCCESS']
  );
});

test("W: valley — 7115 in Riley's chart with 452, through valley's own client; Roland's client sees nothing", async (t) => {
  switchReferrals(t);
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'acknowledged', 'valley');
  const r = await write(baseUrl, id, { milestone: 'received', note: 'The specialist confirmed receipt of the referral.' }, 'valley');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(od.calls.length > 0 && od.calls.every((c) => c.office === 'valley'), 'roland never touched');
  const [post] = od.posts();
  assert.equal(post.body.PatNum, 7115);
  assert.equal(post.body.CommType, 452);
  assert.equal(od.charts.roland.length, 0);
  assert.equal(od.charts.valley.length, 1);
  assert.equal(chartAudits(db)[0].office, 'valley');
});

test('W: the detail read carries the availability and the specialist name; reading it touches no Open Dental', async (t) => {
  switchReferrals(t);
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'sent');
  const entryId = randomUUID();
  db.table('tc_referral_directory').push({ entry_id: entryId, office_id: 'roland', practice_name: 'Test Endo Practice', specialist_name: 'Dr. Example' });
  db.table('tc_referrals').find((r) => r.referral_id === id).directory_entry_id = entryId;
  const r = await api(baseUrl, 'GET', REF(`/${id}`));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.referral.chartNotes, { available: true, code: null, reason: null });
  assert.equal(r.body.referral.specialistName, 'Dr. Example');
  assert.equal(r.body.referral.practiceName, 'Test Endo Practice');
  assert.equal(od.calls.length, 0, 'a read is a read');
});

// ── D: disabled, named ──────────────────────────────────────────────────────

test('D: no referral DefNum configured → 409 named, Open Dental untouched; the detail read says why', async (t) => {
  switchReferrals(t);
  const settings = odOffices.OFFICE_OD_SETTINGS.roland;
  const keep = settings.defaultReferralCommTypeDefNum;
  settings.defaultReferralCommTypeDefNum = null;
  odOffices.resetOdOfficeCache();
  t.after(() => {
    settings.defaultReferralCommTypeDefNum = keep;
    odOffices.resetOdOfficeCache();
  });
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'sent');
  const r = await write(baseUrl, id);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'REFERRAL_COMMTYPE_NOT_CONFIGURED');
  assert.equal(od.calls.length, 0);
  assert.equal(chartEvents(db).length, 0);
  const detail = await api(baseUrl, 'GET', REF(`/${id}`));
  assert.equal(detail.body.referral.chartNotes.available, false);
  assert.equal(detail.body.referral.chartNotes.code, 'REFERRAL_COMMTYPE_NOT_CONFIGURED');
  assert.match(detail.body.referral.chartNotes.reason, /Referral/);
});

test("D: the environment's write switch → 403 OD_WRITE_DISABLED, Open Dental untouched; the detail read says why", async (t) => {
  switchReferrals(t);
  withEnv(t, 'OPENDENTAL_WRITE_DISABLED', 'true');
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'sent');
  const r = await write(baseUrl, id);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'OD_WRITE_DISABLED');
  assert.equal(od.calls.length, 0);
  const detail = await api(baseUrl, 'GET', REF(`/${id}`));
  assert.deepEqual(detail.body.referral.chartNotes, {
    available: false,
    code: 'OD_WRITE_DISABLED',
    reason: 'Open Dental writes are switched off in this environment',
  });
});

test("D: a configured type that is not in the office's own list (the other practice's number) → refused, nothing posted", async (t) => {
  switchReferrals(t);
  // Roland mis-set to Riley's "Referral" number: not a commlog type in Roland at all.
  withEnv(t, 'OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM', '452');
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'sent');
  const r = await write(baseUrl, id);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'REFERRAL_COMMTYPE_INVALID');
  assert.equal(od.posts().length, 0);
  assert.equal(chartEvents(db).length, 0);
  assert.equal(chartAudits(db)[0].result, 'UNAUTHORIZED', 'the refused attempt is on the trail');
});

// ── B: strict body ──────────────────────────────────────────────────────────

test('B: strict body — smuggled fields, unknown milestones, blank / long / OD-unsafe notes are 400; Open Dental untouched', async (t) => {
  switchReferrals(t);
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'sent');
  const max = contract.TC_REFERRAL_CHART_NOTE_MAX;
  assert.equal(max, 2000);
  const ok = { milestone: 'sent', note: NOTE };
  for (const body of [
    { ...ok, patNum: 7115 },
    { ...ok, PatNum: 7115 },
    { ...ok, odPatientId: 7115 },
    { ...ok, office: 'valley' },
    { ...ok, officeId: 'valley' },
    { ...ok, commType: 486 },
    { ...ok, commTypeDefNum: 486 },
    { ...ok, CommType: 486 },
    { ...ok, at: '2020-01-01T00:00:00.000Z' },
    { ...ok, commDateTime: '2020-01-01 00:00:00' },
    { ...ok, actor: 'someone@else' },
    { ...ok, verb: 'mark_sent' },
    { ...ok, milestone: 'cancelled' },
    { ...ok, milestone: 'anything' },
    { ...ok, note: '' },
    { ...ok, note: '   ' },
    { ...ok, note: 'x'.repeat(max + 1) },
    { milestone: 'sent' },
    { note: NOTE },
    {},
  ]) {
    const r = await write(baseUrl, id, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
  }
  // A note the sanitizer would still change: the person did not see what would land.
  const unsafe = await write(baseUrl, id, { milestone: 'sent', note: 'Referral sent — see “notes”' });
  assert.equal(unsafe.status, 400);
  assert.equal(unsafe.body.code, 'CHART_NOTE_NOT_OD_SAFE');
  assert.equal(od.calls.length, 0);
  assert.equal(chartEvents(db).length, 0);
  // Exactly the cap is fine.
  assert.equal((await write(baseUrl, id, { milestone: 'sent', note: 'x'.repeat(max) })).status, 201);
});

// ── M: milestones ───────────────────────────────────────────────────────────

test('M: only a reached milestone; a draft has none — named 409, Open Dental untouched', async (t) => {
  switchReferrals(t);
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const sent = await walkTo(baseUrl, db, 'sent');
  for (const milestone of ['received', 'scheduled', 'seen', 'declined', 'closed']) {
    const r = await write(baseUrl, sent, { milestone, note: 'A note.' });
    assert.equal(r.status, 409, milestone);
    assert.equal(r.body.code, 'CHART_NOTE_MILESTONE_NOT_REACHED');
  }
  const draft = await walkTo(baseUrl, db, 'draft');
  for (const milestone of contract.TC_REFERRAL_CHART_MILESTONES) {
    assert.equal((await write(baseUrl, draft, { milestone, note: 'A note.' })).body.code, 'CHART_NOTE_MILESTONE_NOT_REACHED');
  }
  assert.equal(od.calls.length, 0);
});

test('M: once per milestone — a second write is a named 409 that never reaches Open Dental; another milestone still writes', async (t) => {
  switchReferrals(t);
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'acknowledged');
  assert.equal((await write(baseUrl, id)).status, 201);
  const callsAfterFirst = od.calls.length;
  const again = await write(baseUrl, id, { milestone: 'sent', note: 'Different words, same milestone.' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'CHART_NOTE_ALREADY_WRITTEN');
  assert.equal(again.body.commLogNum, 50001);
  assert.equal(again.body.writtenBy, 'tc@carein.ai');
  assert.equal(od.calls.length, callsAfterFirst, 'refused from the history, before any Open Dental call');
  assert.equal((await write(baseUrl, id, { milestone: 'received', note: 'The specialist confirmed receipt.' })).status, 201);
  assert.deepEqual(chartEvents(db).map((e) => e.chart_note_milestone), ['sent', 'received']);
});

test('M: each of the six milestones is reachable, and each note is dated from its own history row', async (t) => {
  switchReferrals(t);
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const closed = await walkTo(baseUrl, db, 'closed');
  // patient_scheduled comes from the email link; seeded here as the link writes it.
  db.table('tc_referral_events').push({
    event_id: randomUUID(),
    office_id: 'roland',
    referral_id: closed,
    from_status: 'acknowledged',
    to_status: 'acknowledged',
    actor: contract.REFERRAL_LINK_ACTORS.specialist,
    at: '2026-10-20T19:30:00.000Z',
    note: 'Scheduled for 2026-11-03',
    verb: 'patient_scheduled',
  });
  db.table('tc_referrals').find((r) => r.referral_id === closed).scheduled_date = '2026-11-03';
  for (const milestone of ['sent', 'received', 'scheduled', 'seen', 'closed']) {
    const r = await write(baseUrl, closed, { milestone, note: `Note for ${milestone}.` });
    assert.equal(r.status, 201, `${milestone}: ${JSON.stringify(r.body)}`);
  }
  const declined = await walkTo(baseUrl, db, 'declined');
  assert.equal((await write(baseUrl, declined, { milestone: 'declined', note: 'Declined: not needed yet.' })).status, 201);
  const dates = od.posts().map((p) => p.body.CommDateTime);
  assert.equal(dates[2], '2026-10-20 14:30:00', "the scheduled note is dated when the link said so, in Roland's clock");
  assert.equal(chartEvents(db).length, 6);
});

// ── F: failures are named, and nothing is claimed ───────────────────────────

test('F: Open Dental refuses the POST → 502 named, no history row, the attempt audited as an ERROR', async (t) => {
  switchReferrals(t);
  const od = fakeOd(t);
  od.onPost = async () => {
    const err = new Error('Request failed with status code 400');
    err.response = { data: { message: 'PatNum is invalid.' } };
    throw err;
  };
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'sent');
  const r = await write(baseUrl, id);
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'CHART_NOTE_WRITE_FAILED');
  assert.match(r.body.error, /PatNum is invalid/);
  assert.equal(chartEvents(db).length, 0);
  assert.deepEqual(chartAudits(db).map((a) => a.result), ['ERROR']);
  // The milestone is still open: the failure claimed nothing.
  const detail = await api(baseUrl, 'GET', REF(`/${id}`));
  assert.equal(contract.referralChartMilestones(detail.body.referral.events)[0].written, null);
});

test('F: a 201 that names no CommlogNum is UNCONFIRMED, not success — and the retry finds it on the chart and refuses', async (t) => {
  switchReferrals(t);
  const od = fakeOd(t);
  od.onPost = async ({ store }) => {
    store();
    return { status: 201, data: {} };
  };
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'sent');
  const r = await write(baseUrl, id);
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'CHART_NOTE_UNCONFIRMED');
  assert.equal(r.body.commLogNum, null);
  assert.equal(chartEvents(db).length, 0);
  od.onPost = null;
  const retry = await write(baseUrl, id);
  assert.equal(retry.status, 409);
  assert.equal(retry.body.code, 'CHART_NOTE_ALREADY_IN_CHART');
  assert.equal(od.posts().length, 1, 'never written twice');
});

test('F: a read-back that does not match what was sent is UNCONFIRMED, with the CommlogNum to look for', async (t) => {
  switchReferrals(t);
  const od = fakeOd(t);
  od.alterStored = (row) => {
    row.Note = `${row.Note} (truncated)`;
  };
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'sent');
  const r = await write(baseUrl, id);
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'CHART_NOTE_UNCONFIRMED');
  assert.equal(r.body.commLogNum, 50001);
  assert.equal(chartEvents(db).length, 0);
});

test('F: a read-back where the type differs (written under another type) is UNCONFIRMED', async (t) => {
  switchReferrals(t);
  const od = fakeOd(t);
  od.alterStored = (row) => {
    row.CommType = 486;
  };
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'sent');
  assert.equal((await write(baseUrl, id)).body.code, 'CHART_NOTE_UNCONFIRMED');
  assert.equal(chartEvents(db).length, 0);
});

test('F: the exact note already on the chart → 409 named, nothing posted', async (t) => {
  switchReferrals(t);
  const od = fakeOd(t);
  od.charts.roland.push({ CommlogNum: 40000, PatNum: 12827, CommType: 491, Note: `${NOTE}\r\n` });
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'sent');
  const r = await write(baseUrl, id);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'CHART_NOTE_ALREADY_IN_CHART');
  assert.equal(r.body.commLogNum, 40000);
  assert.equal(od.posts().length, 0);
});

test("F: the chart's notes cannot be read → nothing written (unverifiable)", async (t) => {
  switchReferrals(t);
  const od = fakeOd(t);
  const { client } = odOffices.getOdOffice('roland');
  const fake = client.apiGetRaw;
  client.apiGetRaw = async (p, params) => (p === '/commlogs' ? { ok: false, status: 503, data: null, error: 'down' } : fake(p, params));
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'sent');
  const r = await write(baseUrl, id);
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'CHART_NOTE_UNVERIFIABLE');
  assert.equal(od.posts().length, 0);
});

test('F: written but not recorded (the audit store fails) → 500 that says so; the row rolls back; a retry is refused, not doubled', async (t) => {
  switchReferrals(t);
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'sent');
  realTransactions(db);
  let failAudit = true;
  db.onQuery(/INSERT INTO audit_log/, () => {
    if (failAudit) throw new Error('audit store down');
    return undefined;
  });
  const r = await write(baseUrl, id);
  assert.equal(r.status, 500);
  assert.equal(r.body.code, 'CHART_NOTE_WRITTEN_UNRECORDED');
  assert.equal(r.body.commLogNum, 50001);
  assert.match(r.body.error, /Do not write it again/);
  assert.equal(chartEvents(db).length, 0, 'rolled back');
  failAudit = false;
  const retry = await write(baseUrl, id);
  assert.equal(retry.body.code, 'CHART_NOTE_ALREADY_IN_CHART');
  assert.equal(od.posts().length, 1, 'one note on the chart, not two');
});

test('F: a direct-DB office client is refused before anything is written', async () => {
  const od = { officeKey: 'roland', client: { useDatabase: true, apiGetRaw: async () => assert.fail('no read'), client: { post: async () => assert.fail('no write') } } };
  const out = await chartNoteService.writeChartNote(od, { patNum: 12827, note: NOTE, commType: 491, at: NOW.toISOString() });
  assert.deepEqual([out.ok, out.code, out.written], [false, 'CHART_NOTE_API_MODE_ONLY', false]);
});

// ── A: NO AUTOMATIC WRITES ──────────────────────────────────────────────────

/** Every non-test backend source file. */
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

test('A: only the one route reaches the chart-note code, and nothing but a request reaches the route', () => {
  const files = backendSources();
  const requirers = (re) => files.filter((f) => re.test(f.src)).map((f) => f.rel).sort();

  assert.deepEqual(requirers(/require\([^)]*referralChartNotes['"]\)/), ['routes/tc/referrals.js'], 'the route module has one caller');
  assert.deepEqual(
    requirers(/require\([^)]*services\/tc\/referralChartNote['"]\)/),
    ['routes/tc/referralChartNotes.js'],
    'the Open Dental half has one caller'
  );

  // Inside referrals.js the module is used once, in the POST /:id/chart-notes handler.
  const referrals = files.find((f) => f.rel === 'routes/tc/referrals.js').src;
  const uses = [...referrals.matchAll(/chartNotes\.writeChartNote\(/g)];
  assert.equal(uses.length, 1);
  const handler = referrals.slice(referrals.indexOf("'/:id/chart-notes'"));
  assert.ok(handler.indexOf('chartNotes.writeChartNote(') > -1 && handler.indexOf('chartNotes.writeChartNote(') < handler.indexOf('router.'), 'used only inside that handler');
  assert.match(referrals, /router\.post\(\s*'\/:id\/chart-notes'/);

  // Neither file schedules, listens or reacts: a person's request is the only trigger.
  for (const rel of ['routes/tc/referralChartNotes.js', 'services/tc/referralChartNote.js']) {
    const src = files.find((f) => f.rel === rel).src;
    assert.doesNotMatch(src, /setTimeout|setInterval|cron|schedule\(|\.on\(|EventEmitter|process\.nextTick|setImmediate/, rel);
  }
  // The Open Dental half holds no transport of its own: the voice writer is the one.
  const service = files.find((f) => f.rel === 'services/tc/referralChartNote.js').src;
  assert.doesNotMatch(service, /\.post\(|apiWriteRaw|client\.client|axios/);
  assert.match(service, /openDentalSync\.createCommLog\(/);

  // Who may name the commlog writer at all: the voice module itself, its legacy
  // webhook (COMMLOG_AUTO_WRITE, off by default), and this slice's one file.
  assert.deepEqual(requirers(/\bcreateCommLog\(/), ['routes/webhooks.js', 'services/openDentalSync.js', 'services/tc/referralChartNote.js']);
});

test('A: every other referral action — create, moves, sign-off, marks, close, edits, correspondence, reads — writes nothing to any chart', async (t) => {
  switchReferrals(t);
  const od = fakeOd(t);
  const { baseUrl, db } = await boot(t);
  for (const status of Object.keys(STEPS)) await walkTo(baseUrl, db, status);
  const sent = await walkTo(baseUrl, db, 'sent');
  assert.equal((await api(baseUrl, 'POST', REF(`/${sent}/correspondence`), { direction: 'from', party: 'specialist', channel: 'phone', note: 'Booked.' })).status, 201);
  assert.equal((await api(baseUrl, 'GET', REF(`/${sent}`))).status, 200);
  assert.equal((await api(baseUrl, 'GET', REF('/hub'))).status, 200);
  assert.equal(od.posts().length, 0, 'no commlog was written');
  assert.equal(od.commlogReads().length, 0, 'no chart was even read');
  assert.equal(chartEvents(db).length, 0);
});

// ── R: role and office ──────────────────────────────────────────────────────

test("R: another office's referral is a 404; a doctor is refused at the mount; Open Dental untouched", async (t) => {
  switchReferrals(t);
  const od = fakeOd(t);
  const admin = await boot(t);
  const id = await walkTo(admin.baseUrl, admin.db, 'sent');
  const other = await write(admin.baseUrl, id, { milestone: 'sent', note: NOTE }, 'valley');
  assert.equal(other.status, 404, JSON.stringify(other.body));
  const doc = await boot(t, { role: 'doctor', user: DOCTOR, db: admin.db });
  const r = await write(doc.baseUrl, id);
  assert.equal(r.status, 403);
  assert.equal(od.posts().length, 0);
  assert.equal(chartEvents(admin.db).length, 0);
});

// ── S: the OD-safe mirror ───────────────────────────────────────────────────

test("S: the contract's OD-safe text equals the writer's own sanitizer, character for character", () => {
  const probes = [
    '‘’‚‛′“”„‟″«»–—―…•·    ​',
    'Referral sent to Dr. O’Neil — “urgent”… • #3',
    'plain ASCII stays exactly as it is: 1-2 "x" \'y\'',
    '🦷 emoji and box drawing ─│ are left alone',
  ];
  for (const p of probes) assert.equal(contract.referralChartNoteOdSafe(p), sanitizeForOd(p), JSON.stringify(p));
  for (const p of probes) assert.equal(contract.referralChartNoteOdSafe(contract.referralChartNoteOdSafe(p)), contract.referralChartNoteOdSafe(p), 'idempotent');
});

test("S: the voice writer's payload is unchanged when no direction is given", () => {
  const od = { officeKey: 'roland', commTypeDefNum: 486, client: { formatODDateTime: (v) => v } };
  const entry = { Note: 'n', CommDateTime: '2026-10-27 10:00:00', Mode_: 3 };
  assert.equal(openDentalSync.buildCommLogApiPayload(1, entry, od).SentOrReceived, 'Received');
  assert.equal(openDentalSync.buildCommLogApiPayload(1, entry, od, null, 'Sideways').SentOrReceived, 'Received');
  assert.equal(openDentalSync.buildCommLogApiPayload(1, entry, od, null, 'Neither').SentOrReceived, 'Neither');
  assert.equal(openDentalSync.buildCommLogApiPayload(1, entry, od).CommType, 486);
});
