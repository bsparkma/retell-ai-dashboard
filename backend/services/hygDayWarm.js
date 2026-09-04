'use strict';

/**
 * The hygiene morning warm.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IT IS FOR
 * ═════════════════════════════════════════════════════════════════════════════
 * services/odPatientCache.js makes the SECOND look at a day free. It does
 * nothing at all for the first one, and the first one is a hygienist opening
 * today's schedule at 8am — which is the load the whole slice is about.
 *
 * Open Dental throttles at one request per second per credential and offers no
 * bulk patient read, so naming a forty-patient day from cold is forty-odd
 * seconds of somebody standing at a chair. This job pays that cost before the
 * practice opens, against an idle credential, with nobody waiting on it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WARMING IS NOT A DISCLOSURE. IT WRITES NO AUDIT ROWS. THIS IS DELIBERATE.
 * ═════════════════════════════════════════════════════════════════════════════
 * A HIPAA audit row records that a patient's information was shown TO A USER.
 * Nobody is looking at anything here: this is the application fetching, at 7:45
 * in the morning, on its own initiative. There is no actor to record, no
 * request to attribute it to, and `platform/audit.js` has no way to write a row
 * without one.
 *
 * The disclosure happens later, when a hygienist opens the day — and
 * routes/hyg/day.js writes the rows THEN, from what it is about to send, so
 * they land whether the patients came from Open Dental or from a warm cache.
 * That is the exact mirror image of the rule in odPatientCache.js §4, and it is
 * just as easy to get backwards: a warm that audited would file forty
 * disclosures nobody made, and a day view that audited only its fetches would
 * file none at all.
 *
 * If a future slice makes the warm's output visible to somebody before they ask
 * for a day, that is the moment this changes — and it changes by the thing that
 * SHOWS it auditing, not by this file.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT MUST NEVER CONTEND WITH A REAL USER
 * ═════════════════════════════════════════════════════════════════════════════
 * The warm passes no `minIntervalMs`, so it takes the process-default share of
 * the shared per-credential slot and can never RAISE its priority the way RCM's
 * batch matcher deliberately does (decision D-8). At the default spacing,
 * against an idle credential at 7:45am, it is invisible; if a voice lookup
 * arrives mid-warm it interleaves at one request each rather than queueing
 * behind a reservation.
 *
 * It is also strictly bounded: one office at a time, one day, and the patient
 * fan-out is capped by `HYG_OD_MAX_PATIENT_READS` because it goes through the
 * same `odDay.readPatients` the Day View uses. Reusing that function rather
 * than writing a second fan-out is the point — a warm that populated the cache
 * differently from the way the screen reads it would warm the wrong entries.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONLY OFFICES THAT ARE SWITCHED ON
 * ═════════════════════════════════════════════════════════════════════════════
 * `odOffices.isHygOdReady(key)`, which ships FALSE for every office. **The warm
 * must never be the thing that starts talking to a practice.** An office
 * becomes eligible when Beau turns hygiene on for it, which is the same act
 * that lets a person load its day — so the warm can only ever pre-fetch
 * something a user was already able to ask for.
 *
 * A failed warm is a WARNING and nothing else. The Day View still works; it is
 * merely cold, which is where it was before this file existed.
 */

const cron = require('node-cron');

const warmConfig = require('../config/hygWarm');
const odOffices = require('../config/odOffices');
const hygPilot = require('../config/hygPilot');
const odDay = require('./hyg/odDay');
const odPatientCache = require('./odPatientCache');
const { localDayKey } = require('./localDayClock');

class HygDayWarm {
  constructor() {
    /** @type {{ stop: () => void }|null} */
    this.job = null;
    /** Summary of the most recent pass, for the logs and any future ops surface. */
    this.lastRun = null;
    /** True while a pass is running, so a short cron cannot overlap itself. */
    this.running = false;
  }

  /**
   * The offices this warm may touch: those whose hygiene switch is on AND whose
   * Open Dental credentials are present. `isHygOdReady` composes both questions
   * (config/odOffices.js), so there is no state in which the warm reaches an
   * office the Day View could not.
   *
   * READ AT PASS TIME, NEVER CACHED. The pilot switch is a run-time value
   * (config/hygPilot.js) and an office turned off at 9am on Tuesday must not
   * still be warmed at 7:45 on Wednesday by a copy this object took at boot.
   * That is why this is a method and not a field, and why `runNow` refreshes
   * the switch from the control plane before calling it.
   *
   * @returns {string[]}
   */
  eligibleOffices() {
    return Object.keys(odOffices.OFFICE_OD_SETTINGS).filter((key) =>
      odOffices.isHygOdReady(key)
    );
  }

