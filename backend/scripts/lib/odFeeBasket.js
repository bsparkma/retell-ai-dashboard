'use strict';

/**
 * Read-only Open Dental fee-basket reads, shared by the fee negotiation packet.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, AND NO PATIENT DATA — BOTH STRUCTURAL
 * ─────────────────────────────────────────────────────────────────────────────
 * Every Open Dental call in this module is `client.apiGetRaw`. `apiWriteRaw` and
 * `apiDeleteRaw` are never referenced, so there is no write verb in scope to
 * reach by accident.
 *
 * Five resources are read — /feescheds, /fees, /procedurecodes, /carriers,
 * /insplans — and all five are PRACTICE CONFIGURATION. None carries a patient.
 * No patient-scoped endpoint is called, no PatNum is ever requested, and the
 * one response that carries a name at all (`insplan.GroupName`, an employer) is
 * dropped by the projection in `fetchInsPlans`.
 *
 * `/providers` is deliberately NOT read here, even though `provider.FeeSched` is
 * where Open Dental keeps UCR. The packet's permitted resource list does not
 * include it, and it does not need to: the insurance-plan inference below
 * resolves the same schedule at both practices (verified 2026-09-28 — providers
 * and inference agree on `92` at Roland and `89` at Riley), and `--ucr` overrides
 * it outright.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THROTTLE
 * ─────────────────────────────────────────────────────────────────────────────
 * Every request passes `minIntervalMs: OD_MIN_INTERVAL_MS` and so reserves a
 * share of the SHARED per-credential slot in config/openDental.js's request
 * interceptor — the same slot the RCM pacer and the fee poster take. There are
 * no manual sleeps: the interceptor already sleeps, and a second delay on top
 * would double the wall clock while pacing nothing.
 *
 * NOTE ON THE SHARED SLOT AND TWO OFFICES: the slot is keyed per CREDENTIAL, and
 * Roland and Riley hold different customer keys, so a cross-office read (which
 * the Roland packet makes, to compare against Riley's Connection Dental
 * schedule) does not contend with itself. Each office is still paced at 1 req/s
 * against its own practice.
 */

/**
 * The shared per-credential throttle share, in milliseconds.
 *
 * 1200 rather than 1000 for the reason services/fees/odFeesWrites.js and
 * services/rcm/odPacer.js both use 1200: Open Dental publishes 1 req/s and the
 * extra 200 ms absorbs clock skew, so the 429 backoff stays a rarity rather than
 * the steady state.
 */
const OD_MIN_INTERVAL_MS = 1200;

/** The cloud API's hard page size. Asking for more is silently capped. */
const PAGE_SIZE = 100;

/**
 * A page count no legitimate list here reaches (200 x 100 = 20,000 rows against
 * a largest observed list of 1,790 insplans).
 *
 * A circuit breaker, never a limit: hitting it is a refusal, because a server
 * that ignores `Offset` returns the same page forever and the honest answer is
 * "I could not establish where this list ends", not a prefix of it.
 */
const MAX_PAGES = 200;

/** Long enough for a 100-row page, short enough that a hang is not a hostage. */
const TIMEOUT_MS = 30000;

/**
 * The fixed basket: CDT code -> weight, identical to the ranking analysis so the
 * packet's numbers and the analysis's percentages describe the same thing.
 *
 * The weights are a VOLUME PROXY for a general practice, not this practice's
 * measured mix — deriving that would need patient-scoped reads this module is
 * forbidden to make. Every recovery figure built on them is therefore an
 * estimate, and the packet labels it as one everywhere it appears.
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

/** Human labels for the basket, so a sheet an office manager reads names the procedure. */
const CODE_LABELS = Object.freeze({
  D0120: 'Periodic exam',
  D0140: 'Limited exam (problem-focused)',
  D0150: 'Comprehensive exam',
  D0210: 'Full-mouth series of X-rays',
  D0274: 'Four bitewing X-rays',
  D0330: 'Panoramic X-ray',
  D1110: 'Prophylaxis (adult cleaning)',
  D1120: 'Prophylaxis (child cleaning)',
  D1206: 'Fluoride varnish',
  D1208: 'Fluoride (topical)',
  D2391: 'Composite filling, 1 surface (posterior)',
  D2392: 'Composite filling, 2 surfaces (posterior)',
  D2393: 'Composite filling, 3 surfaces (posterior)',
  D2740: 'Crown, porcelain/ceramic',
  D2750: 'Crown, porcelain fused to metal',
  D2950: 'Core buildup',
  D3330: 'Root canal, molar',
  D4341: 'Scaling and root planing, 4+ teeth per quadrant',
  D4910: 'Periodontal maintenance',
  D7140: 'Extraction, erupted tooth',
  D7210: 'Surgical extraction',
  D6010: 'Implant, surgical placement',
});

