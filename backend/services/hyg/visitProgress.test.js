'use strict';

/**
 * The day-card pill, as a table. Every overall state and every step mapping is
 * a row here, so a change to the vocabulary is a change to this file.
 *
 * The rows to read hardest are the HONEST-STATE ones: nothing becomes `written`
 * except a staged write in `Written`, and a perio send or a checkout alert can
 * never promote a step to it.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { deriveVisitProgress, parseAptNums, stepFromStaged } = require('./visitProgress');

/** A visit row as progressStore.js hands it over. */
function visit(over = {}) {
  return {
    checkoutSentAt: null,
    checkoutFinalAt: null,
    treatmentItemCount: 0,
    stagedWrites: [],
    latestPerioSendState: null,
    ...over,
  };
}

const w = (kind, state, hasError = false) => ({ kind, state, hasError });

test('staged-write state → step state', () => {
  const table = [
    [undefined, 'none'],
    [{ state: 'Draft' }, 'drafting'],
    [{ state: 'Amending' }, 'drafting'],
    [{ state: 'Staged' }, 'ready'],
    [{ state: 'Sending' }, 'sending'],
    [{ state: 'Written' }, 'written'],
    [{ state: 'Failed', hasError: true }, 'failed'],
    // A reason on a non-written row is a failure, whatever the state says.
    [{ state: 'Staged', hasError: true }, 'failed'],
    // A state nobody taught this file is surfaced, never guessed friendly.
    [{ state: 'Teleported' }, 'failed'],
  ];
  for (const [row, expected] of table) {
    assert.equal(stepFromStaged(row), expected, JSON.stringify(row));
  }
});

test('overall: every state, one row each', () => {
  const table = [
    {
      name: 'no hyg_visit row → not_started, and no steps claimed',
      input: null,
      overall: 'not_started',
    },
    {
      name: 'visit opened, nothing staged → in_progress',
      input: visit(),
      overall: 'in_progress',
      steps: { note: 'none', slip: 'none', perio: 'not_applicable', tc: 'not_applicable' },
    },
    {
      name: 'any failed → needs_attention, even beside written ones',
      input: visit({ stagedWrites: [w('note', 'Written'), w('router', 'Failed', true)] }),
      overall: 'needs_attention',
    },
    {
      name: 'failed beats ready',
      input: visit({ stagedWrites: [w('note', 'Staged'), w('router', 'Staged'), w('perio', 'Failed', true)] }),
      overall: 'needs_attention',
    },
    {
      name: 'every applicable step written (perio + tc n/a) → sent',
      input: visit({ stagedWrites: [w('note', 'Written'), w('router', 'Written')] }),
      overall: 'sent',
      steps: { note: 'written', slip: 'written', perio: 'not_applicable', tc: 'not_applicable' },
    },
    {
      name: 'all four written → sent',
      input: visit({
        treatmentItemCount: 2,
        stagedWrites: [
          w('note', 'Written'),
          w('router', 'Written'),
          w('perio', 'Written'),
          w('tc-handoff', 'Written'),
        ],
        latestPerioSendState: 'written',
      }),
      overall: 'sent',
    },
    {
      name: 'treatment on the visit but no handoff staged → tc none, not sent',
      input: visit({
        treatmentItemCount: 1,
        stagedWrites: [w('note', 'Written'), w('router', 'Written')],
      }),
      overall: 'in_progress',
      steps: { note: 'written', slip: 'written', perio: 'not_applicable', tc: 'none' },
    },
    {
      name: 'ready and nothing drafting/sending → ready_to_send',
      input: visit({ stagedWrites: [w('note', 'Staged'), w('router', 'Written')] }),
      overall: 'ready_to_send',
    },
    {
      name: 'ready beside a step not yet started is still ready_to_send',
      input: visit({ stagedWrites: [w('note', 'Staged')] }),
      overall: 'ready_to_send',
    },
    {
      name: 'ready but perio still drafting → in_progress',
      input: visit({ stagedWrites: [w('note', 'Staged'), w('router', 'Staged'), w('perio', 'Draft')] }),
      overall: 'in_progress',
    },
    {
      name: 'ready but one sending → in_progress',
      input: visit({ stagedWrites: [w('note', 'Sending'), w('router', 'Staged')] }),
      overall: 'in_progress',
    },
    {
      name: 'perio Amending is drafting, not written',
      input: visit({ stagedWrites: [w('note', 'Written'), w('router', 'Written'), w('perio', 'Amending')] }),
      overall: 'in_progress',
      steps: { note: 'written', slip: 'written', perio: 'drafting', tc: 'not_applicable' },
    },
  ];

  for (const row of table) {
    const got = deriveVisitProgress(row.input);
    assert.equal(got.overall, row.overall, row.name);
    if (row.input === null) assert.equal(got.steps, null, row.name);
    if (row.steps) {
      assert.deepEqual(
        {
          note: got.steps.note.state,
          slip: got.steps.slip.state,
          perio: got.steps.perio.state,
          tc: got.steps.tc.state,
        },
        row.steps,
        row.name
      );
    }
  }
});

