#!/usr/bin/env node
/**
 * Run the backend suite as SEVERAL `node --test` invocations instead of one.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═════════════════════════════════════════════════════════════════════════════
 * `node --test` runs each test file in a child process and streams the results
 * back over an IPC channel that the PARENT deserializes. On every Node 22 there
 * is a bug in that parent-side reader: the per-message size is decoded from four
 * bytes with `<<`, which is a SIGNED operation in JavaScript, so a size whose
 * top byte has the high bit set comes out negative and the next slice is taken
 * from the wrong place. What surfaces is:
 *
 *     not ok N - <an arbitrary file>
 *       failureType: 'uncaughtException'
 *       error: 'Unable to deserialize cloned data due to invalid or unsupported version.'
 *       stack: #processRawBuffer (node:internal/test_runner/runner.js)
 *
 * — a failure with no assertion in it, blaming a file that did nothing wrong,
 * and taking the rest of that file's tests down with it (the reported test count
 * DROPS, which is how you tell it from a real red).
 *
 * The bug is tracked upstream as `nodejs/node#64061` and was fixed by
 * `nodejs/node#64706`, which makes that decode unsigned.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE CLAIM IN THIS FILE YOU CANNOT CHECK FROM THE REPO — SO CHECK IT AGAIN
 * ─────────────────────────────────────────────────────────────────────────────
 * **As of 2026-08-30**, per the release notes for the fix commit and the labels
 * on `nodejs/node#64706`: the fix shipped in **v24.20.0 and v26.7.0**, and in
 * **no** release of Node 22 — `doc/changelogs/CHANGELOG_V22.md` does not mention
 * it through **22.23.2** (2026-07-29, the newest at the time of writing), and the
 * PR carries no v22 backport label.
 *
 * That is a fact about the world on one date, not a property of this repo, and
 * it is the sentence somebody will act on when deciding whether to bump Node.
 * **Re-check it before you rely on it** — a later 22.x may well carry the
 * backport, and if it does, this whole script can go.
 *
 * This repo's runtime image is `node:22-alpine`, so CI runs 22 on purpose:
 * testing on a Node the container does not ship would be a worse trade than the
 * flake.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT SHARDING ACTUALLY BUYS, STATED HONESTLY
 * ═════════════════════════════════════════════════════════════════════════════
 * Each shard is its own parent process reading its own IPC stream, so no single
 * parent decodes the whole suite's messages any more — roughly a quarter each.
 * The bug is per-message and probabilistic, so this REDUCES exposure roughly in
 * proportion. **It does not remove the mechanism, and this file does not claim
 * to have fixed anything.** The cure is Node ≥ 24.20 (or a v22 backport that
 * does not exist yet); until one of those, this is a smaller target.
 *
 * There is deliberately NO RETRY here. A retry that turns a genuine red into a
 * green is worse than the flake it hides, and a retry loud enough to be safe
 * (named in the summary, second failure still fails the job) is a bigger change
 * than this one — worth building only if sharding proves not to be enough.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY `--test-shard` AND NOT A HAND-WRITTEN FILE LIST
 * ═════════════════════════════════════════════════════════════════════════════
 * Node does its own discovery and its own partitioning. A chunker that globbed
 * for test files itself would have to reimplement those rules — and the failure
 * mode of getting them slightly wrong is a directory that silently stops being
 * tested, which is far worse than an occasional red build. The guards below
 * exist for the one way this script itself could drop tests: a wrong index.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * AND WHY IT IS NOT CALLED `test-shards.mjs`
 * ═════════════════════════════════════════════════════════════════════════════
 * It was, for about ten minutes. A leading `test-` is one of Node's default
 * test-file patterns, so `node --test` discovered this runner as a TEST FILE, ran it
 * inside a shard, and that nested run found no files and exited 1 — a red build
 * caused by the thing meant to make builds less red. It also inflated the count
 * by one, which is what gave it away.
 *
 * Any name matching `test-*`, `*-test`, `*_test`, `*.test` or anything under a
 * `test/` directory will be executed rather than merely run. This is the same
 * discovery subtlety that makes hand-rolling the file list a bad idea.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A RED RUN MUST KEEP ITS OWN EVIDENCE
 * ═════════════════════════════════════════════════════════════════════════════
 * This script used to end a failing run with `process.exit(1)`. When stdout is a
 * pipe (it is in CI), `process.stdout.write` of a large string hands the kernel
 * one pipe buffer (~64 KiB) and queues the rest — and the queue only drains when
 * the event loop runs. `spawnSync` blocks the event loop for every later shard,
 * and `process.exit` then discards whatever is still queued. So a red run printed
 * the first ~64 KiB of shard 1 and lost everything after it, INCLUDING the
 * `not ok` line that named the failure (staging-cd run #276; and the reason an
 * earlier truncated log sent a fix hunting in an innocent file, PR #207). A green
 * run never called `process.exit`, which is why green logs were always whole.
 *
 * Three things now keep that from happening:
 *   1. each shard's output is FLUSHED (we await the write callback) before the
 *      next shard starts, so nothing waits behind a blocked event loop;
 *   2. a failure sets `process.exitCode = 1` and returns, so Node drains stdout
 *      before it exits — same exit code, nothing thrown away;
 *   3. each shard's raw stdout + stderr is also written to a file
 *      (`SHARD_OUTPUT_DIR`, default `<os tmpdir>/carein-shard-runner/`), and a
 *      red run names those files, so the evidence survives even a log that a
 *      viewer truncates. On a CI runner they vanish with the job unless a
 *      workflow step uploads them — fixes 1 and 2 are what keep the CI LOG
 *      whole; the files are for local runs and any future upload step.
 * A green run prints exactly what it printed before.
 *
 * Usage:  node scripts/shard-runner.mjs        (from backend/)
 *         TEST_SHARDS=6 node scripts/shard-runner.mjs
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Four is a balance, not a magic number: enough that no parent carries most of
 * the stream, few enough that the per-process start-up cost stays small against
 * a ~60s suite. Overridable so a bisect can try other values without a commit.
 */
