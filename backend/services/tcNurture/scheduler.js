'use strict';

/**
 * The nightly nurture generator — the scheduler (queue item 47).
 *
 * THE SLOT: 05:00 America/Chicago (TC_NURTURE_SCHEDULE / TC_NURTURE_TZ). The
 * pass is pure Postgres — no Open Dental, no provider — so it is not budgeted
 * against the shared OD credential the way the 02:30 opportunities sync is.
 * 05:00 is after that sync and before anyone is in the office, so the drafts
 * are waiting in the outbox when the TC opens it, and every one of them still
 * needs a human click to go anywhere.
 *
 * DARK UNTIL SWITCHED ON, PER OFFICE: every pass reads
 * platform_setting['tc_nurture_enabled'] first (config/tcNurture.js) and does
 * nothing for an office that is not mapped to the literal `true`.
 * TC_NURTURE_ENABLED=false is the break-glass: nothing runs.
 *
 * SINGLE REPLICA, ONE TENANT — the same two invariants, and the same refusal,
 * as services/tcOpportunities/scheduler.js: the re-entrancy guard is
 * in-process (the container apps run at maxReplicas = 1), and the pass runs
 * only when EXACTLY ONE active tenant is entitled to `tc`. Unlike the
 * opportunities sync this pass reads no process-wide practice data, but the
 * office keys in the switch are still not tenant-scoped, so the same refusal
 * (AMBIGUOUS_TC_TENANT) is the honest answer for the day there are two. The
 * per-enrollment claim (generator.js) also makes a doubled pass write no
 * second draft.
 *
 * Does NOT run a pass at boot.
 */

const cron = require('node-cron');

const config = require('../../config/tcNurture');
const { runForOffice } = require('./generator');

class TcNurtureScheduler {
  /**
   * @param {{ registry?: any, tenantDb?: any, config?: any, runForOffice?: typeof runForOffice, now?: () => Date }} [deps]
   */
  constructor(deps = {}) {
    this.deps = deps;
    /** @type {{ stop: () => void }|null} */
    this.job = null;
    this.running = false;
    /** @type {object|null} */
    this.lastRun = null;
  }

  get registry() {
    return this.deps.registry || require('../../platform/registry');
  }

  get tenantDb() {
    return this.deps.tenantDb || require('../../platform/tenantDb');
  }

  get cfg() {
    return this.deps.config || config;
  }

  /** @returns {Promise<{ tenant: { tenant_id: string }|null, reason: string|null }>} */
  async resolveTenant() {
    let tenants;
    try {
      tenants = await this.registry.listTenants();
    } catch (err) {
      return { tenant: null, reason: `CONTROL_PLANE_UNREADABLE: ${(err && err.message) || err}` };
    }
    const entitled = [];
    for (const t of (tenants || []).filter((x) => x && x.status === 'active')) {
      try {
        const modules = await this.registry.getEnabledModules(t.tenant_id);
        if (Array.isArray(modules) && modules.includes('tc')) entitled.push(t);
      } catch {
        // An unreadable entitlement is NOT entitled.
      }
    }
    if (entitled.length === 0) return { tenant: null, reason: 'NO_TC_TENANT' };
    if (entitled.length > 1) return { tenant: null, reason: 'AMBIGUOUS_TC_TENANT' };
    return { tenant: entitled[0], reason: null };
  }

  /**
   * One pass over every switched-on office, in turn. Never throws.
   * @returns {Promise<{ skipped?: string, offices: object[], at: string }>}
   */
  async runNow() {
    const now = this.deps.now ? this.deps.now() : new Date();
    const at = now.toISOString();
    if (this.running) return { skipped: 'ALREADY_RUNNING', offices: [], at };
    this.running = true;
    try {
      const sw = await this.cfg.switchedOnOffices(this.registry);
      if (sw.offices.length === 0) {
        const r = { skipped: sw.reason || 'NO_OFFICE_SWITCHED_ON', offices: [], at };
        this.lastRun = r;
        console.log(`[tcNurture] nightly pass skipped: ${r.skipped}`);
        return r;
      }
      const { tenant, reason } = await this.resolveTenant();
      if (!tenant) {
        const r = { skipped: reason || 'NO_TC_TENANT', offices: [], at };
        this.lastRun = r;
        console.warn(`[tcNurture] nightly pass skipped: ${r.skipped}`);
        return r;
      }
      const pool = await this.tenantDb.getTenantPool(tenant.tenant_id);
      const run = this.deps.runForOffice || runForOffice;
      const results = [];
      for (const office of sw.offices) {
        try {
          const outcome = await run({ pool, office, now, tz: this.cfg.timezone() });
          results.push(outcome);
          // ONE LINE PER OFFICE PER PASS. Counts only — never a name, a phone or a body.
          console.log(
            `[tcNurture] office=${office} due=${outcome.due} queued=${outcome.queued} ` +
              `completed=${outcome.completed} deferred=${outcome.deferred} stopped=${outcome.stopped} ` +
              `lost_claim=${outcome.lost_claim} errors=${outcome.errors} ` +
              `phone_configured=${outcome.phoneConfigured ? 'yes' : 'no'} ms=${outcome.durationMs}`
          );
        } catch (err) {
          results.push({ office, error: (err && err.message) || String(err) });
          console.error(`[tcNurture] office=${office} pass failed: ${(err && err.message) || err}`);
        }
      }
      const r = { offices: results, at };
      this.lastRun = r;
      return r;
    } catch (err) {
      const r = { skipped: `PASS_FAILED: ${(err && err.message) || err}`, offices: [], at };
      this.lastRun = r;
      console.error(`[tcNurture] pass failed: ${r.skipped}`);
      return r;
    } finally {
      this.running = false;
    }
  }

  /** The only node-cron touchpoint, isolated for tests. */
  createJob(schedule, timezone, handler) {
    return cron.schedule(schedule, handler, { timezone });
  }

  /** Arm the nightly job. Harmless while dark. @returns {boolean} */
  start() {
    if (this.cfg.isKilled()) {
      console.log(`⏸️  TC nurture generator disabled (${this.cfg.KILL_ENV_KEY}=false)`);
      return false;
    }
    if (this.job) return false;
    const schedule = this.cfg.cronSchedule();
    if (!cron.validate(schedule)) {
      console.warn(`[tcNurture] invalid TC_NURTURE_SCHEDULE '${schedule}' — the generator will not run`);
      return false;
    }
    const timezone = this.cfg.timezone();
    this.job = this.createJob(schedule, timezone, () => {
      void this.runNow();
    });
    console.log(
      `⏰ TC nurture generator scheduled: '${schedule}' (${timezone}) — drafts only; dark until an office ` +
        `is switched on in platform_setting['${this.cfg.SETTING_KEY}']`
    );
    return true;
  }

  stop() {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
  }
}

module.exports = new TcNurtureScheduler();
module.exports.TcNurtureScheduler = TcNurtureScheduler;
