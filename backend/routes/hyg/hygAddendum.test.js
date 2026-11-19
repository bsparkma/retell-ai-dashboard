'use strict';

/**
 * THE AFTER-SEND ADDENDUM — end to end through the REAL /api/hyg stack.
 *
 * Beau's rulings, each pinned here:
 *   - ANYONE on the team (any role the module lets write), not only the author;
 *   - SAME office-local DAY as the visit note's send; next day → 409, forever;
 *   - additive: the original note (its staged row AND its GroupNote in the
 *     chart) is never touched; several addenda a day are fine;
 *   - the chart is reached ONLY by a human-pressed "Send addendum" naming the
 *     fingerprint of the preview — adding one writes nothing to Open Dental;
 *   - fail closed when the office's Open Dental is not configured.
 *
 * NO REAL PATIENT DATA. PatNum 12827 is the roland staging fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeOd, FakeHygDb, bootHygApp, api, apptRow, patientRow, operatoryRow } = require('./hygTestUtils');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;
const APT = '/api/hyg/visit/900001';

// 10:00 CDT on the visit day — when the note is recorded as sent.
const SENT_AT = new Date('2026-09-08T15:00:00Z');
// 16:30 CDT the same day, and 09:00 CDT the next.
const SAME_DAY = new Date('2026-09-08T21:30:00Z');
const NEXT_DAY = new Date('2026-09-09T14:00:00Z');

function od() {
  const client = new FakeOd({
    '/appointments': [apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' })],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow(),
    '/procedurelogs': [{ ProcNum: 5001 }, { ProcNum: 5002 }],
    '/procedurelogs/GroupNotes': [],
    '/definitions': [{ DefNum: 473, ItemName: 'Routers' }],
  });
  // As Open Dental behaves: a NEW ~GRP~ row appears, with \r\n in the note.
  let next = 60001;
  client.writeRoutes = {
    '/procedurelogs/GroupNote': (body) => {
      const procNum = next++;
      client.routes['/procedurelogs/GroupNotes'] = [
        ...client.routes['/procedurelogs/GroupNotes'],
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
    },
  };
  return client;
}

function noteWrites(client) {
  return client.writes.filter((w) => w[2] === '/procedurelogs/GroupNote');
}

/** Open the visit, stage the note, send it, and pin its sent time to SENT_AT. */
async function sentVisit(app) {
  await api(app.baseUrl, 'POST', `${APT}/open${Q}`);
  const staged = await api(app.baseUrl, 'POST', `${APT}/staged-writes${Q}`, { body: { kind: 'note' } });
  assert.equal(staged.status, 201);
  const note = staged.body.visit.stagedWrites.find((w) => w.kind === 'note');
  const sent = await api(app.baseUrl, 'POST', `${APT}/send${Q}`, {
    body: { confirm: [{ kind: 'note', previewFingerprint: note.previewFingerprint }] },
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.outcomes[0].state, 'Written');
  const row = app.db.hyg_staged_write.find((r) => r.kind === 'note');
  row.sent_at = SENT_AT;
  app.app.set('hygClock', () => SAME_DAY);
  return row;
}

const addendumAt = (body, i = 0) => body.visit.addenda[i];

test('before the note is sent: no addendum, and the window says why (409 ADDENDUM_NOTE_NOT_SENT)', async () => {
  const client = od();
  const app = await bootHygApp({ od: client });
  try {
    const opened = await api(app.baseUrl, 'POST', `${APT}/open${Q}`);
    assert.deepEqual(opened.body.visit.addendumWindow, { open: false, reason: 'note_not_sent', day: null });
    assert.deepEqual(opened.body.visit.addenda, []);
    const res = await api(app.baseUrl, 'POST', `${APT}/addenda${Q}`, { body: { text: 'Too early' } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'ADDENDUM_NOTE_NOT_SENT');
    assert.equal(app.db.hyg_visit_addendum.length, 0);
  } finally {
    await app.close();
  }
});

test('same day: adding composes the preview server-side and writes NOTHING to Open Dental', async () => {
  const client = od();
  const app = await bootHygApp({ od: client });
  try {
    await sentVisit(app);
    const writesBefore = client.writes.length;

    const res = await api(app.baseUrl, 'POST', `${APT}/addenda${Q}`, {
      body: { text: '  Patient called back: sensitivity on #30 resolved.  ' },
    });
    assert.equal(res.status, 201);
    assert.equal(client.writes.length, writesBefore, 'adding an addendum is not a chart write');

    const a = addendumAt(res.body);
    assert.equal(a.state, 'Staged');
    assert.equal(a.text, 'Patient called back: sensitivity on #30 resolved.', 'trimmed on the way in');
    assert.equal(a.author, 'hygienist@carein.ai', 'the author is the signed-in user');
    assert.equal(a.preview[0], 'ADDENDUM to the hygiene visit note of 2026-09-08 (GroupNote 60001)');
    assert.equal(a.preview[1], 'Patient called back: sensitivity on #30 resolved.');
    assert.match(a.preview[2], /^Entered in CareIN by hygienist@carein\.ai at 2026-09-08 16:30 CDT\. Unsigned\.$/);
    assert.ok(a.previewFingerprint);
    assert.deepEqual(res.body.visit.addendumWindow, { open: true, reason: null, day: '2026-09-08' });
  } finally {
    await app.close();
  }
});

test('the author comes from the session, never the body: an extra key is a 400', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await sentVisit(app);
    const spoof = await api(app.baseUrl, 'POST', `${APT}/addenda${Q}`, {
      body: { text: 'x', author: 'somebody-else@carein.ai' },
    });
    assert.equal(spoof.status, 400);
    assert.equal(spoof.body.code, 'INVALID_BODY');
    const blank = await api(app.baseUrl, 'POST', `${APT}/addenda${Q}`, { body: { text: '   ' } });
    assert.equal(blank.status, 400);
    assert.equal(app.db.hyg_visit_addendum.length, 0);
  } finally {
    await app.close();
  }
});