/** The hygiene sub-basket. */
const HYGIENE_CODES = Object.freeze([
  'D0120', 'D0150', 'D0274', 'D1110', 'D1120', 'D1206', 'D1208', 'D4341', 'D4910',
]);

// ─── Value helpers ───────────────────────────────────────────────────────────

/** Open Dental list endpoints return a bare array; be defensive about envelopes. */
function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

/**
 * Open Dental serialises booleans as the STRINGS "true"/"false", not as JSON
 * booleans — `IsHidden: "false"` is truthy in JavaScript, and reading it
 * directly is how a hidden schedule gets reported as visible.
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

/** Lower-case and strip everything that is not a letter or digit. */
function squash(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * RFC-4180 CSV cell. Fee schedule descriptions carry commas, quotes and slashes
 * ("Delta Arkansas /PPO '20"), so quoting is not optional.
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

/** @param {number|null} n @returns {string} a dollar amount, or an em dash. */
function money(n) {
  return n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : `$${n.toFixed(2)}`;
}

/** @param {number|null} n @returns {string} one decimal place, or an em dash. */
function pct(n) {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(1)}%`;
}

/** Local YYYY-MM-DD. The office's day, not UTC's. */
function todayStamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ─── Transport ───────────────────────────────────────────────────────────────

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
 * A counting, paced, read-only wrapper over ONE office's Open Dental client.
 *
 * Counts every request so a run can report its own cost. `apiGetRaw` is the only
 * method reached. `officeKey` is carried so a log line can never misattribute a
 * read to the wrong practice.
 */
class OdReader {
  /** @param {{ apiGetRaw: Function }} client @param {string} officeKey */
  constructor(client, officeKey) {
    this.client = client;
    this.officeKey = officeKey;
    this.requests = 0;
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
      module: 'fee-negotiation',
      timeoutMs: TIMEOUT_MS,
      quiet: true,
    });
  }

  /** @returns {number} seconds elapsed since construction. */
  elapsedSeconds() {
    return (Date.now() - this.startedAt) / 1000;
  }
}

/**
 * Page a list endpoint to exhaustion.
 *
 * Stops on a short page — the documented signal — and refuses at MAX_PAGES. The
 * `seen` set is the stronger guard: a server that ignores `Offset` answers every
 * page with the same rows, and a page contributing no new primary key proves it.
 * Open Dental list filters are sometimes silently ignored rather than refused
 * (RCM Spike 0a), so nothing here trusts a filter it has not re-applied.
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
        `Open Dental did not answer ${p} for ${od.officeKey} (HTTP ${res.status})` +
          `${res.error ? `: ${res.error}` : ''}`,
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

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * Every fee schedule, hidden ones flagged rather than dropped — "hidden" in Open
 * Dental means retired from the picker, not deleted, and live plans keep
 * pointing at hidden schedules.
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
 * ProcCode -> CodeNum for the basket, for THIS office.
 *
 * ONE paged sweep, because `GET /procedurecodes` has no ProcCode filter.
 *
 * THIS MUST BE DONE PER OFFICE AND THE RESULT MUST NEVER BE SHARED. CodeNum is a
 * per-database surrogate key: Roland's D0120 is CodeNum 1, and Riley's D0120 is
 * whatever Riley's database assigned. Reusing one office's map against the other
 * would silently compare two different procedures — the same class of mistake as
 * reusing a PatNum across databases.
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
  return {
    codeNumByProcCode,
    missing: Object.keys(BASKET).filter((c) => !codeNumByProcCode.has(c)),
  };
}

/**
 * Keep only the practice-wide fee for a (schedule, code) pair.
 *
 * Open Dental allows a fee to be overridden per clinic and per provider, and
 * those rows sit in the same table as the practice-wide one. Both offices are
 * single-clinic with no provider overrides (verified: ClinicNum [0], ProvNum
 * [0]), so an override row appearing here means the practice changed shape — it
 * is counted and reported rather than averaged in.
 *
 * A zero or negative Amount is NOT a fee. Open Dental stores an unset fee as
 * 0.00, indistinguishable from a deliberate $0, and a packet that printed $0.00
 * as "their current rate" would put a false number in front of a payer.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @param {(sched: number, code: string, amount: number) => void} accept
 * @returns {{ overrideRows: number, zeroRows: number }}
 */
function collectPracticeWideFees(rows, procCodeByCodeNum, accept) {
  let overrideRows = 0;
  let zeroRows = 0;
  for (const f of rows) {
    if (num(f.ClinicNum) !== 0 || num(f.ProvNum) !== 0) {
      overrideRows += 1;
      continue;
    }
    const code = procCodeByCodeNum.get(num(f.CodeNum));
    if (!code) continue;
    const amount = num(f.Amount);
    if (amount <= 0) {
      zeroRows += 1;
      continue;
    }
    accept(num(f.FeeSched), code, amount);
  }
  return { overrideRows, zeroRows };
}

/**
 * Basket fees for every schedule in this office, one filtered request per code.
 *
 * `GET /fees?CodeNum=` is honoured (verified live), which makes the basket ~22
 * requests instead of the ~360 pages a whole-table sweep would cost. The filter
 * is RE-APPLIED locally on every row regardless, because a silently-ignored
 * CodeNum filter would pour every code's fees into one code's bucket and the
 * resulting dollar figures would be wrong while still looking like money.
 *
 * @param {OdReader} od
 * @param {Map<string, number>} codeNumByProcCode
 * @returns {Promise<{
 *   fees: Map<number, Map<string, number>>,
 *   overrideRows: number, zeroRows: number, filterIgnoredOn: string[]
 * }>}
 */
async function fetchBasketFees(od, codeNumByProcCode) {
  /** @type {Map<number, Map<string, number>>} */
  const fees = new Map();
  /** @type {string[]} */
  const filterIgnoredOn = [];
  let overrideRows = 0;
  let zeroRows = 0;

  for (const [procCode, codeNum] of codeNumByProcCode) {
    const rows = await listAll(od, '/fees', { CodeNum: codeNum }, 'FeeNum');
    const mine = rows.filter((f) => num(f.CodeNum) === codeNum);
    if (mine.length !== rows.length) filterIgnoredOn.push(procCode);

    const counts = collectPracticeWideFees(
      mine,
      new Map([[codeNum, procCode]]),
      (sched, code, amount) => {
        if (!fees.has(sched)) fees.set(sched, new Map());
        const forSched = fees.get(sched);
        // A duplicate practice-wide row for the same pair should not exist; if
        // one does, keep the larger and count it so the flag surfaces it.
        if (forSched.has(code) && amount <= forSched.get(code)) {
          overrideRows += 1;
          return;
        }
        if (forSched.has(code)) overrideRows += 1;
        forSched.set(code, amount);
      }
    );
    overrideRows += counts.overrideRows;
    zeroRows += counts.zeroRows;
  }

  return { fees, overrideRows, zeroRows, filterIgnoredOn };
}

/**
 * Basket fees for ONE schedule, by `FeeSched` rather than by code.
 *
 * Used for the cross-office comparison, where only a single schedule is wanted
 * from the other practice: `?FeeSched=` costs ~7 pages against the ~22 requests
 * a per-code fan-out would, for the same rows. Both filters are re-applied
 * locally, and the ProcCode map is this office's own.
 *
 * @param {OdReader} od
 * @param {number} feeSchedNum
 * @param {Map<string, number>} codeNumByProcCode this office's map
 * @returns {Promise<{ fees: Map<string, number>, overrideRows: number, zeroRows: number, filterHonored: boolean }>}
 */
async function fetchScheduleBasketFees(od, feeSchedNum, codeNumByProcCode) {
  const rows = await listAll(od, '/fees', { FeeSched: feeSchedNum }, 'FeeNum');
  const mine = rows.filter((f) => num(f.FeeSched) === feeSchedNum);

  /** @type {Map<number, string>} */
  const procCodeByCodeNum = new Map();
  for (const [code, codeNum] of codeNumByProcCode) procCodeByCodeNum.set(codeNum, code);

  /** @type {Map<string, number>} */
  const fees = new Map();
  const counts = collectPracticeWideFees(mine, procCodeByCodeNum, (_sched, code, amount) => {
    if (!fees.has(code) || amount > fees.get(code)) fees.set(code, amount);
  });

  return { ...counts, fees, filterHonored: mine.length === rows.length };
}

/**
 * Carriers, projected to the three fields used.
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
 * Insurance plans, projected to the six fields used.
 *
 * `GroupName` is an EMPLOYER name and is deliberately not among them. The cloud
 * API has no `AllowedFeeSched`; the live shape carries `FeeSched`,
 * `CopayFeeSched` and `ManualFeeSchedNum`.
 *
 * @param {OdReader} od
 * @returns {Promise<Array<{ planNum: number, carrierNum: number, feeSched: number, copayFeeSched: number, planType: string, isHidden: boolean }>>}
 */
async function fetchInsPlans(od) {
  const rows = await listAll(od, '/insplans', {}, 'PlanNum');
  return rows.map((p) => ({
    planNum: num(p.PlanNum),
    carrierNum: num(p.CarrierNum),
    feeSched: num(p.FeeSched),
    copayFeeSched: num(p.CopayFeeSched),
    planType: String(p.PlanType ?? ''),
    isHidden: odBool(p.IsHidden),
  }));
}

/**
 * The office's UCR (full fee) schedule, inferred from its insurance plans.
 *
 * Open Dental has no practice-level default fee schedule preference — a full
 * sweep of ~1,250 preferences found only behavioural switches, none naming a
 * schedule. UCR proper lives on `provider.FeeSched`, which this module does not
 * read (see the header).
 *
 * The inference: the modal non-zero `FeeSched` among NON-HIDDEN plans whose
 * `PlanType` is blank. A blank PlanType is Open Dental's "category percentage"
 * plan — the traditional shape that pays a percentage of the office's OWN fee —
 * so the schedule most of them point at is the office's own fee schedule.
 *
 * Verified 2026-09-28 to agree with the providers' schedule at both practices
 * (Roland `92`, Riley `89`). `--ucr` overrides it.
 *
 * @param {ReadonlyArray<{ feeSched: number, planType: string, isHidden: boolean }>} plans
 * @returns {{ feeSchedNum: number|null, basis: string, ranked: Array<{ feeSchedNum: number, planCount: number }> }}
 */
function inferUcr(plans) {
  const blank = plans.filter((p) => !p.isHidden && p.planType === '');
  /** @type {Map<number, number>} */
  const tally = new Map();
  for (const p of blank) {
    if (p.feeSched === 0) continue;
    tally.set(p.feeSched, (tally.get(p.feeSched) || 0) + 1);
  }
  const ranked = [...tally.entries()]
    .map(([feeSchedNum, planCount]) => ({ feeSchedNum, planCount }))
    .sort((a, b) => b.planCount - a.planCount || a.feeSchedNum - b.feeSchedNum);

  if (!ranked.length) {
    return {
      feeSchedNum: null,
      basis: 'no non-hidden plan with a blank PlanType points at any fee schedule',
      ranked,
    };
  }
  return {
    feeSchedNum: ranked[0].feeSchedNum,
    basis:
      `modal FeeSched among non-hidden plans with a blank PlanType ` +
      `(${ranked[0].planCount} of ${blank.length} such plans)`,
    ranked,
  };
}

/**
 * Open one office's Open Dental client through the office-keyed seam.
 *
 * `assertOfficeMatch(key, getOdOffice(key))` is the established idiom and the
 * safety heart of the per-office slice. It matters doubly here because the
 * Roland packet reads Riley too: two live clients exist in one process, and the
 * assertion is what guarantees each read went to the practice it was labelled
 * with. The registry fails closed per office and never substitutes one
 * practice's key for the other's.
 *
 * @param {string} officeKey
 * @returns {{ reader: OdReader, officeName: string }}
 */
function openOffice(officeKey) {
  // Required lazily so this module stays importable by a unit test that never
  // touches Open Dental.
  const odOffices = require('../../config/odOffices');
  const handle = odOffices.assertOfficeMatch(officeKey, odOffices.getOdOffice(officeKey));
  return { reader: new OdReader(handle.client, officeKey), officeName: handle.officeName };
}

module.exports = {
  OD_MIN_INTERVAL_MS,
  PAGE_SIZE,
  MAX_PAGES,
  BASKET,
  CODE_LABELS,
  HYGIENE_CODES,
  OdReadError,
  OdReader,
  asArray,
  odBool,
  num,
  squash,
  csvCell,
  toCsv,
  money,
  pct,
  todayStamp,
  listAll,
  fetchFeeSchedules,
  fetchBasketCodeNums,
  fetchBasketFees,
  fetchScheduleBasketFees,
  fetchCarriers,
  fetchInsPlans,
  inferUcr,
  openOffice,
};