test('perio: an in-flight send reads sending; a send can never make perio written', () => {
  const inFlight = deriveVisitProgress(
    visit({ stagedWrites: [w('perio', 'Staged')], latestPerioSendState: 'filling' })
  );
  assert.equal(inFlight.steps.perio.state, 'sending');

  const posting = deriveVisitProgress(
    visit({ stagedWrites: [w('perio', 'Sending')], latestPerioSendState: 'posting' })
  );
  assert.equal(posting.steps.perio.state, 'sending');

  // HONEST STATES: a `written` send row on a staged chart that is not Written
  // is not read-back evidence the visit can claim. Stays what the row says.
  const notPromoted = deriveVisitProgress(
    visit({ stagedWrites: [w('perio', 'Staged')], latestPerioSendState: 'written' })
  );
  assert.equal(notPromoted.steps.perio.state, 'ready');

  // A restaged chart after an incomplete send is ready again — the retry is
  // the hygienist's, and the old send's failure is history.
  const restaged = deriveVisitProgress(
    visit({ stagedWrites: [w('perio', 'Staged')], latestPerioSendState: 'incomplete' })
  );
  assert.equal(restaged.steps.perio.state, 'ready');

  // A send row with no staged chart is not a perio step.
  const orphan = deriveVisitProgress(visit({ latestPerioSendState: 'written' }));
  assert.equal(orphan.steps.perio.state, 'not_applicable');
});

test('tc: checkout alerted is reported beside the state, and only until Written', () => {
  const at = new Date('2026-09-08T15:00:00Z');

  const alerted = deriveVisitProgress(
    visit({ treatmentItemCount: 1, stagedWrites: [w('tc-handoff', 'Staged')], checkoutSentAt: at })
  );
  assert.equal(alerted.steps.tc.state, 'ready');
  assert.equal(alerted.steps.tc.checkoutAlerted, true);
  assert.equal(alerted.steps.tc.checkoutFinal, false);

  // A checkout alert on a no-treatment visit: tc is n/a, the alert still shows.
  const noTx = deriveVisitProgress(visit({ checkoutSentAt: at, checkoutFinalAt: at }));
  assert.equal(noTx.steps.tc.state, 'not_applicable');
  assert.equal(noTx.steps.tc.checkoutAlerted, true);
  assert.equal(noTx.steps.tc.checkoutFinal, true);

  // Written handoff: the alert is history.
  const written = deriveVisitProgress(
    visit({ treatmentItemCount: 1, stagedWrites: [w('tc-handoff', 'Written')], checkoutSentAt: at })
  );
  assert.equal(written.steps.tc.checkoutAlerted, false);

  // The alert NEVER stands in for a failure.
  const failed = deriveVisitProgress(
    visit({ treatmentItemCount: 1, stagedWrites: [w('tc-handoff', 'Failed', true)], checkoutSentAt: at })
  );
  assert.equal(failed.steps.tc.state, 'failed');
  assert.equal(failed.overall, 'needs_attention');

  // And it never counts as written toward `sent`.
  const notSent = deriveVisitProgress(
    visit({
      treatmentItemCount: 1,
      stagedWrites: [w('note', 'Written'), w('router', 'Written')],
      checkoutSentAt: at,
    })
  );
  assert.equal(notSent.overall, 'in_progress');
});

test('parseAptNums: positive ints, deduped, capped at 200', () => {
  assert.deepEqual(parseAptNums('100,200, 100 ,300'), { ok: true, aptNums: [100, 200, 300] });
  assert.deepEqual(parseAptNums('7'), { ok: true, aptNums: [7] });

  for (const bad of [undefined, '', ' ', '0', '-4', '1.5', '1e3', '0x10', 'abc', '1,,2', '1,', '01', ['1']]) {
    assert.equal(parseAptNums(bad).ok, false, JSON.stringify(bad));
  }
  // Beyond MAX_SAFE_INTEGER is refused rather than rounded into someone else's AptNum.
  assert.equal(parseAptNums('99999999999999999').ok, false);

  const twoHundred = Array.from({ length: 200 }, (_, i) => i + 1).join(',');
  assert.equal(parseAptNums(twoHundred).ok, true);
  assert.equal(parseAptNums(twoHundred + ',201').ok, false);
  // The cap is on DISTINCT AptNums: 200 plus duplicates is fine.
  assert.equal(parseAptNums(twoHundred + ',1,2,3').ok, true);
});