test('ANYONE on the team: office and admin roles may add one the same day, as themselves', async () => {
  const db = new FakeHygDb();
  const client = od();
  const first = await bootHygApp({ od: client, db });
  try {
    await sentVisit(first);
  } finally {
    await first.close();
  }
  for (const [role, email] of [
    ['office', 'frontdesk@carein.ai'],
    ['admin', 'manager@carein.ai'],
  ]) {
    const app = await bootHygApp({ od: client, db, role, user: { email, name: 'Team Member', tenantId: 'x' } });
    try {
      app.app.set('hygClock', () => SAME_DAY);
      const res = await api(app.baseUrl, 'POST', `${APT}/addenda${Q}`, { body: { text: `From the ${role} desk` } });
      assert.equal(res.status, 201, role);
      const mine = res.body.visit.addenda.find((a) => a.author === email);
      assert.ok(mine, `${role}'s addendum is attributed to ${email}`);
    } finally {
      await app.close();
    }
  }
  assert.equal(db.hyg_visit_addendum.length, 2, 'multiple addenda on one visit, one day');
});

test('NEXT DAY: adding is 409 ADDENDUM_WINDOW_CLOSED, sending is 409, and the addenda stay readable', async () => {
  const client = od();
  const app = await bootHygApp({ od: client });
  try {
    await sentVisit(app);
    const added = await api(app.baseUrl, 'POST', `${APT}/addenda${Q}`, { body: { text: 'Same day' } });
    assert.equal(added.status, 201);
    const a = addendumAt(added.body);

    app.app.set('hygClock', () => NEXT_DAY);
    const late = await api(app.baseUrl, 'POST', `${APT}/addenda${Q}`, { body: { text: 'Next day' } });
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'ADDENDUM_WINDOW_CLOSED');

    const writes = noteWrites(client).length;
    const send = await api(app.baseUrl, 'POST', `${APT}/addenda/${a.id}/send${Q}`, {
      body: { previewFingerprint: a.previewFingerprint },
    });
    assert.equal(send.status, 409);
    assert.equal(send.body.code, 'ADDENDUM_WINDOW_CLOSED');
    assert.equal(noteWrites(client).length, writes, 'nothing reached the chart');

    const view = await api(app.baseUrl, 'GET', `${APT}${Q}`);
    assert.equal(view.status, 200);
    assert.deepEqual(view.body.visit.addendumWindow, { open: false, reason: 'day_closed', day: '2026-09-08' });
    assert.equal(view.body.visit.addenda.length, 1, 'read-only, not gone');
    assert.equal(view.body.visit.addenda[0].state, 'Staged');
  } finally {
    await app.close();
  }
});

test('the day is the OFFICE-LOCAL day: 23:30 CT then 00:10 CT is the next day, though UTC agrees', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    const row = await sentVisit(app);
    row.sent_at = new Date('2026-09-09T04:30:00Z'); // 23:30 CDT, 2026-09-08
    app.app.set('hygClock', () => new Date('2026-09-09T05:10:00Z')); // 00:10 CDT, 2026-09-09
    const res = await api(app.baseUrl, 'POST', `${APT}/addenda${Q}`, { body: { text: 'After midnight' } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'ADDENDUM_WINDOW_CLOSED');
  } finally {
    await app.close();
  }
});

