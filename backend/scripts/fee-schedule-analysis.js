#!/usr/bin/env node
'use strict';

/*
 * One-off fee schedule ranking analysis. READ-ONLY, per office.
 *
 *     node scripts/fee-schedule-analysis.js --office roland
 *     node scripts/fee-schedule-analysis.js --office valley
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS ANSWERS
 * ─────────────────────────────────────────────────────────────────────────────
 * "Which of this practice's fee schedules pay well, and which carriers are
 * actually ON them?" Both halves matter: a schedule that pays 52% of UCR is
 * only interesting once you know how many live plans sit on it, and a carrier
 * whose plans are split across three schedules is a renegotiation target the
 * ranking alone would never surface.
 *
 * The ranking is computed over a FIXED basket of 22 procedure codes with fixed
 * weights (see BASKET). The basket is deliberately hardcoded and NOT derived
 * from this practice's procedurelog: deriving it would (a) require reading
 * patient-scoped data this script is forbidden to touch, and (b) make Roland's
 * numbers incomparable to Riley's, which is the entire point of running it
 * twice. A fixed basket is a ruler; a derived one is a mirror.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, AND NO PATIENT DATA — BOTH STRUCTURAL
 * ─────────────────────────────────────────────────────────────────────────────
 * Every Open Dental call in this file is `client.apiGetRaw`. There is no write
 * verb in scope: `apiWriteRaw`/`apiDeleteRaw` are never referenced, and the
 * office handle is obtained through the same `assertOfficeMatch(key,
 * getOdOffice(key))` idiom every other office-scoped caller uses, so a run
 * against one practice can never reach the other's database.
 *
 * The five resources read — /feescheds, /fees, /procedurecodes, /carriers,
 * /insplans — plus /preferences are PRACTICE CONFIGURATION. None of them
 * carries a patient. No patient-scoped endpoint is called, no PatNum is
 * requested, and nothing written to docs/reports/ contains a person's name.
 * `insplan.GroupName` is an EMPLOYER group name and is not read here; only the
 * nine fields named in PLAN_FIELDS are kept.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THROTTLE
 * ─────────────────────────────────────────────────────────────────────────────
 * Every request passes `minIntervalMs: OD_MIN_INTERVAL_MS` (1200) and so takes
 * a share of the SHARED per-credential slot in config/openDental.js's request
 * interceptor — the same slot RCM's pacer and the fees poster reserve. There
 * are deliberately NO manual `sleep()` calls here: the interceptor already
 * sleeps, and adding a second delay on top would double the wall clock while
 * pacing nothing extra.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY /fees IS FETCHED PER CODE AND NOT SWEPT WHOLE
 * ─────────────────────────────────────────────────────────────────────────────
 * Roland has 52 fee schedules against 1,046 procedure codes, so `/fees` is on
 * the order of 36,000 rows — ~360 paged requests, ~7 minutes at the 1.2 s slot,
 * for an office. Every number this script reports is scoped to the 22 basket
 * codes, so all but ~0.1% of that traffic would be fetched and discarded.
 *
 * `GET /fees?CodeNum=` IS honoured (verified live against Roland 2026-09-28:
 * CodeNum=1 returned 43 rows, all CodeNum 1, one per schedule), so the basket
 * costs ~22 requests instead of ~360. The filter is nonetheless RE-APPLIED
 * locally on every row — see `fetchBasketFees` — because Open Dental list
 * filters are sometimes silently ignored rather than refused (RCM Spike 0a),
 * and a silently-ignored CodeNum filter would otherwise mix every code's fees
 * into one bucket.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OUTPUT
 * ─────────────────────────────────────────────────────────────────────────────
 * docs/reports/fee-schedule-analysis-<office>-<YYYY-MM-DD>/
 *     schedules.csv   one row per fee schedule, with the weighted percentages
 *     per_code.csv    schedule x basket code, percent of UCR
 *     carriers.csv    listed carrier -> matched records -> plans -> schedules
 *     summary.md      the ranking, the carrier table, flags and assumptions
 *
 * Nothing here is wired into CI, into a route, or into the UI. It is a
 * one-off a human runs and reads.
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config();

const odOffices = require('../config/odOffices');

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * The shared per-credential throttle share, in milliseconds.
 *
 * 1200 rather than 1000 for the reason services/fees/odFeesWrites.js and
 * services/rcm/odPacer.js both use 1200: Open Dental publishes 1 req/s, and the
 * extra 200 ms absorbs clock skew so the 429 backoff stays a rarity rather than
 * the steady state. The three modules share the credential, so they share the
 * number.
 */
const OD_MIN_INTERVAL_MS = 1200;

/** The cloud API's hard page size. Asking for more is silently capped. */
const PAGE_SIZE = 100;

/**
 * A page count no legitimate list here reaches (200 x 100 = 20,000 rows, against
 * a largest observed list of 1,790 insplans).
 *
 * A circuit breaker, never a limit: hitting it is treated as a refusal, because
 * a server that ignores `Offset` returns the same page forever and the honest
 * answer is "I could not establish where this list ends", not a prefix of it.
 */
const MAX_PAGES = 200;

/** Long enough for a 100-row page, short enough that a hang is not a hostage. */
const TIMEOUT_MS = 30000;

/**
 * The fixed basket: CDT code -> weight. Approximates a general-practice mix.
 *
 * Hardcoded on purpose — see the header. Weights are visit-frequency-ish, not
 * revenue: D0120 and D1110 carry 10 because a GP does far more recall exams and
 * prophys than crowns, and a basket weighted by revenue would let one D6010
 * drown the hygiene department it is supposed to measure.
 *
 * @type {Readonly<Record<string, number>>}
 */
const BASKET = Object.freeze({
  D0120: 10, D0140: 3, D0150: 3, D0210: 1, D0274: 4, D0330: 1,
  D1110: 10, D1120: 5, D1206: 5, D1208: 2,
  D2391: 3, D2392: 3, D2393: 2, D2740: 4, D2750: 2, D2950: 2,
  D3330: 1, D4341: 2, D4910: 3,
  D7140: 2, D7210: 1, D6010: 1,
});

/**
 * The hygiene sub-basket: exams, prophys, fluoride/sealants, SRP and perio
 * maintenance.
 *
 * Split out because hygiene and restorative are negotiated and underpaid
 * INDEPENDENTLY. A schedule can sit at a respectable 58% overall while paying
 * 71% on hygiene and 44% on crowns, and the blended number hides exactly the
 * weakness worth taking to the payer.
 *
 * @type {ReadonlyArray<string>}
 */
const HYGIENE_CODES = Object.freeze([
  'D0120', 'D0150', 'D0274', 'D1110', 'D1120', 'D1206', 'D1208', 'D4341', 'D4910',
]);

/** The rest of the basket: restorative, endo, oral surgery, implant. */
const RESTORATIVE_CODES = Object.freeze(
  Object.keys(BASKET).filter((c) => !HYGIENE_CODES.includes(c))
);

