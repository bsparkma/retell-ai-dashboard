'use strict';

/**
 * WHAT §10.3's KILL TEST RESTS ON.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * `docs/RCM_POSTING.md` §10.3 — kill the container mid-drain, prove the resume
 * completes with exactly one check — has now missed three times, each for a
 * different reason:
 *
 *   2026-08-25  too fast    the drain took ~9 s; the restart landed after it
 *   2026-08-26  never ran   the walk stopped at the `od_patient_office` defect
 *   2026-08-28  too LATE    `revision restart` is a graceful replacement. The
 *                           new replica must be up before the old one is
 *                           retired, so SIGTERM did not arrive inside a paced
 *                           ~50 s drain and the run finished uninterrupted.
 *
 * The third one is the interesting one, because the obvious diagnosis is wrong.
 * The container did NOT survive because it ignores SIGTERM — **this app handles
 * SIGTERM and exits immediately**. It survived because SIGTERM never arrived
 * while the drain was running.
 *
 * That distinction is what the revised recipe rests on, so it is pinned here:
 *
 *   1. `process.on('SIGTERM')` exists and calls `process.exit`.
 *   2. It does NOT wait for in-flight HTTP requests — no `server.close()`, no
 *      connection drain. A held Drain request dies with the process.
 *   3. The pause hook accepts 90 000 ms, which is what makes the kill window
 *      wider than any replacement or grace period.
 *
 * IF SOMEBODY LATER MAKES THE SHUTDOWN GRACEFUL — closes the server, waits for
 * in-flight requests — that is a defensible change to make, and it silently
 * un-arms §10.3: the drain would then be ALLOWED to finish and the kill test
 * would start missing a fourth time for a fourth reason. This file is what makes
 * that a conversation instead of a surprise.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const postingDrain = require('../services/rcm/postingDrain');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

/** The body of the SIGTERM handler, as source. */
function sigtermHandler() {
  const at = SERVER_SRC.indexOf("process.on('SIGTERM'");
  assert.ok(at > -1, 'server.js must install a SIGTERM handler — §10.3 depends on it');
  // To the closing `});` of the handler. The next `process.on(` is SIGINT.
  const next = SERVER_SRC.indexOf('process.on(', at + 10);
  return SERVER_SRC.slice(at, next > -1 ? next : at + 2000);
}

// ─── 1. The signal really does kill this process ────────────────────────────

test('SIGTERM is handled, and the handler exits the process', () => {
  /*
   * Beau's hypothesis on the night was that the app might deliberately NOT
   * handle SIGTERM, which is what would make grace-period survival possible.
   * It is the other way round: the handler is installed and it exits, so a
   * SIGTERM that ARRIVES mid-drain is a hard kill.
   */
  const body = sigtermHandler();
  assert.match(body, /process\.exit\(/, 'the handler must exit rather than merely tidy up');
});

test('the shutdown does NOT drain in-flight HTTP requests', () => {
  /*
   * THE LOAD-BEARING HALF. A held `POST /posting/drain` must die with the
   * process — that is the whole event §10.3 is trying to produce. A
   * `server.close()` in this handler, or an await on connections finishing,
   * would let the drain run to completion and turn every future kill attempt
   * into another near-miss.
   *
   * Scoped to the shutdown handlers rather than the whole file: `server.close`
   * is a perfectly ordinary thing to call elsewhere.
   */
  const at = SERVER_SRC.indexOf("process.on('SIGTERM'");
  const shutdown = SERVER_SRC.slice(at);
  assert.ok(
    !/server\.close\(/.test(shutdown),
    'a graceful connection drain would let the held Drain request finish — see this file header'
  );
});

test('SIGINT shuts down the same way, so a local Ctrl-C reproduces the kill', () => {
  // The dev-box rehearsal of the same test. If the two handlers ever diverge, a
  // kill proven locally would say nothing about the container.
  assert.match(SERVER_SRC, /process\.on\('SIGINT'/);
  const at = SERVER_SRC.indexOf("process.on('SIGINT'");
  assert.match(SERVER_SRC.slice(at), /process\.exit\(/);
});

// ─── 2. The window the recipe opens ─────────────────────────────────────────

test('the recipe delay of 90 000 ms is accepted, not capped away', () => {
  /*
   * §10.3's revised recipe uses 90 000 ms per step. The cap is 120 000, so it
   * must come through untouched — a value silently clamped to something shorter
   * would put the kill back inside the replacement window it is trying to
   * outlive.
   */
  const resolved = postingDrain.resolveStepDelayMs({
    NODE_ENV: 'production',
    AZURE_KEY_VAULT_NAME: 'kv-carein-staging',
    RCM_DRAIN_STEP_DELAY_MS: '90000',
  });
  assert.equal(resolved.delayMs, 90000);
  assert.equal(resolved.refused, false);
  assert.ok(90000 < postingDrain.MAX_STEP_DELAY_MS, 'and it is genuinely under the cap');
});

test('90 000 ms is still refused where the environment cannot prove it is not production', () => {
  // The widened window must not widen the guard. A knob that held a chart write
  // open on prod for a minute and a half is the one thing this hook may never be.
  const resolved = postingDrain.resolveStepDelayMs({
    NODE_ENV: 'production',
    RCM_DRAIN_STEP_DELAY_MS: '90000',
  });
  assert.equal(resolved.delayMs, 0);
  assert.equal(resolved.refused, true);
  assert.match(resolved.reason, /cannot prove it is outside production/);
});

test('three forced-order steps means three windows a kill can land in', () => {
  /*
   * The recipe promises the kill can land after any of the three writes. That is
   * only true if each one pauses — a step that forgot to would leave a stretch
   * of the sequence no kill can be aimed at, and §10.3 would be proving less
   * than it claims.
   */
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'rcm', 'postingDrain.js'),
    'utf8'
  );
  for (const step of ['claimproc_write', 'claim_receipt', 'check']) {
    assert.match(
      src,
      new RegExp(`stepPause\\(ctx, '${step}'\\)`),
      `the ${step} step must pause, or no kill can be aimed after it`
    );
  }
});

// ─── 3. The runbook says what was actually learned ──────────────────────────

test('§10.3 records that revision restart is a graceful replacement, not a kill', () => {
  /*
   * The recipe is a document, and the document is the deliverable here — the
   * finding was in the runbook, not in the code. This is the pin that stops the
   * old command drifting back in, because it read as reasonable for three walks.
   */
  const doc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'docs', 'RCM_POSTING.md'),
    'utf8'
  );
  const at = doc.indexOf('### 10.3 Kill-mid-drain');
  assert.ok(at > -1, '§10.3 must still be where the runbook says it is');
  const section = doc.slice(at, doc.indexOf('### 10.4', at));

  assert.match(section, /graceful replacement/i, 'it must say what restart actually does');
  assert.match(section, /RCM_DRAIN_STEP_DELAY_MS=90000/, 'and carry the widened window');
  assert.match(section, /kill -9 1/, 'and warn about the SIGKILL trap');
  assert.match(section, /containerapp exec/, 'and name the mechanism that does terminate');
});
