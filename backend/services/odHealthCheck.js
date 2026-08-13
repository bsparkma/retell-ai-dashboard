'use strict';

/**
 * Per-office Open Dental reachability.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 *
 * `OpenDentalService.startRealTimeSync()` polled Open Dental every 3 minutes,
 * pulled a day of appointments (plus a per-PatNum name lookup for each one),
 * providers, operatories and recently-changed patients, and emitted the result
 * as a `syncComplete` event that NOTHING in the process listened for. Roughly
 * 25,000 Open Dental API calls a day, consumed by nobody.
 *
 * It could not simply be deleted, because it had one accidental consumer: us.
 * When Roland's eConnector went down (2026-08-05, again 2026-08-11) the loop's
 * error spam in the container log was the only reason anyone noticed. Deleting
 * the loop without a replacement would have removed the outage detector.
 *
 * So this module is the deliberate version of what the loop did by accident,
 * and it strictly dominates it:
 *
 *   | | old 3-min loop | this |
 *   | offices observed | 1 (the singleton's) | every office in the OD registry |
 *   | says WHICH office is down | no | yes |
 *   | says SINCE WHEN | no | yes (lastTransitionAt) |
 *   | distinguishes timeout / auth / 5xx | no | yes |
 *   | OD calls per day | ~25,000 | 576 (288 × 2 offices) |
 *   | log lines per day when healthy | thousands | 24 |
 *
 * ── OBSERVES, NEVER ACTS ────────────────────────────────────────────────────
 *
 * A down office does not trigger a retry anywhere, does not disable anything,
 * and does not gate a single OD operation. The real operations already fail
 * closed per office (config/odOffices.js). This module only watches, so a bug
 * in it can make the dashboard say the wrong thing but can never stop a chart
 * note from being written or cause one to go to the wrong chart.
 *
 * ── LOGGING: TRANSITIONS ONLY ───────────────────────────────────────────────
 *
 * One line when an office goes down, one when it comes back, one heartbeat an
 * hour. Nothing while steady. Per-failure logging is exactly how a monitoring
 * signal becomes noise that gets filtered into a folder nobody opens — the
 * 899-email eConnector flood is the lesson. The individual failures are still
 * in the state object (`lastFailureKind`, `consecutiveFailures`) for whoever
 * reads the snapshot; they are simply not shouted.
 *
 * ── NO TORN READS ───────────────────────────────────────────────────────────
 *
 * Each office's state is a FROZEN object replaced wholesale by a single
 * `Map.set`. A caller consulting an office mid-probe gets either the complete
 * previous state or the complete next one, never a half-written mixture of the
 * two — which matters because `status` and `lastTransitionAt` are read together
 * and would otherwise disagree ("down, since never").
 */

const odHealthConfig = require('../config/odHealth');
const odOffices = require('../config/odOffices');

/** @typedef {'up'|'down'|'unknown'} OdHealthStatus */

/**
 * Why a probe failed. Metadata only — never PHI, and never a credential.
 * `timeout` is the interesting one: a hung eConnector answers slowly or not at
 * all, whereas a misconfigured key answers instantly with 401.
 * @typedef {'timeout'|'network'|'auth'|'rate_limited'|'server_error'|'unexpected_response'|'not_configured'} OdHealthFailureKind
 */

/**
 * @typedef {Object} OdOfficeHealth
 * @property {string} officeKey
 * @property {string} officeName
 * @property {OdHealthStatus} status            up | down | unknown (never probed / not yet decided)
 * @property {boolean} eligible                 is this office OD-configured at all (so worth probing)
 * @property {string|null} ineligibleReason     why not, when eligible is false
 * @property {string|null} lastCheckedAt        ISO — when a probe last completed
 * @property {string|null} lastOkAt             ISO — when a probe last succeeded
 * @property {string|null} lastTransitionAt     ISO — when `status` last changed
 * @property {number} consecutiveFailures
 * @property {OdHealthFailureKind|null} lastFailureKind
 * @property {string|null} lastFailureDetail    truncated OD message; metadata only
 * @property {number|null} lastLatencyMs
 * @property {number} probes                    probes completed since boot
 * @property {string|null} serverVersion        OD ProgramVersion, when the probe read one
 */

/**
 * A never-probed office. `status: 'unknown'` is load-bearing — an office we
 * have not asked about must not render as up, or a checker that failed to start
 * would look like two healthy offices.
 *
 * @param {string} officeKey
 * @param {string} officeName
 * @param {{ code: string, message: string }|null} blocked
 * @returns {OdOfficeHealth}
 */
