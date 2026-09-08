'use strict';

/**
 * The hygiene Day View's Open Dental reads (H1 slice 1).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TRANSPORT CONTRACT — READ-ONLY BY CONSTRUCTION
 * ═════════════════════════════════════════════════════════════════════════════
 * Every function here takes `odGet(path, params, opts) -> {ok, status, data, error}`
 * as its first argument, exactly as routes/tc/odReads.js does. That is
 * deliberately a plain function rather than an imported module: it keeps this
 * file unit-testable against a fake Open Dental, and it makes reaching a write
 * verb impossible rather than merely discouraged. There is no write counterpart
 * in scope. `backend/routes/hyg/hygNoOdWrites.test.js` pins that as a test.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE PULL FOR THE DAY. NO PER-CHAIR FAN-OUT.
 * ═════════════════════════════════════════════════════════════════════════════
 * `GET /appointments` accepts `Op=`, and it filters to EXACTLY ONE operatory
 * (H0 spike §5). A day view over eight chairs that used it would issue eight
 * requests against a credential the voice and RCM modules share, to assemble
 * something one `date=` request already returns. So the day is pulled once and
 * partitioned by `Op` in memory.
 *
 * There is no provider filter at all — not `ProvNum`, not `ProvHyg`. Narrowing
 * to one hygienist is client-side after a full-day read, and that is a property
 * of Open Dental's API rather than a shortcut taken here.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PAGING IS NOT OPTIONAL, AND A TRUNCATED READ LOOKS EXACTLY LIKE A COMPLETE ONE
 * ═════════════════════════════════════════════════════════════════════════════
 * Open Dental's list endpoints return at most 100 rows and page with `Offset`.
 * The H0 spike caught this the only way it can be caught — `GET /scheduleops`
 * came back with EXACTLY 100 rows, which reads as a complete answer and is not
 * one. The same cap applies to `/appointments` and `/operatories`.
 *
 * `pagedList` below therefore keeps requesting until a page comes back SHORT,
 * and reports `truncated` when it hits its page budget instead of quietly
 * returning what it had. A hygienist whose 4pm patient is missing because the
 * day had 101 appointments would have no way to know — so the day either comes
 * back whole or comes back saying it did not.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FLAGS ARE null, NEVER A FABRICATED false
 * ═════════════════════════════════════════════════════════════════════════════
 * "No premedication required" and "we did not ask" are different sentences, and
 * a chairside screen that renders them identically is worse than one that
 * renders neither. Every flag on an appointment is `true`, `false`, or `null`,
 * and `null` means unknown. `flagSources` on the day payload says, per flag,
 * WHY it might be null: `od` (we asked and this is the answer), or `not_read`
 * (slice 1 does not read this at all yet). The UI renders "unknown" for both,
 * but the payload can explain itself and the next slice can see its own to-do list.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SCHEDULE AND THE IDENTITIES ARE TWO DIFFERENT READS
 * ═════════════════════════════════════════════════════════════════════════════
 * The list reads — appointments, chairs, types, providers — are four requests
 * whatever the day looks like. The identity fan-out is ONE REQUEST PER DISTINCT
 * PATIENT, and Open Dental throttles at one request per second per credential,
 * so a 40-patient day is ~40 seconds. Waiting for all of it before showing
 * anything meant a hygienist watched a skeleton for the whole of it.
 *
 * The rulings of 2026-09-03 stand: repeating the morning warm is REJECTED (it
 * spends a credential voice and RCM share — D-8) and lengthening the patient
 * TTL is REJECTED (a medical alert entered at 9:02 must not be invisible at
 * 9:40). Neither is revisited here. **Concurrency is not a lever either** — see
 * services/odPatientCache.js.
 *
 * So `readDay` takes `identities`:
 *
 *   'cached'  resolve ONLY from services/odPatientCache.js. Zero patient
 *             requests, so the day costs its list reads and nothing else, and
 *             every unresolved appointment says `identity: 'pending'`.
 *   'all'     the original behaviour, and still the default: fetch every
 *             patient this day needs.
 *
 * `readDayIdentities` then resolves the pending ones a BOUNDED BATCH at a time,
 * and the screen fills in.
 *
 * ⚠️ WHICH PATIENTS TO RESOLVE IS DERIVED SERVER-SIDE, FROM THE SCHEDULE. ⚠️ A
 * caller never names a PatNum. An endpoint that took a list of them would be a
 * name-lookup for any patient number in the practice, which is a different and
 * much larger disclosure surface than "who is booked today". That costs one
 * extra `/appointments` read per batch, and buying it is deliberate — see
 * readDayIdentities.
 */

const odConfigCache = require('../odConfigCache');
const odPatientCache = require('../odPatientCache');

/** Open Dental pages every list endpoint at 100 rows. Not configurable. */
const OD_PAGE_SIZE = 100;

/**
 * Page budget for one list read. 25 × 100 = 2,500 rows, which is far more than
 * a day of appointments or a practice's operatories and small enough that a
 * pathological response cannot hold a request open indefinitely. Exceeding it
 * sets `truncated`; it is a circuit breaker, not a routine limiter.
 */
const MAX_PAGES = Number(process.env.HYG_OD_MAX_PAGES || 25);

