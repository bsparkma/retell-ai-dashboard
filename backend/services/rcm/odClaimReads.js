'use strict';

/**
 * RCM Slice 6a — the Open Dental READ shell for claim matching.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY BY CONSTRUCTION
 * ─────────────────────────────────────────────────────────────────────────────
 * Every function here takes `odGet(path, params, opts) -> {ok,status,data,error}`
 * as its FIRST argument, exactly as routes/tc/odReads.js does. That is
 * deliberately a plain function rather than a client object or the odOffices
 * module: it keeps this file unit-testable against a recorded-shape fake, and
 * it makes reaching for a write verb impossible — there is no write method in
 * scope to reach for. Routes pass a closure over the OFFICE'S OWN client:
 *
 *     const od = assertOfficeMatch(office, getOdOffice(office));
 *     const odGet = (p, q, o) => od.client.apiGetRaw(p, q, o);
 *
 * `apiGetRaw` is itself GET-only with no counterpart (config/openDental.js).
 * `backend/routes/rcm/rcmNoOdWrites.test.js` asserts no POST/PUT/PATCH/DELETE
 * ever reaches an OD client from this module's require graph.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVEN FILTERS ONLY — AND EVERY ONE OF THEM IS RE-APPLIED CLIENT-SIDE
 * ─────────────────────────────────────────────────────────────────────────────
 * The filters this module sends are the ones measured live against Roland's
 * database: `?PatNum=`, `?ClaimNum=`, `?LName=` / `?FName=` (PREFIX matches),
 * `?Offset=` (100/page). Nothing else is sent.
 *
 * But the spike found that **Open Dental silently ignores list filters it does
 * not implement** — the request succeeds and returns the unfiltered page. A
 * caller that trusts the filter therefore gets a wider set than it asked for
 * and cannot tell. So every list read here is re-filtered on the same predicate
 * after it returns. If OD honoured the filter the client-side pass is a no-op;
 * if it ignored it, the set is still correct and `filterHonored` records which
 * happened, so a note can say so instead of the screen quietly showing another
 * patient's claims.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BOUNDED, AND HONEST ABOUT ITS BOUNDS
 * ─────────────────────────────────────────────────────────────────────────────
 * TC_OD_READS.md's cost note applies here verbatim: the OD chain is ~10 network
 * hops and throttled. Every fan-out below is capped, every cap is an env-var
 * tunable, and hitting one sets `truncated` with a note rather than silently
 * returning a short list. A short list of candidates that does not say it is
 * short is how a biller concludes "there is no such claim in the chart".
 */

const claimMatch = require('./claimMatch');

// ─── Tunables ────────────────────────────────────────────────────────────────

/**
 * Read a positive-integer tunable, or REFUSE TO START.
 *
 * Every cap here used to be `Number(process.env.X || default)`, which turns a
 * typo into `NaN` and `NaN` into silence: `RCM_OD_MAX_CANDIDATE_PATIENTS=three`
 * makes `slice(0, NaN)` return `[]`, no patients are searched, and the workbench
 * states as a FACT that Open Dental has no such claim. A misconfiguration that
 * produces a confident wrong answer is worse than one that fails to boot, and
 * this module's whole premise is that `no_candidate` means we looked.
 *
 * Throwing at require time surfaces it in the deploy, where it is one env edit
 * away from fixed.
 *
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `[rcm/odReads] ${name}=${JSON.stringify(raw)} is not a positive integer. ` +
        `Refusing to start: a NaN cap silently reports "no matching claim in Open Dental".`
    );
  }
  return n;
}

/** Per-OD-call timeout. Same default and same reasoning as the TC read layer. */
const OD_CALL_TIMEOUT_MS = intEnv('RCM_OD_CALL_TIMEOUT_MS', 30000);

/** OD paginates list reads at 100 rows via `Offset`. */
const OD_PAGE_SIZE = 100;

/** Pages of a patient's procedure history to scan for ProcStatus / ADA codes. */
const MAX_PROCEDURE_PAGES = intEnv('RCM_OD_MAX_PROCEDURE_PAGES', 3);

/** Pages of a patient's claims to scan. */
const MAX_CLAIM_PAGES = intEnv('RCM_OD_MAX_CLAIM_PAGES', 3);

/**
 * How many name-search hits become candidate patients.
 *
 * Small on purpose. OD matches names by PREFIX (`LName=Spark` returned 18 rows
 * live), so a common surname produces a long list — and reading eighteen
 * patients' whole claim histories to rank a single remittance line is neither
 * affordable nor proportionate. Exceeding it sets `truncated`.
 */
