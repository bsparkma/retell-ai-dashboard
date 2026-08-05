'use strict';

/**
 * TC Slice 5 — Open Dental READS, re-expressed on the OD Cloud REST API.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The legacy TC app reached Open Dental three ways:
 *   1. OD Cloud API (api.opendental.com)     → the ONLY survivor
 *   2. direct MySQL from the office LAN      → impossible from Azure, forbidden
 *   3. the "Riley connector" HTTP proxy      → dead, never coming back
 *
 * Every legacy MySQL read is re-expressed here as OD Cloud reads, or FLAGGED as
 * a gap. Nothing in this file writes to Open Dental — there is no write path,
 * by construction (odAccess.odApiGet is the only transport and it is GET-only).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TRANSPORT CONTRACT
 * ─────────────────────────────────────────────────────────────────────────────
 * Every function takes `odGet(path, params, opts) -> {ok, status, data, error}`
 * as its first argument. That is deliberately a plain function, not the odAccess
 * module: it keeps this file pure enough to unit-test with a fake OD, and it
 * makes it impossible for read logic to reach for a write method that isn't
 * there. Routes pass a closure over odAccess.odApiGet(req, ...).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HONESTY RULES (the whole point of the slice)
 * ─────────────────────────────────────────────────────────────────────────────
 *  - Every result carries a `coverage` array: one entry per data element the
 *    legacy MySQL query produced, marked confirmed | partial | gap, with the OD
 *    endpoint that produced it. The UI renders these verbatim. A number we could
 *    not fetch is NEVER silently defaulted to zero without a coverage note.
 *  - A capability miss (OD key lacks a resource) is distinguished from an
 *    outage. Capability miss → `gap` + actionable note. Outage → error.
 *  - Multi-call reads return PARTIAL results plus the list of what failed,
 *    rather than throwing away good rows or hanging on a bad one.
 *  - Truncation is always reported (`truncated`, `scanned`), never silent.
 *
 * Legacy sources ported here (READ-ONLY reference, C:\Users\beau\TC-app):
 *   server/index.ts  /api/od/patients, /api/od/patients/:patNum,
 *                    /api/od/treatment-plan/:patNum, /api/od/bulk-unaccepted,
 *                    /api/od/bulk-procedures/:patNum, /api/od/cob-procedures/:patNum,
 *                    /api/od/next-appointment/:patNum, normalizePatient, normalizeProc
 */

// ── Tunables ────────────────────────────────────────────────────────────────

/** Per-OD-call timeout. The OD chain is app → api.opendental.com → OD HQ →
 *  the office eConnector (~10 hops); the legacy app proved 10s is too short. */
const OD_CALL_TIMEOUT_MS = Number(process.env.TC_OD_CALL_TIMEOUT_MS || 30000);

/** Max OD calls in flight for one fan-out. The legacy TP fetch issued up to 25
 *  SEQUENTIAL calls (~25 × latency); this bounds wall-clock without bursting the
 *  OD rate limiter (the client also spaces requests + backs off on 429). */
const OD_CONCURRENCY = Number(process.env.TC_OD_CONCURRENCY || 5);

/** Attachment cap for an Active/Inactive plan. Kept at the legacy value on
 *  purpose so a side-by-side against the legacy app matches dollar-for-dollar;
 *  unlike legacy, hitting it sets `truncated` instead of silently short-paying. */
const TP_ATTACH_CAP = Number(process.env.TC_OD_TP_ATTACH_CAP || 25);

/** OD paginates at 100 rows via `Offset`. Bounds the practice-wide TP scan. */
const OD_PAGE_SIZE = 100;
const MAX_SCAN_PAGES = Number(process.env.TC_OD_MAX_SCAN_PAGES || 40); // ≤ 4000 procs

/**
 * Optional ClinicNum filter for TC's OD reads.
 *
 * The legacy MySQL queries filtered `ClinicNum = ?` (default 0) because they ran
 * against the office's own database. On the cloud API the CUSTOMER KEY already
 * scopes to exactly one practice database (Roland), and OD list reads are not
 * clinic-scoped by default — so filtering on a guessed ClinicNum would silently
 * return nothing. Left UNSET by default; set TC_OD_CLINIC_NUM only once the
 * value is verified against the live database.
 */
const OD_CLINIC_NUM = process.env.TC_OD_CLINIC_NUM || '';

// ── Small utilities ─────────────────────────────────────────────────────────

/**
 * claimproc.Status as the OD API spells it — a STRING enum, not the DB integer
 * (same class as AptStatus/ProcStatus; see docs/OD_API_CONTRACT.md §1).
 * Verified live against Roland OD: "Received", "Estimate" and "Preauth" all
 * observed on one patient.
 *
 * The legacy MySQL used the DB integers:
 *   Status IN (6, 0) → Estimate + NotReceived  = treatment-plan estimates
 *   Status IN (1, 4) → Received + Supplemental = money actually paid
 */
const CP_ESTIMATE_STATUSES = Object.freeze(['Estimate', 'NotReceived', '6', '0']);
const CP_PAID_STATUSES = Object.freeze(['Received', 'Supplemental', '1', '4']);

/**
 * Open Dental writes **-1** into WriteOffEst / DedEst / InsEstTotal to mean
 * "not calculated", not "zero dollars".
 *
 * This matters: the legacy query did `COALESCE(cp.WriteOffEst, 0)` and then
 * `fee - writeOff`, so a -1 sentinel silently produced an allowed amount of
 * fee + $1. COALESCE only guards SQL NULL, and OD does not store NULL here.
 * Returning null instead lets the caller fall back to the billed fee and SAY it
 * is falling back, which is the whole point of the panel.
 *
 * @param {unknown} value
 * @param {unknown} [override] OD's paired *Override column, which wins when set
 * @returns {number|null}
 */
function odEstimate(value, override) {
  const o = Number(override);
  if (Number.isFinite(o) && o >= 0) return o;
  const v = Number(value);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/** OD list endpoints return a bare array; be defensive about envelopes. */
function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && data.value && Array.isArray(data.value.data)) return data.value.data;
  return [];
}

/**
 * Did OD reject this because the developer key has no access to the resource
 * (a CAPABILITY gap the practice can fix in the developer portal), as opposed
 * to the service being down?
 * @param {{ok:boolean,status:number,data:unknown,error?:string}} res
 */
function isCapabilityMiss(res) {
  if (res.ok) return false;
  if (res.status !== 400 && res.status !== 403 && res.status !== 404) return false;
  const msg = String(res.error || '').toLowerCase();
  return (
    msg.includes('not a valid resource') ||
    msg.includes('not a valid parameter') ||
    msg.includes('not enabled') ||
    msg.includes('permission') ||
    res.status === 403 ||
    res.status === 404
  );
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Never rejects: each
 * result is `{ ok:true, value }` or `{ ok:false, item, error }`, so one bad
 * procedure can't collapse a whole treatment plan.
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<Array<{ok:true,value:R}|{ok:false,item:T,error:string}>>}
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length || 1)))
    .fill(null)
    .map(async () => {
      for (;;) {
        const i = cursor;
        cursor += 1;
        if (i >= items.length) return;
        try {
          out[i] = { ok: true, value: await fn(items[i], i) };
        } catch (err) {
          out[i] = { ok: false, item: items[i], error: err && err.message ? err.message : String(err) };
        }
      }
    });
  await Promise.all(workers);
  return out;
}