/**
 * Per-OD-call timeout. The chain is app → api.opendental.com → OD HQ → the
 * office eConnector; the legacy TC app proved 10s is too short, so this matches
 * routes/tc/odReads.js rather than inventing a second number.
 */
const OD_CALL_TIMEOUT_MS = Number(process.env.HYG_OD_CALL_TIMEOUT_MS || 30000);

/**
 * Cap on the per-patient identity fan-out for one day.
 *
 * `GET /appointments` returns `PatNum` and NOT the patient's name (docs/api-appointments.md
 * lists the fields; no name is among them), so a card that says who is in the
 * chair costs one `GET /patients/{PatNum}` per DISTINCT patient on the day.
 * That is a genuine fan-out, unlike the per-chair one above, because Open
 * Dental offers no way to ask for a set of PatNums at once.
 *
 * It is bounded so a mis-typed date or a pathological day cannot turn one page
 * load into hundreds of calls on a credential the whole platform shares (the
 * D-8 lesson from RCM's batch matcher). Past the cap the remaining patients
 * come back with `patientName: null` and the day reports
 * `patientNamesTruncated` — the appointment still renders, without a name, and
 * says so. That is a DIFFERENT fact from `truncated`, which means the schedule
 * itself is incomplete; see the note at the bottom of readDay.
 */
const MAX_PATIENT_READS = Number(process.env.HYG_OD_MAX_PATIENT_READS || 120);

/**
 * The Open Dental appointment statuses that occupy a chair on a given day.
 *
 * `AptStatus` is a STRING enum on the cloud API, not the MySQL integer
 * (docs/OD_API_CONTRACT.md §1) — `AptStatus = 1` is a direct-database fact and
 * writing it here would silently match nothing.
 *
 * `UnschedList` and `Planned` rows are not on the day at all; they carry a date
 * only incidentally. `Broken` is excluded because a cancelled slot is not a
 * visit a hygienist prepares for — but the count is REPORTED rather than
 * dropped in silence, so "my 2pm is missing" has an answer.
 */
const DAY_STATUSES = Object.freeze(['Scheduled', 'Complete']);

/** OD list endpoints return a bare array; be defensive about envelopes. */
function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

/**
 * A thrown thing, as one short line for a warning's `detail`.
 * @param {unknown} err @returns {string}
 */
function errText(err) {
  if (err instanceof Error && typeof err.message === 'string' && err.message.trim()) {
    return err.message.trim().slice(0, 200);
  }
  return 'threw';
}

/** A trimmed string, or null. Never '' — an empty string reads as a value. */
function str(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

/**
 * Open Dental's booleans come back as real booleans on some resources and as
 * the STRINGS "true"/"false" on others — `isHidden` on /definitions is the
 * string form, which is how the commlog-type picker learned this the hard way.
 * Anything that is neither is `null`, not `false`.
 * @param {unknown} value
 * @returns {boolean|null}
 */
function odBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return null;
}

/** A finite integer, or null. `Number(undefined)` is NaN, which must not become 0. */
function odInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Minutes an appointment occupies, from Open Dental's `Pattern`.
 *
 * Pattern is a string of `X` (provider time) and `/` (assistant time), ONE
 * CHARACTER PER FIVE MINUTES — so a 60-minute prophy is twelve characters. The
 * length is the duration; which characters they are says who is in the room,
 * which the day view does not use.
 *
 * Returns null for an absent or empty pattern rather than the 30 that
 * config/openDental.js's older helper defaults to. A card that shows no
 * duration is honest; one that shows a made-up half hour is a lie the length of
 * the block on screen.
 *
 * @param {unknown} pattern
 * @returns {number|null}
 */
function minutesFromPattern(pattern) {
  if (typeof pattern !== 'string') return null;
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length * 5;
}

/**
 * Read one Open Dental list endpoint to completion.
 *
 * Stops when a page comes back SHORT of the page size — the only reliable
 * end-of-list signal on this API, since a full page and a final page of exactly
 * 100 are indistinguishable from the outside. Reports `truncated: true` if the
 * page budget runs out first; the caller decides whether that is fatal.
 *
 * A failure on page 1 is an error. A failure on page 4 returns the first three
 * pages WITH `truncated: true` and the error — three quarters of a day plus a
 * warning beats an outage, and beats three quarters of a day pretending to be
 * all of it.
 *
 * @param {(path: string, params?: object, opts?: object) => Promise<{ok:boolean,status:number,data:unknown,error?:string}>} odGet
 * @param {string} path
 * @param {Record<string, unknown>} params
 * @returns {Promise<{ rows: unknown[], truncated: boolean, error: string|null, pages: number }>}
 */
async function pagedList(odGet, path, params = {}) {
  /** @type {unknown[]} */
  const rows = [];
  let pages = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await odGet(
      path,
      // Offset is omitted on the first page: some OD builds treat Offset=0 as a
      // parameter they do not recognise, and apiGetRaw strips '' but not 0.
      page === 0 ? params : { ...params, Offset: page * OD_PAGE_SIZE },
      { timeoutMs: OD_CALL_TIMEOUT_MS, module: 'hyg' }
    );
    pages += 1;

    if (!res.ok) {
      return {
        rows,
        truncated: rows.length > 0,
        error: res.error || 'HTTP ' + res.status,
        pages,
      };
    }

    const batch = asArray(res.data);
    rows.push(...batch);
    if (batch.length < OD_PAGE_SIZE) {
      return { rows, truncated: false, error: null, pages };
    }
  }

  // The budget ran out on a full page, so there is more we did not fetch.
  return { rows, truncated: true, error: null, pages };
}