/**
 * The carriers this analysis was commissioned for, IN THE ORDER GIVEN.
 *
 * Matched by case-insensitive substring against `carrier.CarrierName`, which is
 * what the request asked for and is the only thing that works against a real
 * carrier table: Open Dental accumulates a separate carrier record per address
 * a payer has ever used, so "Delta Dental" is dozens of rows, not one.
 *
 * The overlap between "Anthem Blue Cross and Blue Shield" and "Anthem" is
 * deliberate and preserved — a record may match several listed names, and each
 * listed name is reported on its own row.
 *
 * @type {ReadonlyArray<string>}
 */
const LISTED_CARRIERS = Object.freeze([
  'United Healthcare',
  'Blue Cross Blue Shield',
  'Health Choice',
  'Choice Benefits',
  'Cigna',
  'Aetna',
  'GEHA',
  'Ameritas',
  'Delta Dental',
  'Anthem Blue Cross and Blue Shield',
  'Anthem',
  'Guardian',
  'Principal Life Insurance Company',
  'Humana',
  'United Concordia TDP & Active Duty',
  'Lincoln Financial Group',
  'MetLife',
]);

/**
 * Minimum basket codes a schedule must price before it earns a place in the
 * main ranking.
 *
 * 12 of 22. Below that the weighted percentage is arithmetic on a handful of
 * codes and ranks a schedule against a basket it mostly does not contain — a
 * schedule holding only D0120 at 100% of UCR would otherwise top the table.
 * Thin schedules are still reported, in their own section, with their coverage
 * stated.
 */
const MIN_COVERAGE_FOR_RANKING = 12;

/** The nine insplan fields this analysis uses. Nothing else is retained. */
const PLAN_FIELDS = Object.freeze([
  'PlanNum', 'CarrierNum', 'FeeSched', 'CopayFeeSched', 'ManualFeeSchedNum',
  'PlanType', 'IsHidden',
]);

// ─── Small helpers ───────────────────────────────────────────────────────────

/** Open Dental list endpoints return a bare array; be defensive about envelopes. */
function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