  /**
   * Today's date, as Open Dental would name it, in the office's own timezone.
   *
   * Not UTC: at 7:45am Central the UTC date is already correct, but at some
   * times of year a container-clock day boundary would warm YESTERDAY's
   * schedule — which is exactly as useless as warming nothing while looking
   * like it worked.
   *
   * @param {Date} [now] injectable for tests
   * @returns {string} 'YYYY-MM-DD'
   */
  today(now = new Date()) {
    return localDayKey(warmConfig.timezone(), now);
  }

  /**
   * Warm one office's day.
   *
   * Reads the schedule (one list read, paged) to learn WHO is on it, then walks
   * the distinct PatNums through the shared cache. Nothing else: no operatories,
   * no appointment types, no providers. Those are three list reads whose results
   * this slice does not cache, so warming them would spend requests on nothing.
   *
   * Never throws. An office that could not be reached is a warning and a
   * `{ ok: false }` — the next office still gets its turn, and the Day View is
   * no worse off than it was.
   *
   * @param {string} officeKey
   * @param {{ date?: string }} [opts]
   * @returns {Promise<{ office: string, ok: boolean, date: string, patients: number,
   *                     odReads: number, alreadyCached: number, durationMs: number,
   *                     error: string|null }>}
   */
  async warmOffice(officeKey, opts = {}) {
    const date = opts.date || this.today();
    const startedAt = Date.now();
    const base = { office: officeKey, date, patients: 0, odReads: 0, alreadyCached: 0 };

    let od;
    try {
      // The same resolution the route uses, including assertOfficeMatch — a
      // handle bound to the wrong practice is refused rather than used, because
      // caching patients under the wrong office key is the one failure this
      // whole slice is written to make impossible.
      od = odOffices.assertOfficeMatch(officeKey, odOffices.getOdOffice(officeKey));
    } catch (err) {
      return {
        ...base,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: (err && err.code) || (err && err.message) || 'office unavailable',
      };
    }

    /*
     * Read-only, and attributed as `hyg-warm` so the transport counters can
     * answer "did the warm contend with anybody" separately from the Day View's
     * own traffic. `module` is attribution ONLY and buys no priority; note that
     * it is spread AFTER the caller's opts, which is how it overrides the
     * `module: 'hyg'` odDay sets on its own reads.
     *
     * No `minIntervalMs`: the warm takes the default share of the shared slot
     * and never raises it. See the header.
     */
    const odGet = (path, params, o) =>
      od.client.apiGetRaw(path, params, { ...(o || {}), module: 'hyg-warm', quiet: true });

    try {
      const appts = await odDay.readAppointments(odGet, date);
      if (appts.error && appts.rows.length === 0) {
        return {
          ...base,
          ok: false,
          durationMs: Date.now() - startedAt,
          error: appts.error,
        };
      }

      /** Distinct PatNums, in schedule order — the same order the Day View spends its budget in. */
      const ordered = [...appts.rows].sort((a, b) =>
        String(a.AptDateTime || '').localeCompare(String(b.AptDateTime || ''))
      );
      /** @type {number[]} */
      const patNums = [];
      const seen = new Set();
      for (const row of ordered) {
        const patNum = odDay.odInt(row.PatNum);
        if (patNum !== null && patNum > 0 && !seen.has(patNum)) {
          seen.add(patNum);
          patNums.push(patNum);
        }
      }

      // Through the SAME function the Day View calls, so the entries this
      // populates are exactly the entries that screen will hit. The normalized
      // map it returns is discarded; the cache is the output.
      const read = await odDay.readPatients(odGet, patNums, { office: officeKey });

      return {
        office: officeKey,
        ok: true,
        date,
        patients: patNums.length,
        odReads: read.odReads,
        // Already fresh — a second warm inside the TTL, or a day somebody had
        // already opened. Costs nothing and is worth seeing in the log.
        alreadyCached: read.cacheHits + read.deduped,
        durationMs: Date.now() - startedAt,
        error: null,
      };
    } catch (err) {
      return {
        ...base,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: (err && err.message) || String(err),
      };
    }
  }