/** 'YYYY-MM-DD' for an OD date/datetime value ('' when absent or an OD null date). */
function odDate(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  // OD's null date. Never render it as a real date.
  if (s.startsWith('0001-01-01')) return '';
  return s.slice(0, 10);
}

/** Today as 'YYYY-MM-DD' in the server's local zone (OD dates are local, not UTC). */
function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** One coverage-table row, surfaced to the UI verbatim. */
function cov(element, status, endpoint, note) {
  return { element, status, endpoint, note };
}

// ── Normalizers (OD → TC shape; ported from legacy server/index.ts) ─────────

/**
 * Legacy normalizePatient + the two fields the legacy shape needed for
 * disambiguation. OD's LName/FName filters are PREFIX matches (see
 * searchPatients), so DOB and phone are what let a user tell "Smith" from
 * "Smithson" — they are part of the contract, not decoration.
 */
function normalizePatient(p) {
  const last = p.LName || '';
  const first = p.FName || '';
  return {
    patNum: num(p.PatNum),
    firstName: first,
    lastName: last,
    displayName: `${last}, ${first}`.trim().replace(/^,\s*/, '').replace(/,\s*$/, ''),
    birthdate: odDate(p.Birthdate),
    // Legacy preferred the cell; the voice module's transformPatientData drops
    // WirelessPhone entirely, which is why TC normalizes its own shape here.
    phone: p.WirelessPhone || p.HmPhone || p.WkPhone || '',
    email: p.Email || '',
    /** OD API returns a STRING enum ("Patient" | "Inactive" | …), not the DB int. */
    status: p.PatStatus == null ? '' : String(p.PatStatus),
  };
}

/** Patient statuses the legacy search excluded. */
const EXCLUDED_PAT_STATUS = new Set(['Deceased', 'Deleted', 'NonPatient', '3', '1', '5']);

/**
 * Legacy normalizeProc — handles BOTH shapes, because OD serves treatment-plan
 * procedures from two different tables:
 *   proctp (Saved plans)      → FeeAmt / PriInsAmt / SecInsAmt / ToothNumTP / ProcTPNum
 *   procedurelog (Active/Inactive) → ProcFee / PriInsEst / SecInsEst / ToothNum / ProcNum
 */
function normalizeProc(p) {
  const code = (p.ProcCode || p.ADACode || p.procCode || String(p.CodeNum || '')).toString().toUpperCase();
  const fee = Number(p.FeeAmt ?? p.ProcFee ?? 0);
  const priIns = Number(p.PriInsAmt ?? p.PriInsEst ?? 0);
  const secIns = Number(p.SecInsAmt ?? p.SecInsEst ?? 0);
  const insEst = priIns + secIns;
  const patAmt = p.PatAmt != null ? Number(p.PatAmt) : Math.max(0, fee - insEst);
  const tooth = String(p.ToothNumTP ?? p.ToothNum ?? '').trim() || 'N/A';

  return {
    procNum: num(p.ProcTPNum ?? p.ProcNum ?? 0),
    toothNum: tooth,
    surf: p.Surf || '',
    procCode: code,
    description: p.Descript || p.descript || '',
    fee,
    insEst,
    // Legacy behavior preserved: with no insurance estimate, patient owes the fee.
    patAmt: patAmt > 0 ? patAmt : fee,
  };
}

