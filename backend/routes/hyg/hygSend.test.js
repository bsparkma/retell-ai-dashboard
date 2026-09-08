'use strict';

/**
 * THE SEND — the module's first Open Dental writes, end to end.
 *
 * Booted through the REAL /api/hyg stack, with an Open Dental client whose
 * write verbs answer only what a test scripted and throw for anything else.
 *
 * The five claims, in the order they would hurt if they were wrong:
 *
 *   1. **The preview IS the write.** A payload that changed between the preview
 *      and the confirm refuses the WHOLE send, before anything is written.
 *   2. **Never claim success before read-back.** A write Open Dental accepted
 *      but cannot show back is `Failed`, not `Written`.
 *   3. **Partial success is normal.** The note can land and the slip fail; each
 *      carries its own state, and a visit is never "sent".
 *   4. **The approving user is recorded at the moment of the write**, server
 *      side, along with a reference to where it landed.
 *   5. **Nothing is gated on completeness.** An entirely unanswered slip sends.
 *
 * NO REAL PATIENT DATA. Every PatNum is a designated staging fixture.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FakeOd,
  bootHygApp,
  api,
  apptRow,
  patientRow,
  operatoryRow,
} = require('./hygTestUtils');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;

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

/**
 * A day, the procedures on the appointment, this office's image categories, and
 * whichever writes a test wants to allow.
 */
function od({ procedures = [{ ProcNum: 5001 }, { ProcNum: 5002 }], writes = {}, definitions } = {}) {
  return new FakeOd(
    {
      '/appointments': [
        apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' }),
      ],
      '/operatories': [operatoryRow()],
      '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
      '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
      '/patients/12827': patientRow(),
      '/procedurelogs': procedures,
      // WHERE A GROUP NOTE IS READ BACK FROM. Empty until a write puts one
      // here — see groupNoteThatLands.
      //
      // The old harness echoed the note onto the `/procedurelogs` rows instead,
      // which is a shape Open Dental does not produce: a procedurelog row
      // carries no note text (H0 quotes OD's own "use API ProcNotes instead").
      // The fake made the broken read-back pass, which is why six green tests
      // sat on top of a read-back that could never confirm anything.
      '/procedurelogs/GroupNotes': [],
      // DefNum 473 at roland. H0 found the SAME category name is 429 at the
      // other office, which is why nothing here may hardcode a number.
      '/definitions': definitions ?? [
        { DefNum: 401, ItemName: 'ODHQ' },
        { DefNum: 473, ItemName: 'Routers' },
      ],
    },
    { writes }
  );
}

/**
 * The GroupNote write, succeeding — as Open Dental behaves: a NEW `~GRP~` row
 * appears on the GroupNotes surface, with a ProcNum the database minted.
 *
 * @param {import('./hygTestUtils').FakeOd} client
 * @param {{ procDate?: string }} [opts] `procDate` defaults to the visit date;
 *   pass another to model a row the dedupe must NOT treat as today's note.
 */
function groupNoteThatLands(client, { procDate = DATE } = {}) {
  let nextProcNum = 60001;
  return (body) => {
    const procNum = nextProcNum++;
    client.routes['/procedurelogs/GroupNotes'] = [
      ...client.routes['/procedurelogs/GroupNotes'],
      { ProcNum: procNum, ProcDate: procDate, Note: body.Note, procCode: '~GRP~' },
    ];
    return { ok: true, status: 200, data: { ProcNum: procNum } };
  };
}

/** How many GroupNote POSTs reached Open Dental. */
function noteWrites(client) {
  return client.writes.filter((w) => w[2] === '/procedurelogs/GroupNote').length;
}

/** Open a visit, add a crown, stage the given kinds. Returns the visit body. */
async function stagedVisit(app, kinds) {
  await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
  await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, { body: CROWN });
  let last = null;
  for (const kind of kinds) {
    last = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
      body: { kind },
    });
    assert.equal(last.status, 201, kind);
  }
  return last.body;
}

/** `{ kind, previewFingerprint }` for each staged write on a visit body. */
function confirmAll(body, kinds) {
  return body.visit.stagedWrites
    .filter((w) => kinds.includes(w.kind))
    .map((w) => ({ kind: w.kind, previewFingerprint: w.previewFingerprint }));
}

