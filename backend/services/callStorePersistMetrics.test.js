'use strict';

/**
 * persist() instrumentation.
 *
 * This is the measurement the retention slice exists to move. persist()
 * synchronously stringifies the ENTIRE store and writes it to an AzureFile
 * mount, and its duration is the prime suspect behind the chronic >5s
 * readiness-probe timeouts on ca-carein-prod-backend. Without a number in the
 * logs, "the store is smaller now, so the probe should be happier" is a claim
 * rather than evidence.
 *
 * The FORMAT is asserted, not just the presence of a log: the prod runbook greps
 * for `[callstore] persist ok` and parses ms= and bytes= out of Log Analytics.
 * Renaming the prefix silently breaks the before/after comparison.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const store = require('./unifiedCallStore');

let tmpDir;
let originalPersistPath;
let originalTempPath;
let originalRequestPersist;
let originalLog;
let logLines;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'callstore-metrics-'));
  originalPersistPath = store.persistPath;
  originalTempPath = store.tempPath;
  originalRequestPersist = store.requestPersist;
  originalLog = console.log;
  logLines = [];
  store.persistPath = path.join(tmpDir, 'unified_calls.json');
  store.tempPath = `${store.persistPath}.tmp`;
  store.requestPersist = () => {};
  console.log = (...args) => { logLines.push(args.join(' ')); };
  store.clear();
});

afterEach(async () => {
  console.log = originalLog;
  store.persistPath = originalPersistPath;
  store.tempPath = originalTempPath;
  store.requestPersist = originalRequestPersist;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('persist logs its duration, its byte size, and the record count', async () => {
  store.addCallInternal({
    id: 'mango_call_metric', external_id: 'mango_call_metric', source: 'mango',
    caller_number: '+15550100444', call_date: '2026-08-01T15:00:00.000Z',
  });
  store.isDirty = true;

  await store.persist();

  const line = logLines.find((l) => l.startsWith('[callstore] persist ok'));
  assert.ok(line, `expected a '[callstore] persist ok' line, got: ${JSON.stringify(logLines)}`);

  const match = line.match(/^\[callstore\] persist ok calls=(\d+) bytes=(\d+) ms=(\d+)$/);
  assert.ok(match, `unexpected format: ${line}`);
  assert.equal(match[1], '1');
  assert.ok(Number(match[2]) > 0, 'bytes must be the real serialized size');
});

test('the logged byte size tracks the store getting smaller', async () => {
  for (let i = 0; i < 5; i++) {
    store.addCallInternal({
      id: `mango_call_b${i}`, external_id: `mango_call_b${i}`, source: 'mango',
      caller_number: `+1555010055${i}`, call_date: '2026-08-01T15:00:00.000Z',
      summary: 'a synthetic summary that takes up room in the snapshot',
      transcript: 'Agent: hello\nUser: hi\n',
    });
  }
  store.isDirty = true;
  await store.persist();
  const before = Number(logLines.at(-1).match(/bytes=(\d+)/)[1]);

  logLines.length = 0;
  store.stubCalls(['mango_call_b0', 'mango_call_b1', 'mango_call_b2']);
  store.isDirty = true;
  await store.persist();
  const after = Number(logLines.find((l) => l.startsWith('[callstore] persist ok')).match(/bytes=(\d+)/)[1]);

  assert.ok(after < before, `pruning must shrink the snapshot (before=${before} after=${after})`);
});
