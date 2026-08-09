/**
 * Store-level twin linking (slice M7).
 *
 * The pure rule is covered in callTwins.test.js. This file covers the part that actually
 * has to hold in production: that links get WRITTEN on both rows, that they survive the
 * re-ingest which erases anything not on normalizeCall's whitelist, that they are found
 * whichever leg arrives first, and that the backlog — the twins already sitting in the
 * store before this slice existed — gets linked too.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;

const unifiedCallStore = require('./unifiedCallStore');
const { ROLE_PRIMARY, ROLE_DUPLICATE, ROLE_TRANSFERRED } = require('./callTwins');

let originalRequestPersist;
let originalWarn;
let warnings;

beforeEach(() => {
  originalRequestPersist = unifiedCallStore.requestPersist;
  unifiedCallStore.requestPersist = () => {};
  unifiedCallStore.clear();
  // Capture console.warn so the tripwire's message can be asserted rather than assumed.
  originalWarn = console.warn;
  warnings = [];
  console.warn = (...args) => { warnings.push(args.join(' ')); };
});

afterEach(() => {
  unifiedCallStore.requestPersist = originalRequestPersist;
  console.warn = originalWarn;
});

const T0 = Date.parse('2026-08-01T15:00:00.000Z');
const iso = (offsetSeconds) => new Date(T0 + offsetSeconds * 1000).toISOString();

/** A Mango leg as mangoNormalize would produce it. */
const mangoCall = (over = {}) => ({
  external_id: 'mango_call_555001',
  source: 'mango',
  mango_call_id: '555001',
  caller_number: '(918) 555-0142',
  called_number: '(918) 555-6262',
  direction: 'inbound',
  outcome: 'missed',
  call_date: iso(0),
  duration_seconds: 244,
  handler_type: 'staff',
  ...over,
});

/** A Retell leg as the webhook / poller delivers it. */
const retellCall = (over = {}) => ({
  call_id: 'call_abc',
  agent_id: 'agent_d1f762efc57db01475ad0579e8',
  from_number: '+19185550142',
  to_number: '+14795550001',
  call_date: iso(7),
  duration_seconds: 237,
  disconnection_reason: 'user_hangup',
  ...over,
});

const getMango = () => unifiedCallStore.getCall('mango_call_555001');
const getRetell = () => unifiedCallStore.getCall('call_abc');

test('links both rows when the Retell leg arrives after its Mango leg', () => {
  unifiedCallStore.addMangoCalls([mangoCall()]);
  assert.equal(getMango().link_role, null, 'nothing to link to yet');

  unifiedCallStore.addRetellCall(retellCall());

  assert.equal(getMango().link_role, ROLE_DUPLICATE);
  assert.equal(getMango().linked_call_id, 'call_abc');
  assert.equal(getRetell().link_role, ROLE_PRIMARY);
  assert.equal(getRetell().linked_call_id, 'mango_call_555001');
});

test('links both rows when the Mango leg arrives after its Retell leg', () => {
  // The hourly Mango sync runs long after the AI call was webhooked in, so this is the
  // ordering that actually dominates in production.
  unifiedCallStore.addRetellCall(retellCall());
  unifiedCallStore.addMangoCalls([mangoCall()]);

  assert.equal(getMango().link_role, ROLE_DUPLICATE);
  assert.equal(getMango().linked_call_id, 'call_abc');
  assert.equal(getRetell().linked_call_id, 'mango_call_555001');
});

test('BACKLOG: relinkAllTwins links pairs that were already in the store', () => {
  // Simulate a store loaded from disk with twins in it and no links — i.e. every twin on
  // prod the moment this slice ships. addCallInternal is the load path.
  unifiedCallStore.addCallInternal({ ...mangoCall(), id: 'mango_call_555001' }, false);
  unifiedCallStore.addCallInternal({
    ...retellCall(), id: 'call_abc', source: 'retell', caller_number: '+19185550142',
  }, false);
  assert.equal(getMango().link_role, null);

  const result = unifiedCallStore.relinkAllTwins();

  assert.equal(result.linked, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.transferred, 0);
  assert.equal(getMango().link_role, ROLE_DUPLICATE);
  assert.equal(getRetell().link_role, ROLE_PRIMARY);
});

test('relinkAllTwins is idempotent — a second pass writes nothing new', () => {
  unifiedCallStore.addMangoCalls([mangoCall()]);
  unifiedCallStore.addRetellCall(retellCall());

  const again = unifiedCallStore.relinkAllTwins();
  assert.equal(again.linked, 0, 'already-linked rows are not re-written');
  assert.equal(again.duplicates, 1, 'but they are still counted');
});

test('the link SURVIVES a Mango re-ingest (normalizeCall whitelist)', () => {
  // The hourly sync re-walks a watermark overlap and re-ingests the same call. Anything
  // not on normalizeCall's whitelist is erased by that — which is how transcribed_at was
  // lost before M4. Prove the link is not.
  unifiedCallStore.addMangoCalls([mangoCall()]);
  unifiedCallStore.addRetellCall(retellCall());
  assert.equal(getMango().link_role, ROLE_DUPLICATE);

  unifiedCallStore.addMangoCalls([mangoCall()]); // same external_id → upsert path

  assert.equal(getMango().link_role, ROLE_DUPLICATE, 're-ingest must not un-hide the row');
  assert.equal(getMango().linked_call_id, 'call_abc');
});