test('the note lands, unsigned, and is only Written after it is read back', async () => {
  const client = od();
  client.writeRoutes = { '/procedurelogs/GroupNote': groupNoteThatLands(client) };
  const app = await bootHygApp({ od: client });
  try {
    const staged = await stagedVisit(app, ['note']);

    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirmAll(staged, ['note']) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.written, 1);
    assert.equal(res.body.failed, 0);
    assert.equal(res.body.outcomes[0].state, 'Written');
    // THE REFERENCE CARRIES THE ~GRP~ ProcNum OPEN DENTAL MINTED, which is the
        // whole point of reading back from the surface that has one.
    assert.match(res.body.outcomes[0].writtenRef, /GroupNote 60001 on 2 procedures \(5001, 5002\)/);

    // THE PAYLOAD OPEN DENTAL SAW.
    const write = client.writes.find((w) => w[2] === '/procedurelogs/GroupNote');
    assert.ok(write, 'the GroupNote write was made');
    const body = write[3];
    assert.equal(body.isSigned, false, 'CareIN never claims a signature');
    // THE PAYLOAD H0 DOCUMENTED: PatNum is REQUIRED and ProcNums is an ARRAY.
    // The first version sent no PatNum and a comma-joined string, and the first
    // real send came back "Invalid JSON" — Open Dental's parse-stage refusal.
    assert.equal(body.PatNum, 12827, 'PatNum is required and was missing');
    assert.deepEqual(body.ProcNums, [5001, 5002], 'an array, not a comma string');
    assert.equal(body.ProvNum, 7, "the appointment's hygiene provider");
    assert.match(body.Note, /Entered in CareIN by hygienist@carein\.ai\. Unsigned\./);
    assert.doesNotMatch(body.Note, /(?<!un)\bsigned\b/i);

    // And the row records WHO approved it and WHERE it went.
    const row = app.db.hyg_staged_write[0];
    assert.equal(row.state, 'Written');
    assert.equal(row.sent_by, 'hygienist@carein.ai');
    assert.ok(row.sent_at, 'sent_by and sent_at are set together');
    assert.ok(row.written_ref);
  } finally {
    await app.close();
  }
});

test('a note Open Dental accepts but cannot show back is Failed, never Written', async () => {
  // The write returns 200 and the note is not on the GroupNotes surface
  // afterwards. "We think it worked" and "the chart contains this" are
  // different claims, and only the second one may set a row to Written.
  const client = od();
  client.writeRoutes = { '/procedurelogs/GroupNote': { ok: true, status: 200, data: {} } };
  const app = await bootHygApp({ od: client });
  try {
    const staged = await stagedVisit(app, ['note']);
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirmAll(staged, ['note']) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.written, 0);
    assert.equal(res.body.failed, 1);
    assert.equal(res.body.outcomes[0].state, 'Failed');
    assert.equal(res.body.outcomes[0].code, 'NOTE_UNCONFIRMED');
    assert.match(res.body.outcomes[0].errorMessage, /read it back|visit notes/);
    assert.equal(res.body.visit.stagedWrites[0].sentAt, null, 'a failed send is not a send');
  } finally {
    await app.close();
  }
});

test('THE 9/07 BUG: a note that is only on the GroupNotes surface still confirms', async () => {
  // What actually happened in staging on 2026-09-07: the POST returned 200, the
  // slip and the handoff landed, and the note came back Failed. The read-back
  // was asking `/procedurelogs?AptNum=` — the appointment's own procedures —
  // where a `~GRP~` row never appears and where no row carries note text at
  // all. This is that shape: the appointment rows have NO note on them, and the
  // note is on the GroupNotes surface, which is where it really lives.
  const client = od();
  client.writeRoutes = { '/procedurelogs/GroupNote': groupNoteThatLands(client) };
  const app = await bootHygApp({ od: client });
  try {
    const staged = await stagedVisit(app, ['note']);
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirmAll(staged, ['note']) },
    });

    assert.equal(res.body.outcomes[0].state, 'Written');
    // Nothing was echoed onto the appointment's procedures, and it did not
    // matter: the old read-back's whole surface stayed empty of note text.
    assert.deepEqual(client.routes['/procedurelogs'], [{ ProcNum: 5001 }, { ProcNum: 5002 }]);
  } finally {
    await app.close();
  }
});

