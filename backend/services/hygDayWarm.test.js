'use strict';

/**
 * The hygiene morning warm.
 *
 * Two claims here are safety claims rather than performance ones, and they are
 * the reason this file is longer than the feature:
 *
 *   · it warms ONLY offices whose hygiene switch is on — the warm must never be
 *     the thing that starts talking to a practice; and
 *   · it writes NO audit rows, because nobody is looking at anything. The
 *     disclosure happens when a hygienist opens the day, and routes/hyg/day.js
 *     records it there.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const odOffices = require('../config/odOffices');
const tenantDb = require('../platform/tenantDb');
const odDay = require('./hyg/odDay');
const odPatientCache = require('./odPatientCache');
const hygDayWarm = require('./hygDayWarm');

/**
 * A recording Open Dental client. Write verbs are absent entirely — reaching
 * one would be a TypeError, which is the loudest possible failure.
 */
function fakeOd(routes) {
  return {
    calls: [],
    async apiGetRaw(p, params = {}, opts = {}) {
      this.calls.push({ path: p, params, opts });
      const offset = params && params.Offset;
      const keyed = offset !== undefined ? p + '?Offset=' + offset : p;
      const scripted = Object.prototype.hasOwnProperty.call(routes, keyed)
        ? routes[keyed]
        : Object.prototype.hasOwnProperty.call(routes, p)
          ? routes[p]
          : undefined;
      if (scripted === undefined) return { ok: false, status: 404, data: null, error: 'unscripted' };
      if (scripted && typeof scripted === 'object' && !Array.isArray(scripted) && 'ok' in scripted) {
        return scripted;
      }
      return { ok: true, status: 200, data: scripted };
    },
  };
}

/**
 * Run `fn` with a known office configuration.
 *
 * The placeholder customer keys are load-bearing: `isHygOdReady` asks
 * `odBlockReason` first, which looks for a per-office key in process.env, so a
 * test box with none would answer OFFICE_OD_KEY_MISSING for every office and
 * the hygiene switch would never be reached. The VALUES are never used — the
 * client is stubbed.
 *
 * @param {{ hygOffices?: string[], od?: object, unavailable?: string[] }} opts
 * @param {(ctx: { db: { calls: number } }) => Promise<void>} fn
 */
