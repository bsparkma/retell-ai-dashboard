'use strict';

/**
 * THE ONE FILE IN THE FEE SCHEDULE MODULE THAT TOUCHES OPEN DENTAL.
 *
 * Slice 1 shipped with a flat invariant — nothing under routes/fees or
 * services/fees may reach Open Dental at all — and `feesNoOdAccess.test.js`
 * proved it two ways. Slice 3 is the reviewed edit that invariant anticipated:
 * it becomes a ONE-FILE ALLOW-LIST naming this file, exactly as RCM's
 * (`odPostingWrites.js`) and hygiene's (`odPerioWriter.js`) did. Every other
 * file in the module is still forbidden from importing the OD seam, and the
 * `mysql2` ban stays absolute — there is no direct-database path here and never
 * will be.
 *
 * Reads AND writes both live here. Putting the reads elsewhere would mean two
 * files named the seam, which is the same as no allow-list.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THE OPEN DENTAL API ACTUALLY OFFERS (verified 2026-09-23)
 * ═════════════════════════════════════════════════════════════════════════════
 * From the published spec, and the reason each choice below is forced:
 *
 *   GET    /feescheds                  list. No filters.
 *   POST   /feescheds                  create. Description + FeeSchedType required.
 *   PUT    /feescheds/{FeeSchedNum}    update. Description, IsHidden, IsGlobal.
 *   ── THERE IS NO DELETE FOR /feescheds. ──
 *
 *   GET    /fees?FeeSched=&CodeNum=    list. Both filters optional.
 *   POST   /fees                       create. Amount + FeeSched + CodeNum required.
 *   PUT    /fees/{FeeNum}              update. Amount.
 *   DELETE /fees/{FeeNum}              delete. Supported.
 *
 *   GET    /procedurecodes             list. NO ProcCode filter — the only way
 *                                      to turn "D2740" into a CodeNum is to
 *                                      page the whole table and match locally.
 *
 * Three consequences run through everything below:
 *
 *  1. A NEW SCHEDULE CANNOT BE UNCREATED. Rollback deletes the fees this batch
 *     wrote and then HIDES the schedule (PUT IsHidden). The shell remains, and
 *     `rollbackToBackup` says so in its result rather than reporting a clean
 *     removal. A hidden schedule attached to no plan reprices nothing, so the
 *     practical harm is zero — but the UI tells the truth about it anyway.
 *  2. POST /fees NEEDS A CodeNum, NOT A ProcCode. The procedure-code table is
 *     paged once per post and cached for the run; ~1,300 codes is ~13 requests
 *     against a 1 req/sec credential, paid once instead of once per fee.
 *  3. EVERYTHING IS PAGED AT 100. `Limit`/`Offset`, hard max 100 on the cloud
 *     API. Every list below pages to exhaustion and refuses to guess when a
 *     page comes back the wrong shape.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A 200 IS NOT PROOF. EVERY WRITE IS READ BACK.
 * ═════════════════════════════════════════════════════════════════════════════
 * RCM learned this the expensive way: `PUT /claimprocs {DateCP}` returns 200 OK
 * and changes nothing. The transport cannot enforce read-back; this file does,
 * and there is no path to an Open Dental write in this module that does not go
 * through it. `writeFee` returns the FeeNum only after reading the fee back and
 * comparing the amount.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THROTTLE
 * ═════════════════════════════════════════════════════════════════════════════
 * Every call passes `minIntervalMs: OD_MIN_INTERVAL_MS` and `module: 'fees'`.
 * The transport holds ONE slot per credential, shared with voice, RCM and
 * hygiene, and `minIntervalMs` can only ever RAISE a request's share of it. So
 * a 500-fee post genuinely does make that office's other Open Dental reads
 * queue behind it — which is why posting is a background job with a progress
 * endpoint rather than something that happens inside a request, and why the
 * confirm dialog states the row count before anybody starts one.
 */