const TOTAL = Number.parseInt(process.env.TEST_SHARDS ?? '4', 10);
if (!Number.isInteger(TOTAL) || TOTAL < 1) {
  console.error(`[shard-runner] TEST_SHARDS must be a positive integer, got ${process.env.TEST_SHARDS}`);
  process.exit(2);
}

/** `# tests 2032` and friends, off the end of a shard's own summary. */
function counters(output) {
  const read = (name) => {
    const m = output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return { tests: read('tests'), pass: read('pass'), fail: read('fail'), skipped: read('skipped') };
}

/**
 * Write and WAIT until the stream has handed the text on. The callback fires on
 * error too, so a closed pipe cannot HANG the run — though the stream's own
 * 'error' event still ends it (EPIPE, exit 1), exactly as a plain write did.
 * @param {NodeJS.WriteStream} stream @param {string} text
 */
function flushed(stream, text) {
  return new Promise((resolve) => {
    stream.write(text, () => resolve(undefined));
  });
}

/** Where each shard's raw output is kept. Best effort: a failure here never fails the run. */
const OUTPUT_DIR = process.env.SHARD_OUTPUT_DIR || join(tmpdir(), 'carein-shard-runner');
/** @param {number} index @param {string} stdout @param {string} stderr @returns {string|null} */
function keepShardOutput(index, stdout, stderr) {
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const file = join(OUTPUT_DIR, `shard-${index}-of-${TOTAL}.log`);
    writeFileSync(file, stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout);
    return file;
  } catch (err) {
    console.error(`[shard-runner] could not keep shard ${index} output: ${err && err.message}`);
    return null;
  }
}

const started = Date.now();
/** @type {{index: number, code: number|null, tests: number|null, pass: number|null, fail: number|null, skipped: number|null, file: string|null}[]} */
const shards = [];

for (let index = 1; index <= TOTAL; index++) {
  await flushed(process.stdout, `\n═══ shard ${index}/${TOTAL} ═══\n`);
  const run = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', `--test-shard=${index}/${TOTAL}`],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  const stdout = run.stdout ?? '';
  const stderr = run.stderr ?? '';
  const file = keepShardOutput(index, stdout, stderr);
  // Streamed after the fact rather than inherited, because the counters have to
  // be read back out of it. Each write is FLUSHED before the next shard starts:
  // spawnSync blocks the event loop, so an unflushed write would sit queued
  // behind every later shard (see "A RED RUN MUST KEEP ITS OWN EVIDENCE").
  await flushed(process.stdout, stdout);
  if (stderr) await flushed(process.stderr, stderr);
  shards.push({ index, code: run.status, ...counters(stdout), file });
}

const sum = (key) => shards.reduce((a, s) => a + (s[key] ?? 0), 0);
const totals = {
  tests: sum('tests'),
  pass: sum('pass'),
  fail: sum('fail'),
  skipped: sum('skipped'),
};

const lines = [
  `backend suite, ${TOTAL} shards, ${((Date.now() - started) / 1000).toFixed(0)}s`,
  ...shards.map(
    (s) =>
      `  shard ${s.index}/${TOTAL}: exit ${s.code} · ${s.tests ?? '?'} tests · ` +
      `${s.pass ?? '?'} pass · ${s.fail ?? '?'} fail · ${s.skipped ?? '?'} skipped`
  ),
  `  TOTAL: ${totals.tests} tests · ${totals.pass} pass · ${totals.fail} fail · ${totals.skipped} skipped`,
];
console.log(`\n${lines.join('\n')}`);

/*
 * THE SUMMARY IS WRITTEN WHERE A PERSON WILL SEE IT WITHOUT OPENING THE LOG.
 *
 * The whole point of splitting the run is that the totals are now assembled by
 * this script rather than printed by Node — so if the assembling is wrong, it
 * has to be wrong somewhere visible.
 */
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Backend tests\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
}

const problems = [];
for (const s of shards) {
  if (s.code !== 0) problems.push(`shard ${s.index}/${TOTAL} exited ${s.code}`);
  /*
   * A SHARD THAT RAN NOTHING IS THE ONE WAY THIS SCRIPT COULD SILENTLY DROP
   * TESTS — a wrong index, or an off-by-one in the loop, hands Node a shard it
   * has no files for and it exits 0 with an empty run. Node's own discovery
   * cannot produce an empty shard for this repo: there are ~111 test files and
   * four shards.
   */
  if (!s.tests) problems.push(`shard ${s.index}/${TOTAL} reported no tests at all`);
}
if (totals.fail > 0) problems.push(`${totals.fail} failing test(s)`);

if (problems.length > 0) {
  const kept = shards.filter((s) => s.file).map((s) => `  shard ${s.index}/${TOTAL}: ${s.file}`);
  console.error(
    `\n[shard-runner] FAILED: ${problems.join('; ')}` +
      (kept.length ? `\n[shard-runner] full per-shard output kept in:\n${kept.join('\n')}` : '')
  );
  // NOT process.exit(1): that discards any output still queued for the pipe.
  // Setting exitCode lets Node drain stdout/stderr first, then exit 1.
  process.exitCode = 1;
} else {
  console.log(`[shard-runner] ${TOTAL} shards, all green`);
}