async function withOffices({ hygOffices = [], od = fakeOd({}), unavailable = [] }, fn) {
  const originals = {
    getOdOffice: odOffices.getOdOffice,
    withTenantDb: tenantDb.withTenantDb,
    flags: Object.fromEntries(
      Object.entries(odOffices.OFFICE_OD_SETTINGS).map(([k, v]) => [k, v.hygOdEnabled])
    ),
    keys: {
      OPENDENTAL_CUSTOMER_KEY: process.env.OPENDENTAL_CUSTOMER_KEY,
      OPENDENTAL_CUSTOMER_KEY_VALLEY: process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY,
    },
  };

  process.env.OPENDENTAL_CUSTOMER_KEY = 'test-customer-key-roland';
  process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = 'test-customer-key-valley';
  odOffices.resetOdOfficeCache();

  for (const [key, settings] of Object.entries(odOffices.OFFICE_OD_SETTINGS)) {
    settings.hygOdEnabled = hygOffices.includes(key);
  }

  odOffices.getOdOffice = (key) => {
    if (unavailable.includes(key)) {
      throw new odOffices.OdOfficeError(
        'office ' + key + ' has no customer key',
        'OFFICE_OD_KEY_MISSING',
        'Open Dental credentials are not configured for this office',
        key
      );
    }
    return Object.freeze({
      officeKey: key,
      officeName: key === 'valley' ? 'Riley Family Dental' : 'Roland Family Dental',
      commTypeDefNum: key === 'valley' ? 451 : 486,
      client: od,
    });
  };

  // The ONLY route platform/audit.js has to a database. Counting calls here is
  // a behavioural proof that the warm audits nothing, not a source assertion.
  const db = { calls: 0 };
  tenantDb.withTenantDb = async () => {
    db.calls += 1;
    throw new Error('[hygDayWarm.test] the warm must not touch a tenant database');
  };

  odPatientCache.resetOdPatientCache();
  hygDayWarm.resetForTests();

  try {
    await fn({ db });
  } finally {
    odOffices.getOdOffice = originals.getOdOffice;
    tenantDb.withTenantDb = originals.withTenantDb;
    for (const [key, value] of Object.entries(originals.flags)) {
      odOffices.OFFICE_OD_SETTINGS[key].hygOdEnabled = value;
    }
    for (const [k, v] of Object.entries(originals.keys)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    odOffices.resetOdOfficeCache();
    odPatientCache.resetOdPatientCache();
    hygDayWarm.resetForTests();
  }
}

/** A day of synthetic appointments. Staging fixture PatNums only. */
function dayRoutes(patNums) {
  return {
    '/appointments': patNums.map((patNum, i) => ({
      AptNum: 900100 + i,
      PatNum: patNum,
      AptStatus: 'Scheduled',
      Pattern: 'XXXXXXXXXXXX',
      Op: 2,
      AptDateTime: '2026-09-08 0' + (8 + i) + ':00:00',
    })),
    ...Object.fromEntries(
      patNums.map((patNum) => [
        '/patients/' + patNum,
        { PatNum: patNum, LName: 'Test 2', FName: 'Stedi', Premed: false, MedUrgNote: '' },
      ])
    ),
  };
}

// ─── The switch ──────────────────────────────────────────────────────────────

test('with no office switched on for hygiene, the warm touches NOTHING', async () => {
  // The shipped state: hygOdEnabled is false everywhere. A warm that talked to
  // a practice before Beau turned that practice on would be the module reaching
  // a database nobody had authorised it to reach.
  const od = fakeOd(dayRoutes([12827]));
  await withOffices({ hygOffices: [], od }, async () => {
    const result = await hygDayWarm.runNow({ date: '2026-09-08' });
    assert.equal(result.skipped, 'NO_ELIGIBLE_OFFICES');
    assert.deepEqual(od.calls, [], 'not one Open Dental request');
  });
});

test('an office switched on for hygiene is warmed; the one beside it is not', async () => {
  const od = fakeOd(dayRoutes([12827, 12828]));
  await withOffices({ hygOffices: ['roland'], od }, async () => {
    assert.deepEqual(hygDayWarm.eligibleOffices(), ['roland']);

    const result = await hygDayWarm.runNow({ date: '2026-09-08' });
    assert.equal(result.offices.length, 1);
    assert.equal(result.offices[0].office, 'roland');
    assert.equal(result.offices[0].ok, true);
    assert.equal(result.offices[0].patients, 2);
    assert.equal(result.offices[0].odReads, 2);

    // Warmed for roland, and ONLY for roland — the cross-office rule holds
    // through the warm exactly as it does through the cache.
    assert.equal(odPatientCache.hasFresh('roland', 12827), true);
    assert.equal(odPatientCache.hasFresh('valley', 12827), false);
  });
});

test('an office whose credentials are missing is skipped, not guessed at', async () => {
  const od = fakeOd(dayRoutes([12827]));
  await withOffices({ hygOffices: ['roland', 'valley'], od, unavailable: ['valley'] }, async () => {
    const result = await hygDayWarm.runNow({ date: '2026-09-08' });
    const valley = result.offices.find((o) => o.office === 'valley');
    assert.equal(valley.ok, false);
    assert.equal(valley.error, 'OFFICE_OD_KEY_MISSING');

    // And roland still got its turn — one office's problem is not the pass's.
    const roland = result.offices.find((o) => o.office === 'roland');
    assert.equal(roland.ok, true);
  });
});

// ─── The warm is not a disclosure ────────────────────────────────────────────

test('warming writes NO audit rows — nobody is looking at anything', async () => {
  /*
   * The mirror image of the rule in services/odPatientCache.js §4. An audit row
   * records a disclosure TO A USER; this is the application fetching at 7:45am
   * on its own initiative, with no actor to attribute it to.
   *
   * `withTenantDb` is platform/audit.js's only route to a database and it
   * THROWS in this harness, so a warm that tried to audit would fail loudly
   * rather than pass with an extra row nobody checked.
   */
  const od = fakeOd(dayRoutes([12827, 12828]));
  await withOffices({ hygOffices: ['roland'], od }, async ({ db }) => {
    const result = await hygDayWarm.runNow({ date: '2026-09-08' });
    assert.equal(result.offices[0].ok, true);
    assert.equal(db.calls, 0, 'the warm reached a tenant database');
  });
});

test('the warm source never imports the audit writer', () => {
  // Belt as well as braces: the behavioural test above only catches a call that
  // actually runs. This catches one added behind a condition.
  const src = fs.readFileSync(path.join(__dirname, 'hygDayWarm.js'), 'utf8');
  // Comments stripped FIRST. This file explains at length why it does not
  // audit, and a scan that read its own reasoning as a violation could only be
  // satisfied by deleting the explanation.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/platform\/audit/.test(code), 'hygDayWarm must not reach platform/audit');
  assert.ok(!/\bauditMany\b|\baudit\s*\(/.test(code), 'hygDayWarm must not call an audit writer');
});

// ─── It must never contend ───────────────────────────────────────────────────

test('the warm never RAISES its share of the shared throttle slot', async () => {
  /*
   * `minIntervalMs` raises a caller's spacing on the per-CREDENTIAL slot that
   * voice, TC and RCM all share (decision D-8). RCM passes 1200 deliberately
   * and a voice lookup waits behind it. A background warm doing the same would
   * push a live phone-path lookup back for a screen nobody is looking at yet.
   */
  const od = fakeOd(dayRoutes([12827, 12828]));
  await withOffices({ hygOffices: ['roland'], od }, async () => {
    await hygDayWarm.runNow({ date: '2026-09-08' });

    assert.ok(od.calls.length > 0);
    for (const call of od.calls) {
      assert.equal(call.opts.minIntervalMs, undefined, call.path + ' raised its throttle share');
      // Attributed separately so the transport counters can answer "did the
      // warm contend with anybody" apart from the Day View's own traffic.
      assert.equal(call.opts.module, 'hyg-warm');
    }
  });
});

test('a warm makes the day view free — the same patients cost zero reads after', async () => {
  const od = fakeOd(dayRoutes([12827, 12828]));
  await withOffices({ hygOffices: ['roland'], od }, async () => {
    await hygDayWarm.runNow({ date: '2026-09-08' });

    // The Day View's own read, through the same function the route calls. If
    // the warm populated different entries than the screen looks up, this is
    // where that shows.
    let reads = 0;
    const odGet = async (p) => {
      reads += 1;
      return { ok: false, status: 500, data: null, error: 'the day view should not have asked' };
    };
    const got = await odDay.readPatients(odGet, [12827, 12828], { office: 'roland' });

    assert.equal(reads, 0, 'the warm did not populate what the day view reads');
    assert.equal(got.cacheHits, 2);
    assert.deepEqual(got.failed, []);
  });
});

test('a second pass inside the TTL re-reads nothing', async () => {
  const od = fakeOd(dayRoutes([12827, 12828]));
  await withOffices({ hygOffices: ['roland'], od }, async () => {
    await hygDayWarm.runNow({ date: '2026-09-08' });
    const second = await hygDayWarm.runNow({ date: '2026-09-08' });

    assert.equal(second.offices[0].odReads, 0);
    assert.equal(second.offices[0].alreadyCached, 2);
  });
});

test('an unreadable schedule is a warning, not an outage', async () => {
  const od = fakeOd({ '/appointments': { ok: false, status: 502, data: null, error: 'eConnector down' } });
  await withOffices({ hygOffices: ['roland'], od }, async () => {
    // Must not throw: the Day View still works, it is merely cold — which is
    // exactly where it was before this file existed.
    const result = await hygDayWarm.runNow({ date: '2026-09-08' });
    assert.equal(result.offices[0].ok, false);
    assert.match(result.offices[0].error, /eConnector down/);
  });
});

test('a pass already running is not joined by a second one', async () => {
  const od = fakeOd(dayRoutes([12827]));
  await withOffices({ hygOffices: ['roland'], od }, async () => {
    // An operator who sets a five-minute cron must not stack passes.
    const first = hygDayWarm.runNow({ date: '2026-09-08' });
    const second = await hygDayWarm.runNow({ date: '2026-09-08' });
    assert.equal(second.skipped, 'ALREADY_RUNNING');
    await first;
  });
});

// ─── Scheduling and shutdown ─────────────────────────────────────────────────

test('start arms a job, stop disarms it, and neither is fired at startup', async () => {
  const od = fakeOd(dayRoutes([12827]));
  await withOffices({ hygOffices: ['roland'], od }, async () => {
    assert.equal(hygDayWarm.getStatus().running, false);

    assert.equal(hygDayWarm.start(), true);
    assert.equal(hygDayWarm.getStatus().running, true);
    // Unlike odHealthCheck, start() does NOT fire a pass: a mid-afternoon
    // deploy must not put a patient fan-out on a credential people are using.
    assert.deepEqual(od.calls, []);

    assert.equal(hygDayWarm.start(), false, 'arming twice must be a no-op');

    hygDayWarm.stop();
    assert.equal(hygDayWarm.getStatus().running, false);
  });
});

test('HYG_WARM_DISABLED=true arms nothing', async () => {
  const original = process.env.HYG_WARM_DISABLED;
  process.env.HYG_WARM_DISABLED = 'true';
  try {
    await withOffices({ hygOffices: ['roland'] }, async () => {
      assert.equal(hygDayWarm.start(), false);
      assert.equal(hygDayWarm.getStatus().running, false);
    });
  } finally {
    if (original === undefined) delete process.env.HYG_WARM_DISABLED;
    else process.env.HYG_WARM_DISABLED = original;
  }
});

test('an unparseable schedule falls back to the default rather than never running', () => {
  const warmConfig = require('../config/hygWarm');
  const original = process.env.HYG_WARM_SCHEDULE;
  try {
    process.env.HYG_WARM_SCHEDULE = 'every morning please';
    assert.equal(warmConfig.schedule(), warmConfig.DEFAULT_SCHEDULE);
    process.env.HYG_WARM_SCHEDULE = '30 6 * * *';
    assert.equal(warmConfig.schedule(), '30 6 * * *');
  } finally {
    if (original === undefined) delete process.env.HYG_WARM_SCHEDULE;
    else process.env.HYG_WARM_SCHEDULE = original;
  }
});

test('the warm is stopped on SIGTERM and SIGINT like every other scheduled job', () => {
  // A cron task holding the process open is how a container stops answering
  // SIGTERM and gets killed instead of drained.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const at = src.indexOf(`process.on('${signal}'`);
    assert.ok(at > 0, signal + ' handler missing');
    const body = src.slice(at, at + 500);
    assert.ok(body.includes('hygDayWarm.stop()'), signal + ' does not stop the warm');
  }
});

test("today is the OFFICE's day, not the container's", () => {
  // 04:30 UTC on the 9th is 23:30 Central on the 8th (CDT, UTC-5). A
  // container-clock warm would fetch TOMORROW's schedule, report a healthy
  // pass, and leave the 8am load exactly as cold as it was.
  const original = process.env.OFFICE_TIMEZONE;
  process.env.OFFICE_TIMEZONE = 'America/Chicago';
  try {
    assert.equal(hygDayWarm.today(new Date('2026-09-09T04:30:00Z')), '2026-09-08');
    // The winter side of the same boundary, where the offset is UTC-6.
    assert.equal(hygDayWarm.today(new Date('2026-01-09T05:30:00Z')), '2026-01-08');
  } finally {
    if (original === undefined) delete process.env.OFFICE_TIMEZONE;
    else process.env.OFFICE_TIMEZONE = original;
  }
});

// ─── the pilot switch is read at PASS TIME ───────────────────────────────────

test('the warm re-reads the pilot switch every pass, never a boot snapshot', async () => {
  /*
   * An office switched off at 9am on Tuesday must not still be warmed at 7:45
   * on Wednesday. That is not hypothetical: this job runs unattended, against a
   * real practice's Open Dental, reading real patient records — the very thing
   * somebody switching the office off is trying to stop.
   *
   * The hardcoded floor is left OFF here, so the STORED value in the control
   * plane is the only thing that can make roland eligible. Flipping it behind
   * the warm's back is exactly what a runbook write looks like.
   */
  const registryModule = require('../platform/registry');
  const hygPilot = require('../config/hygPilot');
  const savedGet = registryModule.getPlatformSetting;

  let stored = { roland: true };
  registryModule.getPlatformSetting = async (key) =>
    key === hygPilot.SETTING_KEY
      ? { key, value: stored, updated_at: new Date('2026-09-04T12:00:00Z'), updated_by: 'boss@carein.ai' }
      : null;

  const od = fakeOd(dayRoutes([12827]));
  try {
    await withOffices({ hygOffices: [], od }, async () => {
      const first = await hygDayWarm.runNow({ date: '2026-09-08' });
      assert.equal(first.offices.length, 1, 'the stored switch made roland eligible');
      assert.equal(first.offices[0].office, 'roland');
      const callsAfterFirst = od.calls.length;
      assert.ok(callsAfterFirst > 0);

      // Somebody turns roland off. No restart, no cache reset here.
      stored = { roland: false };

      const second = await hygDayWarm.runNow({ date: '2026-09-08' });
      assert.equal(second.skipped, 'NO_ELIGIBLE_OFFICES');
      assert.equal(od.calls.length, callsAfterFirst, 'not one further Open Dental request');
    });
  } finally {
    registryModule.getPlatformSetting = savedGet;
    hygPilot.resetCacheForTests();
  }
});