/*
 * THE NAMESPACE, NOT A DESTRUCTURE.
 *
 * `const { getOdOffice } = require(...)` would read both properties at MODULE
 * LOAD, which has two costs. The small one: a test that arms the seam with a
 * tripwire can no longer tell whether this module merely IMPORTED Open Dental
 * or actually CALLED it, because requiring the file is enough to trip it — and
 * "the upload route still works with Open Dental down" is a property worth
 * being able to assert. The larger one: a destructured binding is fixed at
 * require time, so a future test could not stub the seam at all.
 *
 * Accessing through the namespace defers both reads to the moment of use,
 * which is also when the office handle is genuinely needed.
 */
const odOffices = require('../../config/odOffices');

/**
 * Open Dental's documented paid-tier limit is 1 request per second, per
 * CustomerKey. 1200ms leaves headroom for clock skew and for the 429 backoff to
 * stay a rarity rather than the steady state. Matches services/rcm/odPacer.js's
 * floor; the two modules share the credential, so sharing the number is the
 * point.
 */
const OD_MIN_INTERVAL_MS = 1200;

/** The cloud API's hard page size. Asking for more is silently capped. */
const PAGE_SIZE = 100;

/**
 * A page count no legitimate list reaches, so a server that ignores `Offset`
 * cannot spin this forever.
 *
 * This is not paranoia: a sibling spike found that Open Dental list filters are
 * sometimes SILENTLY IGNORED rather than refused (RCM Spike 0a). A list that
 * ignores paging returns the same 100 rows every time, and without a ceiling
 * the loop below would never end. It is a circuit breaker, not a limit — every
 * caller treats hitting it as a refusal, never as "that was all of them".
 */
const MAX_PAGES = 200;

/** Fee schedule types the API admits. 'Normal' is the only one this slice creates. */
const FEE_SCHED_TYPES = Object.freeze([
  'Normal',
  'CoPay',
  'OutNetwork',
  'FixedBenefit',
  'ManualBlueBook',
]);

/**
 * A structured failure. Every function here returns `{ ok: false, code, error }`
 * rather than throwing, for the reason the transport gives: the posting state
 * machine turns on telling a REFUSAL apart from an outage, and Open Dental
 * refuses cleanly and informatively. Throwing the sentence away would discard
 * the most actionable thing in the response.
 */
function fail(code, error, extra) {
  return { ok: false, code, error, ...(extra || {}) };
}

/**
 * The office's own Open Dental client, asserted against the office the
 * operation says it is for.
 *
 * `assertOfficeMatch(key, getOdOffice(key))` is the idiom the per-office slice
 * established; it is the safety heart of this seam. Roland and Riley hold
 * different contracts with the same payers, so a fee schedule written into the
 * wrong database reprices a practice against terms it never agreed to — the
 * exact harm this module exists downstream of.
 *
 * @param {string} officeKey
 * @returns {{ ok: true, handle: object } | { ok: false, code: string, error: string }}
 */
function officeClient(officeKey) {
  try {
    const handle = odOffices.assertOfficeMatch(officeKey, odOffices.getOdOffice(officeKey));
    return { ok: true, handle };
  } catch (err) {
    // OdOfficeError carries a code (OFFICE_UNKNOWN, OFFICE_NOT_OD_CONNECTED,
    // OFFICE_OD_KEY_MISSING, OFFICE_MISMATCH) and never falls back to another
    // office's key. Fail closed per office, as the slice requires.
    const code = (err && err.code) || 'OFFICE_UNAVAILABLE';
    return { ok: false, code, error: (err && err.message) || String(err) };
  }
}

/** Shared options on every request: the throttle share and the attribution. */
function odOpts(extra) {
  return { minIntervalMs: OD_MIN_INTERVAL_MS, module: 'fees', ...(extra || {}) };
}

/**
 * Page a list endpoint to exhaustion.
 *
 * Stops when a page comes back short — which is the documented signal — and
 * refuses at MAX_PAGES rather than looping on a server that ignores `Offset`.
 * A non-array page is a refusal too: an object where a list belongs means the
 * shape changed, and continuing would silently return a prefix of the truth.
 *
 * @param {object} client the office's OD client
 * @param {string} path e.g. '/fees'
 * @param {Record<string, unknown>} params
 * @returns {Promise<{ ok: true, items: object[] } | { ok: false, code: string, error: string }>}
 */