/**
 * The practice's operatories — the chairs the day is laid out in.
 *
 * Small, changes rarely. Hidden operatories are dropped (they are not chairs
 * anyone sits in) and the rest are ordered by `ItemOrder`, which is Open
 * Dental's own column order, so the app's grid reads left-to-right the way the
 * schedule on the office wall does.
 *
 * @param {Function} odGet
 * @returns {Promise<{ operatories: Array<object>, truncated: boolean, error: string|null }>}
 */
async function readOperatories(odGet, { office }) {
  const { rows, truncated, error } = await odConfigCache.getList(office, 'operatories', () =>
    pagedList(odGet, '/operatories')
  );

  const operatories = rows
    // `IsHidden` unknown is NOT a reason to hide a chair: dropping an operatory
    // drops every appointment in it from the grid, and a missing patient is a
    // worse failure than an extra empty column.
    .filter((r) => odBool(r.IsHidden) !== true)
    .map((r) => ({
      opNum: odInt(r.OperatoryNum),
      name: str(r.OpName) || str(r.Abbrev),
      abbrev: str(r.Abbrev),
      isHygiene: odBool(r.IsHygiene),
      itemOrder: odInt(r.ItemOrder),
    }))
    .filter((o) => o.opNum !== null)
    .sort((a, b) => (a.itemOrder ?? 0) - (b.itemOrder ?? 0) || a.opNum - b.opNum);

  return { operatories, truncated, error };
}

/**
 * The day's appointments for one office, whole.
 *
 * @param {Function} odGet
 * @param {string} date 'YYYY-MM-DD', already validated by the caller
 * @returns {Promise<{ rows: object[], truncated: boolean, error: string|null, excludedByStatus: number }>}
 */
async function readAppointments(odGet, date) {
  const { rows, truncated, error } = await pagedList(odGet, '/appointments', { date });

  const kept = [];
  let excludedByStatus = 0;
  for (const r of rows) {
    const status = str(r.AptStatus);
    // An UNRECOGNISED status is KEPT, not dropped. Open Dental can add one, and
    // a hygienist losing an appointment because this list was stale is a worse
    // failure than a card with an unfamiliar chip on it.
    if (status !== null && !DAY_STATUSES.includes(status) &&
        (status === 'Broken' || status === 'UnschedList' || status === 'Planned' ||
         status === 'PtNote' || status === 'PtNoteCompleted')) {
      excludedByStatus += 1;
      continue;
    }
    kept.push(r);
  }

  return { rows: kept, truncated, error, excludedByStatus };
}

/**
 * Appointment types, so a card can say "Prophy Adult" instead of a number.
 * Optional: a failure here costs a label, not the day.
 *
 * PRACTICE CONFIGURATION, cached for an hour per office — see
 * services/odConfigCache.js. The list is edited when the practice renames a
 * visit type, which is not something that happens between two page loads.
 *
 * @param {Function} odGet
 * @param {{ office: string }} opts
 * @returns {Promise<{ byNum: Map<number, string>, error: string|null }>}
 */
async function readAppointmentTypeLabels(odGet, { office }) {
  const { rows, error } = await odConfigCache.getList(office, 'appointmenttypes', () =>
    pagedList(odGet, '/appointmenttypes')
  );
  const byNum = new Map();
  for (const r of rows) {
    const num = odInt(r.AppointmentTypeNum);
    const name = str(r.AppointmentTypeName) || str(r.ItemName) || str(r.Name);
    if (num !== null && name !== null) byNum.set(num, name);
  }
  return { byNum, error };
}

/**
 * Providers, so a card can name the hygienist rather than a ProvNum.
 * Optional in the same way appointment types are, and cached the same way.
 *
 * @param {Function} odGet
 * @param {{ office: string }} opts
 * @returns {Promise<{ byNum: Map<number, string>, error: string|null }>}
 */
async function readProviderLabels(odGet, { office }) {
  const { rows, error } = await odConfigCache.getList(office, 'providers', () =>
    pagedList(odGet, '/providers')
  );
  const byNum = new Map();
  for (const r of rows) {
    const num = odInt(r.ProvNum);
    const label =
      str(r.Abbr) ||
      [str(r.FName), str(r.LName)].filter(Boolean).join(' ') ||
      null;
    if (num !== null && label !== null) byNum.set(num, label);
  }
  return { byNum, error };
}

/**
 * One raw Open Dental patient record → the fields a day card needs.
 *
 * Split out from readPatients when the shared cache landed, because the cache
 * stores what Open Dental RETURNED and every module normalizes on the way out
 * (see services/odPatientCache.js). This is hyg's normalizer, and nothing else
 * may depend on its shape.
 *
 * @param {number} patNum
 * @param {Record<string, unknown>} p the raw `GET /patients/{PatNum}` body
 * @returns {object}
 */