test('the link and the disconnect reason SURVIVE a Retell re-add', () => {
  // A Retell call is re-added on call_started → call_ended → call_analyzed and then every
  // 15-minute poll. Only ONE of those payloads carries disconnection_reason.
  unifiedCallStore.addMangoCalls([mangoCall()]);
  unifiedCallStore.addRetellCall(retellCall());

  // A later event with no reason and no link on it at all.
  unifiedCallStore.addRetellCall({ call_id: 'call_abc', from_number: '+19185550142' });

  assert.equal(getRetell().disconnection_reason, 'user_hangup');
  assert.equal(getRetell().link_role, ROLE_PRIMARY);
  assert.equal(getRetell().linked_call_id, 'mango_call_555001');
  assert.equal(getMango().link_role, ROLE_DUPLICATE);
});

test('a transferred call marks its Mango leg transferred_leg, NOT duplicate', () => {
  // The Mango leg then holds the human half of the conversation, which the AI transcript
  // does not — so it must not be treated as duplication.
  unifiedCallStore.addMangoCalls([mangoCall()]);
  unifiedCallStore.addRetellCall(retellCall({ disconnection_reason: 'call_transfer' }));

  assert.equal(getMango().link_role, ROLE_TRANSFERRED);
  assert.equal(getMango().linked_call_id, 'call_abc');
});

test('a late-arriving transfer reason RE-ROLES an already-linked duplicate leg', () => {
  // call_ended can land after the leg was linked off an earlier event. The role has to
  // follow the facts, or a transferred call stays hidden.
  unifiedCallStore.addMangoCalls([mangoCall()]);
  unifiedCallStore.addRetellCall(retellCall({ disconnection_reason: null }));
  assert.equal(getMango().link_role, ROLE_DUPLICATE);

  unifiedCallStore.addRetellCall(retellCall({ disconnection_reason: 'agent_transfer' }));

  assert.equal(getMango().link_role, ROLE_TRANSFERRED, 'the row comes back into the worklist');
});

test('TRIPWIRE: a transfer is counted once per CALL, not per re-add', () => {
  unifiedCallStore.addRetellCall(retellCall({ disconnection_reason: 'call_transfer' }));
  assert.equal(unifiedCallStore.stats.transferDisconnects, 1);

  // The poller re-adds the same call every 15 minutes. That must not inflate the counter.
  unifiedCallStore.addRetellCall(retellCall({ disconnection_reason: 'call_transfer' }));
  unifiedCallStore.addRetellCall(retellCall({ disconnection_reason: 'call_transfer' }));
  assert.equal(unifiedCallStore.stats.transferDisconnects, 1);

  // A genuinely different transferred call does count.
  unifiedCallStore.addRetellCall(retellCall({ call_id: 'call_def', disconnection_reason: 'agent_transfer' }));
  assert.equal(unifiedCallStore.stats.transferDisconnects, 2);
});

test('TRIPWIRE: warns loudly, and stays silent when no transfer happens', () => {
  unifiedCallStore.addRetellCall(retellCall());
  assert.equal(warnings.length, 0, 'an AI-completed call is not noteworthy');
  assert.equal(unifiedCallStore.stats.transferDisconnects, 0);

  unifiedCallStore.addRetellCall(retellCall({ call_id: 'call_xfer', disconnection_reason: 'call_transfer' }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /TRIPWIRE/);
  assert.match(warnings[0], /transferred this call to a human/);
});

test('a redial is never linked, so it stays in the worklist', () => {
  // The 43-same-caller-pairs-within-60s population. Linking one of these would hide a
  // real call the front desk has to return.
  unifiedCallStore.addRetellCall(retellCall());
  unifiedCallStore.addMangoCalls([
    mangoCall(),
    mangoCall({ external_id: 'mango_call_555002', call_date: iso(300), duration_seconds: 30 }),
  ]);

  assert.equal(getMango().link_role, ROLE_DUPLICATE, 'the real twin is linked');
  const redial = unifiedCallStore.getCall('mango_call_555002');
  assert.equal(redial.link_role, null, 'the redial is NOT');
  assert.equal(redial.linked_call_id, null);
});

test('an ambiguous match links nothing and says so', () => {
  unifiedCallStore.addMangoCalls([mangoCall()]);
  unifiedCallStore.addRetellCall(retellCall({ call_id: 'call_one' }));
  // A second Retell row with identical timings — impossible in practice, which is why the
  // guard has never fired, but it must fail safe rather than pick one.
  unifiedCallStore.addRetellCall(retellCall({ call_id: 'call_two' }));

  assert.equal(getMango().link_role, null, 'nothing linked');
  assert.equal(getMango().linked_call_id, null);
  // The link written while call_one looked unique is DROPPED, not left standing: a leg we
  // can no longer attribute confidently must come back into the worklist, not stay hidden
  // behind a link we can't defend.
  assert.equal(unifiedCallStore.getCall('call_one').linked_call_id, null);
  assert.equal(unifiedCallStore.getCall('call_one').link_role, null);
  assert.ok(warnings.some((w) => /Ambiguous twin/.test(w)));
});

test('getStats surfaces the twin counts and the tripwire', () => {
  unifiedCallStore.addMangoCalls([mangoCall()]);
  unifiedCallStore.addRetellCall(retellCall());

  const stats = unifiedCallStore.getStats();
  assert.equal(stats.twins.duplicateLegs, 1);
  assert.equal(stats.twins.transferredLegs, 0);
  assert.equal(stats.twins.transferDisconnects, 0);
});
