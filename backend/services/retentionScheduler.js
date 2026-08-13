'use strict';

/**
 * The nightly retention job.
 *
 * Deliberately NOT folded into syncScheduler. That scheduler owns pulling data
 * IN from Mango and Retell; this one takes data out. Sharing an object would mean
 * a change to the ingestion cadence could move when records are destroyed, and
 * `MANGO_SYNC_DISABLED` — a switch whose entire purpose is stopping a dev box
 * contending for the shared portal session — would also silently stop retention.
 */

const cron = require('node-cron');
const config = require('../config/retention');
const retention = require('./callRetention');
const unifiedCallStore = require('./unifiedCallStore');

class RetentionScheduler {
  constructor() {
    this.job = null;
    /** Summary of the most recent run, for /api/admin surfaces and the logs. */
    this.lastRun = null;
  }

  /**
   * The ONLY place this service touches node-cron.
   *
   * Isolated as its own method so the decisions in start() — whether to schedule
   * at all, with which expression, in whose timezone — can be tested without a
   * live cron task running inside a parallel test process.
   *
   * @param {string} schedule 5-field cron expression
   * @param {string} timezone IANA zone the expression is read in
   * @param {() => void} handler
   * @returns {{ stop: () => void }}
   */
  createJob(schedule, timezone, handler) {
    return cron.schedule(schedule, handler, { timezone });
  }

  /**
   * Schedule the nightly prune. A no-op when retention is switched off
   * (CALL_RETENTION_DAYS=0) and when a job is already scheduled.
   * @returns {boolean} true when a job was armed by this call
   */
  start() {
    if (!config.isEnabled()) {
      console.log('⏸️  Call retention disabled (CALL_RETENTION_DAYS=0) — nothing will be pruned');
      return false;
    }
    if (this.job) {
      console.log('⚠️ Retention job already scheduled');
      return false;
    }

    const schedule = config.schedule();
    // The timezone is passed EXPLICITLY rather than inherited from the container
    // clock. A "quiet hour" that follows UTC lands at 9:30pm Central — mid-evening,
    // while the after-hours agent is still taking calls.
    const timezone = config.timezone();

    // The promise is RETURNED, not just caught. node-cron ignores it, but it means
    // the scheduled work is awaitable by anything that holds the handler — which
    // is what lets the wiring be tested by firing it rather than by waiting for
    // 3:30am. The .catch stays: an unhandled rejection here would take the
    // process down for a job that is allowed to fail.
    this.job = this.createJob(schedule, timezone, () =>
      this.runNow().catch((err) => console.error('❌ Retention prune failed:', err.message))
    );

    console.log(
      `⏰ Call retention scheduled: '${schedule}' (${timezone}), ` +
      `keeping ${config.retentionDays()} days of full call records`
    );
    return true;
  }

  /** Stop the nightly prune (shutdown / tests). */
  stop() {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
  }

  /**
   * Run one prune pass now.
   *
   * Safe to call at any time: the pass is idempotent, so an operator triggering
   * it after the nightly run simply finds nothing to do.
   *
   * @returns {Promise<{stubbed: number, skipped?: string}>}
   */
  async runNow() {
    if (!config.isEnabled()) {
      return { skipped: 'RETENTION_DISABLED', scanned: 0, stubbed: 0, alreadyStubbed: 0 };
    }

    const retentionDays = config.retentionDays();
    const result = await retention.runPrune(unifiedCallStore, { retentionDays });

    this.lastRun = { ...result, at: new Date().toISOString(), retentionDays };
    console.log(
      `[retention] prune complete scanned=${result.scanned} stubbed=${result.stubbed} ` +
      `cutoff=${result.cutoff} ms=${result.durationMs}`
    );
    return result;
  }

  /** @returns {{running: boolean, schedule: string, timezone: string, retentionDays: number, lastRun: object|null}} */
  getStatus() {
    return {
      running: Boolean(this.job),
      schedule: config.schedule(),
      timezone: config.timezone(),
      retentionDays: config.retentionDays(),
      enabled: config.isEnabled(),
      lastRun: this.lastRun,
    };
  }
}

module.exports = new RetentionScheduler();
