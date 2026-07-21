'use strict';

// Unit tests for the call summary analyzer (M2): prompt routing by source + the
// regex fallback when no BAA-covered LLM provider is configured.
// Runner: `node --test`.

const test = require('node:test');
const assert = require('node:assert/strict');

const callAnalyzer = require('./callAnalyzer');

test('human-call prompt (Mango) is staff-oriented and shares the standard schema', () => {
  const human = callAnalyzer.buildHumanCallPrompt(
    'Staff: Front desk. Caller: I need to move my cleaning.',
    { caller_number: '+15551230000' }
  );
  // Framed as a staff-answered call, not an AI-agent call.
  assert.match(human, /STAFF/);
  // Same output schema fields the downstream worklist/commlog rely on.
  for (const field of ['caller_name', 'call_reason', 'sentiment', 'is_emergency', 'summary', 'appointment_requested', 'callback_needed', 'key_details']) {
    assert.ok(human.includes(field), `human prompt should ask for "${field}"`);
  }
});

test('AI-agent prompt (Retell) differs from the human-call prompt but keeps the schema', () => {
  const agent = callAnalyzer.buildAnalysisPrompt('Agent: hello. User: hi', { caller_number: '+15551230000' });
  assert.doesNotMatch(agent, /front-desk STAFF member answered/i);
  for (const field of ['caller_name', 'call_reason', 'sentiment', 'is_emergency', 'summary', 'appointment_requested', 'callback_needed']) {
    assert.ok(agent.includes(field), `agent prompt should ask for "${field}"`);
  }
});

test('with no LLM provider configured, a Mango call falls back to regex analysis (no throw)', async () => {
  // Ensure nothing is configured in this test env.
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_DEPLOYMENT;
  delete process.env.ALLOW_OPENAI_DIRECT;
  // Reset the singleton's memoized init so it re-evaluates the (empty) env.
  callAnalyzer.isInitialized = false;
  callAnalyzer.client = null;

  const call = {
    source: 'mango',
    caller_number: '+15551230000',
    transcript: 'Staff: How can I help? Caller: I have severe tooth pain and swelling, this is an emergency.',
  };
  const analysis = await callAnalyzer.analyzeCall(call);
  assert.ok(analysis && typeof analysis === 'object');
  // Regex fallback still detects the emergency keywords.
  assert.equal(analysis.is_emergency, true);
  assert.ok('summary' in analysis && 'callback_needed' in analysis);
});