test('SEND ADDENDUM: a human-click staged write — fingerprint first, then the note writer, original untouched', async () => {
  const client = od();
  const app = await bootHygApp({ od: client });
  try {
    const noteRow = await sentVisit(app);
    const noteBefore = JSON.parse(JSON.stringify({ ...noteRow, sent_at: String(noteRow.sent_at) }));
    const chartNoteBefore = client.routes['/procedurelogs/GroupNotes'][0].Note;

    const added = await api(app.baseUrl, 'POST', `${APT}/addenda${Q}`, { body: { text: 'Line one\nLine two' } });
    const a = addendumAt(added.body);

    // A fingerprint of something else refuses, with nothing written.
    const stale = await api(app.baseUrl, 'POST', `${APT}/addenda/${a.id}/send${Q}`, {
      body: { previewFingerprint: 'not-what-was-read' },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'PREVIEW_CHANGED');
    assert.equal(noteWrites(client).length, 1, 'only the visit note so far');

    const res = await api(app.baseUrl, 'POST', `${APT}/addenda/${a.id}/send${Q}`, {
      body: { previewFingerprint: a.previewFingerprint },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome.state, 'Written');
    assert.equal(res.body.outcome.writtenRef, 'GroupNote 60002 (addendum)');

    const writes = noteWrites(client);
    assert.equal(writes.length, 2, 'one more GroupNote: the addendum, beside the note');
    const body = writes[1][3];
    assert.equal(body.Note, a.preview.join('\n'), 'THE PREVIEW IS THE WRITE');
    assert.equal(body.isSigned, false);
    assert.equal(body.PatNum, 12827);
    assert.deepEqual(body.ProcNums, [5001, 5002]);

    const sentA = res.body.visit.addenda[0];
    assert.equal(sentA.state, 'Written');
    assert.equal(sentA.sentBy, 'hygienist@carein.ai');
    assert.ok(sentA.sentAt);

    // THE ORIGINAL NOTE IS NEVER EDITED — not its row, not its words in the chart.
    const noteAfter = app.db.hyg_staged_write.find((r) => r.kind === 'note');
    assert.deepEqual(JSON.parse(JSON.stringify({ ...noteAfter, sent_at: String(noteAfter.sent_at) })), noteBefore);
    assert.equal(client.routes['/procedurelogs/GroupNotes'][0].Note, chartNoteBefore);

    // Written is final: a second press sends nothing.
    const again = await api(app.baseUrl, 'POST', `${APT}/addenda/${a.id}/send${Q}`, {
      body: { previewFingerprint: a.previewFingerprint },
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'ADDENDUM_NOT_SENDABLE');
    assert.equal(noteWrites(client).length, 2);
  } finally {
    await app.close();
  }
});

test('a refused write is Failed with its reason, and sending again (same words) lands it', async () => {
  const client = od();
  const app = await bootHygApp({ od: client });
  try {
    await sentVisit(app);
    const added = await api(app.baseUrl, 'POST', `${APT}/addenda${Q}`, { body: { text: 'Retry me' } });
    const a = addendumAt(added.body);

    const landing = client.writeRoutes['/procedurelogs/GroupNote'];
    client.writeRoutes['/procedurelogs/GroupNote'] = { ok: false, status: 400, data: 'Refused', error: 'Refused' };
    const failed = await api(app.baseUrl, 'POST', `${APT}/addenda/${a.id}/send${Q}`, {
      body: { previewFingerprint: a.previewFingerprint },
    });
    assert.equal(failed.status, 200, 'the request succeeded; the write did not');
    assert.equal(failed.body.outcome.state, 'Failed');
    assert.equal(failed.body.visit.addenda[0].state, 'Failed');
    assert.ok(failed.body.visit.addenda[0].errorMessage);
    assert.equal(failed.body.visit.addenda[0].sentAt, null, 'a failed send is not a send');

    client.writeRoutes['/procedurelogs/GroupNote'] = landing;
    const ok = await api(app.baseUrl, 'POST', `${APT}/addenda/${a.id}/send${Q}`, {
      body: { previewFingerprint: a.previewFingerprint },
    });
    assert.equal(ok.body.outcome.state, 'Written');
  } finally {
    await app.close();
  }
});

test('fail closed: an office whose Open Dental is not configured refuses the send, and the addendum stays Staged', async () => {
  const db = new FakeHygDb();
  const client = od();
  const first = await bootHygApp({ od: client, db });
  let a;
  try {
    await sentVisit(first);
    const added = await api(first.baseUrl, 'POST', `${APT}/addenda${Q}`, { body: { text: 'Kept' } });
    a = addendumAt(added.body);
  } finally {
    await first.close();
  }
  const app = await bootHygApp({ od: client, db, odUnavailableFor: ['roland'] });
  try {
    app.app.set('hygClock', () => SAME_DAY);
    const writes = noteWrites(client).length;
    const res = await api(app.baseUrl, 'POST', `${APT}/addenda/${a.id}/send${Q}`, {
      body: { previewFingerprint: a.previewFingerprint },
    });
    assert.ok(res.status >= 400, `refused (${res.status})`);
    assert.notEqual(res.body.success, true);
    assert.equal(noteWrites(client).length, writes);
    assert.equal(db.hyg_visit_addendum[0].state, 'Staged');
  } finally {
    await app.close();
  }
});

test('an addendum id from another visit or a malformed one is refused', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    await sentVisit(app);
    const missing = await api(app.baseUrl, 'POST', `${APT}/addenda/00000000-0000-4000-8000-999999999999/send${Q}`, {
      body: { previewFingerprint: 'x' },
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'ADDENDUM_NOT_FOUND');
    const bad = await api(app.baseUrl, 'POST', `${APT}/addenda/not-an-id/send${Q}`, { body: { previewFingerprint: 'x' } });
    assert.equal(bad.status, 400);
  } finally {
    await app.close();
  }
});
