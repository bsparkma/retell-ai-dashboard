'use strict';

// Regression tests for the "Send transcript to chart" shape bug (prod, 2026-08-08).
//
// THE BUG: every transcript line in the chart note read
//     [] 👤 Caller: undefined
// while the summary lines in the same note were fine.
//
// ROOT CAUSE: two transcription paths persist `transcript_json` in two different
// shapes, and the commlog formatter only understood one of them.
//
//   Retell / legacy  -> { role: 'agent'|'user', content: '...' }
//   M4 on-demand     -> { speaker: 0, text: '...', start, end, confidence }
//                       (services/transcriptionService.js — Azure Speech phrases)
//
// The formatter read .role / .timestamp / .content, so against the M4 shape all
// three were undefined: no role -> the 'Caller' fallback, no timestamp -> `[]`,
// no content -> the literal string "undefined".
//
// What is pinned here: a transcript from EITHER path renders real text, no shape
// ever renders the string "undefined", and an empty or missing transcript writes
// nothing rather than a wall of undefineds or a bare section header.
//
// No PHI: every line below is invented staging dialogue.

const test = require('node:test');
const assert = require('node:assert/strict');

const sync = require('./openDentalSync');
const { normalizeTranscriptJson } = require('../utils/transcriptShape');

// --- the four shapes, exactly as each producer writes them -----------------

/** services/transcriptionService.js — the M4 on-demand / Azure Speech utterance. */
const M4_UTTERANCES = [
  { speaker: 0, text: 'Front desk, how can I help you?', start: 0, end: 2.1, confidence: 0.94 },
  { speaker: 1, text: 'I need to move my cleaning to next week.', start: 2.4, end: 5.0, confidence: 0.91 },
];

/** services/transcriptionService.js — the word-level fallback (`utterances || words`). */
const M4_WORDS = [
  { word: 'Front', start: 0, end: 0.3, confidence: 0.9, speaker: 0 },
  { word: 'desk', start: 0.3, end: 0.6, confidence: 0.9, speaker: 0 },
];

/** Retell's transcript_object, stored via normalizeCall's transcript_object alias. */
const RETELL_OBJECT = [
  { role: 'agent', content: 'Thanks for calling, how can I help?' },
  { role: 'user', content: 'I would like to book a cleaning.' },
];

/** What the store holds once normalizeTranscriptJson has run. */
const CANONICAL = normalizeTranscriptJson(M4_UTTERANCES);

const ALL_SHAPES = [
  ['M4 on-demand utterances', M4_UTTERANCES],
  ['M4 word-level fallback', M4_WORDS],
  ['legacy Retell transcript_object', RETELL_OBJECT],
  ['canonical (already normalized)', CANONICAL],
];

// --- the formatter --------------------------------------------------------

test('every stored shape renders real text, never the string "undefined"', () => {
  for (const [label, shape] of ALL_SHAPES) {
    const out = sync.formatTranscriptForCommLog('fallback text', shape);
    assert.ok(!/undefined/.test(out), `${label} rendered "undefined": ${JSON.stringify(out)}`);
    assert.ok(out.trim().length > 0, `${label} rendered nothing`);
  }
});

test('the M4 on-demand transcript renders its actual words (the reported bug)', () => {
  const out = sync.formatTranscriptForCommLog('', M4_UTTERANCES);
  assert.match(out, /Front desk, how can I help you\?/);
  assert.match(out, /I need to move my cleaning to next week\./);
  assert.ok(!/undefined/.test(out));
});

test('the legacy Retell transcript still labels agent vs caller', () => {
  const out = sync.formatTranscriptForCommLog('', RETELL_OBJECT);
  assert.match(out, /Agent: Thanks for calling, how can I help\?/);
  assert.match(out, /Caller: I would like to book a cleaning\./);
});

test('a diarized transcript says "Speaker N" rather than inventing agent-vs-caller', () => {
  // Azure diarization gives a speaker INDEX, not a role. Calling speaker 0 "Agent"
  // would be a guess printed into a patient's chart as if it were known.
  const out = sync.formatTranscriptForCommLog('', M4_UTTERANCES);
  assert.match(out, /Speaker 1:/);
  assert.match(out, /Speaker 2:/);
  assert.ok(!/Agent:/.test(out), 'must not claim a role diarization did not establish');
});

test('no stray empty "[]" when a line has no timing', () => {
  // The legacy path never had timestamps, so EVERY line has been written with a
  // leading "[] " since this formatter shipped. Cosmetic, but it is noise in a
  // chart note and it is what made the broken lines read as "[] ... undefined".
  const out = sync.formatTranscriptForCommLog('', RETELL_OBJECT);
  assert.ok(!/\[\]/.test(out), `stray empty brackets: ${JSON.stringify(out)}`);
});