function initialState(officeKey, officeName, blocked) {
  return Object.freeze({
    officeKey,
    officeName,
    status: /** @type {OdHealthStatus} */ ('unknown'),
    eligible: blocked === null,
    ineligibleReason: blocked ? blocked.message : null,
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
}

/**
 * Classify a failed probe.
 *
 * The message is checked for a timeout marker BEFORE the elapsed-time
 * heuristic, because axios reports its own timeout well before the wall clock
 * would prove it and because a slow-but-answered request is a different animal
 * from a dead socket.
 *
 * @param {{ status: number, error?: string }} res  apiGetRaw's failure shape
 * @param {number} elapsedMs
 * @param {number} budgetMs
 * @returns {OdHealthFailureKind}
 */
function classifyFailure(res, elapsedMs, budgetMs) {
  const status = Number(res.status) || 0;
  const message = String(res.error || '');

  if (status === 0) {
    // apiGetRaw answers status 0 for "not configured" as well as for a dead
    // socket. Telling them apart matters: one is a deploy mistake, the other is
    // an outage, and they want different people woken up.
    if (/not configured|direct-DB mode/i.test(message)) return 'not_configured';
    if (/timeout|ECONNABORTED|ETIMEDOUT/i.test(message)) return 'timeout';
    // No marker in the message, but the request burned the whole budget — the
    // eConnector-down signature.
    if (elapsedMs >= budgetMs * 0.9) return 'timeout';
    return 'network';
  }

  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'unexpected_response';
}

/**
 * Pull the OD server version out of a `/preferences?PrefName=ProgramVersion`
 * body. Best-effort and never throws: the version is a nicety, and a probe that
 * got a 200 is a healthy office whether or not we could read the value.
 *
 * @param {unknown} data
 * @returns {string|null}
 */
function extractProgramVersion(data) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return null;
  const value = /** @type {Record<string, unknown>} */ (row).ValueString;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Human duration for a recovery line. "down→up after 12m" is the number an
 * operator actually wants; a pair of ISO timestamps is not.
 * @param {string|null} fromIso
 * @param {number} nowMs
 * @returns {string}
 */
function sinceLabel(fromIso, nowMs) {
  if (!fromIso) return 'an unknown period';
  const ms = nowMs - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown period';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 90) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

class OdHealthCheck {
  constructor() {
    /** @type {Map<string, OdOfficeHealth>} */
    this.state = new Map();
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    /** Offices with a probe in flight — a slow office never gets two at once. @type {Set<string>} */
    this.inFlight = new Set();
    /** ms since epoch of the last heartbeat line. */
    this.lastHeartbeatAt = 0;
    /** Set once start() arms the timer, so getStatus can say whether it is running. */
    this.startedAt = null;
  }

  /**
   * Which offices to probe: the Open Dental registry itself, not the call
   * office list. An office without OD settings has nothing to be reachable.
   * @returns {string[]}
   */
  officeKeys() {
    return Object.keys(odOffices.OFFICE_OD_SETTINGS);
  }

  /**
   * Current state for one office, creating the honest `unknown` entry on first
   * ask so a caller never gets undefined.
   * @param {string} officeKey
   * @returns {OdOfficeHealth}
   */
  getOfficeHealth(officeKey) {
    const existing = this.state.get(officeKey);
    if (existing) return existing;

    const settings = odOffices.OFFICE_OD_SETTINGS[officeKey];
    if (!settings) {
      // Not an OD-registry office (e.g. 'unknown'). Honest, and not eligible.
      return initialState(officeKey, officeKey, {
        code: 'OFFICE_NOT_OD_CONNECTED',
        message: 'Open Dental is not configured for this office',
      });
    }
    const described = odOffices.describeOffice(officeKey);
    const fresh = initialState(officeKey, described.officeName, odOffices.odBlockReason(officeKey));
    this.state.set(officeKey, fresh);
    return fresh;
  }

  /**
   * Every office's state, for a roster payload or an ops endpoint.
   * @returns {OdOfficeHealth[]}
   */
  snapshot() {
    return this.officeKeys().map((key) => this.getOfficeHealth(key));
  }

  /**
   * Checker-level status, for /api/admin/health. Distinct from the per-office
   * states: "the checker is not running" and "both offices are fine" are very
   * different situations that must not look alike.
   *
   * @returns {{ running: boolean, enabled: boolean, intervalMinutes: number,
   *             timeoutMs: number, failureThreshold: number, startedAt: string|null,
   *             offices: OdOfficeHealth[] }}
   */
  getStatus() {
    return {
      running: Boolean(this.timer),
      enabled: odHealthConfig.isEnabled(),
      intervalMinutes: odHealthConfig.intervalMinutes(),
      timeoutMs: odHealthConfig.timeoutMs(),
      failureThreshold: odHealthConfig.failureThreshold(),
      startedAt: this.startedAt,
      offices: this.snapshot(),
    };
  }

  /**
   * Issue the probe for one office and answer what happened. Split out from
   * `checkOffice` so tests can drive the state machine without a network stub
   * and so the OD-facing surface is one small, obvious method.
   *
   * @param {string} officeKey
   * @returns {Promise<{ ok: boolean, latencyMs: number, version: string|null,
   *                     kind: OdHealthFailureKind|null, detail: string|null }>}
   */
  async probeOffice(officeKey) {
    const budgetMs = odHealthConfig.timeoutMs();
    const startedAt = Date.now();

    try {
      // getOdOffice throws OdOfficeError when the office is unknown, switched
      // off, or unkeyed — all configuration facts, not outages.
      const handle = odOffices.getOdOffice(officeKey);
      const res = await handle.client.apiGetRaw(
        odHealthConfig.PROBE_PATH,
        odHealthConfig.PROBE_PARAMS,
        // `quiet` suppresses the OD client's per-request console lines. Without
        // it the probe would print two lines per office per cycle — 1,152 a day
        // of "GET /preferences", which is the noise this design exists to avoid.
        { timeoutMs: budgetMs, quiet: true }
      );
      const latencyMs = Date.now() - startedAt;

      if (res.ok) {
        return { ok: true, latencyMs, version: extractProgramVersion(res.data), kind: null, detail: null };
      }
      return {
        ok: false,
        latencyMs,
        version: null,
        kind: classifyFailure(res, latencyMs, budgetMs),
        detail: res.error ? String(res.error).slice(0, 200) : null,
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const code = err && /** @type {any} */ (err).code;
      const message = err && err.message ? String(err.message) : String(err);
      return {
        ok: false,
        latencyMs,
        version: null,
        // An OdOfficeError is a config refusal, not an unreachable server.
        kind: code && String(code).startsWith('OFFICE_') ? 'not_configured' : 'network',
        detail: message.slice(0, 200),
      };
    }
  }

  /**
   * Probe one office and fold the result into its state.
   *
   * The failure threshold applies to the DOWN direction only. One success is
   * enough to call an office up, because a server that answered is a server
   * that answered; several failures are needed to call it down, because a
   * single blip is not an outage.
   *
   * @param {string} officeKey
   * @returns {Promise<OdOfficeHealth>}
   */
  async checkOffice(officeKey) {
    const prev = this.getOfficeHealth(officeKey);

    if (this.inFlight.has(officeKey)) return prev;
    this.inFlight.add(officeKey);

    try {
      const result = await this.probeOffice(officeKey);
      const now = new Date();
      const nowIso = now.toISOString();
      const threshold = odHealthConfig.failureThreshold();

      let status = prev.status;
      let consecutiveFailures = result.ok ? 0 : prev.consecutiveFailures + 1;
      let lastTransitionAt = prev.lastTransitionAt;

      if (result.ok) {
        if (prev.status !== 'up') {
          status = 'up';
          lastTransitionAt = nowIso;
          if (prev.status === 'down') {
            console.log(
              `[odhealth] office=${officeKey} down→up after ${sinceLabel(prev.lastTransitionAt, now.getTime())}` +
                (result.version ? ` (OD ${result.version})` : '')
            );
          } else {
            console.log(
              `[odhealth] office=${officeKey} unknown→up — Open Dental reachable` +
                (result.version ? ` (OD ${result.version})` : '')
            );
          }
        }
      } else if (consecutiveFailures >= threshold && prev.status !== 'down') {
        status = 'down';
        lastTransitionAt = nowIso;
        console.error(
          `[odhealth] office=${officeKey} ${prev.status}→down after ${consecutiveFailures} ` +
            `consecutive failures (${result.kind}) — ${result.detail || 'no detail'}`
        );
      }
      // Every other outcome — a failure below the threshold, a failure while
      // already down, a success while already up — updates the counters and
      // says NOTHING. That silence is the feature.

      const next = Object.freeze({
        ...prev,
        status,
        // Re-read eligibility each cycle: a key can arrive via a restart with
        // new app settings, and the state should stop saying "not configured".
        eligible: odOffices.isOdReady(officeKey),
        ineligibleReason: (odOffices.odBlockReason(officeKey) || {}).message || null,
        lastCheckedAt: nowIso,
        lastOkAt: result.ok ? nowIso : prev.lastOkAt,
        lastTransitionAt,
        consecutiveFailures,
        lastFailureKind: result.ok ? null : result.kind,
        lastFailureDetail: result.ok ? null : result.detail,
        lastLatencyMs: result.latencyMs,
        probes: prev.probes + 1,
        serverVersion: result.version ?? prev.serverVersion,
      });

      // ONE assignment of a fully-built frozen object — see the no-torn-reads
      // note in the header.
      this.state.set(officeKey, next);
      return next;
    } finally {
      this.inFlight.delete(officeKey);
    }
  }

  /**
   * One cycle: probe every registry office INDEPENDENTLY.
   *
   * `allSettled`, not `all`: one office's failure must never abort another
   * office's probe, and a thrown probe must never leave the interval dead. The
   * offices share nothing — separate state entries, separate clients, separate
   * verdicts. Roland being down can never mark Valley down.
   *
   * @returns {Promise<OdOfficeHealth[]>}
   */
  async runCycle() {
    const keys = this.officeKeys();
    await Promise.allSettled(keys.map((key) => this.checkOffice(key)));
    this.maybeHeartbeat();
    return this.snapshot();
  }

  /**
   * Emit the low-frequency "checker is alive" line, at most once per
   * heartbeat window. Deliberately a single line covering all offices.
   * @param {number} [nowMs]
   * @returns {boolean} whether a line was emitted
   */
  maybeHeartbeat(nowMs = Date.now()) {
    const windowMs = odHealthConfig.heartbeatMinutes() * 60 * 1000;
    if (nowMs - this.lastHeartbeatAt < windowMs) return false;
    this.lastHeartbeatAt = nowMs;

    const summary = this.snapshot()
      .map((o) => `${o.officeKey}=${o.status}`)
      .join(' ');
    console.log(`[odhealth] heartbeat ${summary}`);
    return true;
  }

  /**
   * Arm the interval and fire one cycle immediately.
   *
   * The immediate cycle matters: without it every office reads `unknown` for
   * the first interval after a deploy, which is precisely the window in which
   * somebody is watching to see whether the deploy broke anything.
   *
   * @returns {boolean} true when a timer was armed by this call
   */
  start() {
    if (!odHealthConfig.isEnabled()) {
      console.log('⏸️  Open Dental health check disabled (OD_HEALTH_CHECK_DISABLED=true)');
      return false;
    }
    if (this.timer) {
      console.log('⚠️ Open Dental health check already running');
      return false;
    }

    const minutes = odHealthConfig.intervalMinutes();
    const intervalMs = minutes * 60 * 1000;

    this.timer = setInterval(() => {
      this.runCycle().catch((err) =>
        console.error('[odhealth] cycle failed:', err && err.message ? err.message : err)
      );
    }, intervalMs);

    // Do not hold the event loop open on this timer alone. The server's
    // listening socket is what keeps the process alive; a monitoring timer
    // should not be the reason a shutdown hangs.
    if (typeof this.timer.unref === 'function') this.timer.unref();

    this.startedAt = new Date().toISOString();
    const perDay = Math.round((24 * 60) / minutes) * this.officeKeys().length;
    console.log(
      `⏰ Open Dental health check every ${minutes}m across ${this.officeKeys().length} office(s) ` +
        `— ~${perDay} probes/day, transitions logged only`
    );

    this.runCycle().catch((err) =>
      console.error('[odhealth] initial cycle failed:', err && err.message ? err.message : err)
    );
    return true;
  }

  /** Disarm the interval (SIGTERM / SIGINT / tests). @returns {void} */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.startedAt = null;
  }

  /**
   * Forget every office's state. TESTS ONLY — in the app, forgetting that an
   * office has been down for an hour is exactly the wrong behaviour.
   * @returns {void}
   */
  resetForTests() {
    this.stop();
    this.state.clear();
    this.inFlight.clear();
    this.lastHeartbeatAt = 0;
  }
}

module.exports = new OdHealthCheck();
module.exports.OdHealthCheck = OdHealthCheck;
module.exports.classifyFailure = classifyFailure;
module.exports.extractProgramVersion = extractProgramVersion;