function normalizePatient(patNum, p) {
  const first = str(p.Preferred) || str(p.FName);
  const last = str(p.LName);
  return {
    patNum,
    firstName: first,
    lastName: last,
    // "Last, First" is how Open Dental itself writes a patient, and matching
    // it means a hygienist reading this screen and the chart beside it does
    // not have to translate. Null when OD gave us neither half — never a
    // fabricated "Unknown Patient", which reads as a real record.
    displayName: last && first ? last + ', ' + first : last || first,
    birthdate: str(p.Birthdate),
    // Real answers, from the patient record. Premed is Open Dental's own
    // boolean; medical alerts are the presence of a note, not its content —
    // the note itself is PHI the day view has no reason to serve.
    premed: odBool(p.Premed),
    medicalAlerts: typeof p.MedUrgNote === 'string' ? p.MedUrgNote.trim().length > 0 : null,
  };
}

/**
 * Identity and the two chairside flags Open Dental will actually tell us, for
 * every patient on the day.
 *
 * SEQUENTIAL, not concurrent, AND THAT IS NOT THE SLOW PART. The Open Dental
 * client spaces requests on a per-CREDENTIAL slot that voice and RCM share, so
 * firing these in parallel would not make them finish sooner — it would only
 * make this module's share of the slot burstier and push a voice lookup further
 * back in the queue (the D-8 finding). routes/tc/odReads.js runs the same
 * fan-out at concurrency 5 and gets nothing for it. **If this screen is slow,
 * raising a concurrency number here is the change that does not work.**
 *
 * What DOES work is not asking twice: every read goes through
 * services/odPatientCache.js, keyed by OFFICE and PatNum. The office is
 * therefore required — a PatNum without one identifies nobody, because
 * numbering restarts in every Open Dental database.
 *
 * A per-patient failure is NOT fatal and does NOT invent a name. That
 * appointment comes back with `patientName: null` and every flag null, which
 * the card renders as "name unavailable" — visibly different from an empty day.
 *
 * ── THE REQUEST BUDGET ──────────────────────────────────────────────────────
 * `odBudget` caps how many of these may become an ACTUAL Open Dental request.
 * Cache hits are free and unlimited; only misses are counted. `0` therefore
 * means "answer from the cache and ask for nothing", which is what makes the
 * day view paint in list-read time, and a finite number is what makes the
 * follow-up fill arrive in bounded waves instead of one 40-second wait.
 *
 * A patient skipped for budget is neither resolved nor failed: it is left out
 * of `byPatNum` and named in `unresolved`, because "we have not asked yet" and
 * "we asked and could not read it" are different sentences and a card renders
 * them differently.
 *
 * The budget check uses `odPatientCache.hasFresh`, so a read already IN FLIGHT
 * for another request counts as a miss and is skipped even though joining it
 * would have been free. That loses the occasional free identity to the next
 * batch; the alternative is blocking on somebody else's request while holding a
 * budget of zero, which is the thing this is here to prevent.
 *
 * @param {Function} odGet
 * @param {number[]} patNums distinct, in the order they should be spent
 * @param {{ office: string, odBudget?: number }} opts the office these PatNums
 *   belong to, and how many Open Dental requests this call may issue.
 * @returns {Promise<{ byPatNum: Map<number, object>, truncated: boolean, failed: number[],
 *                     unresolved: number[], odReads: number, cacheHits: number,
 *                     deduped: number }>}
 */
async function readPatients(odGet, patNums, { office, odBudget = Infinity }) {
  const byPatNum = new Map();
  /** @type {number[]} */
  const failed = [];
  /** @type {number[]} */
  const unresolved = [];
  const budget = patNums.slice(0, MAX_PATIENT_READS);

  let odReads = 0;
  let cacheHits = 0;
  let deduped = 0;

  /**
   * The cache's transport. Invoked ONLY on a genuine miss, which is what makes
   * `odReads` an exact count of requests issued to Open Dental.
   * @param {number} patNum
   */
  const readOne = async (patNum) => {
    odReads += 1;
    const res = await odGet('/patients/' + patNum, {}, {
      timeoutMs: OD_CALL_TIMEOUT_MS,
      module: 'hyg',
      quiet: true,
    });
    if (!res.ok || !res.data || typeof res.data !== 'object') return { ok: false, record: null };
    // The RAW body is what is cached, so TC and RCM can share the entry.
    return { ok: true, record: /** @type {Record<string, unknown>} */ (res.data) };
  };

  for (const patNum of budget) {
    // NOT ASKED YET. Distinct from failed — see the budget note above.
    if (odReads >= odBudget && !odPatientCache.hasFresh(office, patNum)) {
      unresolved.push(patNum);
      continue;
    }

    const got = await odPatientCache.getPatient(office, patNum, readOne);
    if (got.source === 'cache') cacheHits += 1;
    else if (got.source === 'inflight') deduped += 1;

    if (!got.ok || !got.record) {
      failed.push(patNum);
      continue;
    }
    byPatNum.set(patNum, normalizePatient(patNum, got.record));
  }

  return {
    byPatNum,
    truncated: patNums.length > budget.length,
    failed,
    unresolved,
    odReads,
    cacheHits,
    deduped,
  };
}

