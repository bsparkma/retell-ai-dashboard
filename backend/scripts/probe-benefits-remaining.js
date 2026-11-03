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
 *   env PROBE_OFFICES=roland,valley PROBE_APP_ROOT=/app \
 *       PROBE_CHECKPOINT=/data/probe-benefits-results.json node /tmp/probe-benefits-remaining.js
 * PROBE_CHECKPOINT is REQUIRED: results are checkpointed there after every
 * phase and every patient, and a relaunch with the same settings RESUMES from
 * it (see "checkpointing" below). Point it at durable storage — never /tmp.
 * Optional: PROBE_DAYS (7), PROBE_MAX_PATIENTS (250), PROBE_MIN_INTERVAL_MS
 * (1200, floor 1000), PROBE_NOT_BEFORE (HH:MM CT).
 */

const path = require('node:path');
const fs = require('node:fs');

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

// ── checkpointing ────────────────────────────────────────────────────────────
//
// Results are checkpointed to ONE durable file (PROBE_CHECKPOINT — on staging,
// the /data AzureFile volume) after Q1, after EVERY patient, after each later
// phase and at the end of each office, so a container replacement loses at most
// one patient's reads. On relaunch the file is read back and the run RESUMES.
//
// The file holds aggregates, anonymous per-patient counts, and field names —
// never a cohort PatNum. That is why resume cannot store the cohort: it
// re-reads the appointments for the SAME pinned window, rebuilds the cohort by
// the same rule, and continues from the saved patient index. If the schedule
// changed in between, the drift is recorded in `resumes`, not hidden.

const CHECKPOINT_VERSION = 1;

/** A fresh per-office checkpoint. Everything in it is PHI-free by construction. */
function newOfficeState() {
  return {
    phase: 'q1', // q1 → patients → datecp → precomputed → done
    window: null,
    cohortSource: null, // 'range' | 'perday' — which read Q1 built the cohort from
    cohortSize: null,
    patientsDone: 0,
    resumes: [],
    report: { q1: {}, q2: {}, q3: {}, q4: {}, errors: {} },
    acc: {
      calls: [], // { b: bucket (no PatNum), ep, s: status, ms }
      elapsedMs: 0,
      perPatient: [],
      shapes: {},
      audits: [],
      monthRenew: [],
      remainBucketsA: {},
      remainBucketsB: {},
      plansWithKnownMax: 0,
      deltaAB: [],
      precomputedHits: [],
      biggest: { rows: 0, idx: null, start: null }, // an INDEX into the cohort, never a PatNum
      tpFullPage: { count: 0, trueRowsOver100: [] },
      tpStatus: {},
      cpStatus: {},
      fieldsByEp: {},
    },
  };
}

/** Atomic where the filesystem allows (tmp + rename); a plain write where it does not. */
function writeCheckpoint(file, doc) {
  const text = JSON.stringify(doc, null, 1);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (_e) {
    fs.writeFileSync(file, text);
  }
}

