#!/usr/bin/env node
'use strict';

/**
 * MEASURE what a nightly "Coming in" opportunities sweep would build on, per
 * scheduled hygiene patient:
 *   (a) upcoming HYGIENE appointments in a date range,
 *   (b) open treatment-planned procedures,
 *   (c) estimated remaining insurance benefits for the current benefit year.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * READ ONLY. The only Open Dental method this file calls is apiGetRaw (a GET
 * with no write counterpart). It prints COUNTS, TALLIES and FIELD NAMES only —
 * never a name, phone, DOB, fee line, or a PatNum other than the designated
 * test fixtures (roland 12827, valley 7115).
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * It does not reimplement the insurance math. It DRIVES the code a sweep would
 * reuse — routes/tc/odReads.js getTpProcedureRows + getInsuranceSnapshot, and
 * services/hyg/odDay.js pagedList — through a counting wrapper, so the request
 * counts are the real ones, and then measures the gaps in that code against the
 * raw rows it fetched:
 *
 *   Q1 Appointments: range read vs per-day reads (same AptNums?), pages, field
 *      names, and a cross-tab of every hygiene signal Open Dental offers
 *      (appointment IsHygiene, ProvHyg, the operatory's IsHygiene, the
 *      provider's IsSecondary, AppointmentTypeNum).
 *   Q2 TP procedures: requests per patient; how many patients fill a whole
 *      100-row page (getTpProcedureRows reads ONE page — a full page means it
 *      truncated); ProcStatus honoured.
 *   Q3 Benefits: requests per patient by endpoint; benefit-row SHAPES
 *      (BenefitType × TimePeriod × CoverageLevel × category/code present);
 *      how often readBenefits' annual-max/deductible pick lands on a suspect
 *      row (lifetime/ortho/family); MonthRenew distribution; the paid-YTD the
 *      current code computes (DateCP basis, paid only) vs a ProcDate basis
 *      that also counts pending claims; whether /claimprocs honours DateCP
 *      (fewer pages per patient); any precomputed "remaining" field anywhere.
 *   Q4 Cost: measured requests + wall time, projected at 1.0 s and 1.2 s
 *      spacing for the full cohort, and for a trimmed path.
 *
 * RUN WINDOW (enforced before EVERY request, America/Chicago):
 *   - 01:55–04:00 → abort, printing what was gathered (opportunities sync
 *     02:30; workstation hibernates ~03:00).
 *   - :13–:17 past any hour → pause until :18 (voice syncs at :15).
 *   - PROBE_NOT_BEFORE=HH:MM → sleep until that local time before starting,
 *     so a detached run can be launched early and start after clinic hours.
 *
 * HOW TO RUN (inside the staging container — secrets come from Key Vault via
 * loadSecrets(), never a .env):
 *   env PROBE_OFFICES=roland,valley PROBE_APP_ROOT=/app node /tmp/probe-benefits-remaining.js
 * Optional: PROBE_DAYS (7), PROBE_MAX_PATIENTS (250), PROBE_MIN_INTERVAL_MS
 * (1200, floor 1000), PROBE_OUT_DIR (os.tmpdir()).
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const TZ = 'America/Chicago';
/** Designated test patients — the ONLY PatNums this file may print. */
const TEST_PATNUM = Object.freeze({ roland: 12827, valley: 7115 });
const PAGE = 100;

// ── pure helpers (exported for the unit test; no I/O) ────────────────────────

/** Local wall clock in the practice zone. @param {Date} [now] */
function ctClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  /** @type {Record<string, string>} */
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

/**
 * 'abort' inside the protected night window, 'pause' around :15, else 'go'.
 * @param {{ hour: number, minute: number }} c
 */
function windowVerdict(c) {
  if ((c.hour === 1 && c.minute >= 55) || c.hour === 2 || c.hour === 3) return 'abort';
  if (c.minute >= 13 && c.minute <= 17) return 'pause';
  return 'go';
}

/** 'YYYY-MM-DD' + n days, by string arithmetic. */
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return t.toISOString().slice(0, 10);
}

/** OD's null date is 0001-01-01; anything unparseable is null too. */
function odDay(v) {
  const s = String(v || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || s.startsWith('0001')) return null;
  return s;
}