async function listAll(client, path, params) {
  /** @type {object[]} */
  const items = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await client.apiGetRaw(
      path,
      { ...params, Limit: PAGE_SIZE, Offset: page * PAGE_SIZE },
      odOpts()
    );
    if (!res.ok) {
      return fail(
        'OD_READ_FAILED',
        `Open Dental did not answer ${path} (HTTP ${res.status})${res.error ? `: ${res.error}` : ''}`
      );
    }
    if (!Array.isArray(res.data)) {
      return fail('OD_BAD_SHAPE', `${path} returned something that is not a list`);
    }
    items.push(...res.data);
    if (res.data.length < PAGE_SIZE) return { ok: true, items };
  }
  return fail(
    'OD_TOO_MANY_PAGES',
    `${path} did not stop paging after ${MAX_PAGES} pages; refusing rather than guessing where it ends`
  );
}

// ─── READ HALF ───────────────────────────────────────────────────────────────

/**
 * The office's fee schedules, for the target picker.
 *
 * Hidden schedules are returned WITH an `isHidden` flag rather than filtered
 * out, because a rolled-back batch's schedule is hidden and an operator looking
 * for it should find it rather than conclude it was deleted.
 *
 * @param {string} officeKey
 * @returns {Promise<{ ok: true, schedules: Array<object> } | { ok: false, code: string, error: string }>}
 */
async function listFeeSchedules(officeKey) {
  const office = officeClient(officeKey);
  if (!office.ok) return office;

  const res = await listAll(office.handle.client, '/feescheds', {});
  if (!res.ok) return res;

  return {
    ok: true,
    schedules: res.items.map((s) => ({
      feeSchedNum: Number(s.FeeSchedNum),
      description: typeof s.Description === 'string' ? s.Description : '',
      feeSchedType: typeof s.FeeSchedType === 'string' ? s.FeeSchedType : '',
      // OD returns these as booleans on the cloud API; coerced defensively
      // because a string "false" is a truthy value and this one decides whether
      // a schedule is offered as a target. (The commlog picker was bitten by
      // exactly that: isHidden came back as the STRING "false".)
      isHidden: s.IsHidden === true || s.IsHidden === 'true',
      isGlobal: s.IsGlobal === true || s.IsGlobal === 'true',
    })),
  };
}

/**
 * Every fee currently in a schedule, in Open Dental's own shape.
 *
 * This is the backup read. The shape is stored VERBATIM — a restore must put
 * back exactly what was there, and a mapping is a place for a field to go
 * missing.
 *
 * THE FeeSched FILTER IS NOT TRUSTED. Open Dental list filters have been
 * observed to be silently ignored rather than refused, and a "backup" that
 * quietly contained the whole practice's fees would restore catastrophically.
 * So the filter is sent AND the result is filtered again locally on
 * `FeeSched`; a row that does not match is dropped with the mismatch counted,
 * and a wholly unfiltered response is therefore reduced to the right rows
 * rather than acted on.
 *
 * @param {string} officeKey
 * @param {number} feeSchedNum
 * @returns {Promise<{ ok: true, fees: object[], ignoredFilter: boolean } | { ok: false, code: string, error: string }>}
 */
async function listFeesInSchedule(officeKey, feeSchedNum) {
  const office = officeClient(officeKey);
  if (!office.ok) return office;
  if (!Number.isInteger(feeSchedNum) || feeSchedNum <= 0) {
    return fail('BAD_FEESCHED', `${String(feeSchedNum)} is not a fee schedule number`);
  }

  const res = await listAll(office.handle.client, '/fees', { FeeSched: feeSchedNum });
  if (!res.ok) return res;

  const mine = res.items.filter((f) => Number(f.FeeSched) === feeSchedNum);
  return {
    ok: true,
    fees: mine,
    // Surfaced rather than swallowed: it is the difference between "this
    // schedule has 12 fees" and "the server handed us the whole table and we
    // kept 12 of them", and the second is worth knowing about.
    ignoredFilter: mine.length !== res.items.length,
  };
}

/**
 * ProcCode → CodeNum for this office.
 *
 * ONE paged sweep of /procedurecodes, because the API offers no ProcCode
 * filter. ~1,300 codes is ~13 requests; paid once per post and handed to the
 * job, rather than once per fee, which would double a 500-fee run.
 *
 * Returns a plain object rather than a Map so it serialises into the job state
 * unchanged if a later slice persists it.
 *
 * @param {string} officeKey
 * @returns {Promise<{ ok: true, codeNums: Record<string, number>, total: number } | { ok: false, code: string, error: string }>}
 */