/**
 * Which flags this slice actually reads, and from where.
 *
 * Shipped in the payload so a null is self-explaining. `not_read` is a promise
 * about the code, not about the patient: slice 1 does not call `/allergies`,
 * `/perioexams`, `/documents` or the TC case store at all, so those flags could
 * only ever be null and saying "unknown" without saying why would invite
 * somebody to read it as "Open Dental has no allergies on file".
 */
const FLAG_SOURCES = Object.freeze({
  premed: 'od',
  medicalAlerts: 'od',
  allergies: 'not_read',
  lastPerioDate: 'not_read',
  xraysDue: 'not_read',
  examNeeded: 'not_read',
  openTcCase: 'not_read',
});

/** The shape every appointment's `flags` takes when nothing is known. */
function unknownFlags() {
  return {
    premed: null,
    medicalAlerts: null,
    allergies: null,
    lastPerioDate: null,
    xraysDue: null,
    examNeeded: null,
    openTcCase: null,
  };
}

/**
 * Read one office's whole day and shape it for the Day View.
 *
 * Returns `{ ok: false, error }` only when the APPOINTMENTS read failed on its
 * first page — there is no day to show, and answering with an empty one is the
 * failure mode this whole file is written against. Everything else (operatory
 * names, type labels, provider names, per-patient identity) degrades to a
 * `warnings` entry and a null field, because losing a chair's NAME is not the
 * same as losing the chair.
 *
 * ── MEASUREMENT ─────────────────────────────────────────────────────────────
 * Every day read returns `stats`: how many Open Dental requests it issued, split
 * LIST reads from PATIENT reads, how many patients the cache answered, and how
 * long each PHASE took — the schedule, the chairs, the labels, the identities.
 * The route logs one line from it.
 *
 * That exists because "it should be faster" is not a result, and neither is
 * "it fails at times". A total of 41s says nothing about which read to look at;
 * `ms_appts=1100 ms_ids=39800` says all of it. The phases are timed separately
 * for the same reason the failures are named separately.
 *
 * ── IDENTITIES ──────────────────────────────────────────────────────────────
 * `identities: 'cached'` resolves names and flags ONLY from the patient cache
 * and issues no patient requests at all, so the day comes back in list-read
 * time with `identity: 'pending'` on whatever is unresolved. `'all'` (the
 * default) is the original behaviour. See the file header.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────
 * `scope: 'hygiene'` (the default) serves only the hygiene appointments and
 * resolves identity only for THEIR patients. That is the whole point of it: the
 * fan-out is one Open Dental request per distinct patient against a throttled
 * shared credential, and a hygienist looking at a hygiene day should not pay for
 * the doctors' patients.
 *
 * A patient this read does not serve is not fetched, not named, and — because
 * the route builds its audit rows from what it is about to SEND — not audited
 * either. Not disclosed, no row.
 *
 * ⚠️ THE FILTER IS THE APPOINTMENT'S OWN `IsHygiene`, NEVER THE CHAIR'S. ⚠️ A
 * hygiene appointment can sit in a doctor's operatory on an overflow day (H0
 * §5), and filtering on the chair would drop that patient off the hygienist's
 * day. An appointment Open Dental did not classify at all is SERVED: "we could
 * not tell" is not "no".
 *
 * @param {Function} odGet
 * @param {{ date: string, office: string, scope?: 'hygiene'|'all',
 *          identities?: 'all'|'cached' }} opts
 *   `office` is REQUIRED — it is half of the patient cache key, and a PatNum
 *   without an office identifies nobody (numbering restarts in every Open Dental
 *   database).
 * @returns {Promise<object>}
 */