/** @param {unknown} v */
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** @param {unknown} data @returns {any[]} */
function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return [data];
  return [];
}

/** Every key seen across the rows, sorted. @param {any[]} rows */
function keysSeen(rows) {
  const keys = new Set();
  for (const r of rows) if (r && typeof r === 'object') for (const k of Object.keys(r)) keys.add(k);
  return [...keys].sort();
}

/** Count of each distinct key. @param {Iterable<string>} values */
function countBy(values) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const v of values) out[v] = (out[v] || 0) + 1;
  return out;
}

/** @param {number[]} xs */
function stats(xs) {
  if (xs.length === 0) return { n: 0, min: null, median: null, mean: null, p90: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    n: s.length,
    min: s[0],
    median: at(0.5),
    mean: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 100) / 100,
    p90: at(0.9),
    max: s[s.length - 1],
  };
}

/** Bucket a dollar figure WITHOUT ever printing the figure itself. */
function dollarBucket(v) {
  if (v == null) return 'unknown';
  if (v <= 0) return '$0';
  if (v <= 250) return '$1-250';
  if (v <= 500) return '$251-500';
  if (v <= 1000) return '$501-1000';
  if (v <= 2000) return '$1001-2000';
  return '>$2000';
}

/** True if a benefit row is tied to a procedure code or a coverage category. */
function isScoped(b) {
  return Number(b.CodeNum) > 0 || !!b.procCode || Number(b.CovCatNum) > 0 || Number(b.CodeGroupNum) > 0;
}

/** One shape key per benefit row — config shape, never a value. */
function benefitShape(b) {
  return [
    String(b.BenefitType ?? '?'),
    `tp=${String(b.TimePeriod ?? '?')}`,
    `lvl=${String(b.CoverageLevel ?? '?')}`,
    `cat=${Number(b.CovCatNum) > 0 ? 'Y' : 'N'}`,
    `code=${Number(b.CodeNum) > 0 || b.procCode ? 'Y' : 'N'}`,
    `qq=${String(b.QuantityQualifier ?? '?')}`,
    `amt=${b.MonetaryAmt == null ? 'null' : Number(b.MonetaryAmt) < 0 ? '-1' : '>=0'}`,
    `pat=${Number(b.PatPlanNum) > 0 ? 'Y' : 'N'}`,
  ].join('|');
}

/**
 * How trustworthy is readBenefits' pick for ONE plan's merged benefit rows?
 * readBenefits takes the LARGEST un-coded Limitations amount as the annual max
 * (it does not look at CovCatNum, TimePeriod or CoverageLevel) and the FIRST
 * Deductible row (any level, any category).
 */
function benefitPickAudit(rows) {
  const lim = rows.filter(
    (b) => String(b.BenefitType) === 'Limitations' && b.MonetaryAmt != null && Number(b.MonetaryAmt) >= 0 && !b.procCode && !b.CodeNum
  );
  let pick = null;
  for (const b of lim) if (!pick || Number(b.MonetaryAmt) > Number(pick.MonetaryAmt)) pick = b;
  const clean = lim.filter(
    (b) => !isScoped(b) && String(b.TimePeriod) !== 'Lifetime' && String(b.CoverageLevel) !== 'Family'
  );
  const ded = rows.filter((b) => String(b.BenefitType) === 'Deductible' && b.MonetaryAmt != null && Number(b.MonetaryAmt) >= 0);
  const firstDed = ded[0] || null;
  return {
    maxCandidates: lim.length,
    maxCleanCandidates: clean.length,
    maxPickSuspect: !!pick && (isScoped(pick) || String(pick.TimePeriod) === 'Lifetime' || String(pick.CoverageLevel) === 'Family'),
    maxPickReason: !pick
      ? 'none'
      : Number(pick.CovCatNum) > 0
        ? 'category-scoped'
        : String(pick.TimePeriod) === 'Lifetime'
          ? 'lifetime'
          : String(pick.CoverageLevel) === 'Family'
            ? 'family'
            : 'ok',
    dedRows: ded.length,
    dedLevels: ded.map((b) => String(b.CoverageLevel ?? '?')),
    dedPickSuspect: !!firstDed && (isScoped(firstDed) || String(firstDed.CoverageLevel) === 'Family'),
    dedPickReason: !firstDed
      ? 'none'
      : Number(firstDed.CovCatNum) > 0 || Number(firstDed.CodeNum) > 0
        ? 'category-scoped'
        : String(firstDed.CoverageLevel) === 'Family'
          ? 'family'
          : 'ok',
  };
}

