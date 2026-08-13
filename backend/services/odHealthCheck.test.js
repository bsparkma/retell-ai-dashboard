'use strict';

/**
 * Tests for the per-office Open Dental health check.
 *
 * The three things worth pinning, in order of what would hurt most if it broke:
 *
 *  1. OFFICE INDEPENDENCE. Roland going down must never mark Valley down. That
 *     is the whole reason this replaced a singleton loop.
 *  2. TRANSITION-ONLY LOGGING. N consecutive failures produce exactly ONE line;
 *     recovery produces exactly one; a steady office produces none. A monitor
 *     that logs every failure gets muted, and a muted monitor is not a monitor.
 *  3. HONEST UNKNOWN. An office that has never been probed must not read as up.
 *
 * `probeOffice` is stubbed throughout — no test here touches Open Dental. The
 * probe's own OD-facing surface is one method by design, precisely so the state
 * machine can be driven without a network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { OdHealthCheck, classifyFailure, extractProgramVersion } = require('./odHealthCheck');

/** Capture console output for a block, so "no lines while steady" is assertable. */
function captureLogs(fn) {
  const lines = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => lines.push(['log', a.join(' ')]);
  console.error = (...a) => lines.push(['error', a.join(' ')]);
  console.warn = (...a) => lines.push(['warn', a.join(' ')]);
  try {
    return { result: fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

/** As above, for an async block. */
async function captureLogsAsync(fn) {
  const lines = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => lines.push(['log', a.join(' ')]);
  console.error = (...a) => lines.push(['error', a.join(' ')]);
  console.warn = (...a) => lines.push(['warn', a.join(' ')]);
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    Object.assign(console, saved);
  }
}

/** Only the checker's own lines — the heartbeat and the transitions. */
const odhealthLines = (lines) => lines.filter(([, text]) => text.includes('[odhealth]'));

const OK = { ok: true, latencyMs: 12, version: '25.4.48.0', kind: null, detail: null };
const TIMEOUT = {
  ok: false,
  latencyMs: 10000,
  version: null,
  kind: 'timeout',
  detail: 'timeout of 10000ms exceeded',
};

/**
 * A checker wired to a scripted probe, with both offices present and a
 * heartbeat window far enough out that it never fires mid-test. The heartbeat
 * has its own test.
 *
 * @param {(officeKey: string) => object} script
 */
function makeChecker(script) {
  const checker = new OdHealthCheck();
  checker.officeKeys = () => ['roland', 'valley'];
  checker.getOfficeHealth = function (officeKey) {
    const existing = this.state.get(officeKey);
    if (existing) return existing;
    const fresh = Object.freeze({
      officeKey,
      officeName: officeKey,
      status: 'unknown',
      eligible: true,
      ineligibleReason: null,
      lastCheckedAt: null,
      lastOkAt: null,
      lastTransitionAt: null,
      consecutiveFailures: 0,
      lastFailureKind: null,
      lastFailureDetail: null,
      lastLatencyMs: null,
      probes: 0,
      serverVersion: null,
    });
    this.state.set(officeKey, fresh);
    return fresh;
  };
  checker.probeOffice = async (officeKey) => script(officeKey);
  // checkOffice re-reads eligibility from the real registry; in a unit test the
  // environment has no OD keys, so pin it to "configured" and let the tests be
  // about the state machine rather than about process.env.
  const realCheck = checker.checkOffice.bind(checker);
  checker.checkOffice = async (officeKey) => {
    const odOffices = require('../config/odOffices');
    const savedReady = odOffices.isOdReady;
    const savedBlock = odOffices.odBlockReason;
    odOffices.isOdReady = () => true;
    odOffices.odBlockReason = () => null;
    try {
      return await realCheck(officeKey);
    } finally {
      odOffices.isOdReady = savedReady;
      odOffices.odBlockReason = savedBlock;
    }
  };
  // Push the heartbeat out of the way unless a test wants it.
  checker.lastHeartbeatAt = Date.now();
  return checker;
}

// ---------------------------------------------------------------------------
// Honest unknown
// ---------------------------------------------------------------------------

test('an office that has never been probed reads unknown, not up', () => {
  const checker = makeChecker(() => OK);
  const snapshot = checker.snapshot();

  assert.equal(snapshot.length, 2);
  for (const office of snapshot) {
    assert.equal(office.status, 'unknown');
    assert.equal(office.lastCheckedAt, null);
    assert.equal(office.probes, 0);
  }
  // A checker that failed to start must be distinguishable from two healthy
  // offices — this is what makes that possible.
  assert.equal(checker.getStatus().running, false);
});

// ---------------------------------------------------------------------------
// Office independence
// ---------------------------------------------------------------------------

test('one office going down never marks the other', async () => {
  const checker = makeChecker((office) => (office === 'roland' ? TIMEOUT : OK));

  await checker.runCycle();
  await checker.runCycle(); // threshold is 2

  const byKey = Object.fromEntries(checker.snapshot().map((o) => [o.officeKey, o]));
  assert.equal(byKey.roland.status, 'down');
  assert.equal(byKey.roland.lastFailureKind, 'timeout');
  assert.equal(byKey.valley.status, 'up');
  assert.equal(byKey.valley.lastFailureKind, null);
  assert.equal(byKey.valley.serverVersion, '25.4.48.0');
});

test('a probe that throws for one office does not abort the cycle for the other', async () => {
  const checker = makeChecker((office) => {
    if (office === 'roland') throw new Error('probe blew up');
    return OK;
  });

  await checker.runCycle();

  const byKey = Object.fromEntries(checker.snapshot().map((o) => [o.officeKey, o]));
  assert.equal(byKey.valley.status, 'up', 'valley still got its verdict');
  assert.equal(byKey.roland.status, 'unknown', 'roland stayed honest rather than being called up');
});

// ---------------------------------------------------------------------------
// Transition-only logging
// ---------------------------------------------------------------------------

test('N consecutive failures produce exactly ONE down line, and none before the threshold', async () => {
  const checker = makeChecker(() => TIMEOUT);
  checker.officeKeys = () => ['roland'];

  const first = await captureLogsAsync(() => checker.runCycle());
  assert.deepEqual(odhealthLines(first.lines), [], 'one failure is not an outage — say nothing');
  assert.equal(checker.getOfficeHealth('roland').status, 'unknown');

  const second = await captureLogsAsync(() => checker.runCycle());
  const downLines = odhealthLines(second.lines);
  assert.equal(downLines.length, 1, 'crossing the threshold logs exactly one line');
  assert.match(downLines[0][1], /office=roland unknown→down after 2 consecutive failures \(timeout\)/);
  assert.equal(downLines[0][0], 'error');

  // Still down, five more cycles. This is the case that produced 899 emails the
  // last time an eConnector died, and the case that must stay silent.
  const steady = await captureLogsAsync(async () => {
    for (let i = 0; i < 5; i += 1) await checker.runCycle();
  });
  assert.deepEqual(odhealthLines(steady.lines), [], 'a down office logs nothing while it stays down');
  assert.equal(checker.getOfficeHealth('roland').consecutiveFailures, 7);
});

test('recovery produces exactly ONE line, carrying how long the office was down', async () => {
  let down = true;
  const checker = makeChecker(() => (down ? TIMEOUT : OK));
  checker.officeKeys = () => ['roland'];

  await captureLogsAsync(async () => {
    await checker.runCycle();
    await checker.runCycle();
  });
  assert.equal(checker.getOfficeHealth('roland').status, 'down');

  down = false;
  const recovery = await captureLogsAsync(() => checker.runCycle());
  const lines = odhealthLines(recovery.lines);
  assert.equal(lines.length, 1);
  assert.match(lines[0][1], /office=roland down→up after /);
  assert.equal(checker.getOfficeHealth('roland').status, 'up');
  assert.equal(checker.getOfficeHealth('roland').consecutiveFailures, 0);
});

test('a healthy office logs once on first contact and then goes quiet', async () => {
  const checker = makeChecker(() => OK);
  checker.officeKeys = () => ['roland'];

  const first = await captureLogsAsync(() => checker.runCycle());
  assert.equal(odhealthLines(first.lines).length, 1, 'unknown→up is a real transition and is worth one line');
  assert.match(odhealthLines(first.lines)[0][1], /unknown→up/);

  const steady = await captureLogsAsync(async () => {
    for (let i = 0; i < 10; i += 1) await checker.runCycle();
  });
  assert.deepEqual(odhealthLines(steady.lines), [], 'ten healthy cycles, no output');
  assert.equal(checker.getOfficeHealth('roland').probes, 11);
});

test('a single success is enough to call an office up; a single failure is not enough to call it down', async () => {
  let result = OK;
  const checker = makeChecker(() => result);
  checker.officeKeys = () => ['roland'];

  await checker.runCycle();
  assert.equal(checker.getOfficeHealth('roland').status, 'up');

  result = TIMEOUT;
  await checker.runCycle();
  assert.equal(checker.getOfficeHealth('roland').status, 'up', 'one blip is not an outage');
  assert.equal(checker.getOfficeHealth('roland').consecutiveFailures, 1);

  result = OK;
  await checker.runCycle();
  assert.equal(checker.getOfficeHealth('roland').status, 'up');
  assert.equal(checker.getOfficeHealth('roland').consecutiveFailures, 0);
});

test('the heartbeat fires at most once per window and covers every office in one line', () => {
  const checker = makeChecker(() => OK);
  checker.lastHeartbeatAt = 0;

  // Well past one 60-minute window from lastHeartbeatAt=0.
  const T0 = 10 * 60 * 60 * 1000;

  const first = captureLogs(() => checker.maybeHeartbeat(T0));
  assert.equal(first.result, true);
  assert.equal(odhealthLines(first.lines).length, 1);
  assert.match(odhealthLines(first.lines)[0][1], /heartbeat roland=unknown valley=unknown/);

  const tooSoon = captureLogs(() => checker.maybeHeartbeat(T0 + 60 * 1000));
  assert.equal(tooSoon.result, false, 'a minute later is not a new window');
  assert.deepEqual(odhealthLines(tooSoon.lines), []);

  const later = captureLogs(() => checker.maybeHeartbeat(T0 + 61 * 60 * 1000));
  assert.equal(later.result, true);
});

// ---------------------------------------------------------------------------
// No torn reads
// ---------------------------------------------------------------------------

test('state consulted mid-probe is a complete previous state, never a half-written one', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const checker = makeChecker(async () => { await gate; return TIMEOUT; });
  checker.officeKeys = () => ['roland'];

  const before = checker.getOfficeHealth('roland');

  const inFlight = checker.checkOffice('roland');
  // The probe is parked inside checkOffice. Read the state while it is running.
  const during = checker.getOfficeHealth('roland');
  assert.equal(during.status, before.status);
  assert.equal(during.lastCheckedAt, before.lastCheckedAt);
  assert.ok(Object.isFrozen(during), 'the state a caller holds cannot be mutated under it');

  release();
  await inFlight;

  const after = checker.getOfficeHealth('roland');
  assert.notEqual(after, during, 'the update replaced the object rather than editing it');
  assert.equal(during.probes, before.probes, 'the object the caller held did not change');
});

test('a second probe is not started for an office that already has one in flight', async () => {
  let probes = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const checker = makeChecker(async () => { probes += 1; await gate; return OK; });
  checker.officeKeys = () => ['roland'];

  const a = checker.checkOffice('roland');
  const b = checker.checkOffice('roland');
  release();
  await Promise.all([a, b]);

  assert.equal(probes, 1, 'a slow office never gets two probes stacked on it');
});

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

test('failures are classified honestly — the eConnector signature is a timeout, not a 500', () => {
  // A hung eConnector: no HTTP status, and the request burned its budget.
  assert.equal(classifyFailure({ status: 0, error: 'timeout of 10000ms exceeded' }, 10000, 10000), 'timeout');
  assert.equal(classifyFailure({ status: 0, error: 'socket hang up' }, 9600, 10000), 'timeout');
  // Fast socket failure — the server refused, it is not hung.
  assert.equal(classifyFailure({ status: 0, error: 'ECONNREFUSED' }, 40, 10000), 'network');
  // A configuration problem wearing status 0. Different person to wake up.
  assert.equal(
    classifyFailure({ status: 0, error: 'Open Dental cloud API is not configured' }, 1, 10000),
    'not_configured'
  );
  assert.equal(classifyFailure({ status: 401, error: 'bad key' }, 30, 10000), 'auth');
  assert.equal(classifyFailure({ status: 403, error: 'forbidden' }, 30, 10000), 'auth');
  assert.equal(classifyFailure({ status: 429, error: 'too many' }, 30, 10000), 'rate_limited');
  assert.equal(classifyFailure({ status: 502, error: 'bad gateway' }, 30, 10000), 'server_error');
  // The probe path or param changed under us — worth telling apart from an outage.
  assert.equal(classifyFailure({ status: 400, error: "not a valid parameter" }, 30, 10000), 'unexpected_response');
});

test('the OD server version is read when present and never fatal when absent', () => {
  assert.equal(extractProgramVersion([{ ValueString: '25.4.48.0' }]), '25.4.48.0');
  assert.equal(extractProgramVersion({ ValueString: '25.4.48.0' }), '25.4.48.0');
  assert.equal(extractProgramVersion([]), null);
  assert.equal(extractProgramVersion(null), null);
  assert.equal(extractProgramVersion('nope'), null);
  assert.equal(extractProgramVersion([{ ValueString: '   ' }]), null);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('start arms one timer, is idempotent, and stop clears it', async () => {
  const checker = makeChecker(() => OK);
  checker.officeKeys = () => ['roland'];

  await captureLogsAsync(async () => {
    assert.equal(checker.start(), true);
    assert.ok(checker.timer, 'a timer is armed');
    assert.equal(checker.start(), false, 'a second start does not arm a second timer');
    assert.equal(checker.getStatus().running, true);
    assert.ok(checker.getStatus().startedAt);

    checker.stop();
  });

  assert.equal(checker.timer, null);
  assert.equal(checker.getStatus().running, false);
  assert.equal(checker.getStatus().startedAt, null);

  // Stopping twice is safe — SIGTERM and SIGINT can both fire.
  checker.stop();
  assert.equal(checker.timer, null);
});

test('OD_HEALTH_CHECK_DISABLED=true refuses to arm anything', async () => {
  const checker = makeChecker(() => OK);
  const saved = process.env.OD_HEALTH_CHECK_DISABLED;
  process.env.OD_HEALTH_CHECK_DISABLED = 'true';
  try {
    const { result } = await captureLogsAsync(async () => checker.start());
    assert.equal(result, false);
    assert.equal(checker.timer, null);
    // And the status says WHY, rather than looking like a checker that crashed.
    assert.equal(checker.getStatus().enabled, false);
  } finally {
    if (saved === undefined) delete process.env.OD_HEALTH_CHECK_DISABLED;
    else process.env.OD_HEALTH_CHECK_DISABLED = saved;
  }
});

test('config falls back to its defaults rather than leaving the checker unscheduled', () => {
  const config = require('../config/odHealth');
  const saved = {
    interval: process.env.OD_HEALTH_INTERVAL_MINUTES,
    timeout: process.env.OD_HEALTH_TIMEOUT_MS,
    threshold: process.env.OD_HEALTH_FAILURE_THRESHOLD,
  };
  try {
    // Garbage, zero and negative all fall back. An interval of 0 would busy-loop
    // against a customer's practice-management server.
    for (const bad of ['banana', '0', '-5', '']) {
      process.env.OD_HEALTH_INTERVAL_MINUTES = bad;
      process.env.OD_HEALTH_TIMEOUT_MS = bad;
      process.env.OD_HEALTH_FAILURE_THRESHOLD = bad;
      assert.equal(config.intervalMinutes(), config.DEFAULT_INTERVAL_MINUTES, `interval for ${JSON.stringify(bad)}`);
      assert.equal(config.timeoutMs(), config.DEFAULT_TIMEOUT_MS);
      assert.equal(config.failureThreshold(), config.DEFAULT_FAILURE_THRESHOLD);
    }

    process.env.OD_HEALTH_INTERVAL_MINUTES = '10';
    assert.equal(config.intervalMinutes(), 10);
    process.env.OD_HEALTH_FAILURE_THRESHOLD = '3';
    assert.equal(config.failureThreshold(), 3);
  } finally {
    for (const [key, value] of Object.entries({
      OD_HEALTH_INTERVAL_MINUTES: saved.interval,
      OD_HEALTH_TIMEOUT_MS: saved.timeout,
      OD_HEALTH_FAILURE_THRESHOLD: saved.threshold,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('the probe is a read of one preference row — never a patient read', () => {
  const config = require('../config/odHealth');
  assert.equal(config.PROBE_PATH, '/preferences');
  assert.deepEqual({ ...config.PROBE_PARAMS }, { PrefName: 'ProgramVersion' });
  // A health probe that read a patient would owe an audit row on every cycle,
  // 288 times a day, per office. This one carries no PHI in either direction.
  assert.equal(/patient/i.test(config.PROBE_PATH), false);
});