async function readDay(odGet, { date, office, scope = 'hygiene', identities = 'all' }) {
  if (typeof office !== 'string' || office.trim() === '') {
    // Loud rather than defaulted. The alternative to knowing the office is
    // caching a patient under a namespace shared with another practice.
    throw new Error('[hyg/odDay] readDay requires an office — a PatNum alone identifies nobody');
  }

  const startedAt = Date.now();
  /** @type {Array<{ resource: string, message: string, detail: string|null }>} */
  const warnings = [];

  /**
   * WHAT FAILED, IN OPEN DENTAL'S OWN WORDS.
   *
   * `message` is the sentence a hygienist reads; `detail` is the status or the
   * timeout underneath it. Both, because "Chair names are unavailable" tells
   * her what to do and "HTTP 504" tells whoever she calls what to look at, and
   * a screen that carries only one of them turns the other into a guess.
   *
   * @param {string} resource @param {string} message @param {string|null} [detail]
   */
  const warn = (resource, message, detail = null) => {
    warnings.push({ resource, message, detail: detail || null });
  };

  /** Per-phase wall clock. See MEASUREMENT in the docblock. @type {Record<string, number>} */
  const phaseMs = {};
  /**
   * Time one phase. Never swallows: a throw is re-thrown after the clock stops,
   * so a phase that failed is still measured.
   * @template T @param {string} name @param {() => Promise<T>} run @returns {Promise<T>}
   */
  const timed = async (name, run) => {
    const at = Date.now();
    try {
      return await run();
    } finally {
      phaseMs[name] = Date.now() - at;
    }
  };

  /**
   * Counts the LIST reads. Wrapping here rather than counting inside pagedList
   * keeps the count honest across pages: a 3-page /appointments read is three
   * requests against the credential, and reporting it as one would hide
   * exactly the cost this instrumentation exists to expose.
   */
  let odListReads = 0;
  const countedGet = (path, params, opts) => {
    odListReads += 1;
    return odGet(path, params, opts);
  };

  const appts = await timed('appointments', () => readAppointments(countedGet, date));
  if (appts.error && appts.rows.length === 0) {
    // The one unrecoverable failure: there is no day to show. The reason comes
    // back with it so the route can name what went wrong instead of saying
    // "could not read the schedule" and leaving the rest to a log query.
    return { ok: false, error: appts.error, phaseMs, odListReads };
  }
  if (appts.error) {
    warn(
      'appointments',
      'Only part of the day could be read from Open Dental.',
      appts.error
    );
  }
  if (appts.truncated) {
    warn(
      'appointments',
      'This day has more appointments than one read can return; some are missing.'
    );
  }

  const ops = await timed('operatories', () => readOperatories(countedGet, { office }));
  if (ops.error) {
    warn('operatories', 'Chair names are unavailable.', ops.error);
  }

  // Labels are cheap and optional; a throw here must not cost the day.
  let typeLabels = new Map();
  let providerLabels = new Map();
  await timed('labels', async () => {
    try {
      const types = await readAppointmentTypeLabels(countedGet, { office });
      typeLabels = types.byNum;
      if (types.error) warn('appointmenttypes', 'Visit type names are unavailable.', types.error);
    } catch (err) {
      warn('appointmenttypes', 'Visit type names are unavailable.', errText(err));
    }
    try {
      const provs = await readProviderLabels(countedGet, { office });
      providerLabels = provs.byNum;
      if (provs.error) warn('providers', 'Provider names are unavailable.', provs.error);
    } catch (err) {
      warn('providers', 'Provider names are unavailable.', errText(err));
    }
  });

  const ordered = [...appts.rows].sort((a, b) =>
    String(a.AptDateTime || '').localeCompare(String(b.AptDateTime || ''))
  );

  /*
   * THE SCOPE, APPLIED BEFORE ANYTHING IS PAID FOR.
   *
   * `IsHygiene !== false` rather than `=== true`: an appointment Open Dental
   * did not classify is served, because "we could not tell" is not "no" and a
   * hygienist must not lose a patient to a null. The chair's own flag is NOT
   * consulted here — see the header.
   */
  const inScope =
    scope === 'all' ? ordered : ordered.filter((r) => odBool(r.IsHygiene) !== false);
  const excludedByScope = ordered.length - inScope.length;

  // Distinct PatNums in schedule order, so the budget is spent on the earliest
  // appointments — the ones a hygienist is looking at first. From the SERVED
  // rows only: a patient this response will not carry is a patient nothing here
  // may fetch, name or disclose.
  /** @type {number[]} */
  const distinctPatNums = [];
  const seen = new Set();
  for (const r of inScope) {
    const patNum = odInt(r.PatNum);
    // `> 0`, not merely `!== null`. Open Dental writes PatNum 0 on an
    // appointment that carries no patient — a blockout, or a row somebody
    // started and never attached anybody to — and 0 is not a patient. Passing
    // it on made services/odPatientCache.js throw ("PatNum must be a positive
    // integer"), which readDay reported as a failed read, which 502'd the WHOLE
    // day. One unattached row must not take a hygienist's whole schedule down;
    // it comes back as an appointment with no name, which is what it is.
    if (patNum !== null && patNum > 0 && !seen.has(patNum)) {
      seen.add(patNum);
      distinctPatNums.push(patNum);
    }
  }

  // `identities: 'cached'` spends NOTHING here: every miss comes back
  // unresolved and the follow-up fill asks for them a batch at a time.
  const patients = await timed('identities', () =>
    readPatients(odGet, distinctPatNums, {
      office,
      odBudget: identities === 'cached' ? 0 : Infinity,
    })
  );
  if (patients.truncated) {
    warn(
      'patients',
      'This day has more patients than one read can name; later cards show no name.'
    );
  }
  if (patients.failed.length > 0) {
    warn(
      'patients',
      patients.failed.length + ' patient record(s) could not be read.',
      'Open Dental answered for the schedule but not for ' +
        patients.failed.length + ' of its patients'
    );
  }

  const failedPatNums = new Set(patients.failed);

  const opsByNum = new Map(ops.operatories.map((o) => [o.opNum, o]));

  const appointments = inScope.map((r) => {
    // Same rule as the fan-out above: PatNum 0 is Open Dental's "no patient on
    // this appointment", and reporting it as a PatNum would let a caller
    // attach a visit — and one slice later a chart note — to patient zero.
    const rawPatNum = odInt(r.PatNum);
    const patNum = rawPatNum !== null && rawPatNum > 0 ? rawPatNum : null;
    const patient = patNum !== null ? patients.byPatNum.get(patNum) : undefined;
    const opNum = odInt(r.Op);
    const op = opNum !== null ? opsByNum.get(opNum) : undefined;
    const typeNum = odInt(r.AppointmentTypeNum);
    const provNum = odInt(r.ProvNum);
    const provHyg = odInt(r.ProvHyg);

    const flags = unknownFlags();
    if (patient) {
      flags.premed = patient.premed;
      flags.medicalAlerts = patient.medicalAlerts;
    }

    return {
      aptNum: odInt(r.AptNum),
      patNum,
      /*
       * WHY THIS CARD HAS NO NAME ON IT — four different answers, and a screen
       * that rendered them all as "Name unavailable" would be lying about three
       * of them.
       *
       *   resolved     we read the patient record. `patientName` may STILL be
       *                null, if Open Dental held neither half of a name — that
       *                is an answer, and it is this one.
       *   pending      not asked yet. The fill is coming; the card says so.
       *   unavailable  asked, and could not read it. Waiting will not help.
       *   no_patient   the appointment carries no PatNum at all — a blockout,
       *                or a row nobody was ever attached to. There is nobody to
       *                name, which is not a failure of any kind.
       */
      identity:
        patNum === null
          ? 'no_patient'
          : patient
            ? 'resolved'
            : failedPatNums.has(patNum)
              ? 'unavailable'
              : 'pending',
      // Null, not 'Unknown Patient'. See readPatients.
      patientName: patient ? patient.displayName : null,
      start: str(r.AptDateTime),
      lengthMin: minutesFromPattern(r.Pattern),
      opNum,
      opName: op ? op.name : null,
      // The operatory's flag and the appointment's own flag can disagree (H0
      // spike §5). BOTH are carried: the APPOINTMENT's is authoritative for
      // "is this a hygiene visit", the operatory's is a layout fact about the
      // chair. Collapsing them would make one of those questions unanswerable.
      isHygiene: odBool(r.IsHygiene),
      opIsHygiene: op ? op.isHygiene : null,
      provNum,
      provHyg,
      providerName: (provHyg !== null && providerLabels.get(provHyg)) ||
        (provNum !== null && providerLabels.get(provNum)) || null,
      // ProcDescript is what the front desk typed on the appointment; the type
      // name is the practice's own vocabulary. Prefer the type, fall back to
      // the description, and never invent "Appointment".
      apptTypeLabel: (typeNum !== null && typeLabels.get(typeNum)) || str(r.ProcDescript),
      // Open Dental resolves the Confirmed DefNum for us and ships the STRING
      // beside it (`"Confirmed": 244, "confirmed": "In Treatment Room"`), so the
      // day view needs no /definitions join. The raw DefNum is per-office and is
      // deliberately NOT returned: nothing downstream may compare it across
      // offices, and the way to guarantee that is not to hand it out.
      confirmedStatus: str(r.confirmed),
      aptStatus: str(r.AptStatus),
      isNewPatient: odBool(r.IsNewPatient),
      flags,
    };
  });

  return {
    ok: true,
    operatories: ops.operatories,
    appointments,
    warnings,
    flagSources: FLAG_SOURCES,
    excludedByStatus: appts.excludedByStatus,
    scope,
    /*
     * Appointments this SCOPE did not serve. Reported, never silently dropped:
     * a hygienist wondering where the 2pm doctor visit went should get an
     * answer. Distinct from excludedByStatus, which counts rows that are not
     * visits at all.
     */
    excludedByScope,
    /*
     * TWO TRUNCATIONS, KEPT APART ON PURPOSE.
     *
     * `truncated` is about the SCHEDULE: an appointment is missing, so the
     * screen is not showing somebody's day. `patientNamesTruncated` is about
     * IDENTITY: every appointment IN THIS SCOPE is present, and some of them
     * have no name on them. The first means "do not trust this page"; the
     * second means "these cards are unlabelled".
     *
     * Neither is about the scope. An appointment the hygiene lens did not serve
     * is not missing and not unnamed — it was not asked for, and
     * `excludedByScope` is where that is said.
     *
     * They were one boolean for about an hour. A day of 137 patients — every
     * appointment fetched, whole, correct — reported itself as truncated
     * because the naming budget ran out, which is the screen telling a
     * hygienist her schedule is incomplete when it is not.
     */
    truncated: appts.truncated,
    patientNamesTruncated: patients.truncated,
    /*
     * How many appointments are still waiting for a name. The client polls the
     * fill while this is above zero and STOPS when a batch does not move it,
     * so a patient Open Dental will never answer for leaves an honest card
     * rather than a spinner that never ends.
     */
    identitiesPending: patients.unresolved.length,
    /*
     * WHAT THIS READ COST. Counts and milliseconds only — never a PatNum, never
     * a name. `odListReads + odPatientReads` is the number of requests this one
     * page load put on a credential the voice and RCM modules are also using,
     * which is the number the whole cache slice exists to bring down.
     *
     * `patientsRequested = patientCacheHits + patientCacheDeduped + odPatientReads`
     * always holds, so misses need no separate field: they ARE odPatientReads.
     */
    stats: {
      odListReads,
      odPatientReads: patients.odReads,
      patientsRequested: Math.min(distinctPatNums.length, MAX_PATIENT_READS),
      /** Answered from a fresh cached record — no Open Dental request at all. */
      patientCacheHits: patients.cacheHits,
      /** Waited on an identical read already in flight — also no request. */
      patientCacheDeduped: patients.deduped,
      durationMs: Date.now() - startedAt,
      /*
       * WHERE THE TIME WENT. One number per phase, so "the schedule is slow"
       * becomes a specific read. Counts and milliseconds only — never a PatNum.
       */
      phaseMs,
    },
  };
}