function readCheckpoint(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The window as reported: the pinned `today` stays in the checkpoint only. */
function publicWindow(w) {
  return w ? { dateStart: w.dateStart, dateEnd: w.dateEnd, days: w.days } : null;
}

/** Q1's cohort rule, shared by the first pass and by a resume. */
function buildCohort(appts, odDayMod, maxPatients) {
  const sched = appts.filter((r) => String(r.AptStatus) === 'Scheduled');
  // The HYG module's rule: the appointment's own IsHygiene, unknown is served.
  const hygPats = [...new Set(sched.filter((r) => odDayMod.odBool(r.IsHygiene) !== false).map((r) => Number(r.PatNum)))].filter(
    (n) => n > 0
  );
  const strictPats = new Set(sched.filter((r) => odDayMod.odBool(r.IsHygiene) === true).map((r) => Number(r.PatNum)));
  return { sched, hygPats, strictPats, cohort: hygPats.slice(0, maxPatients) };
}

/**
 * @param {string} office
 * @param {{odOffices:any, odReads:any, odDayMod:any}} deps
 * @param {{days:number, maxPatients:number, minIntervalMs:number, clock?:Function}} cfg
 * @param {(s:string)=>void} log
 * @param {{state?: ReturnType<typeof newOfficeState>, save?: ()=>void}} [ck]
 *   state is mutated in place; save() is called at every checkpoint.
 */
async function probeOffice(office, deps, cfg, log, ck = {}) {
  const { odOffices, odReads, odDayMod } = deps;
  const st = ck.state || newOfficeState();
  const acc = st.acc;
  const report = st.report;
  let segStart = Date.now();
  const save = () => {
    const now = Date.now();
    acc.elapsedMs += now - segStart;
    segStart = now;
    if (ck.save) ck.save();
  };
  if (st.phase === 'done') return { office, window: publicWindow(st.window), ...report };

  const od = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));

  // ── the counting wrapper: every request this office makes goes through here ─
  let bucket = 'setup';
  /** rows captured from ok responses, by endpoint — this patient only, in memory only */
  let captured = {};
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
    acc.calls.push({ b: bucket, ep, s: res.status, ms: Date.now() - t0 });
    if (res.ok) {
      const rows = rowsOf(res.data);
      (captured[ep] = captured[ep] || []).push(...rows);
      const f = new Set(acc.fieldsByEp[ep] || []);
      for (const k of keysSeen(rows)) f.add(k);
      acc.fieldsByEp[ep] = [...f].sort();
    }
    return res;
  };

  // The window is pinned on the first pass, so a resume reads the same days.
  if (!st.window) {
    const today = (cfg.clock || ctClock)().ymd;
    st.window = { today, dateStart: addDays(today, 1), dateEnd: addDays(today, cfg.days), days: cfg.days };
  }
  const { today, dateStart, dateEnd } = st.window;
  log(`\n[${office}] window ${dateStart} → ${dateEnd} (phase ${st.phase}, patients done ${st.patientsDone})`);

  let cohort;
  if (st.phase === 'q1') {
    // ── Q1: appointments ─────────────────────────────────────────────────────
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

    st.cohortSource = range.rows.length >= perDayRows.length ? 'range' : 'perday';
    const appts = st.cohortSource === 'range' ? range.rows : perDayRows;
    report.q1.AptStatus = countBy(appts.map((r) => String(r.AptStatus)));
    report.q1.ClinicNum = countBy(appts.map((r) => String(r.ClinicNum)));
    const built = buildCohort(appts, odDayMod, cfg.maxPatients);
    const sched = built.sched;
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
    cohort = built.cohort;
    report.q1.cohort = {
      distinctPatients_IsHygieneNotFalse: built.hygPats.length,
      distinctPatients_IsHygieneTrue: built.strictPats.size,
      probed: cohort.length,
      capped: built.hygPats.length > cohort.length,
    };
    st.cohortSize = built.hygPats.length;
    log(`[${office}] Q1 range rows=${range.rows.length} (pages ${range.pages}) per-day rows=${perDayRows.length}; hygiene cohort=${built.hygPats.length}`);
    st.phase = 'patients';
    save();
  } else if (st.phase === 'patients' || st.phase === 'datecp') {
    // ── resume: rebuild the cohort from the same pinned window ───────────────
    bucket = 'resume';
    let appts;
    if (st.cohortSource === 'perday') {
      appts = [];
      for (let i = 1; i <= st.window.days; i += 1) appts.push(...(await odDayMod.pagedList(get, '/appointments', { date: addDays(today, i) })).rows);
    } else {
      appts = (await odDayMod.pagedList(get, '/appointments', { dateStart, dateEnd })).rows;
    }
    const built = buildCohort(appts, odDayMod, cfg.maxPatients);
    cohort = built.cohort;
    st.resumes.push({
      at: new Date().toISOString(),
      phase: st.phase,
      patientsDone: st.patientsDone,
      cohortSizeBefore: st.cohortSize,
      cohortSizeNow: built.hygPats.length,
    });
    log(`[${office}] resuming at patient ${st.patientsDone}/${cohort.length} (cohort was ${st.cohortSize}, now ${built.hygPats.length})`);
    save();
  }

  // ── Q2 + Q3, per patient ───────────────────────────────────────────────────
  if (st.phase === 'patients') {
    for (let i = st.patientsDone; i < cohort.length; i += 1) {
      const patNum = cohort[i];
      const pp = { tpReq: 0, tpRows: 0, insReq: 0, insByEp: {}, plans: 0, err: null };

      bucket = 'tp';
      const before = acc.calls.length;
      try {
        const tp = await odReads.getTpProcedureRows(get, patNum);
        pp.tpRows = tp.rows.length;
        for (const r of tp.rows) acc.tpStatus[String(r.ProcStatus)] = (acc.tpStatus[String(r.ProcStatus)] || 0) + 1;
        if (tp.rows.length >= PAGE) {
          // getTpProcedureRows reads ONE page. Count what it missed.
          acc.tpFullPage.count += 1;
          let total = tp.rows.length;
          for (let page = 1; page < 20; page += 1) {
            const more = await get('/procedurelogs', { PatNum: patNum, ProcStatus: 'TP', Offset: page * PAGE });
            const n = more.ok ? rowsOf(more.data).length : 0;
            total += n;
            if (n < PAGE) break;
          }
          acc.tpFullPage.trueRowsOver100.push(total);
        }
      } catch (e) {
        pp.err = `tp:${e.odStatus || e.message}`;
      }
      pp.tpReq = acc.calls.length - before;

      bucket = 'ins';
      captured = {};
      const insBefore = acc.calls.length;
      let snap = null;
      try {
        snap = await odReads.getInsuranceSnapshot(get, patNum);
      } catch (e) {
        pp.err = (pp.err ? pp.err + ' ' : '') + `ins:${e.odStatus || e.message}`;
      }
      const insCalls = acc.calls.slice(insBefore);
      pp.insReq = insCalls.length;
      pp.insByEp = countBy(insCalls.map((c) => c.ep));

      const hits = new Set(acc.precomputedHits);
      for (const [ep, rows] of Object.entries(captured)) {
        for (const k of keysSeen(rows)) if (/remain|used|ytd|annualmax|benefitsleft/i.test(k)) hits.add(`${ep}.${k}`);
      }
      acc.precomputedHits = [...hits].sort();
      for (const b of captured['/benefits'] || []) {
        const s = benefitShape(b);
        acc.shapes[s] = (acc.shapes[s] || 0) + 1;
      }

      const cps = captured['/claimprocs'] || [];
      for (const cp of cps) acc.cpStatus[String(cp.Status)] = (acc.cpStatus[String(cp.Status)] || 0) + 1;
      if (snap) {
        pp.plans = snap.plans.length;
        for (const plan of snap.plans) {
          acc.monthRenew.push(plan.monthRenew);
          const benRows = (captured['/benefits'] || []).filter(
            (b) => Number(b.PlanNum) === plan.planNum || (plan.patPlanNum && Number(b.PatPlanNum) === plan.patPlanNum)
          );
          acc.audits.push({ ordinal: plan.ordinal, ...benefitPickAudit(benRows) });

          const start = plan.usage ? plan.usage.benefitYearStart : null;
          if (start) {
            const mine = cps.filter((cp) => Number(cp.InsSubNum) === plan.insSubNum || Number(cp.PlanNum) === plan.planNum);
            const u = usageBases(mine, start);
            if (plan.ordinal === 1 && cps.length > acc.biggest.rows) acc.biggest = { rows: cps.length, idx: i, start };
            if (plan.annualMax != null) {
              const a = Math.max(0, plan.annualMax - u.paidDateCP);
              const b = Math.max(0, plan.annualMax - (u.paidProcDate + u.pending + u.adjustment));
              // Buckets only — a per-patient dollar figure never reaches the checkpoint.
              acc.remainBucketsA[dollarBucket(a)] = (acc.remainBucketsA[dollarBucket(a)] || 0) + 1;
              acc.remainBucketsB[dollarBucket(b)] = (acc.remainBucketsB[dollarBucket(b)] || 0) + 1;
              acc.plansWithKnownMax += 1;
              acc.deltaAB.push(Math.round(Math.abs(a - b)));
            }
            pp.pendingRows = (pp.pendingRows || 0) + u.pendingRows;
            pp.pendingField = u.pendingField || pp.pendingField || null;
          }
        }
        pp.ytdAvailable = snap.ytdAvailable;
        pp.claimprocRows = cps.length;
      }
      if (pp.err) pp.err = pp.err.replace(/\d{4,}/g, '#');
      acc.perPatient.push(pp);
      st.patientsDone = i + 1;
      save();
    }
    st.phase = 'datecp';
    save();
  }

  // ── Q3: does /claimprocs honour DateCP? (on the cohort's heaviest history) ─
  if (st.phase === 'datecp') {
    bucket = 'datecp-check';
    const big = acc.biggest;
    const patNum = big.idx != null && cohort && big.idx < cohort.length ? cohort[big.idx] : null;
    if (patNum != null) {
      const all = [];
      let pagesAll = 0;
      for (let page = 0; page < 40; page += 1) {
        const r = await get('/claimprocs', { PatNum: patNum, Offset: page * PAGE });
        pagesAll += 1;
        const rows = r.ok ? rowsOf(r.data) : [];
        all.push(...rows);
        if (rows.length < PAGE) break;
      }
      const filtered = [];
      let pagesFiltered = 0;
      let status = null;
      for (let page = 0; page < 40; page += 1) {
        const r = await get('/claimprocs', { PatNum: patNum, DateCP: big.start, Offset: page * PAGE });
        pagesFiltered += 1;
        status = r.status;
        const rows = r.ok ? rowsOf(r.data) : [];
        filtered.push(...rows);
        if (rows.length < PAGE) break;
      }
      const expected = all.filter((cp) => (odDay(cp.DateCP) || '') >= big.start).length;
      report.q3.dateCpFilter = {
        note: 'measured on the cohort patient with the most claimproc rows (PatNum withheld)',
        status,
        unfilteredRows: all.length,
        unfilteredPages: pagesAll,
        filteredRows: filtered.length,
        filteredPages: pagesFiltered,
        unfilteredRowsWithDateCPOnOrAfterStart: expected,
        filteredRowsBeforeStart: filtered.filter((cp) => (odDay(cp.DateCP) || '0000') < big.start).length,
        notReceivedRowsWithNullDateCP: all.filter((cp) => String(cp.Status) === 'NotReceived' && !odDay(cp.DateCP)).length,
      };
    }
    st.phase = 'precomputed';
    save();
  }

  // ── Q3: a precomputed "remaining"? Asked of the TEST patient only ──────────
  if (st.phase === 'precomputed') {
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
    const hits = new Set(acc.precomputedHits);
    for (const k of report.q3.familyModulesInsurance.fields) if (/remain|used|ytd|annualmax/i.test(k)) hits.add(`/familymodules/{n}/Insurance.${k}`);
    acc.precomputedHits = [...hits].sort();
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
    rollUp(report, acc, st);
    st.phase = 'done';
    save();
    log(`[${office}] done: ${acc.calls.length} requests in ${report.q4.elapsedMinutes} min`);
  }
  return { office, window: publicWindow(st.window), ...report };
}