test('RETRY DOES NOT WRITE TWICE: the 9/07 row repairs itself instead of duplicating', async () => {
  // THE LOAD-BEARING TEST, and the exact staging sequence from 2026-09-07.
  //
  // H0: "No existing procnote can EVER be edited or deleted." So a note that
  // LANDED but could not be confirmed leaves a Failed row with a Retry button
  // sitting over a note that is already in the chart — and every press of it
  // used to file another permanent copy that nobody can take back out.
  //
  // Modelled honestly: the POST lands the row, and Open Dental then stops
  // answering the read that would have confirmed it.
  const client = od();
  /** @type {any} */
  let landed = null;
  client.writeRoutes = {
    '/procedurelogs/GroupNote': (body) => {
      landed = { ProcNum: 60001, ProcDate: DATE, Note: body.Note, procCode: '~GRP~' };
      client.routes['/procedurelogs/GroupNotes'] = {
        ok: false,
        status: 503,
        data: null,
        error: 'upstream timeout',
      };
      return { ok: true, status: 200, data: {} };
    },
  };
  const app = await bootHygApp({ od: client });
  try {
    const staged = await stagedVisit(app, ['note']);
    const send = () =>
      api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
        body: { confirm: confirmAll(staged, ['note']) },
      });

    // 1. The send that happened on 9/07: 200 from the POST, no confirmation.
    const first = await send();
    assert.equal(first.body.outcomes[0].state, 'Failed');
    assert.equal(first.body.outcomes[0].code, 'NOTE_UNCONFIRMED');
    assert.equal(noteWrites(client), 1);
    assert.ok(landed, 'and the note really is in the chart');

    // 2. Open Dental answers again. The hygienist presses Retry.
    client.routes['/procedurelogs/GroupNotes'] = [landed];
    const retry = await api(
      app.baseUrl,
      'POST',
      '/api/hyg/visit/900001/staged-writes/note/retry' + Q
    );
    assert.equal(retry.status, 200);

    // 3. The send that would have duplicated the note.
    const second = await send();
    assert.equal(second.body.outcomes[0].state, 'Written', 'honest: the note IS on the chart');
    assert.equal(noteWrites(client), 1, 'AND OPEN DENTAL WAS NOT WRITTEN TO A SECOND TIME');
    assert.match(
      second.body.outcomes[0].writtenRef,
      /GroupNote 60001 .*already on the chart/,
      'the reference names the row that was already there, and says which event this was'
    );
  } finally {
    await app.close();
  }
});

test('an identical note from ANOTHER DAY does not false-confirm today\'s', async () => {
  // Two prophy visits can compose byte-identical notes. "This text appears
  // somewhere in the patient's history" is not evidence that today's note was
  // filed, so the date has to match before the writer declines to write.
  const client = od();
  client.writeRoutes = { '/procedurelogs/GroupNote': groupNoteThatLands(client) };
  const app = await bootHygApp({ od: client });
  try {
    const staged = await stagedVisit(app, ['note']);
    const noteText = app.db.hyg_staged_write[0].payload.text;
    // The same note, on the chart, dated three months ago.
    client.routes['/procedurelogs/GroupNotes'] = [
      { ProcNum: 41200, ProcDate: '2026-06-08', Note: noteText, procCode: '~GRP~' },
    ];

    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirmAll(staged, ['note']) },
    });

    assert.equal(res.body.outcomes[0].state, 'Written');
    assert.equal(noteWrites(client), 1, "today's note WAS written — the old one is not it");
    assert.match(res.body.outcomes[0].writtenRef, /GroupNote 60001 /, 'confirmed by the NEW row');
    assert.doesNotMatch(res.body.outcomes[0].writtenRef, /already on the chart/);
  } finally {
    await app.close();
  }
});

test('a LONGER note containing this one does not confirm it', async () => {
  // The old read-back used `.includes()`. Once the same comparison also decides
  // whether to SKIP a write, a loose match stops being cosmetic and becomes a
  // note that never reaches a chart.
  const client = od();
  client.writeRoutes = { '/procedurelogs/GroupNote': { ok: true, status: 200, data: {} } };
  const app = await bootHygApp({ od: client });
  try {
    const staged = await stagedVisit(app, ['note']);
    const noteText = app.db.hyg_staged_write[0].payload.text;
    client.routes['/procedurelogs/GroupNotes'] = [
      {
        ProcNum: 41201,
        ProcDate: DATE,
        Note: noteText + '\nAddendum: patient rescheduled.',
        procCode: '~GRP~',
      },
    ];

    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirmAll(staged, ['note']) },
    });

    assert.equal(res.body.outcomes[0].state, 'Failed');
    assert.equal(res.body.outcomes[0].code, 'NOTE_UNCONFIRMED');
    assert.equal(noteWrites(client), 1, 'the near-miss did not suppress the write either');
  } finally {
    await app.close();
  }
});