/**
 * How many patients ONE fill request may fetch from Open Dental.
 *
 * Eight, because Open Dental serves one request a second per credential: a
 * batch is about nine seconds of wall clock (eight patients plus the schedule
 * read that decides who they are), which is short enough that a hygienist sees
 * names arriving in waves rather than watching one long request, and long
 * enough that a 40-patient day is five round trips rather than forty.
 *
 * Raising it makes each wave later and larger. Lowering it multiplies the
 * per-batch schedule read. Neither is a throughput lever — the credential is
 * the throughput, and it is shared.
 */
const IDENTITY_BATCH = Number(process.env.HYG_DAY_IDENTITY_BATCH || 8);

/**
 * Resolve the next batch of unnamed patients on a day.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CALLER DOES NOT SAY WHICH PATIENTS
 * ═════════════════════════════════════════════════════════════════════════════
 * This re-reads the day's appointments and derives the PatNums itself, exactly
 * as `readDay` does. An endpoint that accepted a list of PatNums would be a
 * name-and-medical-alert lookup for ANY patient number in the practice —
 * a far larger disclosure surface than "who is booked today", and one that
 * could be walked. The set of people this can name is the set of people on that
 * day, and that is true by construction rather than by validation.
 *
 * It costs one extra `/appointments` read per batch. It also buys something:
 * each batch sees the CURRENT schedule, so a patient added to the day while the
 * fill is running is picked up rather than missed until a refresh.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IT RETURNS, AND WHY IT CANNOT LOOP FOREVER
 * ═════════════════════════════════════════════════════════════════════════════
 * `patients` are the ones resolved THIS TIME plus any the cache already held —
 * the caller merges them onto its cards. `unavailable` are the ones Open Dental
 * refused; they are reported so a card can stop waiting and say so. `pending`
 * is what is left.
 *
 * A patient that fails is in `unavailable`, not in `pending`, so a chart Open
 * Dental will never serve leaves an honest card instead of a spinner. And the
 * caller stops when `pending` stops falling, which covers the case where a read
 * neither succeeds nor fails cleanly.
 *
 * @param {Function} odGet
 * @param {{ date: string, office: string, scope?: 'hygiene'|'all', batch?: number }} opts
 * @returns {Promise<{ ok: true, patients: object[], unavailable: number[],
 *                     pending: number, stats: object }
 *          | { ok: false, error: string }>}
 */