/**
 * Usage under two bases for ONE plan, from that plan's claimproc rows.
 *   A "current code": Received|Supplemental, InsPayAmt, DateCP ≥ year start.
 *   B "ProcDate + pending": same paid rows by ProcDate, PLUS sent-but-unpaid
 *     (NotReceived, ClaimNum > 0) at InsPayEst, PLUS Adjustment InsPayAmt —
 *     the rows Open Dental's own "benefits used" display is understood to
 *     count. B is a HYPOTHESIS to check against the OD UI on a test patient.
 * @param {any[]} rows claimprocs already attributed to this plan
 * @param {string} start 'YYYY-MM-DD'
 */
function usageBases(rows, start) {
  const out = { paidDateCP: 0, paidProcDate: 0, pending: 0, pendingRows: 0, adjustment: 0, adjustmentRows: 0, pendingField: null };
  for (const cp of rows) {
    const st = String(cp.Status);
    const dcp = odDay(cp.DateCP);
    const pd = odDay(cp.ProcDate);
    if (st === 'Received' || st === 'Supplemental') {
      if (dcp && dcp >= start) out.paidDateCP += money(cp.InsPayAmt);
      if (pd && pd >= start) out.paidProcDate += money(cp.InsPayAmt);
    } else if (st === 'NotReceived' && Number(cp.ClaimNum) > 0 && pd && pd >= start) {
      const field = cp.InsPayEst !== undefined ? 'InsPayEst' : 'InsEstTotal';
      out.pendingField = field;
      const v = money(cp[field]);
      if (v > 0) out.pending += v;
      out.pendingRows += 1;
    } else if (st === 'Adjustment' && pd && pd >= start) {
      out.adjustment += money(cp.InsPayAmt);
      out.adjustmentRows += 1;
    }
  }
  return out;
}

/** '/inssubs/15019' → '/inssubs/{n}', so counts group by endpoint, not by id. */
function endpointKey(p) {
  return String(p).replace(/\/\d+(?=\/|$)/g, '/{n}');
}

// ── the run ──────────────────────────────────────────────────────────────────

class WindowClosed extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForWindow(log, clock = ctClock) {
  for (;;) {
    const v = windowVerdict(clock());
    if (v === 'go') return;
    if (v === 'abort') throw new WindowClosed('Inside the 01:55–04:00 CT protected window — stopping.');
    log('   … pausing around :15 (voice syncs)');
    await sleep(30000);
  }
}

async function waitUntilNotBefore(hhmm, log) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return;
  const target = Number(m[1]) * 60 + Number(m[2]);
  for (;;) {
    const c = ctClock();
    if (c.hour * 60 + c.minute >= target) return;
    log(`waiting for PROBE_NOT_BEFORE=${hhmm} CT (now ${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')})`);
    await sleep(5 * 60000);
  }
}