test('the same note in CRLF is the same note', async () => {
  // The app sends `\n`; Open Dental's docs prefer `\r\n` in note fields, so a
  // round trip may come back in the other convention. That is the same note
  // written the same way — and if it did not match, every retry would file
  // another copy forever.
  const client = od();
  client.writeRoutes = { '/procedurelogs/GroupNote': { ok: true, status: 200, data: {} } };
  const app = await bootHygApp({ od: client });
  try {
    const staged = await stagedVisit(app, ['note']);
    const noteText = app.db.hyg_staged_write[0].payload.text;
    client.routes['/procedurelogs/GroupNotes'] = [
      { ProcNum: 41202, ProcDate: DATE, Note: noteText.replace(/\n/g, '\r\n'), procCode: '~GRP~' },
    ];

    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirmAll(staged, ['note']) },
    });

    assert.equal(res.body.outcomes[0].state, 'Written');
    assert.equal(noteWrites(client), 0, 'and it was recognised BEFORE writing, not after');
    assert.match(res.body.outcomes[0].writtenRef, /GroupNote 41202 .*already on the chart/);
  } finally {
    await app.close();
  }
});

test('an unreadable pre-check refuses rather than risking a duplicate', async () => {
  // Fail closed. A write we could not have confirmed, and whose retry could not
  // have deduped, is exactly the write that produced the duplicate. Declining
  // costs a retry; making it costs a permanent row in a patient's chart.
  const client = od();
  client.routes['/procedurelogs/GroupNotes'] = {
    ok: false,
    status: 503,
    data: null,
    error: 'upstream timeout',
  };
  client.writeRoutes = { '/procedurelogs/GroupNote': groupNoteThatLands(client) };
  const app = await bootHygApp({ od: client });
  try {
    const staged = await stagedVisit(app, ['note']);
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirmAll(staged, ['note']) },
    });

    assert.equal(res.body.outcomes[0].state, 'Failed');
    assert.equal(res.body.outcomes[0].code, 'NOTE_PRECHECK_UNAVAILABLE');
    assert.equal(noteWrites(client), 0, 'NOTHING was written');
  } finally {
    await app.close();
  }
});

test('an appointment with no procedures refuses honestly instead of inventing one', async () => {
  const client = od({ procedures: [] });
  client.writeRoutes = { '/procedurelogs/GroupNote': groupNoteThatLands(client) };
  const app = await bootHygApp({ od: client });
  try {
    const staged = await stagedVisit(app, ['note']);
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirmAll(staged, ['note']) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.outcomes[0].state, 'Failed');
    assert.equal(res.body.outcomes[0].code, 'NO_PROCEDURES');
    assert.match(res.body.outcomes[0].errorMessage, /no procedures in Open Dental/);
    // NOT ONE WRITE. Creating a procedure so the note has somewhere to live
    // would be this module inventing clinical data for its own workflow.
    assert.deepEqual(client.writes, []);
  } finally {
    await app.close();
  }
});

test('the slip is filed with a DocCategory resolved BY NAME, and never a hardcoded one', async () => {
  const client = od();
  client.writeRoutes = { '/documents/Upload': { ok: true, status: 200, data: { DocNum: 4711 } } };
  const app = await bootHygApp({ od: client });
  try {
    const staged = await stagedVisit(app, ['router']);
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirmAll(staged, ['router']) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.outcomes[0].state, 'Written');
    assert.match(res.body.outcomes[0].writtenRef, /Document 4711 in Routers/);

    const upload = client.writes.find((w) => w[2] === '/documents/Upload')[3];
    // ALWAYS SENT. H0: omitting DocCategory files the document into the first
    // category, and a slip nobody looks at is worse than a failed upload.
    assert.equal(upload.DocCategory, 473, 'the DefNum the NAME resolved to');
    assert.equal(upload.PatNum, 12827);
    assert.equal(upload.extension, '.pdf');
    assert.ok(upload.rawBase64.length > 100);
    assert.equal(
      Buffer.from(upload.rawBase64, 'base64').subarray(0, 5).toString(),
      '%PDF-',
      'a real PDF, not a base64 of something else'
    );

    // The definitions read asked for Category 18, Open Dental's image categories.
    const defs = client.calls.find((c) => c.path === '/definitions');
    assert.equal(defs.params.Category, 18);
  } finally {
    await app.close();
  }
});

