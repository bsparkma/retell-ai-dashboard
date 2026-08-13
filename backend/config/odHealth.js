'use strict';

/**
 * Open Dental health-check configuration.
 *
 * WHY THIS EXISTS AT ALL. Until this slice the only thing in the system that
 * NOTICED an Open Dental outage was an accident: the process-wide OD client
 * polled itself every 3 minutes (`startRealTimeSync`), emitted a `syncComplete`
 * event nobody listened for, and — when Roland's eConnector went down — filled
 * the container log with errors. That error spam was our outage detector. It
 * cost roughly 25,000 Open Dental API calls a day to produce, and it could only
 * ever observe ONE office, because the loop belonged to the singleton.
 *
 * The loop is gone. This config drives its replacement: one cheap read-only
 * request per office, on a modest interval, with per-office state. The
 * replacement strictly dominates what the loop provided — it sees both offices,
 * it says which one is down, it says since when, and it costs ~1% as much.
 *
 * EVERY VALUE FALLS BACK TO ITS DEFAULT. A typo in an interval must not leave
 * the checker unscheduled: a health checker that silently never runs is worse
 * than no health checker, because the absence of an alert reads as "everything
 * is fine". That is the opposite of `MANGO_SYNC_SCHEDULE`, where an invalid
 * cron quietly disables the sync, and it is deliberate.
 */

/** How often each office is probed. 5 min ⇒ 288 probes/office/day. */
const DEFAULT_INTERVAL_MINUTES = 5;

/**
 * Probe timeout. Chosen to be well under the OD client's normal 30s so a hung
 * eConnector is CLASSIFIED as a timeout rather than blocking a probe cycle —
 * long timeouts are the eConnector-down signature we are here to catch.
 */
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Consecutive failures before an office is called down.
 *
 * 2, not 1: a single blip during a deploy or a 429 burst is not an outage, and
 * a detector that cries wolf gets muted — the 899-email eConnector alert flood
 * is the anti-pattern this whole slice is written against. 2 failures at a
 * 5-minute interval means an office is reported down within ~10 minutes, which
 * is far faster than the hours it previously took someone to notice.
 */
const DEFAULT_FAILURE_THRESHOLD = 2;

/**
 * Minutes between "still alive" heartbeat lines.
 *
 * Transition-only logging has one hole: silence is ambiguous. "No transition
 * lines for six hours" could mean a healthy office or a checker that died at
 * boot. One line an hour closes it, and Log Analytics can assert on its
 * presence. 24 lines/day is not spam.
 */
const DEFAULT_HEARTBEAT_MINUTES = 60;

/**
 * The probe request.
 *
 * `GET /preferences?PrefName=ProgramVersion` — proven cheap and 200-stable
 * against BOTH offices in the H0 spike (2026-08-12, docs/HYG_SPIKE_H0_OD_COVERAGE.md).
 * It reads one preference row, returns no patient data of any kind, and its
 * value (the OD server version) is itself worth having in the snapshot.
 *
 * It is deliberately NOT a patient or appointment read: a health probe must
 * never be a PHI read, or every probe would owe an audit row.
 */
const PROBE_PATH = '/preferences';
const PROBE_PARAMS = Object.freeze({ PrefName: 'ProgramVersion' });

/**
 * Parse a positive number from the environment. Zero and negatives are rejected
 * along with garbage — an interval of 0 would busy-loop against a customer's
 * practice-management server.
 * @param {unknown} raw
 * @returns {number|null}
 */
function parsePositive(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const parsed = Number(String(raw).trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Minutes between probe cycles. @returns {number} */
function intervalMinutes() {
  return parsePositive(process.env.OD_HEALTH_INTERVAL_MINUTES) ?? DEFAULT_INTERVAL_MINUTES;
}

/** Probe timeout in milliseconds. @returns {number} */
function timeoutMs() {
  return parsePositive(process.env.OD_HEALTH_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
}

/** Consecutive failures before an office is reported down. @returns {number} */
function failureThreshold() {
  const parsed = parsePositive(process.env.OD_HEALTH_FAILURE_THRESHOLD);
  return parsed === null ? DEFAULT_FAILURE_THRESHOLD : Math.max(1, Math.round(parsed));
}

/** Minutes between heartbeat lines. @returns {number} */
function heartbeatMinutes() {
  return parsePositive(process.env.OD_HEALTH_HEARTBEAT_MINUTES) ?? DEFAULT_HEARTBEAT_MINUTES;
}

/**
 * Is the checker switched on?
 *
 * Only the literal 'true' disables it, matching every other kill switch in this
 * codebase (`MANGO_SYNC_DISABLED`, `OPENDENTAL_WRITE_DISABLED`). Set it on a dev
 * box that should not be talking to a live practice server at all.
 *
 * @returns {boolean}
 */
function isEnabled() {
  return String(process.env.OD_HEALTH_CHECK_DISABLED ?? '').trim().toLowerCase() !== 'true';
}

module.exports = {
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_HEARTBEAT_MINUTES,
  PROBE_PATH,
  PROBE_PARAMS,
  intervalMinutes,
  timeoutMs,
  failureThreshold,
  heartbeatMinutes,
  isEnabled,
};