async function probeOffice(office, deps, cfg, log) {
  const { odOffices, odReads, odDayMod } = deps;
  const od = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));

  // ── the counting wrapper: every request this office makes goes through here ─
  const calls = [];
  let bucket = 'setup';
  /** @type {Record<string, any[]>} rows captured from ok responses, by endpoint */
  let captured = {};
  /** @type {Record<string, Set<string>>} field NAMES per endpoint, whole run */
  const fieldsByEp = {};
  /** @type {Record<string, number>} claimproc Status across every cohort row */
  const cpStatus = {};
  const get = async (p, params = {}, opts = {}) => {
    await waitForWindow(log, cfg.clock);
    const t0 = Date.now();
    const res = await od.client.apiGetRaw(p, params, {
      timeoutMs: opts.timeoutMs || 30000,
      module: 'benefits-probe',
      minIntervalMs: cfg.minIntervalMs,
      quiet: true,
    });
    const ep = endpointKey(p);
    calls.push({ bucket, ep, status: res.status, ms: Date.now() - t0 });
    if (res.ok) {
      const rows = rowsOf(res.data);
      (captured[ep] = captured[ep] || []).push(...rows);
      const f = (fieldsByEp[ep] = fieldsByEp[ep] || new Set());
      for (const k of keysSeen(rows)) f.add(k);
    }
    return res;
  };
  const started = Date.now();
  const report = { office, window: null, q1: {}, q2: {}, q3: {}, q4: {}, errors: {} };

  // ── Q1: appointments ───────────────────────────────────────────────────────
  const today = (cfg.clock || ctClock)().ymd;
  const dateStart = addDays(today, 1);
  const dateEnd = addDays(today, cfg.days);
  report.window = { dateStart, dateEnd, days: cfg.days };
  log(`\n[${office}] window ${dateStart} → ${dateEnd}`);

  bucket = 'config';
  const ops = await odDayMod.pagedList(get, '/operatories');
  const provs = await odDayMod.pagedList(get, '/providers');
  const types = await odDayMod.pagedList(get, '/appointmenttypes');
  const opHyg = new Map(ops.rows.map((o) => [Number(o.OperatoryNum), odDayMod.odBool(o.IsHygiene)]));
  const provSecondary = new Map(provs.rows.map((p) => [Number(p.ProvNum), odDayMod.odBool(p.IsSecondary)]));
  const typeName = new Map(
    types.rows.map((t) => [Number(t.AppointmentTypeNum), String(t.AppointmentTypeName || t.ItemName || t.Name || '?')])
  );
  report.q1.config = {
    operatories: { rows: ops.rows.length, pages: ops.pages, IsHygiene: countBy(ops.rows.map((o) => String(odDayMod.odBool(o.IsHygiene)))) },
    providers: {
      rows: provs.rows.length,
      pages: provs.pages,
      IsSecondary: countBy(provs.rows.map((p) => String(odDayMod.odBool(p.IsSecondary)))),
      IsHidden: countBy(provs.rows.map((p) => String(odDayMod.odBool(p.IsHidden)))),
    },
    appointmenttypes: { rows: types.rows.length, pages: types.pages, error: types.error },
  };

  bucket = 'appointments-range';
  const range = await odDayMod.pagedList(get, '/appointments', { dateStart, dateEnd });
  bucket = 'appointments-perday';
  const perDay = [];
  for (let i = 1; i <= cfg.days; i += 1) perDay.push(await odDayMod.pagedList(get, '/appointments', { date: addDays(today, i) }));
  const perDayRows = perDay.flatMap((d) => d.rows);
  const rangeIds = new Set(range.rows.map((r) => Number(r.AptNum)));
  const dayIds = new Set(perDayRows.map((r) => Number(r.AptNum)));
  const outside = range.rows.filter((r) => {
    const d = odDay(r.AptDateTime);
    return !d || d < dateStart || d > dateEnd;
  }).length;

  report.q1.rangeRead = {
    params: 'dateStart,dateEnd',
    pages: range.pages,
    rows: range.rows.length,
    truncated: range.truncated,
    error: range.error,
    rowsOutsideWindow: outside,
  };
  report.q1.perDayReads = {
    params: 'date',
    pagesTotal: perDay.reduce((a, d) => a + d.pages, 0),
    pagesPerDay: perDay.map((d) => d.pages),
    rowsPerDay: perDay.map((d) => d.rows.length),
    rows: perDayRows.length,
    inRangeNotPerDay: [...rangeIds].filter((x) => !dayIds.has(x)).length,
    inPerDayNotRange: [...dayIds].filter((x) => !rangeIds.has(x)).length,
  };
  report.q1.fields = keysSeen(range.rows);

  const appts = range.rows.length >= perDayRows.length ? range.rows : perDayRows;
  report.q1.AptStatus = countBy(appts.map((r) => String(r.AptStatus)));
  report.q1.ClinicNum = countBy(appts.map((r) => String(r.ClinicNum)));
  const sched = appts.filter((r) => String(r.AptStatus) === 'Scheduled');
  report.q1.scheduled = {
    rows: sched.length,
    IsHygiene: countBy(sched.map((r) => String(odDayMod.odBool(r.IsHygiene)))),
    ProvHygSet: sched.filter((r) => Number(r.ProvHyg) > 0).length,
    AppointmentTypeSet: sched.filter((r) => Number(r.AppointmentTypeNum) > 0).length,
    // Every hygiene signal at once: apt IsHygiene / ProvHyg>0 / chair IsHygiene / ProvNum is a hygienist.
    signalCrossTab: countBy(
      sched.map(
        (r) =>
          `apt=${odDayMod.odBool(r.IsHygiene)}|provHyg=${Number(r.ProvHyg) > 0}|op=${opHyg.get(Number(r.Op)) ?? 'unknown'}|provIsHygienist=${provSecondary.get(Number(r.ProvNum)) ?? 'unknown'}`
      )
    ),
    // Appointment-type names are practice configuration, not PHI.
    typeByIsHygiene: countBy(
      sched.map((r) => `apt=${odDayMod.odBool(r.IsHygiene)}|type=${Number(r.AppointmentTypeNum) > 0 ? typeName.get(Number(r.AppointmentTypeNum)) || '#unlisted' : '(none)'}`)
    ),
  };

  // The HYG module's rule: the appointment's own IsHygiene, unknown is served.
  const hygPats = [...new Set(sched.filter((r) => odDayMod.odBool(r.IsHygiene) !== false).map((r) => Number(r.PatNum)))].filter(
    (n) => n > 0
  );
  const strictPats = new Set(sched.filter((r) => odDayMod.odBool(r.IsHygiene) === true).map((r) => Number(r.PatNum)));
  const cohort = hygPats.slice(0, cfg.maxPatients);
  report.q1.cohort = {
    distinctPatients_IsHygieneNotFalse: hygPats.length,
    distinctPatients_IsHygieneTrue: strictPats.size,
    probed: cohort.length,
    capped: hygPats.length > cohort.length,
  };
  log(`[${office}] Q1 range rows=${range.rows.length} (pages ${range.pages}) per-day rows=${perDayRows.length}; hygiene cohort=${hygPats.length}`);

  // ── Q2 + Q3, per patient ───────────────────────────────────────────────────
  const perPatient = [];
  const shapes = {};
  const audits = [];
  const monthRenew = [];
  const remainA = [];
  const remainB = [];
  const deltaAB = [];
  const precomputedHits = new Set();
  let biggest = { rows: 0, patNum: null, start: null };
  const tpFullPage = { count: 0, trueRowsOver100: [] };
  const tpStatus = {};

  for (const patNum of cohort) {
    const pp = { tpReq: 0, tpRows: 0, insReq: 0, insByEp: {}, plans: 0, err: null };

    bucket = `tp:${patNum}`;
    const before = calls.length;
    try {
      const tp = await odReads.getTpProcedureRows(get, patNum);
      pp.tpRows = tp.rows.length;
      for (const r of tp.rows) tpStatus[String(r.ProcStatus)] = (tpStatus[String(r.ProcStatus)] || 0) + 1;
      if (tp.rows.length >= PAGE) {
        // getTpProcedureRows reads ONE page. Count what it missed.
        tpFullPage.count += 1;
        let total = tp.rows.length;
        for (let page = 1; page < 20; page += 1) {
          const more = await get('/procedurelogs', { PatNum: patNum, ProcStatus: 'TP', Offset: page * PAGE });
          const n = more.ok ? rowsOf(more.data).length : 0;
          total += n;
          if (n < PAGE) break;
        }
        tpFullPage.trueRowsOver100.push(total);
      }
    } catch (e) {
      pp.err = `tp:${e.odStatus || e.message}`;
    }
    pp.tpReq = calls.length - before;

    bucket = `ins:${patNum}`;
    captured = {};
    const insBefore = calls.length;
    let snap = null;
    try {
      snap = await odReads.getInsuranceSnapshot(get, patNum);
    } catch (e) {
      pp.err = (pp.err ? pp.err + ' ' : '') + `ins:${e.odStatus || e.message}`;
    }
    const insCalls = calls.slice(insBefore);
    pp.insReq = insCalls.length;
    pp.insByEp = countBy(insCalls.map((c) => c.ep));

    for (const [ep, rows] of Object.entries(captured)) {
      for (const k of keysSeen(rows)) if (/remain|used|ytd|annualmax|benefitsleft/i.test(k)) precomputedHits.add(`${ep}.${k}`);
    }
    for (const b of captured['/benefits'] || []) {
      const s = benefitShape(b);
      shapes[s] = (shapes[s] || 0) + 1;
    }

    const cps = captured['/claimprocs'] || [];
    for (const cp of cps) cpStatus[String(cp.Status)] = (cpStatus[String(cp.Status)] || 0) + 1;
    if (snap) {
      pp.plans = snap.plans.length;
      for (const plan of snap.plans) {
        monthRenew.push(plan.monthRenew);
        const benRows = (captured['/benefits'] || []).filter(
          (b) => Number(b.PlanNum) === plan.planNum || (plan.patPlanNum && Number(b.PatPlanNum) === plan.patPlanNum)
        );
        audits.push({ ordinal: plan.ordinal, ...benefitPickAudit(benRows) });

        const start = plan.usage ? plan.usage.benefitYearStart : null;
        if (start) {
          const mine = cps.filter((cp) => Number(cp.InsSubNum) === plan.insSubNum || Number(cp.PlanNum) === plan.planNum);
          const u = usageBases(mine, start);
          if (plan.ordinal === 1 && cps.length > biggest.rows) biggest = { rows: cps.length, patNum, start };
          if (plan.annualMax != null) {
            const a = Math.max(0, plan.annualMax - u.paidDateCP);
            const b = Math.max(0, plan.annualMax - (u.paidProcDate + u.pending + u.adjustment));
            remainA.push(a);
            remainB.push(b);
            deltaAB.push(Math.round(Math.abs(a - b)));
          }
          pp.pendingRows = (pp.pendingRows || 0) + u.pendingRows;
          pp.pendingField = u.pendingField || pp.pendingField || null;
        }
      }
      pp.ytdAvailable = snap.ytdAvailable;
      pp.claimprocRows = cps.length;
    }
    perPatient.push(pp);
  }

  // ── Q3: does /claimprocs honour DateCP? (on the cohort's heaviest history) ─
  bucket = 'datecp-check';
  if (biggest.patNum != null) {
    const all = [];
    let pagesAll = 0;
    for (let page = 0; page < 40; page += 1) {
      const r = await get('/claimprocs', { PatNum: biggest.patNum, Offset: page * PAGE });
      pagesAll += 1;
      const rows = r.ok ? rowsOf(r.data) : [];
      all.push(...rows);
      if (rows.length < PAGE) break;
    }
    const filtered = [];
    let pagesFiltered = 0;
    let status = null;
    for (let page = 0; page < 40; page += 1) {
      const r = await get('/claimprocs', { PatNum: biggest.patNum, DateCP: biggest.start, Offset: page * PAGE });
      pagesFiltered += 1;
      status = r.status;
      const rows = r.ok ? rowsOf(r.data) : [];
      filtered.push(...rows);
      if (rows.length < PAGE) break;
    }
    const expected = all.filter((cp) => (odDay(cp.DateCP) || '') >= biggest.start).length;
    report.q3.dateCpFilter = {
      note: 'measured on the cohort patient with the most claimproc rows (PatNum withheld)',
      status,
      unfilteredRows: all.length,
      unfilteredPages: pagesAll,
      filteredRows: filtered.length,
      filteredPages: pagesFiltered,
      unfilteredRowsWithDateCPOnOrAfterStart: expected,
      filteredRowsBeforeStart: filtered.filter((cp) => (odDay(cp.DateCP) || '0000') < biggest.start).length,
      notReceivedRowsWithNullDateCP: all.filter((cp) => String(cp.Status) === 'NotReceived' && !odDay(cp.DateCP)).length,
    };
  }

  // ── Q3: a precomputed "remaining"? Asked of the TEST patient only ──────────
  bucket = 'precomputed-check';
  const test = TEST_PATNUM[office];
  const fam = await get(`/familymodules/${test}/Insurance`);
  report.q3.familyModulesInsurance = {
    patNum: test,
    status: fam.status,
    ok: fam.ok,
    fields: fam.ok ? keysSeen(rowsOf(fam.data)) : [],
    error: fam.ok ? null : String(fam.error || '').slice(0, 160),
  };
  for (const k of report.q3.familyModulesInsurance.fields) if (/remain|used|ytd|annualmax/i.test(k)) precomputedHits.add(`/familymodules/{n}/Insurance.${k}`);
  // The test patient's own computed numbers are printable (designated fixture).
  try {
    const s = await odReads.getInsuranceSnapshot(get, test);
    report.q3.testPatientSnapshot = s.plans.map((p) => ({
      ordinal: p.ordinal,
      monthRenew: p.monthRenew,
      annualMax: p.annualMax,
      deductible: p.deductible,
      usage: p.usage,
      remainingMax: p.remainingMax,
      remainingDeductible: p.remainingDeductible,
      unreadable: p.unreadable,
    }));
  } catch (e) {
    report.q3.testPatientSnapshot = { error: String(e.odStatus || e.message) };
  }
  report.q3.endpointFields = Object.fromEntries(Object.entries(fieldsByEp).map(([ep, set]) => [ep, [...set].sort()]));
  report.q3.claimprocStatusAcrossCohort = cpStatus;

  // ── roll-ups ───────────────────────────────────────────────────────────────
  const withIns = perPatient.filter((p) => p.plans > 0);
  report.q2 = {
    patients: perPatient.length,
    requestsPerPatient: stats(perPatient.map((p) => p.tpReq)),
    tpRowsPerPatient: stats(perPatient.map((p) => p.tpRows)),
    patientsWithAnyTP: perPatient.filter((p) => p.tpRows > 0).length,
    patientsFillingOnePage: tpFullPage.count,
    trueTpRowsForThose: tpFullPage.trueRowsOver100,
    ProcStatusSeen: tpStatus,
  };
  report.q3.cohort = {
    patients: perPatient.length,
    withAnyPlan: withIns.length,
    plansPerInsuredPatient: stats(withIns.map((p) => p.plans)),
    requestsPerPatient: stats(perPatient.map((p) => p.insReq)),
    requestsPerInsuredPatient: stats(withIns.map((p) => p.insReq)),
    requestsByEndpointTotal: countBy(
      perPatient.flatMap((p) => Object.entries(p.insByEp).flatMap(([ep, n]) => Array(n).fill(ep)))
    ),
    claimprocRowsPerInsuredPatient: stats(withIns.map((p) => p.claimprocRows || 0)),
    errors: countBy(perPatient.filter((p) => p.err).map((p) => p.err.replace(/\d{4,}/g, '#'))),
  };
  report.q3.benefits = {
    shapes: Object.fromEntries(Object.entries(shapes).sort((a, b) => b[1] - a[1])),
    plansAudited: audits.length,
    maxPick: countBy(audits.map((a) => a.maxPickReason)),
    plansWithMultipleCleanMaxCandidates: audits.filter((a) => a.maxCleanCandidates > 1).length,
    dedPick: countBy(audits.map((a) => a.dedPickReason)),
    dedLevelSets: countBy(audits.map((a) => a.dedLevels.join('+') || '(none)')),
  };
  report.q3.benefitYear = { MonthRenew: countBy(monthRenew.map((m) => (Number(m) > 0 ? `month ${m}` : 'calendar (0)'))) };
  report.q3.remaining = {
    plansWithKnownMax: remainA.length,
    currentCode_DateCP_paidOnly: countBy(remainA.map(dollarBucket)),
    procDate_plusPending_plusAdj: countBy(remainB.map(dollarBucket)),
    absDeltaBetweenBases: stats(deltaAB),
    plansWhereBasesDifferBy50Plus: deltaAB.filter((d) => d >= 50).length,
    patientsWithPendingClaimRows: perPatient.filter((p) => (p.pendingRows || 0) > 0).length,
    pendingEstimateField: [...new Set(perPatient.map((p) => p.pendingField).filter(Boolean))],
  };
  report.q3.precomputedRemainingFieldsFound = [...precomputedHits].sort();

  // ── Q4: cost ───────────────────────────────────────────────────────────────
  const elapsed = Date.now() - started;
  const fixed = calls.filter((c) => c.bucket === 'config' || c.bucket === 'appointments-range').length;
  const perPat = perPatient.map((p) => p.tpReq + p.insReq);
  const carriers = report.q3.cohort.requestsByEndpointTotal['/carriers/{n}'] || 0;
  const meanPer = perPat.length ? perPat.reduce((a, b) => a + b, 0) / perPat.length : 0;
  const trimmedMean = perPat.length ? (perPat.reduce((a, b) => a + b, 0) - carriers) / perPat.length : 0;
  const n = hygPats.length;
  const proj = (perPatient_, spacingMs) => Math.round(((fixed + n * perPatient_) * spacingMs) / 60000 * 10) / 10;
  report.q4 = {
    requestsTotal: calls.length,
    elapsedMinutes: Math.round((elapsed / 60000) * 10) / 10,
    statuses: countBy(calls.map((c) => String(c.status))),
    rateLimited429: calls.filter((c) => c.status === 429).length,
    fixedRequests_configPlusRangeRead: fixed,
    requestsPerPatient: stats(perPat),
    sweepRequests_full: Math.round(fixed + n * meanPer),
    sweepMinutes_full_at1000ms: proj(meanPer, 1000),
    sweepMinutes_full_at1200ms: proj(meanPer, 1200),
    sweepRequests_noCarrierCall: Math.round(fixed + n * trimmedMean),
    sweepMinutes_noCarrierCall_at1200ms: proj(trimmedMean, 1200),
    cohortPatients: n,
  };
  log(`[${office}] done: ${calls.length} requests in ${report.q4.elapsedMinutes} min`);
  return report;
}

