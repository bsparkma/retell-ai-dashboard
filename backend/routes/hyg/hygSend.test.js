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

/** The GroupNote write, succeeding, with the note echoed back on the reads. */
function groupNoteThatLands(client) {
  return (body) => {
    // The read-back path: after the write, /procedurelogs carries the note.
    client.routes['/procedurelogs'] = [
      { ProcNum: 5001, Note: body.Note },
      { ProcNum: 5002, Note: body.Note },
    ];
    return { ok: true, status: 200, data: { Note: body.Note } };
  };
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
    assert.match(res.body.outcomes[0].writtenRef, /GroupNote on 2 procedures \(5001, 5002\)/);

    // THE PAYLOAD OPEN DENTAL SAW.
    const write = client.writes.find((w) => w[2] === '/procedurelogs/GroupNote');
    assert.ok(write, 'the GroupNote write was made');
    const body = write[3];
    assert.equal(body.isSigned, false, 'CareIN never claims a signature');
    assert.equal(body.ProcNums, '5001,5002');
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
  // The write returns 200 and the read-back does not contain the note. "We
  // think it worked" and "the chart contains this" are different claims.
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
    assert.match(res.body.outcomes[0].errorMessage, /read it back|not on the appointment/);
    assert.equal(res.body.visit.stagedWrites[0].sentAt, null, 'a failed send is not a send');
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