test('timing is shown when the shape actually carries it', () => {
  const out = sync.formatTranscriptForCommLog('', M4_UTTERANCES);
  assert.match(out, /\[0:00\]/);
  assert.match(out, /\[0:02\]/);
});

test('an empty transcript array renders nothing, not a wall of undefineds', () => {
  assert.equal(sync.formatTranscriptForCommLog('', []).trim(), '');
});

test('entries with no usable text are skipped rather than printed blank', () => {
  const out = sync.formatTranscriptForCommLog('', [
    { speaker: 0, text: '', start: 0 },
    { speaker: 1, text: 'Only this line has words.', start: 1 },
    { role: 'agent', content: '   ' },
    null,
    'not an object at all',
  ]);
  assert.match(out, /Only this line has words\./);
  assert.ok(!/undefined/.test(out));
  assert.equal(out.split('\n').filter((l) => l.trim()).length, 1);
});

test('a missing transcript_json falls back to the plain-text transcript', () => {
  assert.equal(sync.formatTranscriptForCommLog('plain text transcript', null), 'plain text transcript');
  assert.equal(sync.formatTranscriptForCommLog('plain text transcript', undefined), 'plain text transcript');
});

test('no transcript at all is reported honestly', () => {
  assert.equal(sync.formatTranscriptForCommLog(null, null), 'Transcript not available');
});

// --- the whole chart note -------------------------------------------------

/** The call record as the store holds it, for a full formatCommLogEntry pass. */
function callWith(transcriptJson, transcript = 'Front desk, how can I help you? I need to move my cleaning.') {
  return {
    id: 'call_fixture',
    source: 'mango',
    call_date: '2026-08-07T19:30:00.000Z',
    caller_name: 'Stedi TestValley',
    call_reason: 'Reschedule a cleaning',
    transcript,
    transcript_json: transcriptJson,
  };
}

test('the chart note carries a real transcript from EITHER path', () => {
  for (const [label, shape] of ALL_SHAPES) {
    const note = sync.formatCommLogEntry(callWith(shape), { contentType: 'transcript' }).Note;
    assert.match(note, /--- Full transcript ---/, `${label} lost the transcript section`);
    assert.ok(!/undefined/.test(note), `${label} wrote "undefined" into the chart: ${note}`);
    // The summary block above it is unaffected either way.
    assert.match(note, /Caller: Stedi TestValley/);
    assert.match(note, /Reason: Reschedule a cleaning/);
  }
});

test('an empty transcript_json writes no bare "Full transcript" header', () => {
  // The string transcript is non-empty (so the note is not the no-content stub),
  // but the structured transcript has nothing in it. Writing the header with
  // nothing under it reads like the note was truncated.
  const note = sync.formatCommLogEntry(callWith([]), { contentType: 'transcript' }).Note;
  assert.ok(!/--- Full transcript ---\s*$/.test(note), 'bare section header with nothing under it');
  assert.ok(!/undefined/.test(note));
});

test('the summary path is untouched by transcript shape', () => {
  // "Send summary" never reads transcript_json — pinning that, because the bug
  // report noted the summary lines rendered fine and that must stay true.
  for (const [, shape] of ALL_SHAPES) {
    const note = sync.formatCommLogEntry(callWith(shape), { contentType: 'summary' }).Note;
    assert.ok(!/--- Full transcript ---/.test(note));
    assert.ok(!/undefined/.test(note));
    assert.match(note, /Caller: Stedi TestValley/);
  }
});

// --- the canonical shape --------------------------------------------------

test('normalizeTranscriptJson converts every producer shape to one canonical shape', () => {
  const fromM4 = normalizeTranscriptJson(M4_UTTERANCES);
  assert.deepEqual(fromM4[0], {
    role: null, speaker: 0, content: 'Front desk, how can I help you?', start: 0, end: 2.1,
  });

  const fromRetell = normalizeTranscriptJson(RETELL_OBJECT);
  assert.deepEqual(fromRetell[0], {
    role: 'agent', speaker: null, content: 'Thanks for calling, how can I help?', start: null, end: null,
  });

  const fromWords = normalizeTranscriptJson(M4_WORDS);
  assert.equal(fromWords[0].content, 'Front');
  assert.equal(fromWords[0].speaker, 0);
});

test('normalizeTranscriptJson is idempotent — re-ingest cannot degrade a stored transcript', () => {
  // normalizeCall runs on every re-ingest inside the watermark overlap, so this
  // runs against already-canonical data constantly.
  const once = normalizeTranscriptJson(M4_UTTERANCES);
  const twice = normalizeTranscriptJson(once);
  assert.deepEqual(twice, once);
  assert.deepEqual(normalizeTranscriptJson(twice), once);
});

test('normalizeTranscriptJson drops unusable entries and keeps null as null', () => {
  assert.equal(normalizeTranscriptJson(null), null);
  assert.equal(normalizeTranscriptJson(undefined), null);
  assert.equal(normalizeTranscriptJson('a string'), null);
  assert.deepEqual(normalizeTranscriptJson([]), []);
  assert.deepEqual(normalizeTranscriptJson([null, { text: '' }, 'x']), []);
});