test('two offices resolve the SAME category name to DIFFERENT DefNums', async () => {
  // H0 found 473 and 429 for the same name across the two practices. A constant
  // would file a document into whatever that number means at the other office.
  const seen = {};
  for (const [office, defs] of [
    ['roland', [{ DefNum: 473, ItemName: 'Routers' }]],
    ['valley', [{ DefNum: 429, ItemName: 'Routers' }]],
  ]) {
    const client = od({ definitions: defs });
    client.writeRoutes = { '/documents/Upload': { ok: true, status: 200, data: { DocNum: 900 } } };
    const app = await bootHygApp({ od: client, hygOffices: ['roland', 'valley'] });
    const q = `?office=${office}&date=${DATE}`;
    try {
      await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + q);
      await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + q, { body: CROWN });
      const st = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + q, {
        body: { kind: 'router' },
      });
      await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + q, {
        body: { confirm: confirmAll(st.body, ['router']) },
      });
      seen[office] = client.writes.find((w) => w[2] === '/documents/Upload')[3].DocCategory;
    } finally {
      await app.close();
    }
  }
  assert.deepEqual(seen, { roland: 473, valley: 429 });
});

test('an office with no category of that name refuses, and files nothing', async () => {
  const client = od({ definitions: [{ DefNum: 401, ItemName: 'ODHQ' }] });
  client.writeRoutes = { '/documents/Upload': { ok: true, status: 200, data: { DocNum: 1 } } };
  const app = await bootHygApp({ od: client });
  try {
    const staged = await stagedVisit(app, ['router']);
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirmAll(staged, ['router']) },
    });
    assert.equal(res.body.outcomes[0].state, 'Failed');
    assert.equal(res.body.outcomes[0].code, 'DOC_CATEGORY_NOT_FOUND');
    // The message names the fix rather than the failure.
    assert.match(res.body.outcomes[0].errorMessage, /HYG_SLIP_DOC_CATEGORY_ROLAND/);
    assert.deepEqual(client.writes, [], 'nothing was filed anywhere');
  } finally {
    await app.close();
  }
});

test('THE PREVIEW IS THE WRITE: a payload that changed refuses the whole send', async () => {
  const client = od();
  client.writeRoutes = {
    '/procedurelogs/GroupNote': groupNoteThatLands(client),
    '/documents/Upload': { ok: true, status: 200, data: { DocNum: 4711 } },
  };
  const app = await bootHygApp({ od: client });
  try {
    const staged = await stagedVisit(app, ['note', 'router']);
    const confirm = confirmAll(staged, ['note', 'router']);

    // Between the preview and the confirm, the visit changes and the note is
    // re-staged — a second tab, a second device, or her own edit.
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, {
      body: { ...CROWN, teeth: [14], code: 'Comp' },
    });
    const restaged = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
      body: { kind: 'note' },
    });
    assert.equal(restaged.status, 201);

    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'PREVIEW_CHANGED');
    assert.match(res.body.error, /changed since you read it. Nothing was sent/);

    // THE WHOLE BATCH, not just the changed one. The router's preview is still
    // current, and it did not go either — a send that half-honours a stale
    // preview is worse than one that does not start.
    assert.deepEqual(client.writes, []);
    for (const w of app.db.hyg_staged_write) assert.equal(w.state, 'Staged');
  } finally {
    await app.close();
  }
});

