'use strict';

/**
 * A payment the page never stated must stay "not stated" ON THE WIRE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE REGRESSION THIS PINS (found 2026-09-30, the night #206 reached prod)
 * ─────────────────────────────────────────────────────────────────────────────
 * #206 made per-line `paidCents` nullable end to end through extraction and
 * storage: a category-subtotal EOB stores NULL for every line whose payment is
 * printed only at a benefit-type subtotal, instead of the line's COVERED amount.
 * That half worked. But `toLineWire` still coerced the column with `num()`,
 * whose contract is "null is 0" — so every stored NULL left the server as
 * `paidCents: 0`, the client's stale `number` type hid it from tsc, and
 * `money(0)` printed **$0.00** on every such line of the claim screen and the
 * check screen.
 *
 * $0.00 is not a blank. It asserts "the plan paid nothing for this line", which
 * is exactly the class of invented figure #206 existed to remove — the first
 * real nine-page scanned check rendered a column of fabricated zeros within
 * three hours of the deploy, and read as "the extraction got worse".
 *
 * The derived remainder has the same obligation: R = allowed − paid is not a
 * number when paid was never stated, and shipping R = allowed invites a
 * write-off decision over a figure nobody read. The subtraction itself stays in
 * services/rcm/lineDecisions.js — the wire only withholds it when its input is
 * absent.
 *
 * A STATED ZERO IS NOT NULL. `paid_cents = 0` means the plan paid nothing and
 * must survive as 0 with a real remainder — collapsing the two is the opposite
 * failure, and both directions are pinned here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { toLineWire } = require('./matchService');

/** A stored rcm_procedure_lines row, as pg hands it back (bigints as strings). */
function storedLine(overrides = {}) {
  return {
    line_id: 'line-1',
    position: 0,
    billed_code: 'D2750',
    paid_code: null,
    code: 'D2750',
    description: 'Crown',
    billed_cents: '100000',
    allowed_cents: '80000',
    deductible_cents: '0',
    copay_cents: '0',
    paid_cents: '50000',
    adjustment_cents: '20000',
    patient_resp_cents: '0',
    write_off_cents: '20000',
    adjustment_reason: null,
    is_downcoded: false,
    is_bundled: false,
    is_denied: false,
    flags: [],
    od_claim_proc_num: null,
    line_decision: null,
    decision_reason: null,
    decided_by: null,
    decided_at: null,
    ...overrides,
  };
}

test('an unstated per-line payment ships as null, never as $0.00', () => {
  const wire = toLineWire(storedLine({ paid_cents: null }), []);
  assert.equal(wire.paidCents, null, 'NULL paid_cents must reach the client as null, not 0');
});

test('an unstated payment withholds the derived remainder too', () => {
  const wire = toLineWire(storedLine({ paid_cents: null }), []);
  assert.equal(
    wire.patientRemainderCents,
    null,
    'R = allowed − paid is not a number when paid was never stated; shipping allowed − 0 ' +
      'invites a decision over a figure nobody read'
  );
  // W = billed − allowed involves no payment and is still the carrier's figure.
  assert.equal(wire.contractualWriteOffCents, 20000);
});

test('a stated payment still ships as the stated number with a real remainder', () => {
  const wire = toLineWire(storedLine({ paid_cents: '50000' }), []);
  assert.equal(wire.paidCents, 50000);
  assert.equal(wire.patientRemainderCents, 30000);
  assert.equal(wire.contractualWriteOffCents, 20000);
});

test('a stated ZERO is a payment of zero, not an unstated figure', () => {
  // "The plan paid nothing" and "the page does not say" are different facts
  // about a patient's balance — the whole reason intOrNull exists upstream.
  // BOTH shapes pg can hand back: an integer column arrives as the NUMBER 0,
  // a bigint as the STRING '0'. A falsiness test (`!paid_cents`) collapses the
  // number and not the string, which is why both are pinned — that exact
  // mutant survived the string case alone.
  for (const zero of ['0', 0]) {
    const wire = toLineWire(storedLine({ paid_cents: zero }), []);
    assert.equal(wire.paidCents, 0, `stated zero (${JSON.stringify(zero)}) must stay 0`);
    assert.equal(wire.patientRemainderCents, 80000);
  }
});