test("normalizeTranscriptJson maps Retell's 'user' role to the caller, not to an agent", () => {
  const out = normalizeTranscriptJson([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
  assert.equal(out[0].role, 'user');
  assert.equal(out[1].role, 'agent', "Retell's 'assistant' is the agent");
});

// --- the store holds ONE shape, whoever wrote it --------------------------

const unifiedCallStore = require('./unifiedCallStore');

/** Every stored entry is canonical: has `content`, and no producer-specific key. */
function assertCanonical(entries, label) {
  assert.ok(Array.isArray(entries), `${label}: transcript_json is not an array`);
  for (const e of entries) {
    assert.equal(typeof e.content, 'string', `${label}: entry has no canonical content`);
    assert.ok(!('text' in e), `${label}: producer key 'text' leaked into the store`);
    assert.ok(!('word' in e), `${label}: producer key 'word' leaked into the store`);
    assert.deepEqual(
      Object.keys(e).sort(),
      ['content', 'end', 'role', 'speaker', 'start'],
      `${label}: entry is not the canonical shape`,
    );
  }
}

test('the store normalizes an M4 on-demand transcript to the canonical shape', () => {
  const originalPersist = unifiedCallStore.requestPersist;
  unifiedCallStore.requestPersist = () => {};
  try {
    unifiedCallStore.calls.clear();
    // What onDemandTranscription used to hand straight through to the store.
    const [stored] = unifiedCallStore.addMangoCalls([{
      source: 'mango',
      external_id: 'mango_call_shape_m4',
      call_date: '2026-08-07T15:00:00.000Z',
      caller_number: '+14795551414',
      transcript: 'Front desk, how can I help you?',
      transcript_json: M4_UTTERANCES,
    }]);
    assertCanonical(stored.transcript_json, 'M4');
    assert.equal(stored.transcript_json[0].content, 'Front desk, how can I help you?');
    assert.equal(stored.transcript_json[0].speaker, 0);
    assert.equal(stored.transcript_json[0].role, null);
  } finally {
    unifiedCallStore.requestPersist = originalPersist;
    unifiedCallStore.calls.clear();
  }
});

test('the store normalizes a Retell transcript_object to the SAME canonical shape', () => {
  const originalPersist = unifiedCallStore.requestPersist;
  unifiedCallStore.requestPersist = () => {};
  try {
    unifiedCallStore.calls.clear();
    const stored = unifiedCallStore.addRetellCall({
      call_id: 'call_shape_retell',
      from_number: '+14795551515',
      start_timestamp: '2026-08-07T15:00:00.000Z',
      transcript_object: RETELL_OBJECT,
    });
    assertCanonical(stored.transcript_json, 'Retell');
    assert.equal(stored.transcript_json[0].role, 'agent');
    assert.equal(stored.transcript_json[0].content, 'Thanks for calling, how can I help?');
  } finally {
    unifiedCallStore.requestPersist = originalPersist;
    unifiedCallStore.calls.clear();
  }
});

test('a re-ingest heals a row stored in the old M4 shape (the prod backlog)', () => {
  // Rows transcribed before this fix are still in the store in Azure's shape.
  // normalizeCall runs on every re-ingest inside the watermark overlap, so those
  // rows converge on the canonical shape without a migration.
  const originalPersist = unifiedCallStore.requestPersist;
  unifiedCallStore.requestPersist = () => {};
  try {
    unifiedCallStore.calls.clear();
    const raw = {
      source: 'mango',
      external_id: 'mango_call_legacy_shape',
      call_date: '2026-08-07T15:00:00.000Z',
      caller_number: '+14795551414',
      transcript: 'Front desk, how can I help you?',
    };
    const [added] = unifiedCallStore.addMangoCalls([raw]);
    // Simulate the pre-fix row: the raw producer shape written straight in.
    unifiedCallStore.calls.set(added.id, { ...added, transcript_json: M4_UTTERANCES });
    assert.equal(unifiedCallStore.getCall(added.id).transcript_json[0].text, 'Front desk, how can I help you?');

    unifiedCallStore.addMangoCalls([raw]); // the next hourly re-ingest
    const healed = unifiedCallStore.getCall(added.id);
    assertCanonical(healed.transcript_json, 'healed');

    // And the chart note is correct for it.
    const note = sync.formatCommLogEntry(
      { ...healed, caller_name: 'Stedi TestValley', call_reason: 'Reschedule' },
      { contentType: 'transcript' },
    ).Note;
    assert.ok(!/undefined/.test(note));
    assert.match(note, /Front desk, how can I help you\?/);
  } finally {
    unifiedCallStore.requestPersist = originalPersist;
    unifiedCallStore.calls.clear();
  }
});
