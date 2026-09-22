'use strict';

/**
 * ITEM 21 — a patient with no visit notes can receive their first one.
 *
 * Open Dental answers a patient with no group notes with an ERROR, not `[]`:
 * HTTP 404, "No GroupNote(s) found for PatNum N." (captured from roland 12827 on
 * staging; new-dashboard/tests/fixtures/od-groupnotes-none-staging.json). The
 * pre-check read that as "Open Dental did not answer", so every FIRST note was
 * refused with NOTE_PRECHECK_UNAVAILABLE and Retry failed forever.
 *
 *   2. a no-notes patient's first note lands Written, after read-back
 *   3. ONLY that captured answer is empty; every other failure still refuses
 *      - the read-back after a write that did not land is still NOTE_UNCONFIRMED
 *   4. a note that Failed on the old code, retried, goes Written — one note, no duplicate
 *   5. the fake models the none-found answer, pinned to the capture
 *
 * NO PHI: 12827 is the designated roland fixture; 4242424 is synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeOd, bootHygApp, api, apptRow, patientRow, operatoryRow } = require('./hygTestUtils');
const odWriter = require('../../services/hyg/odWriter');
const CAPTURED = require('../../../new-dashboard/tests/fixtures/od-groupnotes-none-staging.json');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;
const GROUP_NOTES = '/procedurelogs/GroupNotes';

const CROWN = {
  teeth: [3],
  code: 'Crown',
  category: 'Restorative',
  surfaces: ['O'],
  dx: ['D'],
  priority: 'urgent',
  motivation: ['pain'],
  status: 'proposed',
  scheduleNext: true,
  photos: [],
};

/** A day at roland for 12827, whose GroupNotes surface starts EMPTY — i.e. answers the 404. */
function od() {
  return new FakeOd({
    '/appointments': [apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' })],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow(),
    '/procedurelogs': [{ ProcNum: 5001 }, { ProcNum: 5002 }],
    [GROUP_NOTES]: [],
  });
}

/** The GroupNote write landing as Open Dental's does: a new `~GRP~` row appears. */
function noteThatLands(client) {
  let next = 60001;
  return (body) => {
    const procNum = next++;
    const current = Array.isArray(client.routes[GROUP_NOTES]) ? client.routes[GROUP_NOTES] : [];
    client.routes[GROUP_NOTES] = [
      ...current,
      {
        ProcNum: procNum,
        PatNum: body.PatNum,
        ProcNums: body.ProcNums,
        ProvNum: body.ProvNum,
        isSigned: false,
        Note: String(body.Note).replace(/\n/g, '\r\n'),
      },
    ];
    return { ok: true, status: 200, data: { ProcNum: procNum } };
  };
}

function noteWrites(client) {
  return client.writes.filter((w) => w[2] === '/procedurelogs/GroupNote').length;
}
function groupNoteReads(client) {
  return client.calls.filter((c) => c.path === GROUP_NOTES);
}

async function stageNote(app) {
  await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
  await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, { body: CROWN });
  const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, { body: { kind: 'note' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

function sendNote(app, staged) {
  const confirm = staged.visit.stagedWrites
    .filter((w) => w.kind === 'note')
    .map((w) => ({ kind: w.kind, previewFingerprint: w.previewFingerprint }));
  return api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, { body: { confirm } });
}

// ── 5. the fake, pinned to what Open Dental actually said ───────────────────

test('ACCEPTANCE 5: the capture is a 404 with the none-found sentence for 12827, and the rule matches it', () => {
  assert.equal(CAPTURED.request.path, GROUP_NOTES);
  assert.deepEqual(CAPTURED.request.params, { PatNum: 12827 });
  assert.equal(CAPTURED.response.status, 404);
  assert.equal(CAPTURED.response.body, 'No GroupNote(s) found for PatNum 12827.');
  // The captured answer, in the shape apiGetRaw hands the caller.
  const asSeen = { ok: false, status: 404, data: CAPTURED.response.body, error: CAPTURED.response.body };
  assert.equal(odWriter.isNoGroupNotesAnswer(asSeen, 12827), true);
});

test('ACCEPTANCE 5: the fake models ABSENCE as Open Dental does — a presence-only fake fails here', async () => {
  const client = od();
  const res = await client.apiGetRaw(GROUP_NOTES, { PatNum: 12827 });
  // A fake that answered `[]` (200) for a patient with no notes is the fake that
  // let every first-note send pass in this suite while failing on staging.
  assert.equal(res.ok, false, 'no notes is NOT a 200 on this surface');
  assert.equal(res.status, CAPTURED.response.status);
  assert.equal(res.data, CAPTURED.response.body);

  // The PatNum in the sentence is the one asked about.
  const other = await client.apiGetRaw(GROUP_NOTES, { PatNum: 12828 });
  assert.equal(other.data, 'No GroupNote(s) found for PatNum 12828.');

  // And once a note exists, the surface answers the rows.
  client.routes[GROUP_NOTES] = [{ ProcNum: 1, PatNum: 12827, ProcNums: [5001], Note: 'x' }];
  const present = await client.apiGetRaw(GROUP_NOTES, { PatNum: 12827 });
  assert.equal(present.ok, true);
  assert.equal(present.data.length, 1);
});

// ── 3. only THAT answer is empty ────────────────────────────────────────────

test('ACCEPTANCE 3: readGroupNotes — the captured answer is empty; every near-miss still refuses', async () => {
  const none = (data, status = 404) => async () => ({ ok: false, status, data, error: String(data) });

  const empty = await odWriter.readGroupNotes(none('No GroupNote(s) found for PatNum 12827.'), 12827);
  assert.deepEqual(empty, { ok: true, rows: [] });
  // Trailing whitespace from the transport is not a different answer.
  assert.equal((await odWriter.readGroupNotes(none('No GroupNote(s) found for PatNum 12827.\r\n'), 12827)).ok, true);

  const nearMisses = [
    ['the right sentence about ANOTHER patient', none('No GroupNote(s) found for PatNum 12828.')],
    ['the right sentence with the wrong status', none('No GroupNote(s) found for PatNum 12827.', 400)],
    ['the right sentence as a 500', none('No GroupNote(s) found for PatNum 12827.', 500)],
    ['a 404 for a path that is not there', none("'/procedurelogs/GroupNotes' is not a valid resource.")],
    ['a 404 with no body', none(null)],
    ['a 404 whose body is an object', none({ message: 'No GroupNote(s) found for PatNum 12827.' })],
    ['a longer sentence that merely contains it', none('Error: No GroupNote(s) found for PatNum 12827. Retry.')],
    ['an outage', none('upstream timeout', 503)],
    ['no answer at all', none('socket hang up', 0)],
    ['a 200 that is not a list', async () => ({ ok: true, status: 200, data: { rows: [] } })],
  ];
  for (const [label, odGet] of nearMisses) {
    const res = await odWriter.readGroupNotes(odGet, 12827);
    assert.equal(res.ok, false, label);
    assert.equal(res.code, 'GROUP_NOTES_UNREADABLE', label);
  }
});

test('ACCEPTANCE 3: a genuinely unreachable Open Dental still refuses the first note — nothing written', async () => {
  for (const answer of [
    { ok: false, status: 503, data: null, error: 'upstream timeout' },
    { ok: false, status: 0, data: null, error: 'timeout of 30000ms exceeded' },
    { ok: false, status: 404, data: "'/procedurelogs/GroupNotes' is not a valid resource.", error: 'x' },
  ]) {
    const client = od();
    client.routes[GROUP_NOTES] = answer;
    client.writeRoutes = { '/procedurelogs/GroupNote': noteThatLands(client) };
    const app = await bootHygApp({ od: client });
    try {
      const res = await sendNote(app, await stageNote(app));
      assert.equal(res.status, 200);
      assert.equal(res.body.outcomes[0].state, 'Failed', JSON.stringify(answer));
      assert.equal(res.body.outcomes[0].code, 'NOTE_PRECHECK_UNAVAILABLE');
      assert.equal(noteWrites(client), 0, 'NOTHING was written');
    } finally {
      await app.close();
    }
  }
});

// ── 2. the first note ───────────────────────────────────────────────────────

test('ACCEPTANCE 2: a patient with NO notes gets their first one — Written only after it is read back', async () => {
  const client = od();
  client.writeRoutes = { '/procedurelogs/GroupNote': noteThatLands(client) };
  const app = await bootHygApp({ od: client });
  try {
    const res = await sendNote(app, await stageNote(app));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const note = res.body.outcomes[0];
    assert.equal(note.state, 'Written', JSON.stringify(note));
    assert.match(note.writtenRef, /GroupNote/);
    assert.equal(noteWrites(client), 1, 'exactly one note');

    // The pre-check asked and heard "none"; the read-back asked and found it.
    const reads = groupNoteReads(client);
    assert.equal(reads.length, 2, 'one pre-check, one read-back');
    assert.deepEqual(reads.map((r) => r.params), [{ PatNum: 12827 }, { PatNum: 12827 }]);
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 3: the read-back after a write that did not land still says NOTE_UNCONFIRMED', async () => {
  // Open Dental answers the POST but the note never appears: the surface still
  // says "none found" afterwards. Empty is not confirmation.
  const client = od();
  client.writeRoutes = { '/procedurelogs/GroupNote': () => ({ ok: true, status: 200, data: {} }) };
  const app = await bootHygApp({ od: client });
  try {
    const res = await sendNote(app, await stageNote(app));
    assert.equal(res.body.outcomes[0].state, 'Failed');
    assert.equal(res.body.outcomes[0].code, 'NOTE_UNCONFIRMED');
    assert.equal(noteWrites(client), 1);
  } finally {
    await app.close();
  }

  // And a read-back Open Dental does not answer is NOTE_UNCONFIRMED too.
  const client2 = od();
  client2.writeRoutes = {
    '/procedurelogs/GroupNote': () => {
      client2.routes[GROUP_NOTES] = { ok: false, status: 503, data: null, error: 'upstream timeout' };
      return { ok: true, status: 200, data: {} };
    },
  };
  const app2 = await bootHygApp({ od: client2 });
  try {
    const res = await sendNote(app2, await stageNote(app2));
    assert.equal(res.body.outcomes[0].state, 'Failed');
    assert.equal(res.body.outcomes[0].code, 'NOTE_UNCONFIRMED');
  } finally {
    await app2.close();
  }
});

// ── 4. the stuck note ───────────────────────────────────────────────────────

test('ACCEPTANCE 4 (in the fake): a note Failed by the old pre-check, retried after the fix, goes Written — ONE note', async () => {
  const client = od();
  client.writeRoutes = { '/procedurelogs/GroupNote': noteThatLands(client) };
  const app = await bootHygApp({ od: client });
  try {
    const staged = await stageNote(app);

    // The state 12827's note is in on staging: Failed with NOTE_PRECHECK_UNAVAILABLE.
    // Reproduced by the pre-check going unanswered once.
    client.routes[GROUP_NOTES] = { ok: false, status: 503, data: null, error: 'upstream timeout' };
    const first = await sendNote(app, staged);
    assert.equal(first.body.outcomes[0].code, 'NOTE_PRECHECK_UNAVAILABLE');
    assert.equal(noteWrites(client), 0);

    // Open Dental answers again — with the none-found 404, as it does for 12827.
    client.routes[GROUP_NOTES] = [];
    const retry = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes/note/retry' + Q);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    const second = await sendNote(app, staged);
    assert.equal(second.body.outcomes[0].state, 'Written', JSON.stringify(second.body.outcomes[0]));
    assert.equal(noteWrites(client), 1, 'one note in Open Dental');

    // Sent again (a double-press after Written is refused as not staged), and a
    // retry cannot re-arm a Written note — so there is never a second copy.
    const again = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes/note/retry' + Q);
    assert.equal(again.status, 409);
    assert.equal(noteWrites(client), 1);
    assert.equal(client.routes[GROUP_NOTES].length, 1);
  } finally {
    await app.close();
  }
});