async function readDayIdentities(odGet, { date, office, scope = 'hygiene', batch }) {
  if (typeof office !== 'string' || office.trim() === '') {
    throw new Error('[hyg/odDay] readDayIdentities requires an office — a PatNum alone identifies nobody');
  }
  const startedAt = Date.now();
  let odListReads = 0;
  const countedGet = (path, params, opts) => {
    odListReads += 1;
    return odGet(path, params, opts);
  };

  const appts = await readAppointments(countedGet, date);
  if (appts.error && appts.rows.length === 0) return { ok: false, error: appts.error };

  // The SAME scope rule as readDay, and for the same reason: a patient this
  // day does not serve is a patient nothing here may fetch or name.
  const inScope =
    scope === 'all' ? appts.rows : appts.rows.filter((r) => odBool(r.IsHygiene) !== false);
  const ordered = [...inScope].sort((a, b) =>
    String(a.AptDateTime || '').localeCompare(String(b.AptDateTime || ''))
  );

  /** @type {number[]} */
  const distinctPatNums = [];
  const seen = new Set();
  for (const r of ordered) {
    // `> 0`: PatNum 0 is Open Dental's "nobody is attached to this row".
    const patNum = odInt(r.PatNum);
    if (patNum !== null && patNum > 0 && !seen.has(patNum)) {
      seen.add(patNum);
      distinctPatNums.push(patNum);
    }
  }

  const limit = Number.isInteger(batch) && batch > 0 ? batch : IDENTITY_BATCH;
  const read = await readPatients(odGet, distinctPatNums, { office, odBudget: limit });

  const patients = [];
  for (const [patNum, p] of read.byPatNum) {
    // Only what a card needs, and only what the patient record answered. The
    // medical-alert NOTE is never sent — its presence is the fact this screen
    // uses, and its text is PHI the day view has no reason to carry.
    patients.push({
      patNum,
      patientName: p.displayName,
      premed: p.premed,
      medicalAlerts: p.medicalAlerts,
    });
  }

  return {
    ok: true,
    patients,
    unavailable: read.failed,
    pending: read.unresolved.length,
    stats: {
      odListReads,
      odPatientReads: read.odReads,
      patientsRequested: Math.min(distinctPatNums.length, MAX_PATIENT_READS),
      patientCacheHits: read.cacheHits,
      patientCacheDeduped: read.deduped,
      durationMs: Date.now() - startedAt,
    },
  };
}

module.exports = {
  readDay,
  readDayIdentities,
  // Exported for tests and for the slices that follow, not for routes to call
  // directly — routes call readDay.
  pagedList,
  readOperatories,
  readAppointments,
  readPatients,
  minutesFromPattern,
  odBool,
  odInt,
  FLAG_SOURCES,
  DAY_STATUSES,
  OD_PAGE_SIZE,
  MAX_PATIENT_READS,
  IDENTITY_BATCH,
};