async function main({ env = process.env, log = console.log } = {}) {
  const APP_ROOT = env.PROBE_APP_ROOT || path.join(__dirname, '..');
  const offices = String(env.PROBE_OFFICES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const cfg = {
    days: Math.max(1, Math.min(14, Number(env.PROBE_DAYS) || 7)),
    maxPatients: Math.max(1, Number(env.PROBE_MAX_PATIENTS) || 250),
    // A floor, never lowered: OD's documented rate is 1 req/s per credential.
    minIntervalMs: Math.max(1000, Number(env.PROBE_MIN_INTERVAL_MS) || 1200),
  };
  for (const o of offices) {
    if (!Object.prototype.hasOwnProperty.call(TEST_PATNUM, o)) {
      throw new Error(`Refusing to run: PROBE_OFFICES must name only ${Object.keys(TEST_PATNUM).join(', ')}`);
    }
  }
  if (offices.length === 0) throw new Error('Refusing to run: set PROBE_OFFICES=roland,valley');

  await waitUntilNotBefore(env.PROBE_NOT_BEFORE, log);
  await waitForWindow(log);

  // Required here, not at the top: requiring this file must load no OD config.
  const odOffices = require(path.join(APP_ROOT, 'config/odOffices'));
  const { loadSecrets } = require(path.join(APP_ROOT, 'config/secrets'));
  const odReads = require(path.join(APP_ROOT, 'routes/tc/odReads'));
  const odDayMod = require(path.join(APP_ROOT, 'services/hyg/odDay'));
  await loadSecrets();

  const outDir = env.PROBE_OUT_DIR || os.tmpdir();
  const reports = [];
  for (const office of offices) {
    let report;
    try {
      report = await probeOffice(office, { odOffices, odReads, odDayMod }, cfg, log);
    } catch (e) {
      report = { office, aborted: e instanceof WindowClosed ? 'window' : 'error', error: String(e && e.message).slice(0, 300) };
    }
    reports.push(report);
    fs.writeFileSync(path.join(outDir, `benefits-probe-${office}.json`), JSON.stringify(report, null, 2));
    if (report.aborted) break;
  }
  log('\n===BENEFITS-PROBE-JSON-BEGIN===');
  log(JSON.stringify({ ranAt: new Date().toISOString(), cfg, reports }, null, 2));
  log('===BENEFITS-PROBE-JSON-END===');
}

// Guarded, so requiring this file reaches Open Dental for nothing.
if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message);
    process.exit(1);
  });
}

module.exports = {
  main,
  probeOffice,
  ctClock,
  windowVerdict,
  addDays,
  odDay,
  keysSeen,
  countBy,
  stats,
  dollarBucket,
  benefitShape,
  benefitPickAudit,
  usageBases,
  endpointKey,
  TEST_PATNUM,
};