const MAX_CANDIDATE_PATIENTS = intEnv('RCM_OD_MAX_CANDIDATE_PATIENTS', 3);

/** Candidate claims whose claimprocs are fetched. */
const MAX_CANDIDATE_CLAIMS = intEnv('RCM_OD_MAX_CANDIDATE_CLAIMS', 8);

// ─── Small utilities ─────────────────────────────────────────────────────────

/** OD list endpoints return a bare array; be defensive about envelopes. */
function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

/**
 * Did OD reject this because the developer key has no access to the resource (a
 * CAPABILITY gap a practice fixes in the developer portal), rather than because
 * the service is down? The distinction is the difference between "enable
 * /claims on this key" and "Open Dental is unreachable", and a biller can only
 * act on one of them.
 * @param {{ok:boolean,status:number,error?:string}} res
 */
function isCapabilityMiss(res) {
  if (res.ok) return false;
  const msg = String(res.error || '').toLowerCase();
  return (
    msg.includes('not a valid resource') ||
    msg.includes('not a valid parameter') ||
    msg.includes('not enabled') ||
    res.status === 403 ||
    res.status === 404
  );
}

/**
 * A read that failed for a reason the caller must not mistake for "no results".
 * Thrown rather than returned so an empty candidate list can never be produced
 * by an outage — `no_candidate` is a claim we make only after a read succeeded.
 */
