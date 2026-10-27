'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { isAgentDeadAir, classifyDeadAir } = require('./agentDeadAir');

// Synthetic fixtures only — no real caller words, names or numbers.
const turn = (role, content) => ({ role, speaker: null, content, start: null, end: null });
const call = (overrides) => ({
  source: 'retell',
  direction: 'inbound',
  disconnection_reason: 'inactivity',
  transcript_json: [
    turn('agent', 'Thanks for calling, how can I help?'),
    turn('user', 'I need to move my appointment.'),
  ],
  ...overrides,
});

test('(a) inactivity, caller spoke last → flagged', () => {
  assert.equal(isAgentDeadAir(call({})), true);
});

test('(b) inactivity, agent spoke last → not flagged (caller abandonment)', () => {
  const c = call({
    transcript_json: [
      turn('agent', 'Thanks for calling, how can I help?'),
      turn('user', 'I need to move my appointment.'),
      turn('agent', 'Which appointment would you like to move?'),
    ],
  });
  assert.equal(isAgentDeadAir(c), false);
  assert.equal(classifyDeadAir(c), 'agent_spoke_last');
});

test('(c) user_hangup → not flagged', () => {
  assert.equal(isAgentDeadAir(call({ disconnection_reason: 'user_hangup' })), false);
});

test('(d) missing transcript → not flagged, reported as no_transcript', () => {
  for (const transcript_json of [undefined, null, [], 'not an array']) {
    const c = call({ transcript_json });
    assert.equal(isAgentDeadAir(c), false);
    assert.equal(classifyDeadAir(c), 'no_transcript');
  }
});

test('(e) empty agent turn after the caller → still flagged', () => {
  const c = call({
    transcript_json: [
      turn('agent', 'Thanks for calling, how can I help?'),
      turn('user', 'I need to move my appointment.'),
      turn('agent', ''),
      turn('agent', '   '),
    ],
  });
  assert.equal(isAgentDeadAir(c), true);
});

test('(f) caller spoke, then an agent "[No spoken response]" placeholder → flagged', () => {
  const c = call({
    transcript_json: [
      turn('agent', 'Thanks for calling, how can I help?'),
      turn('user', 'I need to move my appointment.'),
      turn('agent', '[No spoken response]'),
    ],
  });
  assert.equal(classifyDeadAir(c), 'dead_air');
});

test('(g) caller spoke, then an agent "[Silence]" placeholder → flagged', () => {
  const c = call({
    transcript_json: [
      turn('agent', 'Thanks for calling, how can I help?'),
      turn('user', 'I need to move my appointment.'),
      turn('agent', '  [Silence]  '),
    ],
  });
  assert.equal(classifyDeadAir(c), 'dead_air');
});

test('(h) an agent turn with real words that merely contains brackets still counts', () => {
  const c = call({
    transcript_json: [
      turn('agent', 'Thanks for calling, how can I help?'),
      turn('user', 'I need to move my appointment.'),
      turn('agent', "Sure [pause] what's your name?"),
    ],
  });
  assert.equal(classifyDeadAir(c), 'agent_spoke_last');
});

test('(i) a caller "[inaudible]" as the last turn is NOT discounted → flagged', () => {
  const c = call({
    transcript_json: [
      turn('agent', 'Thanks for calling, how can I help?'),
      turn('user', '[inaudible]'),
    ],
  });
  assert.equal(classifyDeadAir(c), 'dead_air');
});

test('a transcript that is only an agent placeholder counts as missing, not as the agent speaking', () => {
  assert.equal(classifyDeadAir(call({ transcript_json: [turn('agent', '[No spoken response]')] })), 'no_transcript');
});

test('outbound and unknown direction are never flagged', () => {
  assert.equal(classifyDeadAir(call({ direction: 'outbound' })), 'not_inbound');
  assert.equal(classifyDeadAir(call({ direction: null })), 'not_inbound');
});

test('a transcript with only empty turns counts as missing', () => {
  assert.equal(classifyDeadAir(call({ transcript_json: [turn('user', ''), turn('agent', ' ')] })), 'no_transcript');
});

test('a diarized turn with no established role is not treated as the caller', () => {
  assert.equal(isAgentDeadAir(call({ transcript_json: [turn(null, 'Hello?')] })), false);
});

test('null / undefined call → not flagged', () => {
  assert.equal(isAgentDeadAir(null), false);
  assert.equal(isAgentDeadAir(undefined), false);
});
