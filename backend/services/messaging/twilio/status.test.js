'use strict';

/** Twilio status → ours, and the monotonic ladder (queue item 39). */

const assert = require('node:assert/strict');
const test = require('node:test');

const contract = require('../../../tc/contract.gen.cjs');
const { RANK, mapStatus, mapCreateStatus, replaceableBy, errorText } = require('./status');

test('every Twilio outbound status maps onto the item-38 vocabulary', () => {
  const expected = {
    accepted: 'queued',
    scheduled: 'queued',
    queued: 'queued',
    sending: 'queued',
    sent: 'sent',
    delivered: 'delivered',
    read: 'delivered',
    undelivered: 'failed',
    failed: 'failed',
    canceled: 'failed',
  };
  for (const [twilio, ours] of Object.entries(expected)) {
    assert.equal(mapStatus(twilio), ours, twilio);
    assert.ok(contract.MessageStatus.options.includes(ours));
  }
  assert.equal(mapStatus('DELIVERED'), 'delivered', 'case-insensitive');
});

test('inbound / unknown statuses are ignored, never guessed', () => {
  for (const s of ['received', 'receiving', 'partially_delivered', '', null, undefined, 42]) {
    assert.equal(mapStatus(s), null, String(s));
  }
});

test("Twilio's own `sending` is OUR queued, never our `sending` (that one belongs to the in-flight click)", () => {
  assert.equal(mapStatus('sending'), 'queued');
  assert.ok(!Object.keys(RANK).includes('sending'));
});

test('create-message answers: only a hand-off counts', () => {
  assert.equal(mapCreateStatus('accepted'), 'queued');
  assert.equal(mapCreateStatus('queued'), 'queued');
  assert.equal(mapCreateStatus('sent'), 'sent');
  assert.equal(mapCreateStatus('failed'), null);
  assert.equal(mapCreateStatus('delivered'), null);
  assert.equal(mapCreateStatus('nonsense'), null);
});

test('the ladder: queued < sent < failed < delivered', () => {
  assert.deepEqual(replaceableBy('queued'), []);
  assert.deepEqual(replaceableBy('sent'), ['queued']);
  assert.deepEqual(replaceableBy('failed').sort(), ['queued', 'sent']);
  assert.deepEqual(replaceableBy('delivered').sort(), ['failed', 'queued', 'sent']);
});

test('nothing replaces delivered; a draft/sending/received row is never replaceable', () => {
  for (const s of ['queued', 'sent', 'failed', 'delivered']) {
    const r = replaceableBy(/** @type {any} */ (s));
    assert.ok(!r.includes('delivered'), s);
    for (const untouchable of ['draft', 'sending', 'received']) assert.ok(!r.includes(untouchable), `${s}/${untouchable}`);
  }
});

test('error text: known code explained, unknown code still shown, never PHI-shaped input echoed', () => {
  assert.equal(errorText('30007', 'undelivered'), 'Not delivered (Twilio error 30007: the carrier filtered the message as possible spam).');
  assert.equal(errorText('39999', 'failed'), 'Not delivered (Twilio error 39999).');
  assert.equal(errorText(null, 'failed'), 'Not delivered (Twilio reported "failed").');
  // A code field that is not a short number is not echoed at all.
  assert.equal(errorText('+1 (479) 555-0101', 'failed'), 'Not delivered (Twilio reported "failed").');
  assert.equal(errorText('14795550101', 'failed'), 'Not delivered (Twilio reported "failed").');
});