class OdReadError extends Error {
  /** @param {string} message @param {string} code @param {number} status */
  constructor(message, code, status) {
    super(message);
    this.name = 'OdReadError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Walk a paginated OD list, re-applying `keep` client-side (see the header) and
 * stopping at `maxPages`.
 *
 * @param {(path:string, params?:Record<string,unknown>, opts?:Record<string,unknown>) => Promise<{ok:boolean,status:number,data:unknown,error?:string}>} odGet
 * @param {string} path
 * @param {Record<string, unknown>} params
 * @param {(row: Record<string, unknown>) => boolean} keep
 * @param {number} maxPages
 * @returns {Promise<{ rows: Record<string,unknown>[], truncated: boolean, calls: number,
 *                     filterHonored: boolean, capabilityMiss: boolean }>}
 */
async function scanList(odGet, path, params, keep, maxPages) {
  /** @type {Record<string,unknown>[]} */
  const rows = [];
  let calls = 0;
  let truncated = false;
  let dropped = 0;
  let seen = 0;

  for (let page = 0; page < maxPages; page++) {
    const res = await odGet(
      path,
      { ...params, ...(page > 0 ? { Offset: page * OD_PAGE_SIZE } : {}) },
      { timeoutMs: OD_CALL_TIMEOUT_MS }
    );
    calls++;

    if (!res.ok) {
      if (isCapabilityMiss(res) && page === 0) {
        return { rows: [], truncated: false, calls, filterHonored: true, capabilityMiss: true };
      }
      throw new OdReadError(`OD GET ${path} failed (${res.status})`, 'OD_READ_FAILED', res.status);
    }

    const page_ = asArray(res.data);
    seen += page_.length;
    for (const row of page_) {
      if (keep(row)) rows.push(row);
      else dropped++;
    }

    if (page_.length < OD_PAGE_SIZE) {
      return { rows, truncated, calls, filterHonored: dropped === 0, capabilityMiss: false };
    }
    // A full page on the last allowed iteration means there is more behind it.
    if (page === maxPages - 1) truncated = true;
  }

  return { rows, truncated, calls, filterHonored: dropped === 0 && seen > 0, capabilityMiss: false };
}

// ─── Patient resolution ──────────────────────────────────────────────────────

/**
 * Split a remittance's patient name into surname and forename candidates.
 *
 * An 835's NM1*QC arrives as separate elements but our schema stores one string
 * (`rcm_claims.patient_name`), written by the parser as `"LAST, FIRST"`. An EOB
 * extraction can produce `"First Last"`. Both shapes are tried, because getting
 * this wrong means searching Open Dental for a first name in the surname lane
 * and concluding the patient does not exist.
 *
 * @param {unknown} patientName
 * @returns {{ last: string, first: string }[]} interpretations, best guess first
 */
function nameInterpretations(patientName) {
  if (typeof patientName !== 'string') return [];
  const trimmed = patientName.trim();
  if (!trimmed) return [];

  const comma = trimmed.indexOf(',');
  if (comma > 0) {
    // "LAST, FIRST" — the parser's own shape, so it is the only reading needed.
    const last = trimmed.slice(0, comma).trim();
    const first = trimmed.slice(comma + 1).trim().split(/\s+/)[0] || '';
    return [{ last, first }];
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return [{ last: parts[0], first: '' }];

  // No comma: both readings are plausible and OD is prefix-matching either way,
  // so try "First Last" first (the commoner human shape) and "Last First" too.
  return [
    { last: parts[parts.length - 1], first: parts[0] },
    { last: parts[0], first: parts[parts.length - 1] },
  ];
}

/**
 * Find candidate patients by name.
 *
 * Two lanes — surname and forename — merged, because Open Dental's fixture
 * `12828` is `LName: "Test", FName: "MangoTest"` and a surname-only search
 * misses it entirely. TC learned this the same way and its dual-lane merge is
 * documented as "not optional"; this is the same merge, written locally rather
 * than imported from routes/tc so a service does not depend on a route module.
 *
 * ⚠️ `LName` / `FName` are PREFIX matches. `LName=Spark` returns 18 rows live.
 * That is why the caller caps candidates and why nothing here auto-selects.
 *
 * @param {Parameters<typeof scanList>[0]} odGet
 * @param {unknown} patientName
 * @returns {Promise<{ patients: Record<string,unknown>[], calls: number, truncated: boolean, notes: string[] }>}
 */
async function searchPatientsByName(odGet, patientName) {
  const readings = nameInterpretations(patientName);
  /** @type {string[]} */
  const notes = [];
  if (readings.length === 0) {
    return { patients: [], calls: 0, truncated: false, notes: ['No patient name on the remittance to search by.'] };
  }

  /** @type {Map<number, Record<string, unknown>>} */
  const byPatNum = new Map();
  let calls = 0;
  let filterIgnored = false;
  let pageCapped = false;

  for (const { last, first } of readings) {
    for (const [param, value] of [['LName', last], ['FName', first]]) {
      if (!value || value.length < 2) continue;
      const res = await odGet('/patients', { [param]: value }, { timeoutMs: OD_CALL_TIMEOUT_MS });
      calls++;
      if (!res.ok) {
        if (isCapabilityMiss(res)) {
          notes.push('Open Dental refused the patient search — enable the /patients resource on this key.');
          continue;
        }
        throw new OdReadError(`OD patient search failed (${res.status})`, 'OD_READ_FAILED', res.status);
      }
      /*
       * RE-FILTERED, like every other list read in this file.
       *
       * This was the ONE that trusted Open Dental's filter, and it is the
       * worst place to have done so: if `?LName=` is ever non-functional (an
       * upgrade, a per-practice entitlement difference), OD returns page 1 of
       * the PATIENT TABLE — 100 real people — with a 200. Every one of them
       * would have been read in full and offered as a candidate for a biller
       * to attach a stranger's PatNum to.
       *
       * The predicate is the one we asked for: a PREFIX match on the same
       * field, case-insensitively. If OD honoured the filter this drops
       * nothing.
       */
      const wanted = String(value).toUpperCase();
      let kept = 0;
      let dropped = 0;
      for (const p of asArray(res.data)) {
        const n = Number(p.PatNum);
        if (!Number.isFinite(n)) continue;
        const field = String(p[param] || '').toUpperCase();
        if (!field.startsWith(wanted)) {
          dropped++;
          continue;
        }
        kept++;
        if (!byPatNum.has(n)) byPatNum.set(n, p);
      }
      if (dropped > 0) {
        filterIgnored = true;
        console.warn(
          `[rcm/odReads] Open Dental ignored the ${param} filter on /patients — ` +
            `${dropped} non-matching rows discarded client-side`
        );
      }
      // A full page means OD had more to give and we asked for one page. Say so
      // rather than letting "N patients matched" silently mean "at least N".
      if (kept + dropped >= OD_PAGE_SIZE) pageCapped = true;
    }
    // A reading that found somebody is enough; trying the transposed one as
    // well would only add same-prefix strangers.
    if (byPatNum.size > 0) break;
  }

  // Rank by how much of the remittance name the chart actually shares, so the
  // cap below keeps the plausible ones rather than whichever OD returned first.
  const ourTokens = claimMatch.nameTokens(patientName);
  const patients = [...byPatNum.values()].sort((a, b) => {
    const shared = (p) =>
      claimMatch.nameTokens(`${p.LName || ''} ${p.FName || ''}`).filter((t) => ourTokens.includes(t)).length;
    return shared(b) - shared(a) || Number(a.PatNum) - Number(b.PatNum);
  });

  if (filterIgnored) {
    notes.push(
      'Open Dental ignored the name filter on /patients and returned unrelated patients; they were discarded here. Verify the patient before confirming any match.'
    );
  }
  if (pageCapped) {
    notes.push(
      `Open Dental returned a full page of ${OD_PAGE_SIZE} name matches; there may be more it did not send.`
    );
  }

  const truncated = patients.length > MAX_CANDIDATE_PATIENTS || pageCapped;
  if (patients.length > MAX_CANDIDATE_PATIENTS) {
    notes.push(
      `Open Dental matched ${patients.length} patients by name prefix; the ${MAX_CANDIDATE_PATIENTS} closest were searched. Narrow it by linking the patient first.`
    );
  }

  return { patients: patients.slice(0, MAX_CANDIDATE_PATIENTS), calls, truncated, notes };
}

/**
 * One patient by PatNum. Used when the proposal already carries a linked
 * `od_patient_id` — which is only ever set alongside its office (hard rule 3).
 * @param {Parameters<typeof scanList>[0]} odGet
 * @param {number} patNum
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function getPatient(odGet, patNum) {
  const res = await odGet(`/patients/${patNum}`, {}, { timeoutMs: OD_CALL_TIMEOUT_MS });
  if (!res.ok) {
    if (isCapabilityMiss(res)) return null;
    throw new OdReadError(`OD patient read failed (${res.status})`, 'OD_READ_FAILED', res.status);
  }
  const data = res.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

// ─── The candidate fetch ─────────────────────────────────────────────────────

/**
 * Fetch everything the pure scorer needs to rank Open Dental claims against one
 * proposal claim.
 *
 * Call shape per patient: 1 claims scan (+pages), 1 procedure scan (+pages),
 * and one `/claimprocs?ClaimNum=` per candidate claim. The procedure scan is
 * per PATIENT rather than per claimproc on purpose — `GET /procedurelogs/{n}`
 * once per line would be one call per line per claim, which on a patient with
 * four candidate claims of five lines each is twenty calls instead of one.
 *
 * @param {Parameters<typeof scanList>[0]} odGet
 * @param {{ patientName?: unknown, odPatientId?: number|null, claimNumber?: unknown,
 *           serviceDate?: unknown, totalBilledCents?: unknown, lines?: unknown[] }} proposal
 * @returns {Promise<{
 *   candidates: Array<{ claim: Record<string,unknown>, claimProcs: Record<string,unknown>[],
 *                       procedures: Map<number, Record<string,unknown>>,
 *                       patient: Record<string,unknown>|null }>,
 *   patientsConsidered: Array<{ patNum: number, name: string }>,
 *   notes: string[], truncated: boolean, odCalls: number, fetchedAt: string,
 * }>}
 */
async function findClaimCandidates(odGet, proposal) {
  /** @type {string[]} */
  const notes = [];
  let odCalls = 0;
  let truncated = false;

  // ── 1. Which patients ────────────────────────────────────────────────────
  /** @type {Record<string, unknown>[]} */
  let patients = [];
  const linkedPatNum = Number(proposal.odPatientId);

  if (Number.isFinite(linkedPatNum) && linkedPatNum > 0) {
    // Already linked. A linked PatNum belongs to THIS office's database by
    // construction (it was stored on an office_id-carrying row), and the
    // caller has already asserted the client matches that office.
    const p = await getPatient(odGet, linkedPatNum);
    odCalls++;
    if (p) patients = [p];
    else notes.push(`Open Dental has no patient ${linkedPatNum} — the stored link may belong to another practice.`);
  } else {
    const found = await searchPatientsByName(odGet, proposal.patientName);
    odCalls += found.calls;
    patients = found.patients;
    truncated = truncated || found.truncated;
    notes.push(...found.notes);
  }

  if (patients.length === 0) {
    return {
      candidates: [],
      patientsConsidered: [],
      notes,
      truncated,
      odCalls,
      fetchedAt: new Date().toISOString(),
    };
  }

  // ── 2. Their claims, and the procedures behind them ──────────────────────
  /** @type {Array<{claim: Record<string,unknown>, claimProcs: Record<string,unknown>[], procedures: Map<number, Record<string,unknown>>, patient: Record<string,unknown>|null}>} */
  const candidates = [];
  /** @type {Array<{patNum:number,name:string}>} */
  const patientsConsidered = [];

  for (const patient of patients) {
    const patNum = Number(patient.PatNum);
    patientsConsidered.push({
      patNum,
      name: `${patient.LName || ''}, ${patient.FName || ''}`.trim().replace(/^,\s*/, ''),
    });

    const claims = await scanList(
      odGet,
      '/claims',
      { PatNum: patNum },
      (row) => Number(row.PatNum) === patNum,
      MAX_CLAIM_PAGES
    );
    odCalls += claims.calls;
    truncated = truncated || claims.truncated;
    if (claims.capabilityMiss) {
      notes.push('Open Dental refused the claim list — enable the /claims resource on this developer key.');
      continue;
    }
    if (!claims.filterHonored) {
      notes.push(
        `Open Dental ignored the PatNum filter on /claims and returned other patients' rows; they were discarded here.`
      );
    }
    if (claims.truncated) {
      notes.push(
        `Patient ${patNum} has more claims than the ${MAX_CLAIM_PAGES * OD_PAGE_SIZE}-row scan reads. Older claims were not considered.`
      );
    }

    const procedures = await scanList(
      odGet,
      '/procedurelogs',
      { PatNum: patNum },
      (row) => Number(row.PatNum) === patNum,
      MAX_PROCEDURE_PAGES
    );
    odCalls += procedures.calls;
    /*
     * A capability miss here used to be SILENT — the `/claims` and
     * `/claimprocs` scans checked for one and this did not. The consequence was
     * not a missing note but a WRONG ANSWER: with no procedure rows, every line
     * read as not-deleted (DELETE is a soft delete, so absence is
     * indistinguishable from presence), which inflated the chart's billed and
     * paid totals, hid the deleted-lines blocker, and let a deleted
     * procedure's ClaimProcNum be paired for Slice 6c to post against.
     *
     * The scorer now treats a missing procedure row as 'unknown' rather than
     * live; this is the note that tells a human WHY.
     */
    if (procedures.capabilityMiss) {
      notes.push(
        'Open Dental refused the procedure list — enable the /procedurelogs resource on this key. ' +
          'Without it a deleted procedure cannot be told from a live one, so amounts are withheld.'
      );
      truncated = true;
    }
    if (procedures.truncated) {
      notes.push(
        `Patient ${patNum} has more procedures than the ${MAX_PROCEDURE_PAGES * OD_PAGE_SIZE}-row scan reads; some line codes and deleted-procedure checks may be missing.`
      );
      truncated = true;
    }
    /** @type {Map<number, Record<string, unknown>>} */
    const procByNum = new Map();
    for (const proc of procedures.rows) {
      const n = Number(proc.ProcNum);
      if (Number.isFinite(n)) procByNum.set(n, proc);
    }

    // Newest claims first — a remittance almost always concerns recent work,
    // and the cap below should spend itself on those.
    const ordered = claims.rows
      .slice()
      .sort((a, b) => String(b.DateService || '').localeCompare(String(a.DateService || '')));

    if (ordered.length > MAX_CANDIDATE_CLAIMS) {
      truncated = true;
      notes.push(
        `Patient ${patNum} has ${ordered.length} claims; the ${MAX_CANDIDATE_CLAIMS} most recent were examined in detail.`
      );
    }

    for (const claim of ordered.slice(0, MAX_CANDIDATE_CLAIMS)) {
      const claimNum = Number(claim.ClaimNum);
      const procs = await scanList(
        odGet,
        '/claimprocs',
        { ClaimNum: claimNum },
        (row) => Number(row.ClaimNum) === claimNum,
        MAX_CLAIM_PAGES
      );
      odCalls += procs.calls;
      if (procs.capabilityMiss) {
        notes.push('Open Dental refused the claimproc list — enable the /claimprocs resource on this key.');
        continue;
      }
      if (!procs.filterHonored) {
        notes.push(
          `Open Dental ignored the ClaimNum filter on /claimprocs and returned other claims' lines; they were discarded here.`
        );
      }
      candidates.push({ claim, claimProcs: procs.rows, procedures: procByNum, patient });
    }
  }

  return {
    candidates,
    patientsConsidered,
    notes,
    truncated,
    odCalls,
    // The instant the observation was made. Slice 6c re-verifies against the
    // snapshot this stamps, so it is data, not decoration.
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  OdReadError,
  OD_CALL_TIMEOUT_MS,
  OD_PAGE_SIZE,
  MAX_PROCEDURE_PAGES,
  MAX_CLAIM_PAGES,
  MAX_CANDIDATE_PATIENTS,
  MAX_CANDIDATE_CLAIMS,
  findClaimCandidates,
  searchPatientsByName,
  getPatient,
  nameInterpretations,
  isCapabilityMiss,
  scanList,
  intEnv,
};