/**
 * Open Dental serialises booleans as the STRINGS "true"/"false", not as JSON
 * booleans — `IsHidden: "false"` is truthy in JavaScript, and reading it
 * directly is how a hidden schedule gets reported as visible (and how the
 * commlog type picker once mis-read `isHidden`). Always go through here.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
function odBool(v) {
  return v === true || String(v).toLowerCase() === 'true';
}

/** @param {unknown} v @returns {number} NaN-free numeric coercion. */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * RFC-4180 CSV cell. Fee schedule descriptions carry commas, quotes and
 * slashes ("Delta Arkansas /PPO '20", "DNOA BCBS OK/TX/IL/MI/NM/KS"), so
 * quoting is not optional.
 *
 * @param {unknown} v
 * @returns {string}
 */
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** @param {ReadonlyArray<ReadonlyArray<unknown>>} rows @returns {string} */
function toCsv(rows) {
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** @param {number|null} n @returns {string} one decimal place, or an em dash. */
function pct(n) {
  return n === null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(1)}%`;
}

/** Local YYYY-MM-DD. The office's day, not UTC's. */
function todayStamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ─── Transport ───────────────────────────────────────────────────────────────

/**
 * A counting, paced, read-only wrapper over one office's Open Dental client.
 *
 * Counts every request so the run can report its own cost, which is the only
 * way a reader can tell a 60-request analysis from one that quietly paged 400
 * times. `apiGetRaw` is the ONLY method reached.
 */
class OdReader {
  /** @param {{ apiGetRaw: Function }} client */
  constructor(client) {
    /** @type {{ apiGetRaw: Function }} */
    this.client = client;
    /** @type {number} */
    this.requests = 0;
    /** @type {number} */
    this.startedAt = Date.now();
  }

  /**
   * @param {string} p OD path beginning with '/'
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<{ ok: boolean, status: number, data: unknown, error?: string }>}
   */
  async get(p, params) {
    this.requests += 1;
    return this.client.apiGetRaw(p, params || {}, {
      minIntervalMs: OD_MIN_INTERVAL_MS,
      module: 'fee-analysis',
      timeoutMs: TIMEOUT_MS,
      quiet: true,
    });
  }

  /** @returns {number} seconds elapsed since construction. */
  elapsedSeconds() {
    return (Date.now() - this.startedAt) / 1000;
  }
}

/** Raised when Open Dental cannot be read. Ends the run; nothing is written. */
class OdReadError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'OdReadError';
    this.code = code;
  }
}

/**
 * Page a list endpoint to exhaustion.
 *
 * Stops on a short page — the documented signal — and refuses at MAX_PAGES.
 * The `seen` set is the stronger guard: a server that ignores `Offset` answers
 * every page with the same rows, and a page that contributes no new primary key
 * proves that happened. Verified honoured against Roland on 2026-09-28, but
 * verified-once is not enforced, so the guard stays.
 *
 * @param {OdReader} od
 * @param {string} p
 * @param {Record<string, unknown>} params
 * @param {string} idField primary key used to detect a repeated page
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function listAll(od, p, params, idField) {
  /** @type {Array<Record<string, unknown>>} */
  const items = [];
  /** @type {Set<number>} */
  const seen = new Set();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await od.get(p, { ...params, Limit: PAGE_SIZE, Offset: page * PAGE_SIZE });
    if (!res.ok) {
      throw new OdReadError(
        `Open Dental did not answer ${p} (HTTP ${res.status})${res.error ? `: ${res.error}` : ''}`,
        'OD_READ_FAILED'
      );
    }
    if (!Array.isArray(res.data)) {
      throw new OdReadError(`${p} returned something that is not a list`, 'OD_BAD_SHAPE');
    }

    let fresh = 0;
    for (const row of res.data) {
      const id = num(row[idField]);
      if (seen.has(id)) continue;
      seen.add(id);
      items.push(row);
      fresh += 1;
    }

    if (res.data.length < PAGE_SIZE) return items;
    if (fresh === 0) {
      throw new OdReadError(
        `${p} returned page ${page} with no rows this sweep had not already seen — ` +
          'Offset is being ignored, so there is no honest way to page this list',
        'OD_OFFSET_IGNORED'
      );
    }
  }

  throw new OdReadError(
    `${p} did not stop paging after ${MAX_PAGES} pages; refusing rather than guessing where it ends`,
    'OD_TOO_MANY_PAGES'
  );
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

/**
 * Every fee schedule, hidden ones included and flagged rather than dropped.
 *
 * Hidden schedules are kept because "hidden" in Open Dental means retired from
 * the picker, not deleted — live plans keep pointing at them, and a carrier
 * sitting on a hidden schedule is a finding, not noise.
 *
 * @param {OdReader} od
 * @returns {Promise<Array<{ feeSchedNum: number, description: string, feeSchedType: string, isHidden: boolean }>>}
 */
async function fetchFeeSchedules(od) {
  const rows = await listAll(od, '/feescheds', {}, 'FeeSchedNum');
  return rows.map((s) => ({
    feeSchedNum: num(s.FeeSchedNum),
    description: String(s.Description ?? ''),
    feeSchedType: String(s.FeeSchedType ?? ''),
    isHidden: odBool(s.IsHidden),
  }));
}

/**
 * ProcCode -> CodeNum for the basket.
 *
 * One paged sweep, because `GET /procedurecodes` offers no ProcCode filter —
 * turning "D2740" into a CodeNum means reading the table. Only basket codes are
 * retained; the other ~1,024 rows are read and dropped.
 *
 * @param {OdReader} od
 * @returns {Promise<{ codeNumByProcCode: Map<string, number>, missing: string[] }>}
 */
async function fetchBasketCodeNums(od) {
  const rows = await listAll(od, '/procedurecodes', {}, 'CodeNum');
  /** @type {Map<string, number>} */
  const codeNumByProcCode = new Map();
  for (const r of rows) {
    const code = String(r.ProcCode ?? '').trim().toUpperCase();
    if (code in BASKET) codeNumByProcCode.set(code, num(r.CodeNum));
  }
  const missing = Object.keys(BASKET).filter((c) => !codeNumByProcCode.has(c));
  return { codeNumByProcCode, missing };
}

/**
 * Basket fees, one filtered request per code.
 *
 * Returns `fees.get(feeSchedNum).get(procCode) = amount`.
 *
 * TWO LOCAL RE-FILTERS, both load-bearing:
 *
 *   1. `CodeNum` is re-checked on every row. The server filter is honoured
 *      today; a silently-ignored one would pour every code's fees into one
 *      code's bucket and the percentages would be nonsense that still looked
 *      like numbers.
 *
 *   2. `ClinicNum`/`ProvNum` must both be 0. Open Dental allows a fee to be
 *      overridden per clinic and per provider, and those rows sit in the same
 *      table as the practice-wide one. Roland and Riley are both single-clinic
 *      with no provider overrides (verified: CodeNum=1 returned ClinicNum [0],
 *      ProvNum [0]), so an override row appearing here means the practice
 *      changed shape — it is counted and flagged rather than averaged in.
 *
 * A zero or negative Amount is NOT a fee. In Open Dental an unset fee is stored
 * as 0.00, indistinguishable from a deliberate $0, and treating it as priced
 * would drag a schedule's percentage toward zero for codes it simply never
 * filled in. They are excluded from coverage and counted separately.
 *
 * @param {OdReader} od
 * @param {Map<string, number>} codeNumByProcCode
 * @returns {Promise<{
 *   fees: Map<number, Map<string, number>>,
 *   zeroAmount: Map<number, number>,
 *   overrideRows: number,
 *   filterIgnoredOn: string[]
 * }>}
 */
async function fetchBasketFees(od, codeNumByProcCode) {
  /** @type {Map<number, Map<string, number>>} */
  const fees = new Map();
  /** @type {Map<number, number>} */
  const zeroAmount = new Map();
  /** @type {string[]} */
  const filterIgnoredOn = [];
  let overrideRows = 0;

  for (const [procCode, codeNum] of codeNumByProcCode) {
    const rows = await listAll(od, '/fees', { CodeNum: codeNum }, 'FeeNum');

    // Re-filter 1: the server's own CodeNum filter, re-applied.
    const mine = rows.filter((f) => num(f.CodeNum) === codeNum);
    if (mine.length !== rows.length) filterIgnoredOn.push(procCode);

    for (const f of mine) {
      // Re-filter 2: practice-wide rows only.
      if (num(f.ClinicNum) !== 0 || num(f.ProvNum) !== 0) {
        overrideRows += 1;
        continue;
      }
      const sched = num(f.FeeSched);
      const amount = num(f.Amount);
      if (amount <= 0) {
        zeroAmount.set(sched, (zeroAmount.get(sched) || 0) + 1);
        continue;
      }
      if (!fees.has(sched)) fees.set(sched, new Map());
      const forSched = fees.get(sched);
      // Belt and braces: a duplicate practice-wide row for the same pair should
      // not exist. If one does, the larger amount is kept and the row is
      // counted as an override so the flag surfaces it.
      if (forSched.has(procCode)) {
        overrideRows += 1;
        if (amount <= forSched.get(procCode)) continue;
      }
      forSched.set(procCode, amount);
    }
  }

  return { fees, zeroAmount, overrideRows, filterIgnoredOn };
}

/**
 * Carriers, projected to the four fields used.
 *
 * @param {OdReader} od
 * @returns {Promise<Array<{ carrierNum: number, carrierName: string, isHidden: boolean }>>}
 */
async function fetchCarriers(od) {
  const rows = await listAll(od, '/carriers', {}, 'CarrierNum');
  return rows.map((c) => ({
    carrierNum: num(c.CarrierNum),
    carrierName: String(c.CarrierName ?? ''),
    isHidden: odBool(c.IsHidden),
  }));
}

/**
 * Insurance plans, projected to PLAN_FIELDS.
 *
 * NOTE ON `AllowedFeeSched`: the brief asked for it, and the cloud API's
 * /insplans response has no such field. The live shape (verified against Roland
 * 2026-09-28) carries `FeeSched`, `CopayFeeSched` and `ManualFeeSchedNum`;
 * `ManualFeeSchedNum` is the closest thing to an allowed-fee override and is
 * what is read here in its place. This substitution is reported in summary.md
 * rather than made silently.
 *
 * @param {OdReader} od
 * @returns {Promise<Array<{
 *   planNum: number, carrierNum: number, feeSched: number,
 *   copayFeeSched: number, manualFeeSchedNum: number,
 *   planType: string, isHidden: boolean
 * }>>}
 */
async function fetchInsPlans(od) {
  const rows = await listAll(od, '/insplans', {}, 'PlanNum');
  return rows.map((p) => ({
    planNum: num(p.PlanNum),
    carrierNum: num(p.CarrierNum),
    feeSched: num(p.FeeSched),
    copayFeeSched: num(p.CopayFeeSched),
    manualFeeSchedNum: num(p.ManualFeeSchedNum),
    planType: String(p.PlanType ?? ''),
    isHidden: odBool(p.IsHidden),
  }));
}

// ─── UCR resolution ──────────────────────────────────────────────────────────

/**
 * Which schedule is this practice's UCR (full fee) schedule?
 *
 * THIS IS AN INFERENCE, and the report says so. What was checked:
 *
 *   - `/preferences` was swept in full (13 pages, ~1,250 preferences) looking
 *     for a practice-default fee schedule. THERE IS NOT ONE. The only
 *     fee-schedule-shaped preferences are behavioural switches
 *     (`InsPpoAlwaysUseUcrFee`, `InsBlueBookUcrFeePercent`,
 *     `CoPay_FeeSchedule_BlankLikeZero`), none of which names a schedule.
 *
 *   - In Open Dental proper, UCR is `provider.FeeSched` — it is a PROVIDER
 *     attribute, not a practice one. `GET /providers` exposes it. That endpoint
 *     is outside the resource allow-list this script was given, so it is NOT
 *     called, and this function uses the brief's prescribed fallback instead.
 *     Running the one extra read would settle the question outright; that is a
 *     decision for whoever authorises the resource list, and it is raised in
 *     summary.md rather than taken here.
 *
 * The fallback, exactly as prescribed: the modal non-zero `FeeSched` among
 * NON-HIDDEN plans whose `PlanType` is blank. A blank PlanType is Open Dental's
 * "category percentage" plan — the traditional indemnity shape that pays a
 * percentage of the office's own fee — so the schedule most of them point at is
 * the office's own fee schedule.
 *
 * @param {ReadonlyArray<{ feeSched: number, planType: string, isHidden: boolean }>} plans
 * @param {number|null} override explicit --ucr, or null
 * @returns {{
 *   feeSchedNum: number|null,
 *   basis: string,
 *   evidence: Array<{ feeSchedNum: number, planCount: number }>,
 *   corroborated: boolean,
 *   overallModal: number|null
 * }}
 */
function resolveUcr(plans, override) {
  const visible = plans.filter((p) => !p.isHidden);

  /** @param {ReadonlyArray<{ feeSched: number }>} rows */
  const modal = (rows) => {
    /** @type {Map<number, number>} */
    const tally = new Map();
    for (const r of rows) {
      if (r.feeSched === 0) continue;
      tally.set(r.feeSched, (tally.get(r.feeSched) || 0) + 1);
    }
    return [...tally.entries()]
      .map(([feeSchedNum, planCount]) => ({ feeSchedNum, planCount }))
      .sort((a, b) => b.planCount - a.planCount || a.feeSchedNum - b.feeSchedNum);
  };

  const blankRanked = modal(visible.filter((p) => p.planType === ''));
  const allRanked = modal(visible);
  const overallModal = allRanked.length ? allRanked[0].feeSchedNum : null;

  if (override !== null) {
    return {
      feeSchedNum: override,
      basis: `explicit --ucr ${override}`,
      evidence: blankRanked.slice(0, 6),
      corroborated: overallModal === override,
      overallModal,
    };
  }

  if (!blankRanked.length) {
    return {
      feeSchedNum: null,
      basis: 'no non-hidden plan with a blank PlanType points at any fee schedule',
      evidence: [],
      corroborated: false,
      overallModal,
    };
  }

  const chosen = blankRanked[0];
  return {
    feeSchedNum: chosen.feeSchedNum,
    basis:
      `modal FeeSched among non-hidden plans with blank PlanType ` +
      `(${chosen.planCount} of ${visible.filter((p) => p.planType === '').length} such plans)`,
    evidence: blankRanked.slice(0, 6),
    // The same schedule also being the most-used across ALL plans is independent
    // corroboration: an office's own fee schedule is normally what the largest
    // number of plans is written against.
    corroborated: overallModal === chosen.feeSchedNum,
    overallModal,
  };
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Weighted percentage of UCR over a set of codes.
 *
 * Computed only over codes priced in BOTH this schedule and UCR — a code UCR
 * does not price has no denominator, and a code the schedule does not price
 * would otherwise be silently scored as zero, which reads as "they pay nothing
 * for crowns" when the truth is "this schedule does not mention crowns".
 *
 * @param {Map<string, number>|undefined} schedFees
 * @param {Map<string, number>|undefined} ucrFees
 * @param {ReadonlyArray<string>} codes
 * @returns {{ ratio: number|null, covered: number, eligible: number }}
 */
function weightedRatio(schedFees, ucrFees, codes) {
  if (!schedFees || !ucrFees) return { ratio: null, covered: 0, eligible: codes.length };
  let numerator = 0;
  let denominator = 0;
  let covered = 0;
  for (const code of codes) {
    const weight = BASKET[code];
    const schedFee = schedFees.get(code);
    const ucrFee = ucrFees.get(code);
    if (schedFee === undefined || ucrFee === undefined) continue;
    numerator += weight * schedFee;
    denominator += weight * ucrFee;
    covered += 1;
  }
  return {
    ratio: denominator > 0 ? numerator / denominator : null,
    covered,
    eligible: codes.length,
  };
}

/**
 * Score every fee schedule against UCR.
 *
 * @param {ReadonlyArray<{ feeSchedNum: number, description: string, feeSchedType: string, isHidden: boolean }>} schedules
 * @param {Map<number, Map<string, number>>} fees
 * @param {number} ucrNum
 * @param {Map<number, number>} planCounts
 * @param {Map<number, number>} zeroAmount
 * @returns {Array<object>}
 */
function scoreSchedules(schedules, fees, ucrNum, planCounts, zeroAmount) {
  const ucrFees = fees.get(ucrNum);
  const allCodes = Object.keys(BASKET);

  return schedules.map((s) => {
    const schedFees = fees.get(s.feeSchedNum);
    const overall = weightedRatio(schedFees, ucrFees, allCodes);
    const hygiene = weightedRatio(schedFees, ucrFees, HYGIENE_CODES);
    const restorative = weightedRatio(schedFees, ucrFees, RESTORATIVE_CODES);

    /** @type {Record<string, number|null>} */
    const perCode = {};
    for (const code of allCodes) {
      const sf = schedFees ? schedFees.get(code) : undefined;
      const uf = ucrFees ? ucrFees.get(code) : undefined;
      perCode[code] = sf !== undefined && uf !== undefined && uf > 0 ? sf / uf : null;
    }

    return {
      ...s,
      // Codes this schedule prices at all, whether or not UCR also prices them.
      pricedCodes: schedFees ? allCodes.filter((c) => schedFees.has(c)).length : 0,
      coverage: overall.covered,
      weightedPctUcr: overall.ratio,
      hygienePctUcr: hygiene.ratio,
      hygieneCoverage: hygiene.covered,
      restorativePctUcr: restorative.ratio,
      restorativeCoverage: restorative.covered,
      planCount: planCounts.get(s.feeSchedNum) || 0,
      zeroAmountCodes: zeroAmount.get(s.feeSchedNum) || 0,
      perCode,
    };
  });
}

// ─── Carrier mapping ─────────────────────────────────────────────────────────

/**
 * Map each listed carrier name onto the practice's carrier records and the fee
 * schedules its live plans actually use.
 *
 * "Actually use" is the point of the exercise. A carrier the office believes is
 * on one schedule routinely has plans spread over three, because each new group
 * arrives with whatever schedule was current that year and nothing ever
 * migrates them.
 *
 * @param {ReadonlyArray<{ carrierNum: number, carrierName: string, isHidden: boolean }>} carriers
 * @param {ReadonlyArray<{ carrierNum: number, feeSched: number, isHidden: boolean }>} plans
 * @param {Map<number, object>} scoreByNum
 * @returns {Array<object>}
 */
function mapCarriers(carriers, plans, scoreByNum) {
  /** @type {Map<number, Array<{ feeSched: number }>>} */
  const visiblePlansByCarrier = new Map();
  for (const p of plans) {
    if (p.isHidden) continue;
    if (!visiblePlansByCarrier.has(p.carrierNum)) visiblePlansByCarrier.set(p.carrierNum, []);
    visiblePlansByCarrier.get(p.carrierNum).push({ feeSched: p.feeSched });
  }

  return LISTED_CARRIERS.map((listed) => {
    const needle = listed.toLowerCase();
    const matched = carriers.filter((c) => c.carrierName.toLowerCase().includes(needle));

    /** @type {Map<number, number>} plans per fee schedule */
    const bySchedule = new Map();
    let planCount = 0;
    for (const c of matched) {
      for (const p of visiblePlansByCarrier.get(c.carrierNum) || []) {
        planCount += 1;
        bySchedule.set(p.feeSched, (bySchedule.get(p.feeSched) || 0) + 1);
      }
    }

    const schedules = [...bySchedule.entries()]
      .map(([feeSched, n]) => ({
        feeSched,
        planCount: n,
        description:
          feeSched === 0
            ? '(no schedule — pays off UCR)'
            : (scoreByNum.get(feeSched) || {}).description || '(not in /feescheds)',
        weightedPctUcr:
          feeSched === 0 ? 1 : (scoreByNum.get(feeSched) || {}).weightedPctUcr ?? null,
      }))
      .sort((a, b) => b.planCount - a.planCount);

    // Plan-count-weighted mean of the schedules whose percentage is known.
    // A FeeSched of 0 counts as 1.00: no schedule attached means the plan is
    // adjudicated against the office's own fee, which is 100% of UCR by
    // definition. Schedules too thin to score are left out of the mean and
    // their plans are left out of its denominator, so the number stays a mean
    // of what is known rather than a guess padded with zeroes.
    let weighted = 0;
    let weightBase = 0;
    for (const s of schedules) {
      if (s.weightedPctUcr === null) continue;
      weighted += s.weightedPctUcr * s.planCount;
      weightBase += s.planCount;
    }

    /** @type {string[]} */
    const flags = [];
    if (!matched.length) flags.push('NO_CARRIER_RECORD');
    else if (planCount === 0) flags.push('NO_PLANS');
    if (bySchedule.has(0)) flags.push(`UCR_NO_SCHEDULE:${bySchedule.get(0)}`);
    if (schedules.length > 1) flags.push(`SPLIT_ACROSS_${schedules.length}_SCHEDULES`);
    if (weightBase > 0 && weightBase < planCount) {
      flags.push(`PARTIAL_ESTIMATE(${weightBase}/${planCount} plans scored)`);
    }

    return {
      listed,
      matched,
      planCount,
      schedules,
      effectivePctUcr: weightBase > 0 ? weighted / weightBase : null,
      scoredPlans: weightBase,
      flags,
    };
  });
}

/** Lower-case and strip everything that is not a letter or digit. */
function squash(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * What the STRICT rule missed.
 *
 * The brief specifies case-insensitive substring on `CarrierName`, and that is
 * what `mapCarriers` does and what every number in this report is built from.
 * But the rule is punctuation-sensitive in a way that matters here: Roland's
 * carrier table spells it `HEALTHCHOICE`, one word, so the listed "Health
 * Choice" matches **nothing** — while the practice has a `Healthchoice` fee
 * schedule carrying live plans. Reporting a bare zero there would be accurate
 * and useless.
 *
 * So a second, LOOSER pass runs for diagnosis only: both sides squashed to
 * letters and digits. Its results are never counted, never averaged, and never
 * reach a CSV percentage — they appear in the flag line as "the strict rule
 * missed this", so the reader can decide whether the listed name or the
 * practice's spelling is the one to change.
 *
 * @param {string} listed
 * @param {ReadonlyArray<{ carrierNum: number, carrierName: string }>} carriers
 * @param {ReadonlyArray<{ carrierNum: number, isHidden: boolean }>} plans
 * @returns {{ names: string[], planCount: number }}
 */
function looseMatch(listed, carriers, plans) {
  const needle = squash(listed);
  if (!needle) return { names: [], planCount: 0 };
  const matched = carriers.filter((c) => squash(c.carrierName).includes(needle));
  const nums = new Set(matched.map((c) => c.carrierNum));
  const planCount = plans.filter((p) => !p.isHidden && nums.has(p.carrierNum)).length;
  return { names: matched.map((c) => c.carrierName.trim()).sort(), planCount };
}

/**
 * For a listed carrier that matched nothing, what DOES the table contain that
 * shares its most distinctive words?
 *
 * Purely a diagnostic for the summary — never treated as a match, never counted
 * anywhere. A zero-match line that also says "the table does have 'United
 * Concordia Tricare TDP'" saves the reader a trip into Open Dental.
 *
 * Ranked by how many of the listed name's tokens a record contains, so the
 * genuinely close names surface above the ones that merely share the word
 * "health". Alphabetical order put `HEALTH ADVANTAGE MEDICAL` above
 * `HEALTHCHOICE` and then truncated the list before the answer.
 *
 * @param {string} listed
 * @param {ReadonlyArray<{ carrierName: string }>} carriers
 * @returns {string[]}
 */
function nearestNames(listed, carriers) {
  const stop = new Set(['and', 'the', 'of', 'life', 'group', 'company', 'insurance', 'active', 'duty']);
  const tokens = listed
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !stop.has(t));
  if (!tokens.length) return [];

  /** @type {Array<{ name: string, hits: number }>} */
  const scored = [];
  for (const c of carriers) {
    const squashed = squash(c.carrierName);
    const hits = tokens.filter((t) => squashed.includes(t)).length;
    if (hits > 0) scored.push({ name: c.carrierName.trim(), hits });
  }
  /** @type {Map<string, number>} */
  const best = new Map();
  for (const s of scored) best.set(s.name, Math.max(best.get(s.name) || 0, s.hits));
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([name]) => name);
}

// ─── Report writing ──────────────────────────────────────────────────────────

/**
 * @param {object} ctx
 * @returns {void}
 */
function writeReports(ctx) {
  const {
    outDir, officeKey, officeName, scores, ucr, carrierRows, carriers,
    missingBasketCodes, requests, elapsedSeconds, plans, zeroTotals,
    overrideRows, filterIgnoredOn, ucrSchedule,
  } = ctx;

  fs.mkdirSync(outDir, { recursive: true });
  const allCodes = Object.keys(BASKET);

  // ── schedules.csv ──────────────────────────────────────────────────────────
  const carrierNamesBySchedule = new Map();
  for (const row of carrierRows) {
    for (const s of row.schedules) {
      if (s.feeSched === 0) continue;
      if (!carrierNamesBySchedule.has(s.feeSched)) carrierNamesBySchedule.set(s.feeSched, new Set());
      carrierNamesBySchedule.get(s.feeSched).add(row.listed);
    }
  }

  const schedRows = [
    [
      'fee_sched_num', 'description', 'fee_sched_type', 'is_hidden', 'is_ucr',
      'plan_count', 'listed_carriers_using_it', 'coverage_of_22', 'priced_codes_of_22',
      'weighted_pct_ucr', 'hygiene_pct_ucr', 'hygiene_coverage_of_9',
      'restorative_pct_ucr', 'restorative_coverage_of_13', 'zero_amount_basket_codes',
    ],
  ];
  const ranked = [...scores].sort(
    (a, b) => (b.weightedPctUcr ?? -1) - (a.weightedPctUcr ?? -1)
  );
  for (const s of ranked) {
    schedRows.push([
      s.feeSchedNum, s.description, s.feeSchedType, s.isHidden ? 'yes' : 'no',
      s.feeSchedNum === ucr.feeSchedNum ? 'yes' : 'no',
      s.planCount,
      [...(carrierNamesBySchedule.get(s.feeSchedNum) || [])].sort().join('; '),
      s.coverage, s.pricedCodes,
      s.weightedPctUcr === null ? '' : (s.weightedPctUcr * 100).toFixed(1),
      s.hygienePctUcr === null ? '' : (s.hygienePctUcr * 100).toFixed(1),
      s.hygieneCoverage,
      s.restorativePctUcr === null ? '' : (s.restorativePctUcr * 100).toFixed(1),
      s.restorativeCoverage, s.zeroAmountCodes,
    ]);
  }
  fs.writeFileSync(path.join(outDir, 'schedules.csv'), toCsv(schedRows), 'utf8');

  // ── per_code.csv ───────────────────────────────────────────────────────────
  const perCodeRows = [
    ['fee_sched_num', 'description', 'is_ucr', ...allCodes.map((c) => `${c}_pct_ucr`)],
  ];
  for (const s of ranked) {
    perCodeRows.push([
      s.feeSchedNum, s.description, s.feeSchedNum === ucr.feeSchedNum ? 'yes' : 'no',
      ...allCodes.map((c) =>
        s.perCode[c] === null ? '' : (s.perCode[c] * 100).toFixed(1)
      ),
    ]);
  }
  fs.writeFileSync(path.join(outDir, 'per_code.csv'), toCsv(perCodeRows), 'utf8');

  // ── carriers.csv ───────────────────────────────────────────────────────────
  const carrierCsv = [
    [
      'listed_carrier', 'matched_carrier_records', 'matched_carrier_nums',
      'non_hidden_plan_count', 'fee_schedules_used', 'best_guess_effective_pct_ucr', 'flags',
    ],
  ];
  for (const row of carrierRows) {
    carrierCsv.push([
      row.listed,
      row.matched.map((c) => `${c.carrierName.trim()}${c.isHidden ? ' (hidden)' : ''}`).join('; '),
      row.matched.map((c) => c.carrierNum).join('; '),
      row.planCount,
      row.schedules
        .map((s) => `${s.feeSched}:${s.description} [${s.planCount} plans, ${pct(s.weightedPctUcr)}]`)
        .join('; '),
      row.effectivePctUcr === null ? '' : (row.effectivePctUcr * 100).toFixed(1),
      row.flags.join('; '),
    ]);
  }
  fs.writeFileSync(path.join(outDir, 'carriers.csv'), toCsv(carrierCsv), 'utf8');

  // ── summary.md ─────────────────────────────────────────────────────────────
  const main = ranked.filter(
    (s) => s.weightedPctUcr !== null && s.coverage >= MIN_COVERAGE_FOR_RANKING
  );
  const thin = ranked.filter(
    (s) => s.weightedPctUcr === null || s.coverage < MIN_COVERAGE_FOR_RANKING
  );

  /** @type {string[]} */
  const md = [];
  md.push(`# Fee schedule analysis — ${officeName} (\`${officeKey}\`)`);
  md.push('');
  md.push(`Generated ${todayStamp()} · read-only · ${requests} Open Dental GET requests · ${elapsedSeconds.toFixed(1)}s`);
  md.push('');
  md.push(
    `**UCR schedule: ${ucr.feeSchedNum === null ? '_not resolved_' : `\`${ucr.feeSchedNum}\` — ${ucrSchedule ? ucrSchedule.description : '(unknown)'}`}**  `
  );
  md.push(`Basis: ${ucr.basis}.`);
  md.push('');
  md.push(
    `Every percentage below is **weighted % of that UCR schedule**, over a fixed 22-code ` +
      `general-practice basket, computed only across codes priced in _both_ schedules. ` +
      `Higher is better: 100% means the schedule pays the office's own full fee.`
  );
  md.push('');

  // Ranking
  md.push(`## Schedules ranked, high → low`);
  md.push('');
  md.push(`Schedules pricing at least ${MIN_COVERAGE_FOR_RANKING} of the 22 basket codes. ${main.length} of ${scores.length} qualify.`);
  md.push('');
  md.push('| # | Fee schedule | Plans | Cov. | **% UCR** | Hygiene | Restorative | |');
  md.push('|---:|---|---:|---:|---:|---:|---:|---|');
  main.forEach((s, i) => {
    const tags = [];
    if (s.feeSchedNum === ucr.feeSchedNum) tags.push('**UCR**');
    if (s.isHidden) tags.push('hidden');
    md.push(
      `| ${i + 1} | ${s.description} (\`${s.feeSchedNum}\`) | ${s.planCount} | ${s.coverage}/22 | ` +
        `**${pct(s.weightedPctUcr)}** | ${pct(s.hygienePctUcr)} | ${pct(s.restorativePctUcr)} | ${tags.join(', ')} |`
    );
  });
  md.push('');

  if (thin.length) {
    md.push(`## Low coverage — not ranked`);
    md.push('');
    md.push(`Fewer than ${MIN_COVERAGE_FOR_RANKING} basket codes priced against UCR. The percentage, where one exists, is arithmetic on too few codes to rank against the others.`);
    md.push('');
    md.push('| Fee schedule | Plans | Cov. | % UCR | |');
    md.push('|---|---:|---:|---:|---|');
    for (const s of thin) {
      const tags = [];
      if (s.isHidden) tags.push('hidden');
      if (s.pricedCodes === 0) tags.push('no basket fees at all');
      md.push(
        `| ${s.description} (\`${s.feeSchedNum}\`) | ${s.planCount} | ${s.coverage}/22 | ${pct(s.weightedPctUcr)} | ${tags.join(', ')} |`
      );
    }
    md.push('');
  }

  // Carriers
  md.push(`## The carrier list`);
  md.push('');
  md.push(
    'In the order given. "Plans" counts non-hidden insurance plans across every carrier ' +
      'record whose name contains the listed text. "Effective %" is those plans\' ' +
      'plan-count-weighted average of the schedules they actually sit on.'
  );
  md.push('');
  md.push('| Carrier | Recs | Plans | Effective % UCR | Schedules actually used |');
  md.push('|---|---:|---:|---:|---|');
  for (const row of carrierRows) {
    const sched = row.schedules.length
      ? row.schedules
          .slice(0, 4)
          .map((s) => `${s.description} — ${s.planCount} (${pct(s.weightedPctUcr)})`)
          .join('<br>') + (row.schedules.length > 4 ? `<br>_+${row.schedules.length - 4} more_` : '')
      : '—';
    md.push(
      `| **${row.listed}** | ${row.matched.length} | ${row.planCount} | ${pct(row.effectivePctUcr)} | ${sched} |`
    );
  }
  md.push('');

  // Flags
  md.push(`## Flags`);
  md.push('');
  md.push(`### Carriers`);
  md.push('');
  /** @type {string[]} */
  const flagLines = [];
  for (const row of carrierRows) {
    if (!row.flags.length) continue;
    const detail = row.flags
      .map((f) => {
        if (f === 'NO_CARRIER_RECORD' || f === 'NO_PLANS') {
          const base =
            f === 'NO_PLANS'
              ? 'carrier records exist but carry no non-hidden plans'
              : 'no carrier record contains that text';
          // The punctuation-insensitive second pass. Louder than the "nearest
          // names" hint because a hit here is almost always THE carrier, spelled
          // without the space the listed name has.
          const loose = looseMatch(row.listed, carriers, plans);
          if (loose.names.length) {
            return (
              `${base} — but ignoring spaces and punctuation it matches ` +
              `${loose.names.map((n) => `\`${n}\``).join(', ')}, carrying **${loose.planCount} non-hidden plans**. ` +
              'Not counted above (the specified rule is a literal substring); almost certainly the same payer.'
            );
          }
          const near = nearestNames(row.listed, carriers);
          return near.length
            ? `${base} — the table does have: ${near.map((n) => `\`${n}\``).join(', ')}`
            : `${base}, and nothing similar either`;
        }
        if (f.startsWith('UCR_NO_SCHEDULE')) {
          return `${f.split(':')[1]} plan(s) have no fee schedule attached — adjudicated off UCR`;
        }
        if (f.startsWith('SPLIT_ACROSS')) {
          return `plans split across ${row.schedules.length} different fee schedules`;
        }
        if (f.startsWith('PARTIAL_ESTIMATE')) {
          return `effective % covers only ${row.scoredPlans} of ${row.planCount} plans (the rest sit on schedules too thin to score)`;
        }
        return f;
      })
      .join('; ');
    flagLines.push(`- **${row.listed}** — ${detail}`);
  }
  md.push(...(flagLines.length ? flagLines : ['- No carrier flags.']));
  md.push('');
  md.push(`### Data`);
  md.push('');

  /** @type {string[]} */
  const dataFlags = [];

  // A schedule with live plans and no basket fees is a live misconfiguration:
  // those plans adjudicate against an empty schedule. Worth its own line.
  const emptyWithPlans = scores.filter((s) => s.planCount > 0 && s.pricedCodes === 0);
  if (emptyWithPlans.length) {
    dataFlags.push(
      `- **${emptyWithPlans.length} fee schedule(s) carry live plans but price none of the 22 basket codes**: ` +
        `${emptyWithPlans.map((s) => `\`${s.feeSchedNum}\` ${s.description} (${s.planCount} plans)`).join(', ')}. ` +
        'A plan pointed at an empty schedule has nothing to adjudicate against — worth checking in Open Dental.'
    );
  }
  if (missingBasketCodes.length) {
    dataFlags.push(
      `- **${missingBasketCodes.length} basket code(s) absent from this office's procedure code list**: ${missingBasketCodes.map((c) => `\`${c}\``).join(', ')}. They contribute to no percentage and reduce every schedule's coverage.`
    );
  }
  if (zeroTotals > 0) {
    dataFlags.push(
      `- **${zeroTotals} fee row(s) across all schedules carry an Amount of 0.00** on a basket code. Open Dental stores an unset fee as 0.00, so these are read as "not priced" rather than "free" and are excluded from coverage.`
    );
  }
  if (overrideRows > 0) {
    dataFlags.push(
      `- **${overrideRows} fee row(s) are clinic- or provider-specific overrides** (ClinicNum or ProvNum non-zero), or duplicate a practice-wide row. Only practice-wide rows (ClinicNum 0, ProvNum 0) are scored.`
    );
  }
  if (filterIgnoredOn.length) {
    dataFlags.push(
      `- **\`GET /fees?CodeNum=\` was silently ignored** for: ${filterIgnoredOn.map((c) => `\`${c}\``).join(', ')}. The local re-filter caught it and the numbers are still correct, but the API's behaviour changed.`
    );
  }
  if (!ucr.corroborated && ucr.feeSchedNum !== null) {
    dataFlags.push(
      `- **The UCR inference is not corroborated.** The modal schedule across _all_ non-hidden plans is \`${ucr.overallModal}\`, not \`${ucr.feeSchedNum}\`. Normally an office's own fee schedule is both. Worth confirming by hand before acting on the ranking.`
    );
  }
  md.push(...(dataFlags.length ? dataFlags : ['- No data flags.']));
  md.push('');

  // Assumptions
  md.push(`## Assumptions and method`);
  md.push('');
  md.push(
    `1. **UCR is inferred, not read.** \`/preferences\` was swept in full and Open Dental's ` +
      `cloud API exposes **no practice-default fee schedule preference** — the ` +
      `fee-schedule-shaped preferences are behavioural switches ` +
      `(\`InsPpoAlwaysUseUcrFee\`, \`InsBlueBookUcrFeePercent\`, ` +
      `\`CoPay_FeeSchedule_BlankLikeZero\`), none of which names a schedule. So the ` +
      `brief's prescribed fallback was used: ${ucr.basis}. ` +
      (ucr.corroborated
        ? 'It is corroborated by being the most-used schedule across all non-hidden plans as well.'
        : 'It is **not** corroborated by the all-plans modal schedule — see Flags.')
  );
  md.push(
    `   In Open Dental proper, UCR is \`provider.FeeSched\` — a **provider** attribute, ` +
      `which \`GET /providers\` would give outright. That endpoint sits outside the ` +
      `resource allow-list for this analysis, so it was not called. One extra read would ` +
      `settle it.`
  );
  md.push('');
  const evid = ucr.evidence.length
    ? ucr.evidence
        .map((e) => `\`${e.feeSchedNum}\` ×${e.planCount}`)
        .join(', ')
    : '(none)';
  md.push(`   Blank-PlanType plans point at: ${evid}.`);
  md.push('');
  md.push(
    `2. **A fee of 0.00 is "not priced", not "free".** Open Dental cannot distinguish the two; ` +
      `scoring 0.00 as a real fee would drag a schedule's percentage toward zero for codes it ` +
      `simply never filled in.`
  );
  md.push(
    `3. **Only practice-wide fee rows are scored** — ClinicNum 0 and ProvNum 0. Clinic- and ` +
      `provider-specific overrides are counted and flagged, never averaged in.`
  );
  md.push(
    `4. **The basket is fixed, not derived.** Deriving weights from this practice's ` +
      `procedurelog would require patient-scoped reads this analysis does not make, and would ` +
      `make the two offices incomparable.`
  );
  md.push(
    `5. **\`AllowedFeeSched\` does not exist** on the cloud API's \`/insplans\` response. The ` +
      `live shape carries \`FeeSched\`, \`CopayFeeSched\` and \`ManualFeeSchedNum\`; the last ` +
      `was read in its place. Plan counts above key on \`FeeSched\`.`
  );
  md.push(
    `6. **\`/fees\` was fetched per basket code**, not swept whole — ~22 filtered requests ` +
      `instead of ~360 pages for the same answer. Every filter is re-applied locally, because ` +
      `Open Dental list filters are sometimes silently ignored.`
  );
  md.push(
    `7. **Carrier matching is case-insensitive substring on \`CarrierName\`**, exactly as ` +
      `specified. "Anthem" therefore also matches every "Anthem Blue Cross and Blue Shield" ` +
      `record; both listed names are reported separately and their plan counts overlap.`
  );
  md.push('');
  md.push(`## Scope of this run`);
  md.push('');
  md.push(`- Office: \`${officeKey}\` (${officeName}) — its own Open Dental database, asserted via \`assertOfficeMatch\`. Roland and Riley are never merged.`);
  md.push(`- ${scores.length} fee schedules (${scores.filter((s) => s.isHidden).length} hidden), ${plans.length} insurance plans (${plans.filter((p) => !p.isHidden).length} non-hidden), ${carriers.length} carrier records.`);
  md.push(`- Read-only: every call is \`apiGetRaw\`. No POST, PUT or DELETE exists in this script.`);
  md.push(`- No patient-scoped endpoint was called and no patient data appears in any output.`);
  md.push('');

  fs.writeFileSync(path.join(outDir, 'summary.md'), `${md.join('\n')}\n`, 'utf8');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * @param {ReadonlyArray<string>} argv
 * @returns {{ office: string, ucr: number|null }}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] ?? '';
  }
  const office = String(out.office || '').trim();
  if (office !== 'roland' && office !== 'valley') {
    throw new Error('usage: node scripts/fee-schedule-analysis.js --office roland|valley [--ucr <FeeSchedNum>]');
  }
  const ucr = out.ucr ? Number(out.ucr) : null;
  if (ucr !== null && !Number.isFinite(ucr)) throw new Error('--ucr must be a FeeSchedNum');
  return { office, ucr };
}