async function fetchProcedureCodeMap(officeKey) {
  const office = officeClient(officeKey);
  if (!office.ok) return office;

  const res = await listAll(office.handle.client, '/procedurecodes', {});
  if (!res.ok) return res;

  /** @type {Record<string, number>} */
  const codeNums = {};
  for (const item of res.items) {
    const proc = typeof item.ProcCode === 'string' ? item.ProcCode.trim().toUpperCase() : '';
    const num = Number(item.CodeNum);
    // FIRST WINS, and duplicates are left alone. Open Dental permits two rows
    // with the same ProcCode (a hidden legacy one beside a live one); picking
    // the later would silently move fees onto whichever the sweep happened to
    // reach last. First is at least stable across runs.
    if (proc !== '' && Number.isInteger(num) && num > 0 && codeNums[proc] === undefined) {
      codeNums[proc] = num;
    }
  }
  return { ok: true, codeNums, total: res.items.length };
}

/**
 * The fee for one code in one schedule, or null.
 *
 * This is the VERIFY-BY-READ primitive the resume path turns on: after a crash,
 * a row with no stored FeeNum might still have been written, because the crash
 * could have landed between Open Dental's commit and ours. Asking Open Dental
 * is the only way to tell, and writing without asking is how a schedule ends up
 * with D2740 in it twice — which Open Dental then picks from arbitrarily.
 *
 * @param {string} officeKey
 * @param {number} feeSchedNum
 * @param {number} codeNum
 * @returns {Promise<{ ok: true, fee: object|null } | { ok: false, code: string, error: string }>}
 */
async function findFee(officeKey, feeSchedNum, codeNum) {
  const office = officeClient(officeKey);
  if (!office.ok) return office;

  const res = await office.handle.client.apiGetRaw(
    '/fees',
    { FeeSched: feeSchedNum, CodeNum: codeNum, Limit: PAGE_SIZE },
    odOpts()
  );
  if (!res.ok) {
    // A 404 on a list endpoint means "none", not "broken" — OD documents 404 on
    // GET /fees. Treating it as an outage would stall a resume on every row
    // that genuinely has not been written yet, which is most of them.
    if (res.status === 404) return { ok: true, fee: null };
    return fail('OD_READ_FAILED', `Could not read fees (HTTP ${res.status})`);
  }
  if (!Array.isArray(res.data)) return fail('OD_BAD_SHAPE', '/fees returned something that is not a list');

  // Both filters re-applied locally, for the reason listFeesInSchedule gives.
  const match = res.data.find(
    (f) => Number(f.FeeSched) === feeSchedNum && Number(f.CodeNum) === codeNum
  );
  return { ok: true, fee: match || null };
}

// ─── WRITE HALF ──────────────────────────────────────────────────────────────

/**
 * Create a fee schedule.
 *
 * Always `FeeSchedType: 'Normal'` and `IsGlobal: true`, and ATTACHED TO NO
 * INSURANCE PLAN — v1 writes fees only (ratified: no carrier creation, no plan
 * creation, no plan attachment). An unattached schedule reprices nothing, which
 * is what makes a mistaken post recoverable and what makes the staging
 * safety rule ("ZZ CAREIN TEST - DO NOT USE") sufficient rather than hopeful.
 *
 * @param {string} officeKey
 * @param {string} description
 * @returns {Promise<{ ok: true, feeSchedNum: number, description: string } | { ok: false, code: string, error: string }>}
 */
