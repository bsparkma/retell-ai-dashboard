'use strict';

/**
 * The nightly TC Opportunities sync — the scheduler.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SLOT: 02:30 America/Chicago
 * ═════════════════════════════════════════════════════════════════════════════
 * The spec says "off-hours, after the hyg 07:45 warm". Read literally, "after
 * 07:45" is inside office hours — the one window where the shared Open Dental
 * credential is busiest (voice lookups, TC screens, the hygiene Day View). The
 * intent is NOT TO COLLIDE with the warm, and 02:30 satisfies it more strictly:
 * a pass budgeted at ≤ 14 minutes per office, two offices in sequence, is done
 * by ~03:00 — almost five hours before the 07:45 warm, so the warm never queues
 * behind it, and there is no business-hours traffic to contend with at all.
 * It also clears every other scheduled job: the Mango sync runs at :15 past the
 * hour and reads Mango, not Open Dental. Overridable with TC_OPPS_SYNC_SCHEDULE.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SINGLE REPLICA
 * ═════════════════════════════════════════════════════════════════════════════
 * The re-entrancy guard below is in-process. The container apps run at
 * maxReplicas = 1 (the same invariant the RCM startup sweep and the call-store
 * mount depend on). Under a second replica, two passes would run at 02:30
 * against the same credential and the same rows. The row writes are
 * status-guarded so they would not corrupt anything, but the OD traffic would
 * double. A lease row is the work to do BEFORE raising maxReplicas.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHICH TENANT
 * ═════════════════════════════════════════════════════════════════════════════
 * Open Dental office handles are PROCESS-WIDE (config/odOffices.js) — they are
 * not bound to a tenant. So the sync runs only when EXACTLY ONE active tenant
 * is entitled to `tc`; zero is "nothing to do", and more than one is refused
 * (AMBIGUOUS_TC_TENANT), because writing one practice's Open Dental data into
 * every entitled tenant would be a cross-tenant disclosure. Today there is one
 * tenant, and the refusal is the safe answer for the day there are two.
 *
 * Does NOT run a pass at boot: a deploy at 2pm must not start a full sweep
 * against a live credential.
 */

const cron = require('node-cron');

const config = require('../../config/tcOpportunities');
const odOffices = require('../../config/odOffices');
const odPatientCache = require('../odPatientCache');
const { syncOffice } = require('./sync');

class TcOpportunitiesScheduler {
  /**
   * @param {{ registry?: any, tenantDb?: any, odOffices?: any, odPatientCache?: any,
   *           config?: any, syncOffice?: typeof syncOffice }} [deps]
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

  /**
   * The one tenant this process may sync for, or a refusal.
   * @returns {Promise<{ tenant: { tenant_id: string, slug: string }|null, reason: string|null }>}
   */
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
   * One pass: every switched-on, OD-ready office, in turn. Never throws.
   * @returns {Promise<{ skipped?: string, offices: object[], at: string }>}
   */
  async runNow() {
    const at = new Date().toISOString();
    if (this.running) return { skipped: 'ALREADY_RUNNING', offices: [], at };
    this.running = true;
    try {
      const oo = this.deps.odOffices || odOffices;
      const sw = await this.cfg.switchedOnOffices(this.registry);
      if (sw.offices.length === 0) {
        const r = { skipped: sw.reason || 'NO_OFFICE_SWITCHED_ON', offices: [], at };
        this.lastRun = r;
        console.log(`[tcopps] nightly sync skipped: ${r.skipped}`);
        return r;
      }
      const { tenant, reason } = await this.resolveTenant();
      if (!tenant) {
        const r = { skipped: reason || 'NO_TC_TENANT', offices: [], at };
        this.lastRun = r;
        console.warn(`[tcopps] nightly sync skipped: ${r.skipped}`);
        return r;
      }

      const pool = await this.tenantDb.getTenantPool(tenant.tenant_id);
      const run = this.deps.syncOffice || syncOffice;
      const results = [];
      // Sequential across offices, as the hygiene warm is: nobody is waiting,
      // so finishing sooner is worth nothing and being quieter is worth a lot.
      for (const office of sw.offices) {
        if (!oo.isOdReady(office)) {
          results.push({ office, status: 'failed', error: 'OFFICE_NOT_OD_READY' });
          console.warn(`[tcopps] office=${office} skipped: not OD-ready`);
          continue;
        }
        const outcome = await run({
          office,
          pool,
          odOffices: oo,
          odPatientCache: this.deps.odPatientCache || odPatientCache,
          config: this.cfg,
        });
        results.push(outcome);
        // ONE LINE PER OFFICE PER PASS. Counts only — never a PatNum or a name.
        console.log(
          `[tcopps] office=${office} status=${outcome.status} pages=${outcome.pages} ` +
            `scanned=${outcome.proceduresScanned} patients=${outcome.patients} ` +
            `inserted=${outcome.inserted} refreshed=${outcome.refreshed} cleared=${outcome.cleared} ` +
            `resurrected=${outcome.resurrected} name_reads=${outcome.nameReads} ` +
            `names_pending=${outcome.namesPending} od_requests=${outcome.odRequests} ` +
            `ms=${outcome.durationMs}${outcome.error ? ` error=${outcome.error}` : ''}`
        );
      }
      const r = { offices: results, at };
      this.lastRun = r;
      return r;
    } catch (err) {
      const r = { skipped: `PASS_FAILED: ${(err && err.message) || err}`, offices: [], at };
      this.lastRun = r;
      console.error(`[tcopps] pass failed: ${r.skipped}`);
      return r;
    } finally {
      this.running = false;
    }
  }

  /** The only node-cron touchpoint, isolated for tests. */
  createJob(schedule, timezone, handler) {
    return cron.schedule(schedule, handler, { timezone });
  }

  /**
   * Arm the nightly job. Arming is harmless while dark: each pass reads the
   * switch first and does nothing until an office is turned on.
   * @returns {boolean}
   */
  start() {
    if (this.cfg.isKilled()) {
      console.log('⏸️  TC opportunities sync disabled (TC_OPPS_SYNC_DISABLED=true)');
      return false;
    }
    if (this.job) return false;
    const schedule = this.cfg.schedule();
    if (!cron.validate(schedule)) {
      console.warn(`[tcopps] invalid TC_OPPS_SYNC_SCHEDULE '${schedule}' — the sync will not run`);
      return false;
    }
    const timezone = this.cfg.timezone();
    this.job = this.createJob(schedule, timezone, () => {
      void this.runNow();
    });
    console.log(
      `⏰ TC opportunities sync scheduled: '${schedule}' (${timezone}) — dark until an office is ` +
        `switched on in platform_setting['${this.cfg.SETTING_KEY}']`
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

module.exports = new TcOpportunitiesScheduler();
module.exports.TcOpportunitiesScheduler = TcOpportunitiesScheduler;
