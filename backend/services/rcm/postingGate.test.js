'use strict';

/**
 * The shadow gate's reader — the half of the two conditions that lives in a row.
 *
 * The route tests prove what a refused press does. These prove what the reader
 * itself says, including the two answers that only exist because something has
 * gone wrong: a missing row, and a row whose boolean is not a boolean.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeRcmDb, seedOfficeSettings } = require('../../routes/rcm/rcmTestUtils');
const postingGate = require('./postingGate');

test('a seeded, untouched row reads OFF, with no change evidence', async () => {
  const db = seedOfficeSettings(new FakeRcmDb());
  const settings = await postingGate.readOfficeSettings(db, 'roland');
  assert.equal(settings.drainEnabled, false);
  assert.equal(settings.updatedAt, null);
  assert.equal(settings.updatedBy, null);
  assert.equal(settings.rowMissing, false, 'the row is there — it just says no');
});

test('a switched-on row reads ON', async () => {
  const db = seedOfficeSettings(new FakeRcmDb(), { roland: true });
  assert.equal(await postingGate.isDrainEnabled(db, 'roland'), true);
  assert.equal(
    await postingGate.isDrainEnabled(db, 'valley'),
    false,
    'and the other office is untouched — the switch is per practice'
  );
});

test('a MISSING row is OFF, and says so separately', async () => {
  /*
   * The migration seeds both offices, so this is either a database migrations
   * have not reached or a row somebody removed. Neither is a licence to write to
   * a chart: the only honest reading of "there is no record of anyone switching
   * this on" is that nobody did.
   */
  postingGate._resetForTests();
  const settings = await postingGate.readOfficeSettings(new FakeRcmDb(), 'roland');
  assert.equal(settings.drainEnabled, false);
  assert.equal(settings.rowMissing, true, 'the screen can send an admin to the migration');
});

test('a NULL that slipped past NOT NULL is still OFF', async () => {
  // `=== true`, not a truthy test. A column that somehow holds NULL is not a
  // licence to post either, and neither is the string 'false'.
  const db = new FakeRcmDb();
  db.seed('rcm_office_settings', [
    { office_id: 'roland', drain_enabled: null, drain_updated_at: null, drain_updated_by: null },
    { office_id: 'valley', drain_enabled: 'false', drain_updated_at: null, drain_updated_by: null },
  ]);
  assert.equal(await postingGate.isDrainEnabled(db, 'roland'), false);
  assert.equal(await postingGate.isDrainEnabled(db, 'valley'), false);
});

test('the missing-row warning is once per office, not once per press', async () => {
  /*
   * A shadow-mode practice presses Drain all day. A warning per press would
   * bury the one line that matters under a thousand copies of itself — and the
   * line matters, because a missing row means migrations did not run.
   */
  postingGate._resetForTests();
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => warned.push(String(args[0]));
  try {
    const db = new FakeRcmDb();
    for (let i = 0; i < 5; i++) await postingGate.readOfficeSettings(db, 'roland');
    await postingGate.readOfficeSettings(db, 'valley');
  } finally {
    console.warn = original;
  }
  assert.equal(warned.length, 2, `one per office, got: ${warned.join(' | ')}`);
  assert.match(warned[0], /roland/);
  assert.match(warned[0], /SWITCHED OFF/);
  assert.match(warned[1], /valley/);
});

test('the reader is a SELECT and nothing else — it cannot create the row it wants', async () => {
  /*
   * If the reader ever "helpfully" upserted a default row, a database whose
   * migrations had not run would come back SWITCHED ON by its own defaults —
   * the gate answering "yes" from a table it had just written itself. One
   * statement, and it is a SELECT.
   */
  const db = seedOfficeSettings(new FakeRcmDb());
  await postingGate.readOfficeSettings(db, 'roland');
  const statements = db.log.map((e) => e.sql);
  assert.equal(statements.length, 1, statements.join(' | '));
  assert.match(statements[0], /^SELECT .* FROM rcm_office_settings WHERE office_id = \$1 LIMIT 1$/);
  assert.deepEqual(db.log[0].params, ['roland']);
});

test('the office is a PARAMETER, never interpolated', async () => {
  // Same rule as every other query in this module. A settings lookup is the
  // last place that should be the exception.
  const db = seedOfficeSettings(new FakeRcmDb(), { roland: true });
  await postingGate.readOfficeSettings(db, 'valley');
  assert.ok(!db.log[0].sql.includes('valley'), 'the office name must not be in the SQL text');
});