test('partial success: the note lands and the slip fails, and each says so', async () => {
  const client = od();
  client.writeRoutes = {
    '/procedurelogs/GroupNote': groupNoteThatLands(client),
    '/documents/Upload': { ok: false, status: 500, data: null, error: 'storage full' },
  };
  const app = await bootHygApp({ od: client });
  try {
    const staged = await stagedVisit(app, ['note', 'router']);
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirmAll(staged, ['note', 'router']) },
    });

    // 200: the REQUEST succeeded and reports what happened. A visit is never
    // "sent" — its individual writes are.
    assert.equal(res.status, 200);
    assert.equal(res.body.written, 1);
    assert.equal(res.body.failed, 1);

    const byKind = Object.fromEntries(res.body.outcomes.map((o) => [o.kind, o]));
    assert.equal(byKind.note.state, 'Written');
    assert.equal(byKind.router.state, 'Failed');
    assert.match(byKind.router.errorMessage, /storage full/);
    assert.equal(byKind.note.errorMessage, null);

    // The note first: it is the record that the visit happened.
    assert.deepEqual(
      res.body.outcomes.map((o) => o.kind),
      ['note', 'router']
    );
  } finally {
    await app.close();
  }
});

test('a failed write can be retried with the SAME words, not re-composed ones', async () => {
  const client = od();
  client.writeRoutes = {
    '/documents/Upload': { ok: false, status: 500, data: null, error: 'storage full' },
  };
  const app = await bootHygApp({ od: client });
  try {
    const staged = await stagedVisit(app, ['router']);
    const preview = staged.visit.stagedWrites[0].preview;

    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirmAll(staged, ['router']) },
    });
    assert.equal(app.db.hyg_staged_write[0].state, 'Failed');

    const retried = await api(
      app.baseUrl,
      'POST',
      '/api/hyg/visit/900001/staged-writes/router/retry' + Q
    );
    assert.equal(retried.status, 200);
    const back = retried.body.visit.stagedWrites[0];
    assert.equal(back.state, 'Staged');
    assert.equal(back.errorMessage, null);
    // THE SAME WORDS. A retry that re-composed would send something she never
    // read, which is the rule this slice is built around.
    assert.deepEqual(back.preview, preview);

    // And a retry on something that did not fail is refused.
    const again = await api(
      app.baseUrl,
      'POST',
      '/api/hyg/visit/900001/staged-writes/router/retry' + Q
    );
    assert.equal(again.status, 409);
  } finally {
    await app.close();
  }
});

test('the treatment handoff goes through TC’s own intake, and records the case', async () => {
  const client = od();
  const submitted = [];
  const app = await bootHygApp({
    od: client,
    tcSubmit: async (_req, { office, body }) => {
      submitted.push({ office, body });
      return { ok: true, caseId: '8f3c1d20-0000-4000-8000-000000000001' };
    },
  });
  try {
    const staged = await stagedVisit(app, ['tc-handoff']);
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirmAll(staged, ['tc-handoff']) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.outcomes[0].state, 'Written');
    assert.match(res.body.outcomes[0].writtenRef, /^Case 8f3c1d20/);

    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].office, 'roland');
    const body = submitted[0].body;
    assert.equal(body.odPatientId, 12827);
    // deriveCategory said Restorative; TC's nearest category is single_tooth.
    assert.equal(body.category, 'single_tooth');
    // The crown is urgent, so the case is high urgency and flagged.
    assert.equal(body.urgency, 'high');
    assert.equal(body.flagUrgent, true);
    assert.match(body.suspectedTreatment, /#3 Crown \(urgent\)/);
    // Not asked anywhere in this module.
    assert.equal(body.patientInterestLevel, 'unknown');
    assert.equal(body.intraoralPhotosTaken, false);
    // And no Open Dental write happened for a TC handoff.
    assert.deepEqual(client.writes, []);
  } finally {
    await app.close();
  }
});

test('a TC refusal is the handoff failing, not the send crashing', async () => {
  const app = await bootHygApp({
    od: od(),
    tcSubmit: async () => ({ ok: false, code: 'TC_FORBIDDEN', error: 'MODULE_NOT_ENTITLED' }),
  });
  try {
    const staged = await stagedVisit(app, ['tc-handoff']);
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirmAll(staged, ['tc-handoff']) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.outcomes[0].state, 'Failed');
    assert.equal(res.body.outcomes[0].code, 'TC_FORBIDDEN');
    assert.equal(app.db.hyg_staged_write[0].state, 'Failed');
    assert.equal(app.db.hyg_staged_write[0].sent_by, null);
  } finally {
    await app.close();
  }
});