async function createFeeSchedule(officeKey, description) {
  const office = officeClient(officeKey);
  if (!office.ok) return office;

  const name = typeof description === 'string' ? description.trim() : '';
  if (name === '') return fail('BAD_SCHEDULE_NAME', 'A new fee schedule needs a name');
  if (name.length > 255) return fail('BAD_SCHEDULE_NAME', 'That fee schedule name is too long');

  const res = await office.handle.client.apiWriteRaw(
    'POST',
    '/feescheds',
    { Description: name, FeeSchedType: 'Normal', IsHidden: false, IsGlobal: true },
    odOpts()
  );
  if (!res.ok) {
    return fail(
      'OD_WRITE_FAILED',
      `Open Dental refused to create the fee schedule${res.error ? `: ${res.error}` : ` (HTTP ${res.status})`}`
    );
  }

  const created = res.data && typeof res.data === 'object' ? res.data : {};
  const feeSchedNum = Number(created.FeeSchedNum);
  if (!Number.isInteger(feeSchedNum) || feeSchedNum <= 0) {
    // A 200 with no id is a refusal, not a success: persisting a half-known
    // linkage would be worse than refusing, and we would have no target to post
    // into or to roll back.
    return fail('OD_BAD_SHAPE', 'Open Dental accepted the fee schedule but returned no FeeSchedNum');
  }

  return {
    ok: true,
    feeSchedNum,
    description: typeof created.Description === 'string' ? created.Description : name,
  };
}

/**
 * Write ONE fee, and read it back before reporting success.
 *
 * Create-or-update: if the code already has a fee in this schedule, the amount
 * is PUT onto the existing FeeNum rather than POSTing a second row. A schedule
 * holding one code twice is a schedule Open Dental picks from arbitrarily, and
 * "post an updated schedule over last year's" is the ordinary case, not the
 * exception.
 *
 * READ-BACK IS NOT OPTIONAL. A 200 from Open Dental is not proof — the sibling
 * module has a documented endpoint that returns 200 and changes nothing. The
 * FeeNum is returned only after the fee has been read back and its amount
 * compared, so `rows_written` counts writes that are actually there.
 *
 * @param {string} officeKey
 * @param {{ feeSchedNum: number, codeNum: number, amountCents: number }} spec
 * @returns {Promise<{ ok: true, feeNum: number, action: 'created'|'updated' } | { ok: false, code: string, error: string }>}
 */
async function writeFee(officeKey, spec) {
  const office = officeClient(officeKey);
  if (!office.ok) return office;

  const { feeSchedNum, codeNum, amountCents } = spec;
  if (!Number.isInteger(feeSchedNum) || feeSchedNum <= 0) {
    return fail('BAD_FEESCHED', 'A fee needs a fee schedule');
  }
  if (!Number.isInteger(codeNum) || codeNum <= 0) {
    return fail('BAD_CODENUM', 'A fee needs a procedure code');
  }
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    return fail('BAD_AMOUNT', 'A fee amount must be a whole number of cents, and not negative');
  }

  // Open Dental's Amount is DOLLARS. Cents are this platform's storage unit —
  // the conversion happens exactly here, at the boundary, and nowhere else.
  const amount = amountCents / 100;

  const existing = await findFee(officeKey, feeSchedNum, codeNum);
  if (!existing.ok) return existing;

  /** @type {'created'|'updated'} */
  let action;
  let feeNum;

  if (existing.fee) {
    feeNum = Number(existing.fee.FeeNum);
    action = 'updated';
    const res = await office.handle.client.apiWriteRaw(
      'PUT',
      `/fees/${feeNum}`,
      { Amount: amount },
      odOpts()
    );
    if (!res.ok) {
      return fail(
        'OD_WRITE_FAILED',
        `Open Dental refused to update the fee${res.error ? `: ${res.error}` : ` (HTTP ${res.status})`}`
      );
    }
  } else {
    action = 'created';
    const res = await office.handle.client.apiWriteRaw(
      'POST',
      '/fees',
      { Amount: amount, FeeSched: feeSchedNum, CodeNum: codeNum, ClinicNum: 0, ProvNum: 0 },
      odOpts()
    );
    if (!res.ok) {
      return fail(
        'OD_WRITE_FAILED',
        `Open Dental refused to create the fee${res.error ? `: ${res.error}` : ` (HTTP ${res.status})`}`
      );
    }
    const created = res.data && typeof res.data === 'object' ? res.data : {};
    feeNum = Number(created.FeeNum);
  }

  // ── THE READ-BACK. Everything above is a claim; this is the evidence.
  const verify = await findFee(officeKey, feeSchedNum, codeNum);
  if (!verify.ok) return verify;
  if (!verify.fee) {
    return fail(
      'OD_WRITE_UNVERIFIED',
      'Open Dental accepted the fee but it is not there when read back'
    );
  }
  // Compared in CENTS, never dollars. 18.20 has no exact binary representation,
  // and a float comparison here would report a mismatch on a write that was
  // perfectly correct — the same reason this module stores cents at all.
  const readBackCents = Math.round(Number(verify.fee.Amount) * 100);
  if (readBackCents !== amountCents) {
    return fail(
      'OD_WRITE_UNVERIFIED',
      `Open Dental accepted the fee but read back ${readBackCents} cents, not ${amountCents}`
    );
  }

  const verifiedFeeNum = Number(verify.fee.FeeNum);
  return {
    ok: true,
    // The read-back's FeeNum wins over the create response's: it is the one we
    // have just proved exists, and it is what a rollback will delete.
    feeNum: Number.isInteger(verifiedFeeNum) && verifiedFeeNum > 0 ? verifiedFeeNum : feeNum,
    action,
  };
}