/** Every roll-up is a pure function of the checkpointed accumulators. */
function rollUp(report, acc, st) {
  const perPatient = acc.perPatient;
  const calls = acc.calls;
  report.q3.endpointFields = acc.fieldsByEp;
  report.q3.claimprocStatusAcrossCohort = acc.cpStatus;
  const withIns = perPatient.filter((p) => p.plans > 0);
  report.q2 = {
    patients: perPatient.length,
    requestsPerPatient: stats(perPatient.map((p) => p.tpReq)),
    tpRowsPerPatient: stats(perPatient.map((p) => p.tpRows)),
    patientsWithAnyTP: perPatient.filter((p) => p.tpRows > 0).length,
    patientsFillingOnePage: acc.tpFullPage.count,
    trueTpRowsForThose: acc.tpFullPage.trueRowsOver100,
    ProcStatusSeen: acc.tpStatus,
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
    errors: countBy(perPatient.filter((p) => p.err).map((p) => p.err)),
  };
  report.q3.benefits = {
    shapes: Object.fromEntries(Object.entries(acc.shapes).sort((a, b) => b[1] - a[1])),
    plansAudited: acc.audits.length,
    maxPick: countBy(acc.audits.map((a) => a.maxPickReason)),
    plansWithMultipleCleanMaxCandidates: acc.audits.filter((a) => a.maxCleanCandidates > 1).length,
    dedPick: countBy(acc.audits.map((a) => a.dedPickReason)),
    dedLevelSets: countBy(acc.audits.map((a) => a.dedLevels.join('+') || '(none)')),
  };
  report.q3.benefitYear = { MonthRenew: countBy(acc.monthRenew.map((m) => (Number(m) > 0 ? `month ${m}` : 'calendar (0)'))) };
  report.q3.remaining = {
    plansWithKnownMax: acc.plansWithKnownMax,
    currentCode_DateCP_paidOnly: acc.remainBucketsA,
    procDate_plusPending_plusAdj: acc.remainBucketsB,
    absDeltaBetweenBases: stats(acc.deltaAB),
    plansWhereBasesDifferBy50Plus: acc.deltaAB.filter((d) => d >= 50).length,
    patientsWithPendingClaimRows: perPatient.filter((p) => (p.pendingRows || 0) > 0).length,
    pendingEstimateField: [...new Set(perPatient.map((p) => p.pendingField).filter(Boolean))],
  };
  report.q3.precomputedRemainingFieldsFound = acc.precomputedHits;

  // ── Q4: cost ───────────────────────────────────────────────────────────────
  const fixed = calls.filter((c) => c.b === 'config' || c.b === 'appointments-range').length;
  const perPat = perPatient.map((p) => p.tpReq + p.insReq);
  const carriers = report.q3.cohort.requestsByEndpointTotal['/carriers/{n}'] || 0;
  const meanPer = perPat.length ? perPat.reduce((a, b) => a + b, 0) / perPat.length : 0;
  const trimmedMean = perPat.length ? (perPat.reduce((a, b) => a + b, 0) - carriers) / perPat.length : 0;
  const n = st.cohortSize || 0;
  const proj = (perPatient_, spacingMs) => Math.round(((fixed + n * perPatient_) * spacingMs) / 60000 * 10) / 10;
  report.q4 = {
    requestsTotal: calls.length,
    elapsedMinutes: Math.round((acc.elapsedMs / 60000) * 10) / 10,
    resumed: st.resumes.length,
    statuses: countBy(calls.map((c) => String(c.s))),
    rateLimited429: calls.filter((c) => c.s === 429).length,
    fixedRequests_configPlusRangeRead: fixed,
    requestsPerPatient: stats(perPat),
    sweepRequests_full: Math.round(fixed + n * meanPer),
    sweepMinutes_full_at1000ms: proj(meanPer, 1000),
    sweepMinutes_full_at1200ms: proj(meanPer, 1200),
    sweepRequests_noCarrierCall: Math.round(fixed + n * trimmedMean),
    sweepMinutes_noCarrierCall_at1200ms: proj(trimmedMean, 1200),
    cohortPatients: n,
  };
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
  const file = String(env.PROBE_CHECKPOINT || '').trim();
  if (!file) throw new Error('Refusing to run: set PROBE_CHECKPOINT to a durable path (staging: /data/probe-benefits-results.json)');

  // Resume when the file is this same run; refuse rather than overwrite another run's results.
  let doc = readCheckpoint(file);
  if (doc) {
    const same =
      doc.version === CHECKPOINT_VERSION &&
      doc.cfg && doc.cfg.days === cfg.days && doc.cfg.maxPatients === cfg.maxPatients &&
      JSON.stringify(doc.offices && Object.keys(doc.offices)) === JSON.stringify(offices);
    if (!same) throw new Error(`Refusing to run: ${file} holds a different run (move it aside to start fresh)`);
    log(`resuming from ${file}: ${offices.map((o) => `${o}=${doc.offices[o].phase}`).join(' ')}`);
  } else {
    doc = {
      version: CHECKPOINT_VERSION,
      startedAt: new Date().toISOString(),
      cfg,
      offices: Object.fromEntries(offices.map((o) => [o, newOfficeState()])),
    };
  }
  const save = () => {
    doc.updatedAt = new Date().toISOString();
    writeCheckpoint(file, doc);
  };
  save(); // proves the path is writable before anything reaches Open Dental

  await waitUntilNotBefore(env.PROBE_NOT_BEFORE, log);
  await waitForWindow(log);

  // Required here, not at the top: requiring this file must load no OD config.
  const odOffices = require(path.join(APP_ROOT, 'config/odOffices'));
  const { loadSecrets } = require(path.join(APP_ROOT, 'config/secrets'));
  const odReads = require(path.join(APP_ROOT, 'routes/tc/odReads'));
  const odDayMod = require(path.join(APP_ROOT, 'services/hyg/odDay'));
  await loadSecrets();

  for (const office of offices) {
    const state = doc.offices[office];
    delete state.aborted;
    try {
      await probeOffice(office, { odOffices, odReads, odDayMod }, cfg, log, { state, save });
    } catch (e) {
      state.aborted = { kind: e instanceof WindowClosed ? 'window' : 'error', error: String(e && e.message).slice(0, 300).replace(/\d{4,}/g, '#'), at: new Date().toISOString() };
      save();
      log(`[${office}] stopped (${state.aborted.kind}) at phase ${state.phase}; relaunch to resume`);
      break;
    }
  }
  const done = offices.every((o) => doc.offices[o].phase === 'done');
  doc.complete = done;
  if (done) doc.completedAt = doc.completedAt || new Date().toISOString();
  save();
  log('\n===BENEFITS-PROBE-JSON-BEGIN===');
  log(
    JSON.stringify(
      {
        complete: done,
        startedAt: doc.startedAt,
        completedAt: doc.completedAt || null,
        cfg,
        reports: offices.map((o) => ({ office: o, phase: doc.offices[o].phase, window: doc.offices[o].window, resumes: doc.offices[o].resumes, aborted: doc.offices[o].aborted || null, ...doc.offices[o].report })),
      },
      null,
      2
    )
  );
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
  newOfficeState,
  buildCohort,
  CHECKPOINT_VERSION,
};
