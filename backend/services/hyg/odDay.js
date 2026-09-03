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
 */

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
async function readOperatories(odGet) {
  const { rows, truncated, error } = await pagedList(odGet, '/operatories');

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
 * @param {Function} odGet
 * @returns {Promise<Map<number, string>>}
 */
async function readAppointmentTypeLabels(odGet) {
  const { rows } = await pagedList(odGet, '/appointmenttypes');
  const byNum = new Map();
  for (const r of rows) {
    const num = odInt(r.AppointmentTypeNum);
    const name = str(r.AppointmentTypeName) || str(r.ItemName) || str(r.Name);
    if (num !== null && name !== null) byNum.set(num, name);
  }
  return byNum;
}

/**
 * Providers, so a card can name the hygienist rather than a ProvNum.
 * Optional in the same way appointment types are.
 * @param {Function} odGet
 * @returns {Promise<Map<number, string>>}
 */
async function readProviderLabels(odGet) {
  const { rows } = await pagedList(odGet, '/providers');
  const byNum = new Map();
  for (const r of rows) {
    const num = odInt(r.ProvNum);
    const label =
      str(r.Abbr) ||
      [str(r.FName), str(r.LName)].filter(Boolean).join(' ') ||
      null;
    if (num !== null && label !== null) byNum.set(num, label);
  }
  return byNum;
}

/**
 * Identity and the two chairside flags Open Dental will actually tell us, for
 * one patient.
 *
 * SEQUENTIAL, not concurrent. The Open Dental client already spaces requests on
 * a per-CREDENTIAL slot that voice and RCM share, so firing these in parallel
 * would not make them finish sooner — it would only make this module's share of
 * the slot burstier and push a voice lookup further back in the queue (the D-8
 * finding). One at a time, capped, is the polite shape.
 *
 * A per-patient failure is NOT fatal and does NOT invent a name. That
 * appointment comes back with `patientName: null` and every flag null, which
 * the card renders as "name unavailable" — visibly different from an empty day.
 *
 * @param {Function} odGet
 * @param {number[]} patNums distinct, in the order they should be spent
 * @returns {Promise<{ byPatNum: Map<number, object>, truncated: boolean, failed: number[] }>}
 */
async function readPatients(odGet, patNums) {
  const byPatNum = new Map();
  /** @type {number[]} */
  const failed = [];
  const budget = patNums.slice(0, MAX_PATIENT_READS);

  for (const patNum of budget) {
    const res = await odGet('/patients/' + patNum, {}, {
      timeoutMs: OD_CALL_TIMEOUT_MS,
      module: 'hyg',
      quiet: true,
    });
    if (!res.ok || !res.data || typeof res.data !== 'object') {
      failed.push(patNum);
      continue;
    }
    const p = /** @type {Record<string, unknown>} */ (res.data);
    const first = str(p.Preferred) || str(p.FName);
    const last = str(p.LName);
    byPatNum.set(patNum, {
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
    });
  }

  return { byPatNum, truncated: patNums.length > budget.length, failed };
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
 * @param {Function} odGet
 * @param {{ date: string }} opts
 * @returns {Promise<object>}
 */
async function readDay(odGet, { date }) {
  /** @type {Array<{ resource: string, message: string }>} */
  const warnings = [];

  const appts = await readAppointments(odGet, date);
  if (appts.error && appts.rows.length === 0) {
    return { ok: false, error: appts.error };
  }
  if (appts.error) {
    warnings.push({
      resource: 'appointments',
      message: 'Only part of the day could be read from Open Dental.',
    });
  }
  if (appts.truncated) {
    warnings.push({
      resource: 'appointments',
      message: 'This day has more appointments than one read can return; some are missing.',
    });
  }

  const ops = await readOperatories(odGet);
  if (ops.error) {
    warnings.push({ resource: 'operatories', message: 'Chair names are unavailable.' });
  }

  // Labels are cheap and optional; a throw here must not cost the day.
  let typeLabels = new Map();
  let providerLabels = new Map();
  try {
    typeLabels = await readAppointmentTypeLabels(odGet);
  } catch {
    warnings.push({ resource: 'appointmenttypes', message: 'Visit type names are unavailable.' });
  }
  try {
    providerLabels = await readProviderLabels(odGet);
  } catch {
    warnings.push({ resource: 'providers', message: 'Provider names are unavailable.' });
  }

  // Distinct PatNums in schedule order, so the budget is spent on the earliest
  // appointments — the ones a hygienist is looking at first.
  const ordered = [...appts.rows].sort((a, b) =>
    String(a.AptDateTime || '').localeCompare(String(b.AptDateTime || ''))
  );
  /** @type {number[]} */
  const distinctPatNums = [];
  const seen = new Set();
  for (const r of ordered) {
    const patNum = odInt(r.PatNum);
    if (patNum !== null && !seen.has(patNum)) {
      seen.add(patNum);
      distinctPatNums.push(patNum);
    }
  }

  const patients = await readPatients(odGet, distinctPatNums);
  if (patients.truncated) {
    warnings.push({
      resource: 'patients',
      message: 'This day has more patients than one read can name; later cards show no name.',
    });
  }
  if (patients.failed.length > 0) {
    warnings.push({
      resource: 'patients',
      message: patients.failed.length + ' patient record(s) could not be read.',
    });
  }

  const opsByNum = new Map(ops.operatories.map((o) => [o.opNum, o]));

  const appointments = ordered.map((r) => {
    const patNum = odInt(r.PatNum);
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
    /*
     * TWO TRUNCATIONS, KEPT APART ON PURPOSE.
     *
     * `truncated` is about the SCHEDULE: an appointment is missing, so the
     * screen is not showing somebody's day. `patientNamesTruncated` is about
     * IDENTITY: every appointment is present, and some of them have no name on
     * them. The first means "do not trust this page"; the second means "these
     * cards are unlabelled".
     *
     * They were one boolean for about an hour. A day of 137 patients — every
     * appointment fetched, whole, correct — reported itself as truncated
     * because the naming budget ran out, which is the screen telling a
     * hygienist her schedule is incomplete when it is not.
     */
    truncated: appts.truncated,
    patientNamesTruncated: patients.truncated,
  };
}

module.exports = {
  readDay,
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
};