/**
 * Delete one fee.
 *
 * `DELETE /fees/{FeeNum}` is supported by the API. Open Dental refuses fees
 * belonging to a FeeSchedGroup ("Fees associated with a FeeSchedGroup cannot be
 * created, updated or deleted"), and that refusal is passed through rather than
 * retried — it is a statement about the practice's configuration that a person
 * needs to read.
 *
 * A 404 is treated as SUCCESS: the fee is not there, which is the state the
 * caller asked for. A rollback that failed because something was already gone
 * would stall on exactly the rows that need no work.
 *
 * @param {string} officeKey
 * @param {number} feeNum
 * @returns {Promise<{ ok: true, alreadyGone: boolean } | { ok: false, code: string, error: string }>}
 */
async function deleteFee(officeKey, feeNum) {
  const office = officeClient(officeKey);
  if (!office.ok) return office;
  if (!Number.isInteger(feeNum) || feeNum <= 0) {
    return fail('BAD_FEENUM', `${String(feeNum)} is not a fee number`);
  }

  const res = await office.handle.client.apiDeleteRaw(`/fees/${feeNum}`, odOpts());
  if (res.ok) return { ok: true, alreadyGone: false };
  if (res.status === 404) return { ok: true, alreadyGone: true };

  return fail(
    'OD_DELETE_FAILED',
    `Open Dental refused to delete fee ${feeNum}${res.error ? `: ${res.error}` : ` (HTTP ${res.status})`}`
  );
}

/**
 * Hide a fee schedule.
 *
 * THIS IS WHAT STANDS IN FOR DELETING ONE, because the API has no DELETE for
 * /feescheds. Rolling back a batch that CREATED a schedule empties it and hides
 * it; the shell remains, and both this function's name and the rollback's
 * result say so. A hidden schedule attached to no plan reprices nothing.
 *
 * @param {string} officeKey
 * @param {number} feeSchedNum
 * @returns {Promise<{ ok: true } | { ok: false, code: string, error: string }>}
 */
async function hideFeeSchedule(officeKey, feeSchedNum) {
  const office = officeClient(officeKey);
  if (!office.ok) return office;
  if (!Number.isInteger(feeSchedNum) || feeSchedNum <= 0) {
    return fail('BAD_FEESCHED', `${String(feeSchedNum)} is not a fee schedule number`);
  }

  const res = await office.handle.client.apiWriteRaw(
    'PUT',
    `/feescheds/${feeSchedNum}`,
    { IsHidden: true },
    odOpts()
  );
  if (!res.ok) {
    return fail(
      'OD_WRITE_FAILED',
      `Open Dental refused to hide the fee schedule${res.error ? `: ${res.error}` : ` (HTTP ${res.status})`}`
    );
  }
  return { ok: true };
}

module.exports = {
  OD_MIN_INTERVAL_MS,
  PAGE_SIZE,
  MAX_PAGES,
  FEE_SCHED_TYPES,
  // read half
  listFeeSchedules,
  listFeesInSchedule,
  fetchProcedureCodeMap,
  findFee,
  // write half
  createFeeSchedule,
  writeFee,
  deleteFee,
  hideFeeSchedule,
};
