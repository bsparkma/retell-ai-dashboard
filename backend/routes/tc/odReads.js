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
 * Legacy (/api/od/cob-procedures/:patNum) read procedurelog joined to per-plan
 * claimproc aggregates (via patplan.Ordinal → inssub → claimproc), giving each
 * TP procedure a REAL contracted allowed amount:
 *
 *     allowedAmt = ProcFee − claimproc.WriteOffEst   (per plan)
 *     insEst     = claimproc.InsEstTotal
 *     dedEst     = claimproc.DedEst
 *
 * API verdict: the procedure list is CONFIRMED; the per-plan claimproc numbers
 * are a GAP. **The OD Cloud API exposes no claimproc resource** — there is no
 * /claimprocs endpoint, and claim-level /claims rows carry only whole-claim
 * totals, which cannot be attributed back to an individual planned procedure.
 * WriteOffEst in particular has no API expression at all, so the contracted
 * allowed amount cannot be derived.
 *
 * What IS available, and is used here as the sanctioned partial substitute: when
 * the patient has a SAVED treatment plan, OD's own proctp rows carry PriInsAmt /
 * SecInsAmt / PatAmt — OD's per-plan insurance ESTIMATES. Those fill primary and
 * secondary insEst. They are not allowed amounts and are labelled as estimates.
 *
 * When neither is available, `primaryAllowed` falls back to the billed fee — the
 * same fallback the legacy Riley path used — and the coverage row says so, so the
 * COB panel can print "allowed = billed fee (no contracted amount available)"
 * instead of implying a negotiated number.
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

  // ── Saved-plan estimates (the only per-plan numbers the API can give) ─────
  /** @type {Map<number, {pri:number, sec:number, pat:number|null}>} keyed by ProcNumOrig */
  const savedEstimates = new Map();
  let savedPlanUsed = null;

  const plansRes = await odGet('/treatplans', { PatNum: patNum, TPStatus: 'Saved' }, { timeoutMs: OD_CALL_TIMEOUT_MS });
  if (plansRes.ok) {
    const saved = asArray(plansRes.data).sort(
      (a, b) => new Date(b.SecDateTEdit || 0).getTime() - new Date(a.SecDateTEdit || 0).getTime()
    );
    for (const plan of saved.slice(0, 3)) {
      let r = await odGet('/proctps', { TreatPlanNum: plan.TreatPlanNum }, { timeoutMs: OD_CALL_TIMEOUT_MS });
      if (!r.ok && isCapabilityMiss(r)) {
        r = await odGet('/proctp', { TreatPlanNum: plan.TreatPlanNum }, { timeoutMs: OD_CALL_TIMEOUT_MS });
      }
      if (!r.ok) break;
      const rowsTp = asArray(r.data);
      if (rowsTp.length === 0) continue;
      for (const t of rowsTp) {
        const key = num(t.ProcNumOrig);
        if (!key || savedEstimates.has(key)) continue;
        savedEstimates.set(key, {
          pri: num(t.PriInsAmt),
          sec: num(t.SecInsAmt),
          pat: t.PatAmt == null ? null : num(t.PatAmt),
        });
      }
      savedPlanUsed = num(plan.TreatPlanNum);
      endpointsUsed.push('GET /proctps?TreatPlanNum');
      break;
    }
  }

  const procs = tpRows.map((r) => {
    const fee = num(r.ProcFee);
    const est = savedEstimates.get(num(r.ProcNum));
    return {
      procNum: num(r.ProcNum),
      toothNum: String(r.ToothNum ?? '').trim() || 'N/A',
      surf: r.Surf || '',
      procCode: (r.procCode || r.ProcCode || '').toString().toUpperCase(),
      description: r.descript || r.Descript || '',
      fee,
      // Contracted allowed amounts are not derivable from the API — the billed
      // fee stands in, and `allowedIsBilledFee` tells the UI to say so.
      primaryAllowed: fee,
      primaryInsEst: est ? est.pri : 0,
      primaryDedEst: null,
      hasPrimaryEstimate: !!est,
      secondaryAllowed: null,
      secondaryInsEst: est ? est.sec : 0,
      secondaryDedEst: null,
      hasSecondaryEstimate: !!(est && est.sec > 0),
      allowedIsBilledFee: true,
      estimateSource: est ? 'od_saved_plan' : null,
    };
  });

  coverage.push(
    cov('Treatment-planned procedures (code, tooth, surface, fee)', 'confirmed', 'GET /procedurelogs?PatNum&ProcStatus=TP'),
    cov('Per-plan contracted allowed amount (ProcFee − claimproc.WriteOffEst)', 'gap', '(none)',
      'The OD Cloud API exposes no claimproc resource, and WriteOffEst appears in no other endpoint. Allowed amounts fall back to the billed fee.'),
    cov('Per-plan insurance estimate (claimproc.InsEstTotal)', savedEstimates.size > 0 ? 'partial' : 'gap',
      savedEstimates.size > 0 ? 'GET /proctps?TreatPlanNum' : '(none)',
      savedEstimates.size > 0
        ? "Substituted from OD's own Saved-plan estimates (proctp PriInsAmt/SecInsAmt), not from claimproc. Available only for procedures in a Saved plan."
        : 'No Saved treatment plan for this patient, so no per-plan estimate is available.'),
    cov('Per-procedure deductible estimate (claimproc.DedEst)', 'gap', '(none)',
      'claimproc is not exposed by the API; per-procedure deductible is unavailable.'),
    cov('Primary / secondary split by patplan.Ordinal', 'confirmed', 'GET /patplans?PatNum',
      'Ordinals come from the insurance snapshot; the per-procedure split is limited by the claimproc gap above.')
  );

  if (savedEstimates.size === 0) {
    notes.push('No Saved treatment plan was found, so Open Dental has no per-plan insurance estimate for these procedures.');
  }
  notes.push('Allowed amounts shown are the billed fees. Contracted (write-off adjusted) amounts are not available through the Open Dental API.');

  return { procs, savedPlanUsed, coverage, endpointsUsed, notes };
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
 * API verdict:
 *   - the plan chain (patplan → inssub → insplan → carrier) is CONFIRMED
 *   - annual max / deductible / coinsurance from /benefits is CONFIRMED
 *   - YTD usage is PARTIAL: with no claimproc resource, paid-to-date is summed
 *     from RECEIVED CLAIMS (/claims → InsPayAmt, DedApplied) attributed to a plan
 *     via claim.PlanNum. Same dollars, DIFFERENT DATE BASIS — claim.DateReceived
 *     rather than claimproc.DateCP — and claims not yet marked Received are not
 *     counted. `ytdBasis` states this and the UI must print it.
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

  // ── YTD usage from RECEIVED claims (the claimproc substitute) ─────────────
  const yearFor = planList.length > 0 ? benefitYearStart(planList[0].monthRenew) : benefitYearStart(0);
  const claimsRes = await odGet('/claims', { PatNum: patNum, ClaimStatus: 'R' }, { timeoutMs: OD_CALL_TIMEOUT_MS });
  let ytdAvailable = claimsRes.ok;
  const usageByPlan = new Map();

  if (claimsRes.ok) {
    endpointsUsed.push('GET /claims?PatNum&ClaimStatus=R');
    for (const c of asArray(claimsRes.data)) {
      const when = odDate(c.DateReceived) || odDate(c.DateService);
      if (!when) continue;
      const planNum = num(c.PlanNum);
      const own = planList.find((p) => p.planNum === planNum);
      if (!own) continue;
      const yr = benefitYearStart(own.monthRenew);
      if (when < yr.start) continue;
      const acc = usageByPlan.get(planNum) || { paidYTD: 0, dedAppliedYTD: 0, claimCount: 0 };
      acc.paidYTD += num(c.InsPayAmt);
      acc.dedAppliedYTD += num(c.DedApplied);
      acc.claimCount += 1;
      usageByPlan.set(planNum, acc);
    }
  } else {
    notes.push('Claims could not be read, so year-to-date insurance usage is unavailable.');
  }

  for (const p of planList) {
    const u = usageByPlan.get(p.planNum);
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
    cov('YTD paid / deductible applied (SUM claimproc.InsPayAmt, DedApplied)', ytdAvailable ? 'partial' : 'gap',
      ytdAvailable ? 'GET /claims?PatNum&ClaimStatus=R' : '(none)',
      ytdAvailable
        ? 'Summed from RECEIVED CLAIMS, not claimproc. Date basis is claim.DateReceived rather than claimproc.DateCP, and claims not yet marked Received are excluded — so this can read low near a benefit-year boundary or with claims in flight.'
        : 'No claimproc resource in the API and the claims read failed.'),
    cov('Supplemental payments (claimproc.Status = 4)', 'partial', 'GET /claims?PatNum&ClaimStatus=R',
      'Included only where the supplemental payment is reflected in the claim total.')
  );

  return {
    plans: planList,
    ytdAvailable,
    ytdBasis: ytdAvailable
      ? `Year-to-date figures are summed from received insurance claims since ${yearFor.start} (${yearFor.basis}). Claims still in process are not counted.`
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
  OD_CONCURRENCY,
  TP_ATTACH_CAP,
};