/** Legacy billable filter: a real CDT code with a real fee. */
function isBillable(p) {
  const code = (p.ProcCode || p.ADACode || p.procCode || '').toString().toUpperCase();
  const fee = Number(p.FeeAmt ?? p.ProcFee ?? 0);
  return /^D\d{4}/.test(code) && fee > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Patient search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Search Roland OD patients by name.
 *
 * ⚠️ PLATFORM-DOCUMENTED GOTCHA (docs/OD_API_CONTRACT.md §7): OD's `LName`/`FName`
 * filters are PARTIAL/PREFIX matches, case-insensitive — "Smith" also returns
 * "Smithson", and "Test" returns every *Patient Test / Stedi Test / MangoTest.
 * There is no exact-match parameter. The caller therefore always gets DOB and
 * phone back so a human can disambiguate; callers must never auto-pick result[0].
 *
 * Legacy strategy preserved: last-name lane first (the common lookup), and only
 * fan out to the first-name lane when the first lane is thin — the legacy comment
 * says this exists to avoid tripping OD's throttle on every keystroke.
 *
 * @param {(path:string, params?:object, opts?:object)=>Promise<any>} odGet
 * @param {string} query
 * @param {{ limit?: number }} [opts]
 */
async function searchPatients(odGet, query, opts = {}) {
  const q = String(query || '').trim();
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 50);
  if (q.length < 2) {
    return { patients: [], query: q, matchMode: 'prefix', truncated: false, notes: [] };
  }

  const merged = new Map();
  const notes = [];

  const ingest = (res) => {
    if (!res.ok) {
      notes.push(`OD returned ${res.status} for a name lane; results may be incomplete.`);
      return;
    }
    for (const p of asArray(res.data)) {
      const id = Number(p && p.PatNum);
      if (id && !merged.has(id)) merged.set(id, p);
    }
  };

  ingest(await odGet('/patients', { LName: q }, { timeoutMs: OD_CALL_TIMEOUT_MS }));
  if (merged.size < 5) {
    ingest(await odGet('/patients', { FName: q }, { timeoutMs: OD_CALL_TIMEOUT_MS }));
  }

  const all = [...merged.values()].filter((p) => !EXCLUDED_PAT_STATUS.has(String(p.PatStatus)));

  return {
    query: q,
    /** Tells the UI to say "starts with", not "matches". */
    matchMode: 'prefix',
    patients: all.slice(0, limit).map(normalizePatient),
    truncated: all.length > limit,
    totalFound: all.length,
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Patient by PatNum
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {Promise<{patient: object|null, notFound?: boolean}>} */
async function getPatient(odGet, patNum) {
  const res = await odGet(`/patients/${patNum}`, {}, { timeoutMs: OD_CALL_TIMEOUT_MS });
  if (!res.ok) {
    if (res.status === 404) return { patient: null, notFound: true };
    const err = new Error(`OD patient lookup failed (${res.status})`);
    err.odStatus = res.status;
    throw err;
  }
  const raw = Array.isArray(res.data) ? res.data[0] : res.data;
  if (!raw || !raw.PatNum) return { patient: null, notFound: true };
  return { patient: normalizePatient(raw) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Treatment plan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OD serves treatment-plan procedures from two unrelated places depending on the
 * plan's status. Both paths are ported:
 *
 *   Saved            → /treatplans → /proctps        (frozen fee copies; best data)
 *   Active|Inactive  → /treatplans → /treatplanattaches → /procedurelogs/{ProcNum}
 *
 * PLURAL-NAME NOTE: the legacy app called `/proctp` and `/treatplanattach`
 * (singular) and had a whole "procEndpointBlocked" branch for the 404s that
 * produced. OD's documented resources are PLURAL (`/treatplanattaches`, per
 * opendental.com/site/apitreatreatment.html). We try plural first and fall back
 * to the legacy singular once per request, so whichever this practice's OD build
 * exposes, the read works — and `endpointsUsed` records which one answered.
 *
 * Additions over legacy (the legacy version made up to 25 SEQUENTIAL calls with
 * no timeout and an all-or-nothing failure mode):
 *   - bounded concurrency (OD_CONCURRENCY) + per-call timeout
 *   - PARTIAL results: procedures that failed are listed in `unreadable`
 *   - explicit `truncated` when a plan exceeds TP_ATTACH_CAP
 */
async function getTreatmentPlan(odGet, patNum) {
  const endpointsUsed = [];
  const notes = [];

  const plansRes = await odGet('/treatplans', { PatNum: patNum }, { timeoutMs: OD_CALL_TIMEOUT_MS });
  endpointsUsed.push('GET /treatplans?PatNum');
  if (!plansRes.ok) {
    const err = new Error(`Failed to fetch treatment plans (${plansRes.status})`);
    err.odStatus = plansRes.status;
    throw err;
  }

  const allPlans = asArray(plansRes.data);
  const planSummaries = allPlans.map((p) => ({
    treatPlanNum: num(p.TreatPlanNum),
    heading: p.Heading || '',
    status: p.TPStatus || '',
    dateTP: odDate(p.DateTP),
  }));

  if (allPlans.length === 0) {
    return {
      procedures: [],
      plans: [],
      source: null,
      partial: false,
      truncated: false,
      unreadable: [],
      endpointsUsed,
      notes: ['This patient has no treatment plans in Open Dental.'],
    };
  }

  // Resource-name resolution, memoized for this request so a miss costs one call.
  /** @type {Record<string, string|null>} */
  const resolved = {};
  async function tryNames(key, candidates, params) {
    if (resolved[key] === null) return { ok: false, status: 404, data: null, error: 'resource unavailable' };
    const names = resolved[key] ? [resolved[key]] : candidates;
    let last = null;
    for (const name of names) {
      const res = await odGet(name, params, { timeoutMs: OD_CALL_TIMEOUT_MS });
      if (res.ok) {
        if (!resolved[key]) {
          resolved[key] = name;
          endpointsUsed.push(`GET ${name}`);
        }
        return res;
      }
      last = res;
      if (!isCapabilityMiss(res)) break; // a real failure — don't try the alias
    }
    if (last && isCapabilityMiss(last) && !resolved[key]) resolved[key] = null;
    return last;
  }

  // ── Saved plans → proctps (most reliable: frozen, fee-complete copies) ────
  const savedPlans = allPlans
    .filter((p) => p.TPStatus === 'Saved')
    .sort((a, b) => new Date(b.SecDateTEdit || 0).getTime() - new Date(a.SecDateTEdit || 0).getTime());

  for (const plan of savedPlans) {
    const r = await tryNames('proctp', ['/proctps', '/proctp'], { TreatPlanNum: plan.TreatPlanNum });
    if (!r || !r.ok) {
      if (r && isCapabilityMiss(r)) {
        notes.push(
          'This OD developer key cannot read /proctps (Saved-plan procedures). ' +
            'Enable the resource in the Open Dental developer portal, or paste the plan in manually.'
        );
        break; // no point retrying the other Saved plans
      }
      continue;
    }
    const procs = asArray(r.data);
    const billable = procs.filter(isBillable);
    if (billable.length > 0) {
      return {
        procedures: billable.map(normalizeProc),
        plans: planSummaries,
        source: { treatPlanNum: num(plan.TreatPlanNum), status: 'Saved', heading: plan.Heading || '' },
        partial: false,
        truncated: false,
        unreadable: [],
        endpointsUsed,
        notes,
      };
    }
  }

  // ── Active / Inactive plans → treatplanattaches → procedurelogs/{ProcNum} ──
  const activePlans = allPlans
    .filter((p) => p.TPStatus === 'Active' || p.TPStatus === 'Inactive')
    .sort((a, b) => (a.TPStatus === 'Active' ? -1 : 1) - (b.TPStatus === 'Active' ? -1 : 1));

  for (const plan of activePlans) {
    const attachRes = await tryNames('attach', ['/treatplanattaches', '/treatplanattach'], {
      TreatPlanNum: plan.TreatPlanNum,
    });
    if (!attachRes || !attachRes.ok) {
      if (attachRes && isCapabilityMiss(attachRes)) {
        notes.push(
          'This OD developer key cannot read /treatplanattaches (Active-plan procedures). ' +
            'Enable the resource in the Open Dental developer portal, or paste the plan in manually.'
        );
        break;
      }
      continue;
    }

    const attachments = asArray(attachRes.data);
    if (attachments.length === 0) continue;

    const capped = attachments.slice(0, TP_ATTACH_CAP);
    const truncated = attachments.length > TP_ATTACH_CAP;

    const results = await mapLimit(capped, OD_CONCURRENCY, async (attach) => {
      const r = await odGet(`/procedurelogs/${attach.ProcNum}`, {}, { timeoutMs: OD_CALL_TIMEOUT_MS });
      if (!r.ok) {
        const e = new Error(isCapabilityMiss(r) ? 'procedure not readable with this OD key' : `OD ${r.status}`);
        e.procNum = attach.ProcNum;
        throw e;
      }
      return Array.isArray(r.data) ? r.data[0] : r.data;
    });

    const details = [];
    const unreadable = [];
    results.forEach((res, i) => {
      if (res && res.ok && res.value && typeof res.value === 'object') details.push(res.value);
      else unreadable.push({ procNum: num(capped[i] && capped[i].ProcNum), reason: (res && res.error) || 'unknown' });
    });

    const billable = details.filter(isBillable);
    if (billable.length > 0 || unreadable.length > 0) {
      if (truncated) {
        notes.push(
          `Plan has ${attachments.length} procedures; the first ${TP_ATTACH_CAP} were read. ` +
            'Totals below are for those procedures only.'
        );
      }
      if (unreadable.length > 0) {
        notes.push(`${unreadable.length} procedure(s) could not be read from Open Dental and are excluded from the totals.`);
      }
      if (billable.length === 0) continue;
      return {
        procedures: billable.map(normalizeProc),
        plans: planSummaries,
        source: {
          treatPlanNum: num(plan.TreatPlanNum),
          status: plan.TPStatus || '',
          heading: plan.Heading || '',
        },
        partial: unreadable.length > 0 || truncated,
        truncated,
        unreadable,
        endpointsUsed,
        notes,
      };
    }
  }

  // Plans exist but no billable procedures came back.
  if (notes.length === 0) {
    notes.push(
      `Found ${allPlans.length} treatment plan(s), but none contain a billable procedure ` +
        '(a D-code with a fee greater than zero).'
    );
  }
  return {
    procedures: [],
    plans: planSummaries,
    source: null,
    partial: true,
    truncated: false,
    unreadable: [],
    endpointsUsed,
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Bulk unaccepted finder  ⚠️ WAS DIRECT MYSQL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legacy (server/index.ts, /api/od/bulk-unaccepted) was raw MySQL:
 *
 *   SELECT p.*, COUNT(pl.ProcNum), SUM(pl.ProcFee), MIN/MAX(pl.DateTP)
 *   FROM procedurelog pl JOIN patient p ON p.PatNum = pl.PatNum
 *   WHERE pl.ProcStatus = 1 AND pl.ClinicNum = ? AND pl.DateTP >= ?
 *     AND pl.ProcFee > 0 AND p.PatStatus = 0
 *   GROUP BY p.PatNum HAVING SUM(pl.ProcFee) >= ? ORDER BY totalFee DESC LIMIT 200
 *
 * API verdict: PARTIAL. `GET /procedurelogs` can filter ProcStatus (OD 25.2.21+)
 * and ClinicNum (23.3.13+) but has NO fee filter, NO DateTP filter, NO patient
 * join, NO GROUP BY and NO server-side ordering. So:
 *   - the ProcStatus/ClinicNum predicates go to OD,
 *   - DateTP window, fee floor, grouping, HAVING and ordering are re-implemented
 *     client-side over a PAGINATED scan (100/page, capped at MAX_SCAN_PAGES),
 *   - patient demographics + the PatStatus filter need one /patients/{PatNum}
 *     call per candidate (the join OD will not do), so they are fetched only for
 *     the top `limit` patients after ranking.
 *
 * The scan is bounded and reports what it saw: `scanned`, `pages`, `truncated`.
 * A truncated scan is stated, never presented as a complete practice sweep.
 */
async function findUnaccepted(odGet, opts = {}) {
  const minFee = Math.max(Number(opts.minFee) || 0, 0);
  const days = Math.min(Math.max(Number(opts.days) || 90, 1), 1825);
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const coverage = [];
  const notes = [];
  const endpointsUsed = [];

  // ── Scan TP procedures, page by page ──────────────────────────────────────
  const baseParams = { ProcStatus: 'TP' };
  if (OD_CLINIC_NUM) baseParams.ClinicNum = OD_CLINIC_NUM;

  let serverSideStatusFilter = true;
  const rows = [];
  let pages = 0;
  let truncated = false;

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const params = { ...baseParams, Offset: page * OD_PAGE_SIZE };
    let res = await odGet('/procedurelogs', params, { timeoutMs: OD_CALL_TIMEOUT_MS });

    // OD builds older than 25.2.21 reject ProcStatus. Degrade to an unfiltered
    // scan + client-side status filter rather than returning nothing.
    if (!res.ok && page === 0 && isCapabilityMiss(res) && serverSideStatusFilter) {
      serverSideStatusFilter = false;
      delete baseParams.ProcStatus;
      notes.push(
        "This Open Dental build does not accept the ProcStatus filter, so every procedure is " +
          'scanned and filtered here. Results are the same; the scan is slower and more likely to be truncated.'
      );
      res = await odGet('/procedurelogs', { ...baseParams, Offset: 0 }, { timeoutMs: OD_CALL_TIMEOUT_MS });
    }

    if (!res.ok) {
      if (page === 0) {
        const err = new Error(`Failed to scan treatment-planned procedures (${res.status})`);
        err.odStatus = res.status;
        err.capability = isCapabilityMiss(res);
        throw err;
      }
      notes.push(`The scan stopped early after ${pages} page(s) (Open Dental returned ${res.status}).`);
      truncated = true;
      break;
    }

    const batch = asArray(res.data);
    pages += 1;
    rows.push(...batch);
    if (batch.length < OD_PAGE_SIZE) break;
    if (page === MAX_SCAN_PAGES - 1) truncated = true;
  }
  endpointsUsed.push(
    `GET /procedurelogs?${serverSideStatusFilter ? 'ProcStatus=TP' : '(no ProcStatus filter)'}${OD_CLINIC_NUM ? '&ClinicNum' : ''}&Offset`
  );

  if (truncated) {
    notes.push(
      `Scanned ${rows.length} treatment-planned procedures (${pages} page(s)) — the practice has more. ` +
        'Narrow the date window or raise the fee floor for a complete list.'
    );
  }

  // ── Client-side: status/date/fee predicates, then GROUP BY PatNum ─────────
  /** @type {Map<number, {patNum:number, procCount:number, totalFee:number, earliestTP:string, latestTP:string}>} */
  const byPatient = new Map();
  for (const r of rows) {
    const status = String(r.ProcStatus || '');
    if (!serverSideStatusFilter && status !== 'TP' && status !== '1') continue;
    const fee = num(r.ProcFee);
    if (fee <= 0) continue;
    const dateTP = odDate(r.DateTP);
    if (!dateTP || dateTP < cutoffStr) continue;
    if (OD_CLINIC_NUM && String(r.ClinicNum ?? '') !== String(OD_CLINIC_NUM)) continue;

    const id = num(r.PatNum);
    if (!id) continue;
    const acc = byPatient.get(id) || {
      patNum: id,
      procCount: 0,
      totalFee: 0,
      earliestTP: dateTP,
      latestTP: dateTP,
    };
    acc.procCount += 1;
    acc.totalFee += fee;
    if (dateTP < acc.earliestTP) acc.earliestTP = dateTP;
    if (dateTP > acc.latestTP) acc.latestTP = dateTP;
    byPatient.set(id, acc);
  }

  const ranked = [...byPatient.values()]
    .filter((p) => p.totalFee >= minFee)
    .sort((a, b) => b.totalFee - a.totalFee);
  const top = ranked.slice(0, limit);

  // ── The join OD will not do: one /patients/{PatNum} per candidate ─────────
  const demographics = await mapLimit(top, OD_CONCURRENCY, async (row) => {
    const r = await odGet(`/patients/${row.patNum}`, {}, { timeoutMs: OD_CALL_TIMEOUT_MS });
    if (!r.ok) throw new Error(`OD ${r.status}`);
    return Array.isArray(r.data) ? r.data[0] : r.data;
  });
  endpointsUsed.push('GET /patients/{PatNum}');

  const patients = [];
  let demographicsMissing = 0;
  demographics.forEach((res, i) => {
    const row = top[i];
    if (!res || !res.ok || !res.value) {
      demographicsMissing += 1;
      // Keep the money, be explicit that the name is missing — dropping the row
      // would silently shrink the worklist.
      patients.push({
        ...row,
        firstName: '',
        lastName: '',
        displayName: `PatNum ${row.patNum}`,
        birthdate: '',
        phone: '',
        email: '',
        demographicsUnavailable: true,
      });
      return;
    }
    const p = normalizePatient(res.value);
    // Legacy filtered p.PatStatus = 0 (active patients only).
    if (EXCLUDED_PAT_STATUS.has(p.status) || (p.status && p.status !== 'Patient' && p.status !== '0')) return;
    patients.push({ ...row, ...p, demographicsUnavailable: false });
  });

  if (demographicsMissing > 0) {
    notes.push(`${demographicsMissing} patient record(s) could not be read; those rows show a PatNum instead of a name.`);
  }

  coverage.push(
    cov('Treatment-planned procedures (ProcStatus=TP)', serverSideStatusFilter ? 'confirmed' : 'partial', 'GET /procedurelogs',
      serverSideStatusFilter ? null : 'Filtered client-side — this OD build rejects the ProcStatus parameter.'),
    cov('Procedure fee (ProcFee)', 'confirmed', 'GET /procedurelogs'),
    cov('TP date window (DateTP)', 'partial', 'GET /procedurelogs',
      'OD has no DateTP filter; the window is applied client-side over the scanned pages.'),
    cov('Fee floor / total per patient (HAVING SUM)', 'partial', 'GET /procedurelogs',
      'No aggregation or fee filter in the API; grouped and filtered client-side.'),
    cov('Clinic scoping (ClinicNum)', OD_CLINIC_NUM ? 'confirmed' : 'partial', 'GET /procedurelogs?ClinicNum',
      OD_CLINIC_NUM ? null : "Not applied: the customer key already scopes to one practice database. Set TC_OD_CLINIC_NUM once the office's ClinicNum is verified."),
    cov('Patient name / DOB / phone / email', 'partial', 'GET /patients/{PatNum}',
      'No patient join in the API — one extra call per ranked patient, so demographics are fetched only for the returned page.'),
    cov('Active-patient filter (PatStatus)', 'confirmed', 'GET /patients/{PatNum}',
      'Applied after the demographics fetch, so an inactive patient can consume one of the ranked slots.'),
    cov('Full-practice completeness', truncated ? 'gap' : 'confirmed', 'GET /procedurelogs?Offset',
      truncated ? 'The scan hit its page cap; this is a partial sweep of the practice.' : null)
  );

  return {
    patients,
    total: patients.length,
    scanned: rows.length,
    pages,
    truncated,
    filters: { minFee, days, cutoff: cutoffStr, limit, clinicNum: OD_CLINIC_NUM || null },
    coverage,
    endpointsUsed,
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5a. COB procedures  ⚠️ WAS DIRECT MYSQL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read every claimproc for a patient, following OD's 100-row pagination.
 *
 * `GET /claimprocs` is the endpoint the legacy MySQL join needed and it DOES
 * exist (verified live against Roland OD, 2026-08-04): it accepts PatNum,
 * ProcNum, ClaimNum, PlanNum, Status and DateCP, and returns the full row —
 * WriteOffEst, InsEstTotal, DedEst, InsPayAmt, DedApplied, Status, DateCP,
 * PlanNum, InsSubNum. Note the singular `/claimproc` is NOT a resource.
 *
 * @returns {Promise<{rows: any[], truncated: boolean}>}
 */
async function fetchClaimProcs(odGet, params) {
  const rows = [];
  let truncated = false;
  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const res = await odGet(
      '/claimprocs',
      { ...params, Offset: page * OD_PAGE_SIZE },
      { timeoutMs: OD_CALL_TIMEOUT_MS }
    );
    if (!res.ok) {
      if (page === 0) {
        const err = new Error(`Failed to fetch insurance estimates (${res.status})`);
        err.odStatus = res.status;
        err.capability = isCapabilityMiss(res);
        throw err;
      }
      truncated = true;
      break;
    }
    const batch = asArray(res.data);
    rows.push(...batch);
    if (batch.length < OD_PAGE_SIZE) break;
    if (page === MAX_SCAN_PAGES - 1) truncated = true;
  }
  return { rows, truncated };
}

/**
 * Map a patient's plans to their ordinal (1 = primary, 2 = secondary), keyed by
 * BOTH InsSubNum and PlanNum.
 *
 * The legacy SQL joined `inssub ON PlanNum` then `patplan ON InsSubNum` — i.e.
 * it reached the ordinal via the PLAN. claimproc carries InsSubNum directly, so
 * we key on that first: two subscribers on the same group plan (a couple who
 * both work somewhere, each covering the other) resolve correctly here and
 * could collide in the legacy join. PlanNum stays as a fallback.
 */
async function loadPlanOrdinals(odGet, patNum) {
  const res = await odGet('/patplans', { PatNum: patNum }, { timeoutMs: OD_CALL_TIMEOUT_MS });
  if (!res.ok) return { bySub: new Map(), byPlan: new Map(), patPlans: [] };

  const patPlans = asArray(res.data).filter((pp) => {
    const o = Number(pp.Ordinal);
    return o === 1 || o === 2;
  });

  const bySub = new Map();
  const byPlan = new Map();
  await mapLimit(patPlans, OD_CONCURRENCY, async (pp) => {
    const ordinal = Number(pp.Ordinal);
    bySub.set(num(pp.InsSubNum), ordinal);
    const sub = await odGet(`/inssubs/${pp.InsSubNum}`, {}, { timeoutMs: OD_CALL_TIMEOUT_MS });
    if (sub.ok) {
      const row = Array.isArray(sub.data) ? sub.data[0] : sub.data;
      const planNum = num(row && row.PlanNum);
      if (planNum && !byPlan.has(planNum)) byPlan.set(planNum, ordinal);
    }
  });

  return { bySub, byPlan, patPlans };
}

/** Ordinal for a claimproc row, InsSubNum first then PlanNum. */
function ordinalFor(cp, maps) {
  const bySub = maps.bySub.get(num(cp.InsSubNum));
  if (bySub) return bySub;
  return maps.byPlan.get(num(cp.PlanNum)) || null;
}

/**
 * Legacy (/api/od/cob-procedures/:patNum) read procedurelog joined to per-plan
 * claimproc aggregates (via patplan.Ordinal → inssub → claimproc), giving each
 * TP procedure a REAL contracted allowed amount:
 *
 *     allowedAmt = ProcFee − claimproc.WriteOffEst   (per plan)
 *     insEst     = claimproc.InsEstTotal
 *     dedEst     = claimproc.DedEst
 *
 * API verdict: **fully expressible.** `GET /claimprocs` exists and returns the
 * whole row, so this is a faithful port rather than a substitute — see
 * docs/TC_OD_READS.md for the live probe evidence.
 *
 * Two corrections to the legacy behavior, both deliberate:
 *
 *  1. **The -1 sentinel.** OD writes -1 into WriteOffEst/DedEst/InsEstTotal to
 *     mean "not calculated". The legacy `COALESCE(cp.WriteOffEst, 0)` only
 *     guarded SQL NULL, so a -1 became `fee − (−1)` = an allowed amount one
 *     dollar ABOVE the billed fee. Here -1 means "no estimate": the allowed
 *     amount falls back to the fee and `allowedIsBilledFee` says so.
 *  2. **OD's *Override columns win.** WriteOffEstOverride / InsEstTotalOverride /
 *     DedEstOverride are what OD itself displays when set; the legacy query
 *     ignored them and could disagree with the OD screen.
 */
async function getCobProcedures(odGet, patNum) {
  const coverage = [];
  const notes = [];
  const endpointsUsed = [];

  // ── TP procedures for this patient ────────────────────────────────────────
  let statusFiltered = true;
  let res = await odGet('/procedurelogs', { PatNum: patNum, ProcStatus: 'TP', ...(OD_CLINIC_NUM ? { ClinicNum: OD_CLINIC_NUM } : {}) }, { timeoutMs: OD_CALL_TIMEOUT_MS });
  if (!res.ok && isCapabilityMiss(res)) {
    statusFiltered = false;
    res = await odGet('/procedurelogs', { PatNum: patNum }, { timeoutMs: OD_CALL_TIMEOUT_MS });
  }
  if (!res.ok) {
    const err = new Error(`Failed to fetch procedures (${res.status})`);
    err.odStatus = res.status;
    throw err;
  }
  endpointsUsed.push(`GET /procedurelogs?PatNum${statusFiltered ? '&ProcStatus=TP' : ''}`);

  const tpRows = asArray(res.data).filter((r) => {
    if (!statusFiltered) {
      const s = String(r.ProcStatus || '');
      if (s !== 'TP' && s !== '1') return false;
    }
    if (OD_CLINIC_NUM && String(r.ClinicNum ?? '') !== String(OD_CLINIC_NUM)) return false;
    return num(r.ProcFee) > 0;
  });

  // ── Per-plan claimproc estimates (the legacy join, on the API) ────────────
  const maps = await loadPlanOrdinals(odGet, patNum);
  endpointsUsed.push('GET /patplans?PatNum', 'GET /inssubs/{n}');

  let claimProcs = [];
  let cpTruncated = false;
  let cpAvailable = true;
  try {
    const fetched = await fetchClaimProcs(odGet, { PatNum: patNum });
    claimProcs = fetched.rows;
    cpTruncated = fetched.truncated;
    endpointsUsed.push('GET /claimprocs?PatNum&Offset');
  } catch (err) {
    // A claimproc failure must not sink the procedure list — the fee column is
    // still useful, and the coverage row will say the estimates are missing.
    cpAvailable = false;
    notes.push(
      err && err.capability
        ? 'This Open Dental key cannot read insurance estimates (/claimprocs). Allowed amounts fall back to the billed fee.'
        : 'Insurance estimates could not be read from Open Dental. Allowed amounts fall back to the billed fee.'
    );
  }

  /**
   * ProcNum → { 1: est, 2: est }. Only claimprocs in an ESTIMATE status count:
   * a Received row is money already paid on a completed procedure, not an
   * estimate for planned work, and summing the two would double-count.
   */
  const estByProc = new Map();
  for (const cp of claimProcs) {
    if (!CP_ESTIMATE_STATUSES.includes(String(cp.Status))) continue;
    const ordinal = ordinalFor(cp, maps);
    if (ordinal !== 1 && ordinal !== 2) continue;
    const procNum = num(cp.ProcNum);
    if (!procNum) continue;

    const slot = estByProc.get(procNum) || {};
    const prior = slot[ordinal];
    // Duplicate rows per plan (an estimate plus an adjustment) collapse by sum,
    // matching the legacy derived-table SUM(...) GROUP BY ProcNum.
    const writeOff = odEstimate(cp.WriteOffEst, cp.WriteOffEstOverride);
    const insEst = odEstimate(cp.InsEstTotal, cp.InsEstTotalOverride);
    const dedEst = odEstimate(cp.DedEst, cp.DedEstOverride);
    slot[ordinal] = {
      writeOff: writeOff == null ? (prior ? prior.writeOff : null) : (prior && prior.writeOff != null ? prior.writeOff + writeOff : writeOff),
      insEst: insEst == null ? (prior ? prior.insEst : null) : (prior && prior.insEst != null ? prior.insEst + insEst : insEst),
      dedEst: dedEst == null ? (prior ? prior.dedEst : null) : (prior && prior.dedEst != null ? prior.dedEst + dedEst : dedEst),
    };
    estByProc.set(procNum, slot);
  }

  let fallbackLines = 0;
  const procs = tpRows.map((r) => {
    const fee = num(r.ProcFee);
    const slot = estByProc.get(num(r.ProcNum)) || {};
    const pri = slot[1] || null;
    const sec = slot[2] || null;

    // allowed = fee − write-off, exactly as the legacy query, but only when OD
    // actually has a write-off estimate.
    const priAllowed = pri && pri.writeOff != null ? Math.max(0, fee - pri.writeOff) : fee;
    const secAllowed = sec && sec.writeOff != null ? Math.max(0, fee - sec.writeOff) : null;
    const allowedIsBilledFee = !(pri && pri.writeOff != null);
    if (allowedIsBilledFee) fallbackLines += 1;

    return {
      procNum: num(r.ProcNum),
      toothNum: String(r.ToothNum ?? '').trim() || 'N/A',
      surf: r.Surf || '',
      procCode: (r.procCode || r.ProcCode || '').toString().toUpperCase(),
      description: r.descript || r.Descript || '',
      fee,
      primaryAllowed: priAllowed,
      primaryInsEst: pri && pri.insEst != null ? pri.insEst : 0,
      primaryDedEst: pri ? pri.dedEst : null,
      hasPrimaryEstimate: !!pri,
      secondaryAllowed: secAllowed,
      secondaryInsEst: sec && sec.insEst != null ? sec.insEst : 0,
      secondaryDedEst: sec ? sec.dedEst : null,
      hasSecondaryEstimate: !!sec,
      allowedIsBilledFee,
      estimateSource: pri || sec ? 'claimproc' : null,
    };
  });

  coverage.push(
    cov('Treatment-planned procedures (code, tooth, surface, fee)', 'confirmed', 'GET /procedurelogs?PatNum&ProcStatus=TP'),
    cov('Per-plan contracted allowed amount (ProcFee − claimproc.WriteOffEst)', cpAvailable ? 'confirmed' : 'gap',
      cpAvailable ? 'GET /claimprocs?PatNum' : '(none)',
      cpAvailable
        ? 'A -1 write-off estimate means "not calculated" in Open Dental, not zero — those lines fall back to the billed fee and are counted for you.'
        : 'Insurance estimates could not be read; allowed amounts are the billed fees.'),
    cov('Per-plan insurance estimate (claimproc.InsEstTotal)', cpAvailable ? 'confirmed' : 'gap',
      cpAvailable ? 'GET /claimprocs?PatNum' : '(none)'),
    cov('Per-procedure deductible estimate (claimproc.DedEst)', cpAvailable ? 'confirmed' : 'gap',
      cpAvailable ? 'GET /claimprocs?PatNum' : '(none)'),
    cov('Primary / secondary split by patplan.Ordinal', 'confirmed', 'GET /patplans?PatNum → /inssubs/{n}',
      'Matched on the claimproc\'s own InsSubNum first, so two subscribers sharing one group plan resolve correctly.')
  );

  if (cpTruncated) {
    notes.push('This patient has more insurance history than one read returns; some estimates may be missing.');
  }
  if (cpAvailable && fallbackLines > 0) {
    notes.push(
      `${fallbackLines} procedure${fallbackLines === 1 ? ' has' : 's have'} no contracted allowed amount in Open Dental — the billed fee is used for ${fallbackLines === 1 ? 'it' : 'them'}.`
    );
  }

  return { procs, fallbackLines, claimProcsAvailable: cpAvailable, coverage, endpointsUsed, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5b. Insurance snapshot  ⚠️ WAS DIRECT MYSQL
// ─────────────────────────────────────────────────────────────────────────────

/** BenefitType → the COB field it feeds. */
function readBenefits(benefits) {
  const out = { annualMax: null, deductible: null, coinsurance: [], coverageLevel: null };
  for (const b of benefits) {
    const type = String(b.BenefitType || '');
    const amt = b.MonetaryAmt == null ? null : Number(b.MonetaryAmt);
    if (type === 'Limitations' && amt != null && amt >= 0 && !b.procCode && !b.CodeNum) {
      // Plan-wide annual maximum: no procedure code, a real dollar amount.
      if (out.annualMax == null || amt > out.annualMax) {
        out.annualMax = amt;
        out.coverageLevel = b.CoverageLevel || null;
      }
    } else if (type === 'Deductible' && amt != null && amt >= 0) {
      if (out.deductible == null) out.deductible = amt;
    } else if (type === 'CoInsurance' && b.Percent != null && Number(b.Percent) >= 0) {
      out.coinsurance.push({
        percent: Number(b.Percent),
        category: b.CovCatNum == null ? null : Number(b.CovCatNum),
        procCode: b.procCode || null,
      });
    }
  }
  return out;
}

/**
 * Benefit-year start for a plan. The legacy MySQL query hard-coded Jan 1 of the
 * current year; OD actually stores the renewal month on insplan.MonthRenew
 * (0 = calendar year). Using it makes the YTD basis correct for plans on a
 * non-calendar benefit year — an improvement over the legacy behavior, and the
 * basis is reported so the UI can say which one it used.
 */
function benefitYearStart(monthRenew) {
  const m = Number(monthRenew) || 0;
  const now = new Date();
  const year = now.getFullYear();
  if (m <= 0 || m > 12) return { start: `${year}-01-01`, basis: 'calendar year' };
  const pad = (n) => String(n).padStart(2, '0');
  const thisYear = `${year}-${pad(m)}-01`;
  const start = now.getMonth() + 1 >= m ? thisYear : `${year - 1}-${pad(m)}-01`;
  return { start, basis: `plan year starting ${pad(m)}/01` };
}

/**
 * Legacy read the patient's plans and their YTD usage straight out of MySQL:
 *
 *   SELECT pp.Ordinal, SUM(cp.InsPayAmt), SUM(cp.DedApplied)
 *   FROM claimproc cp JOIN inssub i … JOIN patplan pp …
 *   WHERE cp.PatNum = ? AND cp.Status IN (1,4) AND cp.DateCP >= benefitYearStart
 *
 * API verdict: **fully expressible.** `GET /claimprocs` accepts PatNum and
 * Status, returns InsPayAmt / DedApplied / DateCP / PlanNum / InsSubNum, and
 * pages via Offset — so this is the same aggregation on the same rows with the
 * same date basis (claimproc.DateCP), not an approximation from claim headers.
 *
 * Status is OD's STRING enum here ("Received" / "Supplemental"), not the DB
 * integers 1 and 4 the legacy query used.
 *
 * One improvement over legacy: the benefit year comes from insplan.MonthRenew
 * rather than a hard-coded January 1, so plans on a non-calendar year are right.
 */
async function getInsuranceSnapshot(odGet, patNum) {
  const coverage = [];
  const notes = [];
  const endpointsUsed = [];

  const patPlansRes = await odGet('/patplans', { PatNum: patNum }, { timeoutMs: OD_CALL_TIMEOUT_MS });
  endpointsUsed.push('GET /patplans?PatNum');
  if (!patPlansRes.ok) {
    const err = new Error(`Failed to fetch patient insurance (${patPlansRes.status})`);
    err.odStatus = patPlansRes.status;
    throw err;
  }

  const patPlans = asArray(patPlansRes.data)
    .filter((pp) => Number(pp.Ordinal) === 1 || Number(pp.Ordinal) === 2)
    .sort((a, b) => Number(a.Ordinal) - Number(b.Ordinal));

  const plans = await mapLimit(patPlans, OD_CONCURRENCY, async (pp) => {
    const ordinal = Number(pp.Ordinal);
    const out = {
      ordinal,
      role: ordinal === 1 ? 'primary' : 'secondary',
      patPlanNum: num(pp.PatPlanNum),
      // Carried so claimproc rows can be attributed by their own InsSubNum.
      insSubNum: num(pp.InsSubNum),
      isPending: !!pp.IsPending,
      relationship: pp.Relationship || '',
      planNum: null,
      carrierName: '',
      groupName: '',
      groupNum: '',
      planType: '',
      cobRule: '',
      monthRenew: 0,
      effectiveDate: '',
      termDate: '',
      annualMax: null,
      deductible: null,
      coinsurance: [],
      coverageLevel: null,
      unreadable: [],
    };

    const subRes = await odGet(`/inssubs/${pp.InsSubNum}`, {}, { timeoutMs: OD_CALL_TIMEOUT_MS });
    if (!subRes.ok) {
      out.unreadable.push('subscription');
      return out;
    }
    const sub = Array.isArray(subRes.data) ? subRes.data[0] : subRes.data;
    out.planNum = num(sub && sub.PlanNum);
    out.effectiveDate = odDate(sub && sub.DateEffective);
    out.termDate = odDate(sub && sub.DateTerm);

    if (out.planNum) {
      const planRes = await odGet(`/insplans/${out.planNum}`, {}, { timeoutMs: OD_CALL_TIMEOUT_MS });
      if (planRes.ok) {
        const plan = Array.isArray(planRes.data) ? planRes.data[0] : planRes.data;
        out.groupName = (plan && plan.GroupName) || '';
        out.groupNum = (plan && plan.GroupNum) || '';
        out.planType = (plan && plan.PlanType) || '';
        out.cobRule = (plan && plan.CobRule) || '';
        out.monthRenew = Number((plan && plan.MonthRenew) || 0);
        const carrierNum = num(plan && plan.CarrierNum);
        if (carrierNum) {
          const carrierRes = await odGet(`/carriers/${carrierNum}`, {}, { timeoutMs: OD_CALL_TIMEOUT_MS });
          if (carrierRes.ok) {
            const c = Array.isArray(carrierRes.data) ? carrierRes.data[0] : carrierRes.data;
            out.carrierName = (c && (c.CarrierName || c.carrierName)) || '';
          } else {
            out.unreadable.push('carrier');
          }
        }
      } else {
        out.unreadable.push('plan');
      }

      // Patient-specific benefit overrides win over plan-level rows, so read both.
      const [planBen, patBen] = await Promise.all([
        odGet('/benefits', { PlanNum: out.planNum }, { timeoutMs: OD_CALL_TIMEOUT_MS }),
        odGet('/benefits', { PatPlanNum: out.patPlanNum }, { timeoutMs: OD_CALL_TIMEOUT_MS }),
      ]);
      if (planBen.ok || patBen.ok) {
        const merged = [...(planBen.ok ? asArray(planBen.data) : []), ...(patBen.ok ? asArray(patBen.data) : [])];
        Object.assign(out, readBenefits(merged));
      } else {
        out.unreadable.push('benefits');
      }
    }

    return out;
  });

  const planList = plans.filter((r) => r && r.ok).map((r) => r.value);
  if (planList.length > 0) endpointsUsed.push('GET /inssubs/{n}', 'GET /insplans/{n}', 'GET /carriers/{n}', 'GET /benefits?PlanNum|PatPlanNum');

  // ── YTD usage: the legacy claimproc roll-up, on the API ───────────────────
  const yearFor = planList.length > 0 ? benefitYearStart(planList[0].monthRenew) : benefitYearStart(0);

  /** InsSubNum/PlanNum → ordinal, so a claimproc lands on the right plan. */
  const bySub = new Map(planList.map((p) => [p.insSubNum, p.ordinal]));
  const byPlan = new Map(planList.filter((p) => p.planNum).map((p) => [p.planNum, p.ordinal]));

  let ytdAvailable = true;
  let ytdTruncated = false;
  const usageByOrdinal = new Map();
  try {
    const { rows, truncated } = await fetchClaimProcs(odGet, { PatNum: patNum });
    ytdTruncated = truncated;
    endpointsUsed.push('GET /claimprocs?PatNum&Offset');

    for (const cp of rows) {
      // Money actually paid — never estimates, or the treatment being quoted
      // would count against its own annual maximum.
      if (!CP_PAID_STATUSES.includes(String(cp.Status))) continue;
      const ordinal = bySub.get(num(cp.InsSubNum)) || byPlan.get(num(cp.PlanNum)) || null;
      if (ordinal !== 1 && ordinal !== 2) continue;

      const plan = planList.find((p) => p.ordinal === ordinal);
      const yr = benefitYearStart(plan ? plan.monthRenew : 0);
      const when = odDate(cp.DateCP);
      if (!when || when < yr.start) continue;

      const acc = usageByOrdinal.get(ordinal) || { paidYTD: 0, dedAppliedYTD: 0, claimCount: 0 };
      acc.paidYTD += num(cp.InsPayAmt);
      acc.dedAppliedYTD += num(cp.DedApplied);
      acc.claimCount += 1;
      usageByOrdinal.set(ordinal, acc);
    }
  } catch (_err) {
    ytdAvailable = false;
    notes.push('Insurance payment history could not be read, so year-to-date usage is unavailable.');
  }

  for (const p of planList) {
    const u = usageByOrdinal.get(p.ordinal);
    const yr = benefitYearStart(p.monthRenew);
    p.usage = ytdAvailable
      ? {
          paidYTD: u ? u.paidYTD : 0,
          dedAppliedYTD: u ? u.dedAppliedYTD : 0,
          claimCount: u ? u.claimCount : 0,
          benefitYearStart: yr.start,
          basis: yr.basis,
        }
      : null;
    // null, not 0: an unknown maximum must never render as "nothing left".
    p.remainingMax = p.annualMax != null && p.usage ? Math.max(0, p.annualMax - p.usage.paidYTD) : null;
    p.remainingDeductible =
      p.deductible != null && p.usage ? Math.max(0, p.deductible - p.usage.dedAppliedYTD) : null;
  }

  coverage.push(
    cov('Primary / secondary designation (patplan.Ordinal)', 'confirmed', 'GET /patplans?PatNum'),
    cov('Carrier, group name/number, plan type, COB rule', 'confirmed', 'GET /inssubs/{n} → /insplans/{n} → /carriers/{n}'),
    cov('Annual maximum, deductible, coinsurance %', 'confirmed', 'GET /benefits?PlanNum & ?PatPlanNum',
      'Plan-level and patient-specific benefit rows are merged; patient-specific rows override.'),
    cov('Benefit-year start (insplan.MonthRenew)', 'confirmed', 'GET /insplans/{n}',
      'Better than the legacy query, which hard-coded January 1 regardless of the plan renewal month.'),
    cov('YTD paid / deductible applied (SUM claimproc.InsPayAmt, DedApplied)', ytdAvailable ? 'confirmed' : 'gap',
      ytdAvailable ? 'GET /claimprocs?PatNum' : '(none)',
      ytdAvailable
        ? 'Same rows and same date basis (claimproc.DateCP) as the legacy query. Claims sent but not yet paid are NOT subtracted — adjust by hand if a large claim is in process.'
        : 'The claimproc read failed for this patient.'),
    cov('Supplemental payments (claimproc Status Supplemental)', ytdAvailable ? 'confirmed' : 'gap',
      ytdAvailable ? 'GET /claimprocs?PatNum' : '(none)',
      'Counted alongside Received, matching the legacy Status IN (1,4).')
  );

  if (ytdTruncated) {
    notes.push('This patient has a long insurance history; year-to-date totals may be incomplete.');
  }

  return {
    plans: planList,
    ytdAvailable,
    ytdBasis: ytdAvailable
      ? `Remaining maximum and deductible are computed from paid claims since ${yearFor.start} (${yearFor.basis}). Claims sent but not yet paid are not subtracted — adjust by hand if a large claim is in process.`
      : 'Year-to-date insurance usage is unavailable.',
    coverage,
    endpointsUsed,
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Next appointment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legacy read appointment JOIN provider in MySQL (AptStatus = 1, next future).
 * Fully expressible: GET /appointments?PatNum&AptStatus=Scheduled&dateStart.
 * The API returns the string enum "Scheduled" (docs/OD_API_CONTRACT.md §1), not
 * the DB integer 1, and `provAbbr` saves the provider join.
 */
async function getNextAppointment(odGet, patNum) {
  const from = todayLocal();
  let res = await odGet(
    '/appointments',
    { PatNum: patNum, AptStatus: 'Scheduled', dateStart: from },
    { timeoutMs: OD_CALL_TIMEOUT_MS }
  );
  let serverFiltered = true;
  if (!res.ok && isCapabilityMiss(res)) {
    serverFiltered = false;
    res = await odGet('/appointments', { PatNum: patNum }, { timeoutMs: OD_CALL_TIMEOUT_MS });
  }
  if (!res.ok) {
    const err = new Error(`Failed to fetch appointments (${res.status})`);
    err.odStatus = res.status;
    throw err;
  }

  const upcoming = asArray(res.data)
    .filter((a) => {
      const status = String(a.AptStatus || '');
      if (status !== 'Scheduled' && status !== '1') return false;
      const when = odDate(a.AptDateTime);
      return !!when && when >= from;
    })
    .sort((a, b) => String(a.AptDateTime).localeCompare(String(b.AptDateTime)));

  const next = upcoming[0];
  return {
    appointment: next
      ? {
          aptNum: num(next.AptNum),
          dateTime: next.AptDateTime || '',
          description: next.ProcDescript || '',
          providerName: next.provAbbr || '',
          operatory: next.Op == null ? null : num(next.Op),
          isHygiene: !!next.IsHygiene,
        }
      : null,
    endpointsUsed: [`GET /appointments?PatNum${serverFiltered ? '&AptStatus=Scheduled&dateStart' : ''}`],
  };
}

module.exports = {
  // reads
  searchPatients,
  getPatient,
  getTreatmentPlan,
  findUnaccepted,
  getCobProcedures,
  getInsuranceSnapshot,
  getNextAppointment,
  // exported for tests / reuse
  asArray,
  isCapabilityMiss,
  mapLimit,
  normalizePatient,
  normalizeProc,
  isBillable,
  benefitYearStart,
  readBenefits,
  odDate,
  odEstimate,
  fetchClaimProcs,
  CP_ESTIMATE_STATUSES,
  CP_PAID_STATUSES,
  OD_CONCURRENCY,
  TP_ATTACH_CAP,
};