async function main() {
  const { office, ucr: ucrOverride } = parseArgs(process.argv.slice(2));

  // The customer key lives in process.env and only this loader puts it there.
  // Awaited before the first odOffices call, as every other script does.
  await require('../config/secrets').loadSecrets();

  const handle = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  const od = new OdReader(handle.client);

  console.log(`\n=== FEE SCHEDULE ANALYSIS — ${office} (${handle.officeName}) — READ-ONLY ===\n`);

  process.stdout.write('  /feescheds      ... ');
  const schedules = await fetchFeeSchedules(od);
  console.log(`${schedules.length} (${schedules.filter((s) => s.isHidden).length} hidden)`);

  process.stdout.write('  /procedurecodes ... ');
  const { codeNumByProcCode, missing } = await fetchBasketCodeNums(od);
  console.log(`${codeNumByProcCode.size}/22 basket codes resolved${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);

  process.stdout.write('  /carriers       ... ');
  const carriers = await fetchCarriers(od);
  console.log(`${carriers.length}`);

  process.stdout.write('  /insplans       ... ');
  const plans = await fetchInsPlans(od);
  console.log(`${plans.length} (${plans.filter((p) => !p.isHidden).length} non-hidden)`);

  process.stdout.write('  /fees (basket)  ... ');
  const { fees, zeroAmount, overrideRows, filterIgnoredOn } = await fetchBasketFees(od, codeNumByProcCode);
  console.log(`${[...fees.values()].reduce((n, m) => n + m.size, 0)} priced fees across ${fees.size} schedules`);

  const ucr = resolveUcr(plans, ucrOverride);
  const ucrSchedule = schedules.find((s) => s.feeSchedNum === ucr.feeSchedNum) || null;
  if (ucr.feeSchedNum === null) {
    throw new OdReadError(
      `Could not identify a UCR schedule for ${office}: ${ucr.basis}. ` +
        'Re-run with --ucr <FeeSchedNum> once it is known by hand.',
      'UCR_UNRESOLVED'
    );
  }
  console.log(`\n  UCR -> ${ucr.feeSchedNum} "${ucrSchedule ? ucrSchedule.description : '?'}"  (${ucr.basis})`);
  console.log(`  corroborated by all-plans modal schedule: ${ucr.corroborated ? 'yes' : `NO (all-plans modal is ${ucr.overallModal})`}`);

  /** @type {Map<number, number>} non-hidden plan count per fee schedule */
  const planCounts = new Map();
  for (const p of plans) {
    if (p.isHidden) continue;
    planCounts.set(p.feeSched, (planCounts.get(p.feeSched) || 0) + 1);
  }

  const scores = scoreSchedules(schedules, fees, ucr.feeSchedNum, planCounts, zeroAmount);
  const scoreByNum = new Map(scores.map((s) => [s.feeSchedNum, s]));
  const carrierRows = mapCarriers(carriers, plans, scoreByNum);

  const outDir = path.join(
    __dirname, '..', '..', 'docs', 'reports',
    `fee-schedule-analysis-${office}-${todayStamp()}`
  );

  writeReports({
    outDir,
    officeKey: office,
    officeName: handle.officeName,
    scores,
    ucr,
    ucrSchedule,
    carrierRows,
    carriers,
    plans,
    missingBasketCodes: missing,
    zeroTotals: [...zeroAmount.values()].reduce((a, b) => a + b, 0),
    overrideRows,
    filterIgnoredOn,
    requests: od.requests,
    elapsedSeconds: od.elapsedSeconds(),
  });

  console.log(`\n  wrote ${path.relative(path.join(__dirname, '..', '..'), outDir)}/`);
  console.log(`         schedules.csv  per_code.csv  carriers.csv  summary.md`);
  console.log(`\n  ${od.requests} requests in ${od.elapsedSeconds().toFixed(1)}s\n`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`\nFAILED: ${err && err.code ? `[${err.code}] ` : ''}${err && err.message ? err.message : String(err)}`);
      // The one failure an operator will actually hit on a workstation. The
      // registry is right to refuse — it must never fall back to the other
      // office's key — but "OFFICE_OD_KEY_MISSING" alone does not say what to do.
      if (err && err.code === 'OFFICE_OD_KEY_MISSING') {
        console.error(
          '\n  This office\'s Open Dental CUSTOMER key is not in this environment.\n' +
            '  In staging/prod it arrives from Key Vault; a workstation run needs it in the\n' +
            '  environment for that one run. The secret NAMES (never values) are in\n' +
            '  backend/config/odOffices.js -> OFFICE_OD_SETTINGS[<office>].customerKeySecret.\n' +
            '  Roland and Valley have separate keys and separate databases; the registry will\n' +
            '  not substitute one for the other, which is why this is a refusal and not a warning.'
        );
      }
      console.error('');
      process.exit(1);
    });
}