test('NOTHING IS GATED ON COMPLETENESS — an unanswered slip goes into the chart', async () => {
  const client = od();
  client.writeRoutes = {
    '/procedurelogs/GroupNote': groupNoteThatLands(client),
    '/documents/Upload': { ok: true, status: 200, data: { DocNum: 4711 } },
  };
  const app = await bootHygApp({ od: client });
  try {
    // Everything the prototype gated on is unanswered: no recare, no TX
    // entered, and records the crown needs that nobody has taken.
    const staged = await stagedVisit(app, ['note', 'router']);
    assert.equal(staged.visit.slip.recareScheduled, null);
    assert.equal(staged.visit.slip.txEnteredInOd, null);
    assert.ok(staged.recordsNeeded.length > 0);

    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirmAll(staged, ['note', 'router']) },
    });
    assert.equal(res.body.written, 2, 'both writes landed with nothing answered');
    assert.equal(res.body.failed, 0);
  } finally {
    await app.close();
  }
});

test('the office is asserted before any write, and an office that is off sends nothing', async () => {
  const client = od();
  client.writeRoutes = { '/documents/Upload': { ok: true, status: 200, data: { DocNum: 1 } } };
  const app = await bootHygApp({ od: client, hygOffices: ['roland'] });
  try {
    const staged = await stagedVisit(app, ['router']);

    // The same visit, asked for as an office whose hygiene switch is off.
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/hyg/visit/900001/send?office=valley&date=${DATE}`,
      { body: { confirm: confirmAll(staged, ['router']) } }
    );
    // The OFFICE's own refusal, not "no such visit". An office CareIN is not
    // talking to must hear why, and the readiness gate runs before this route
    // says anything about whether a visit exists.
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'OFFICE_NOT_READY');
    assert.equal(res.body.reason, 'OFFICE_HYG_NOT_ENABLED');
    assert.deepEqual(client.writes, []);
  } finally {
    await app.close();
  }
});

test('every write is audited with the approving user, success or failure', async () => {
  const client = od();
  client.writeRoutes = {
    '/procedurelogs/GroupNote': groupNoteThatLands(client),
    '/documents/Upload': { ok: false, status: 500, data: null, error: 'nope' },
  };
  const app = await bootHygApp({ od: client });
  try {
    const staged = await stagedVisit(app, ['note', 'router']);
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: confirmAll(staged, ['note', 'router']) },
    });

    const sends = app.db.audit.filter((r) => r.resource_type === 'hyg_visit_send');
    assert.equal(sends.length, 2, 'one row per write, not one per request');
    assert.deepEqual(sends.map((r) => r.result).sort(), ['ERROR', 'SUCCESS']);
    for (const row of sends) {
      assert.equal(row.action, 'UPDATE');
      assert.equal(row.office, 'roland');
      assert.equal(row.resource_id, '900001');
    }
  } finally {
    await app.close();
  }
});

test('a body that names a payload, a state or a kind that is not staged is refused', async () => {
  const app = await bootHygApp({ od: od() });
  try {
    const staged = await stagedVisit(app, ['note']);
    const good = confirmAll(staged, ['note']);

    // A payload on the wire. There is no route in this module that accepts one.
    const withPayload = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: good, payload: { text: 'anything I like' } },
    });
    assert.equal(withPayload.status, 400);
    assert.equal(withPayload.body.code, 'INVALID_BODY');

    // A kind that is not staged.
    const notStaged = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: [{ kind: 'router', previewFingerprint: 'whatever' }] },
    });
    assert.equal(notStaged.status, 409);
    assert.equal(notStaged.body.code, 'NOT_STAGED');

    // An empty confirmation list.
    const empty = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm: [] },
    });
    assert.equal(empty.status, 400);
  } finally {
    await app.close();
  }
});

test('sending twice does not write twice', async () => {
  const client = od();
  client.writeRoutes = { '/procedurelogs/GroupNote': groupNoteThatLands(client) };
  const app = await bootHygApp({ od: client });
  try {
    const staged = await stagedVisit(app, ['note']);
    const confirm = confirmAll(staged, ['note']);

    const first = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm },
    });
    assert.equal(first.body.written, 1);

    // The same confirmation again. The row is Written, so it is not staged.
    const second = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, {
      body: { confirm },
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'NOT_STAGED');
    assert.equal(
      client.writes.filter((w) => w[2] === '/procedurelogs/GroupNote').length,
      1,
      'exactly one GroupNote reached Open Dental'
    );
  } finally {
    await app.close();
  }
});
