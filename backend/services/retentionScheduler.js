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
    // Re-read the stored window FIRST, every time. The console can change it
    // between two nightly runs, and a job that destroyed an extra 60 days of
    // records because it was holding a boot-time snapshot of "30" is precisely
    // the bug this refresh exists to make impossible. Cheap: one indexed row
    // from the control plane, once a night.
    await config.refreshFromDb();

    // Never read the policy successfully since boot ⇒ we cannot rule out a
    // stored window that disagrees with the environment, and the disagreement
    // is measured in months of records. Refuse rather than guess.
    if (!config.policyKnown()) {
      console.warn(
        '[retention] SKIPPED — the retention window could not be read from the control ' +
          'plane, so the current policy is unknown. Nothing was pruned.'
      );
      return {
        skipped: 'RETENTION_POLICY_UNKNOWN',
        scanned: 0,
        stubbed: 0,
        alreadyStubbed: 0,
      };
    }

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

  /**
   * A SNAPSHOT, not a fresh read. `runNow()` is the only thing that refreshes
   * from the control plane, because that is the only place a stale number could
   * destroy something; a status panel showing a value a few seconds old costs
   * nothing, and making a status endpoint hit the control DB would put a
   * database round trip behind every poll of the admin page.
   *
   * `source` and `policyKnown` are surfaced so the panel can say WHY the number
   * is what it is — "the environment says 30 because nobody has chosen" reads
   * very differently from "somebody set 30 last Tuesday".
   *
   * @returns {{running: boolean, schedule: string, timezone: string, retentionDays: number,
   *            enabled: boolean, source: string, policyKnown: boolean, lastRun: object|null}}
   */
  getStatus() {
    return {
      running: Boolean(this.job),
      schedule: config.schedule(),
      timezone: config.timezone(),
      retentionDays: config.retentionDays(),
      enabled: config.isEnabled(),
      source: config.retentionSource(),
      policyKnown: config.policyKnown(),
      lastRun: this.lastRun,
    };
  }
}

module.exports = new RetentionScheduler();