  /**
   * One pass: every eligible office, in turn.
   *
   * SEQUENTIAL across offices even though they have separate credentials and
   * would not contend with each other. Two offices in parallel would double the
   * warm's instantaneous footprint for no benefit — nobody is waiting on it, so
   * finishing sooner is worth nothing, and being quieter is worth something.
   *
   * Re-entrancy guarded: an operator who sets a five-minute cron must not get a
   * second pass on top of one that is still running.
   *
   * @param {{ date?: string }} [opts]
   * @returns {Promise<{ skipped?: string, offices: object[], at: string }>}
   */
  async runNow(opts = {}) {
    if (this.running) {
      return { skipped: 'ALREADY_RUNNING', offices: [], at: new Date().toISOString() };
    }
    this.running = true;
    try {
      // Re-read the switch FIRST, every pass — the same discipline
      // retentionScheduler applies before every prune. A runbook can write the
      // control-plane row directly, and the difference between a stale copy and
      // the current value is a practice's real patient data being read at 7:45
      // in the morning after somebody switched it off. Never throws: a control
      // plane we cannot reach leaves the previous value in place.
      await hygPilot.refreshFromDb();

      const offices = this.eligibleOffices();
      if (offices.length === 0) {
        // The normal state until an office is switched on from the Platform
        // Console. Said once per pass rather than silently, so "the warm is
        // not doing anything" has an answer in the log.
        const result = { skipped: 'NO_ELIGIBLE_OFFICES', offices: [], at: new Date().toISOString() };
        this.lastRun = result;
        return result;
      }

      /** @type {object[]} */
      const results = [];
      for (const officeKey of offices) {
        const outcome = await this.warmOffice(officeKey, opts);
        results.push(outcome);

        // ONE LINE PER OFFICE PER PASS. Transition-log volume, like [odhealth]:
        // a per-patient line would be forty lines a morning per office, which is
        // how a useful signal becomes a filtered folder.
        if (outcome.ok) {
          console.log(
            `[hygwarm] office=${outcome.office} date=${outcome.date} ` +
              `patients=${outcome.patients} od_reads=${outcome.odReads} ` +
              `already_cached=${outcome.alreadyCached} ms=${outcome.durationMs}`
          );
        } else {
          // A WARNING, never an error state. The Day View still works; it is
          // merely cold. Nothing downstream consults this outcome.
          console.warn(
            `[hygwarm] office=${outcome.office} date=${outcome.date} warm FAILED ` +
              `after ${outcome.durationMs}ms: ${outcome.error} — the day view is simply cold`
          );
        }
      }

      const result = { offices: results, at: new Date().toISOString() };
      this.lastRun = result;
      return result;
    } finally {
      this.running = false;
    }
  }

  /**
   * The ONLY place this service touches node-cron — isolated exactly as
   * retentionScheduler does it, so start()'s decisions are testable without a
   * live cron task running inside a parallel test process.
   *
   * @param {string} schedule
   * @param {string} timezone
   * @param {() => void} handler
   * @returns {{ stop: () => void }}
   */
  createJob(schedule, timezone, handler) {
    return cron.schedule(schedule, handler, { timezone });
  }

  /**
   * Arm the warm.
   *
   * Deliberately does NOT fire a pass immediately the way odHealthCheck does.
   * That job's first cycle matters because an unprobed office reads `unknown`;
   * this one only makes a screen faster, and a deploy at 2pm firing a full
   * patient fan-out against a live credential — while people are using it — is
   * the opposite of what the warm is for.
   *
   * @returns {boolean} true when a job was armed by this call
   */
  start() {
    if (!warmConfig.isEnabled()) {
      console.log('⏸️  Hygiene day warm disabled (HYG_WARM_DISABLED=true)');
      return false;
    }
    if (this.job) {
      console.log('⚠️ Hygiene day warm already scheduled');
      return false;
    }

    const schedule = warmConfig.schedule();
    const timezone = warmConfig.timezone();

    this.job = this.createJob(schedule, timezone, () =>
      this.runNow().catch((err) =>
        console.error('[hygwarm] pass failed:', (err && err.message) || err)
      )
    );

    const eligible = this.eligibleOffices();
    console.log(
      `⏰ Hygiene day warm scheduled: '${schedule}' (${timezone}) — ` +
        (eligible.length > 0
          ? `warming ${eligible.join(', ')}`
          : 'no office has hygiene switched on, so it will warm nothing')
    );
    return true;
  }

  /** Disarm the warm (SIGTERM / SIGINT / tests). @returns {void} */
  stop() {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
  }

  /**
   * Whether a job is armed, and what it would do. For a status surface and for
   * the tests that assert start()/stop() actually change something.
   * @returns {{ running: boolean, enabled: boolean, schedule: string, timezone: string,
   *             eligibleOffices: string[], lastRun: object|null }}
   */
  getStatus() {
    return {
      running: Boolean(this.job),
      enabled: warmConfig.isEnabled(),
      schedule: warmConfig.schedule(),
      timezone: warmConfig.timezone(),
      eligibleOffices: this.eligibleOffices(),
      lastRun: this.lastRun,
    };
  }

  /** Tests only. @returns {void} */
  resetForTests() {
    this.stop();
    this.lastRun = null;
    this.running = false;
    odPatientCache.resetOdPatientCache();
  }
}

module.exports = new HygDayWarm();
module.exports.HygDayWarm = HygDayWarm;
