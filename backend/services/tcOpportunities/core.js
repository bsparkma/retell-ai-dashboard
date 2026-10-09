'use strict';

/**
 * TC Opportunities (queue item 41) — the pure rules.
 *
 * No I/O in this file: no Open Dental client, no database. Everything the
 * nightly sync and the inbox routes DECIDE lives here so the decisions can be
 * tested exhaustively without either.
 *
 *   qualifyProcedure     is this Open Dental procedure a candidate?
 *   groupByPatient       one candidate per patient: procedures, value, date
 *   planRowChange        what a complete sweep does to an existing row
 *   hasNewProcedure      THE resurrection rule for a dismissed row
 *   planExistingCaseFlips  existing_case marking, both directions
 *   verifyClaimPhases    a client-built phase tree must match the snapshot
 *
 * VOCABULARY. The four statuses below are the CHECK literals in
 * migrations-tenant/1790600000000_tc_opportunities.js, pinned against this
 * file by test/tcOpportunitiesMigration.test.js. Readers of every value are
 * listed in docs/reports/feature-tc-od-opportunities.md.
 */

/** tc_opportunities.status — the spec's four, and no fifth. */
const OPPORTUNITY_STATUSES = Object.freeze(['new', 'claimed', 'dismissed', 'existing_case']);

/** Statuses a human can still act on (claim or dismiss). */
const ACTIONABLE_STATUSES = Object.freeze(['new', 'existing_case']);

/** tc_opportunity_sync.last_status. */
const SYNC_STATUSES = Object.freeze(['ok', 'partial', 'failed']);

/** Open Dental's ProcStatus for treatment-planned work (a STRING on the API). */
const OD_TP_STATUS = 'TP';

/**
 * 'YYYY-MM-DD' for an OD date, or null for absent / OD's null date
 * ('0001-01-01' — Open Dental never stores SQL NULL for a date).
 * @param {unknown} v
 * @returns {string|null}
 */
function odDate(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (s.startsWith('0001-01-01')) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/**
 * Dollars (OD sends "255.00" strings) → integer cents. Non-finite or negative
 * reads as 0, which the billable rule then excludes.
 * @param {unknown} v
 * @returns {number}
 */
function toCents(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

/** A positive integer or null. @param {unknown} v @returns {number|null} */
function posInt(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * @typedef {{
 *   procNum: number, code: string, description: string, feeCents: number,
 *   tooth: string, surf: string, plannedDate: string|null
 * }} OpportunityProcedure
 */

/**
 * Is one Open Dental /procedurelogs row a candidate?
 *
 * Returns `{ ok: true, patNum, procedure }` or `{ ok: false, reason }`. The
 * reasons are counted by the sync so a report can say WHY the inbox is the
 * size it is.
 *
 *   not_tp          ProcStatus is not 'TP'. Through the sync's
 *                   ProcStatus=TP sweep this means Open Dental IGNORED the
 *                   filter, and the sync aborts rather than continue a
 *                   full-table scan (see sync.js). It is never just skipped.
 *   no_patient      no usable PatNum
 *   not_billable    not a CDT D-code with a positive fee (the legacy finder's rule)
 *   on_appointment  AptNum > 0: the procedure is attached to an appointment.
 *                   ASSUMED to mean "scheduled". Open Dental can attach a
 *                   procedure to a broken or unscheduled-list appointment too,
 *                   which this rule also excludes; reading /appointments per
 *                   patient to tell them apart would cost one request per
 *                   patient a night. Conservative by design: it may under-report
 *                   an opportunity, it never nags about booked work.
 *   too_old         planned before the look-back cutoff
 *
 * @param {Record<string, unknown>} row
 * @param {{ cutoff: string|null }} opts cutoff 'YYYY-MM-DD' or null for none
 * @returns {{ ok: true, patNum: number, procedure: OpportunityProcedure } | { ok: false, reason: string }}
 */
function qualifyProcedure(row, opts) {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'not_tp' };
  if (String(row.ProcStatus ?? '') !== OD_TP_STATUS) return { ok: false, reason: 'not_tp' };
  const patNum = posInt(row.PatNum);
  if (patNum === null) return { ok: false, reason: 'no_patient' };
  const procNum = posInt(row.ProcNum);
  if (procNum === null) return { ok: false, reason: 'no_patient' };

  const code = String(row.procCode ?? row.ProcCode ?? '').trim().toUpperCase();
  const feeCents = toCents(row.ProcFee);
  if (!/^D\d{4}/.test(code) || feeCents <= 0) return { ok: false, reason: 'not_billable' };

  const aptNum = Number(row.AptNum);
  if (Number.isFinite(aptNum) && aptNum > 0) return { ok: false, reason: 'on_appointment' };

  const plannedDate = odDate(row.DateTP);
  if (opts.cutoff && plannedDate && plannedDate < opts.cutoff) return { ok: false, reason: 'too_old' };

  const toothRaw = String(row.ToothNum ?? '').trim();
  return {
    ok: true,
    patNum,
    procedure: {
      procNum,
      code,
      description: String(row.descript ?? row.Descript ?? '').trim().slice(0, 200),
      feeCents,
      tooth: toothRaw,
      surf: String(row.Surf ?? '').trim(),
      plannedDate,
    },
  };
}

/** Stable procedure order: planned date (undated last), then ProcNum. */
function compareProcedures(a, b) {
  const ad = a.plannedDate || '9999-12-31';
  const bd = b.plannedDate || '9999-12-31';
  if (ad !== bd) return ad < bd ? -1 : 1;
  return a.procNum - b.procNum;
}

/**
 * @typedef {{ patNum: number, procedures: OpportunityProcedure[], valueCents: number,
 *             plannedDate: string|null }} PatientCandidate
 */

/**
 * Qualifying procedures → one candidate per patient.
 *
 * Duplicate ProcNums (Offset paging over a set that moved between pages) are
 * kept once.
 *
 * @param {Array<{ patNum: number, procedure: OpportunityProcedure }>} qualified
 * @returns {Map<number, PatientCandidate>}
 */
function groupByPatient(qualified) {
  /** @type {Map<number, Map<number, OpportunityProcedure>>} */
  const byPatient = new Map();
  for (const { patNum, procedure } of qualified) {
    let procs = byPatient.get(patNum);
    if (!procs) {
      procs = new Map();
      byPatient.set(patNum, procs);
    }
    procs.set(procedure.procNum, procedure);
  }
  /** @type {Map<number, PatientCandidate>} */
  const out = new Map();
  for (const [patNum, procs] of byPatient) {
    const procedures = [...procs.values()].sort(compareProcedures);
    const dates = procedures.map((p) => p.plannedDate).filter(Boolean).sort();
    out.set(patNum, {
      patNum,
      procedures,
      valueCents: procedures.reduce((s, p) => s + p.feeCents, 0),
      plannedDate: dates.length ? dates[0] : null,
    });
  }
  return out;
}

/**
 * THE RESURRECTION RULE.
 *
 * A dismissed row comes back ONLY when the patient now has a planned procedure
 * whose ProcNum was not in the snapshot that was dismissed. A fee change, a
 * re-dated plan, a procedure completed or removed — none of those bring it
 * back, because none of them is new treatment a human has not already looked
 * at and decided about. Value growing because a FEE went up is explicitly not
 * new treatment.
 *
 * @param {OpportunityProcedure[]} dismissedSnapshot
 * @param {OpportunityProcedure[]} current
 * @returns {boolean}
 */
function hasNewProcedure(dismissedSnapshot, current) {
  const seen = new Set((dismissedSnapshot || []).map((p) => Number(p.procNum)));
  return (current || []).some((p) => !seen.has(Number(p.procNum)));
}

/**
 * Is this row frozen — attached to or creating a case by a CLAIM?
 * A frozen row's snapshot is what the TC acted on and is never rewritten.
 * @param {{ status: string, claimed_case_id?: string|null }} row
 */
function isFrozen(row) {
  return row.status === 'claimed' || (row.status === 'existing_case' && row.claimed_case_id != null);
}

/**
 * What one COMPLETE sweep does to one existing row.
 *
 * `incoming` is the patient's candidate from this sweep, or null when the
 * sweep found no qualifying procedure for them. Only ever called after a
 * complete sweep: a partial sweep proves nothing about absence.
 *
 * Ops:
 *   refresh     open row: procedures / value / date replaced, last_seen moves,
 *               cleared_at cleared
 *   touch       frozen or dismissed row still present: last_seen moves (and
 *               cleared_at cleared), snapshot untouched
 *   resurrect   dismissed row + a NEW ProcNum → back to 'new', snapshot
 *               replaced, dismissal fields cleared, resurrected_at stamped
 *   clear       nothing qualifying any more → cleared_at stamped (once)
 *   none        already cleared and still absent
 *
 * @param {{ status: string, claimed_case_id?: string|null, procedures: OpportunityProcedure[],
 *           cleared_at?: unknown }} existing
 * @param {PatientCandidate|null} incoming
 * @returns {{ op: 'refresh'|'touch'|'resurrect'|'clear'|'none' }}
 */
function planRowChange(existing, incoming) {
  if (!incoming) return { op: existing.cleared_at ? 'none' : 'clear' };
  if (existing.status === 'dismissed') {
    return { op: hasNewProcedure(existing.procedures, incoming.procedures) ? 'resurrect' : 'touch' };
  }
  if (isFrozen(existing)) return { op: 'touch' };
  return { op: 'refresh' };
}

/**
 * existing_case marking, BOTH directions.
 *
 *   new            + the patient has an OPEN TC case in this office → existing_case
 *   existing_case  (marked by this rule, no claimed_case_id) + no open case
 *                  any more → new
 *
 * A row a CLAIM attached to a case (existing_case WITH claimed_case_id) never
 * flips back: that treatment was handled; a later lost/completed case is the
 * case's story, not a reason to resurface the same plan.
 *
 * "Open" is OPEN_CASE_STATUSES from the shared TC contract — the same
 * partition intakeFromCall's attach-or-create uses.
 *
 * @param {Array<{ opportunity_id: string, od_patient_id: number, status: string,
 *                 claimed_case_id?: string|null }>} rows
 * @param {Set<number>} patientsWithOpenCase
 * @returns {Array<{ opportunityId: string, from: string, to: 'new'|'existing_case' }>}
 */
function planExistingCaseFlips(rows, patientsWithOpenCase) {
  /** @type {Array<{ opportunityId: string, from: string, to: 'new'|'existing_case' }>} */
  const flips = [];
  for (const r of rows) {
    const has = patientsWithOpenCase.has(Number(r.od_patient_id));
    if (r.status === 'new' && has) {
      flips.push({ opportunityId: r.opportunity_id, from: 'new', to: 'existing_case' });
    } else if (r.status === 'existing_case' && r.claimed_case_id == null && !has) {
      flips.push({ opportunityId: r.opportunity_id, from: 'existing_case', to: 'new' });
    }
  }
  return flips;
}

/**
 * A claim's phase tree is BUILT ON THE CLIENT by features/tc/od/odPlan.ts
 * (groupItemsIntoPhases + inferUrgency — the one implementation of those
 * rules). The server does not re-derive it; it CHECKS it against the snapshot
 * it holds, so a client cannot price or invent treatment the opportunity does
 * not contain:
 *
 *   - every item names an odProcNum that is in the snapshot
 *   - no odProcNum appears twice
 *   - each item's feeCents equals the snapshot's fee for that procedure
 *
 * A subset is allowed (the TC may leave a line out). Returns null when the
 * tree is acceptable, otherwise a reason code.
 *
 * @param {Array<{ items: Array<{ odProcNum?: number|null, feeCents: number }> }>} phases
 * @param {OpportunityProcedure[]} snapshot
 * @returns {null | 'ITEM_NOT_IN_SNAPSHOT' | 'ITEM_DUPLICATED' | 'FEE_MISMATCH'}
 */
function verifyClaimPhases(phases, snapshot) {
  const fees = new Map((snapshot || []).map((p) => [Number(p.procNum), Number(p.feeCents)]));
  const used = new Set();
  for (const phase of phases || []) {
    for (const item of phase.items || []) {
      const procNum = Number(item.odProcNum);
      if (!fees.has(procNum)) return 'ITEM_NOT_IN_SNAPSHOT';
      if (used.has(procNum)) return 'ITEM_DUPLICATED';
      used.add(procNum);
      if (Number(item.feeCents) !== fees.get(procNum)) return 'FEE_MISMATCH';
    }
  }
  return null;
}

/** Urgency ordering, most urgent first — ORDERING ONLY, not inference. */
const URGENCY_ORDER = Object.freeze(['high', 'medium', 'low', 'elective']);

/**
 * The case's urgency from a verified phase tree: the most urgent item's
 * urgency, which the CLIENT inferred with inferUrgency. 'medium' — the manual
 * New Case default — when there are no items.
 * @param {Array<{ items: Array<{ urgency: string }> }>} phases
 * @returns {string}
 */
function caseUrgencyFromPhases(phases) {
  let best = URGENCY_ORDER.length;
  for (const phase of phases || []) {
    for (const item of phase.items || []) {
      const i = URGENCY_ORDER.indexOf(item.urgency);
      if (i >= 0 && i < best) best = i;
    }
  }
  return best < URGENCY_ORDER.length ? URGENCY_ORDER[best] : 'medium';
}

/**
 * Open Dental patient statuses the inbox shows. The legacy finder kept
 * `PatStatus = 0` only; the API returns the string "Patient" for that.
 * An UNKNOWN status (name not read yet) is shown — hiding it would hide every
 * row the name pass has not reached.
 * @param {string|null|undefined} status
 */
function isShowablePatientStatus(status) {
  return status == null || status === '' || status === 'Patient' || status === '0';
}

/**
 * 'YYYY-MM-DD' `days` before `now`, in the given IANA zone.
 * @param {number} days
 * @param {Date} now
 * @param {string} timeZone
 */
function cutoffDate(days, now, timeZone) {
  if (!Number.isFinite(days) || days <= 0) return null;
  const then = new Date(now.getTime() - days * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(then);
}

module.exports = {
  OPPORTUNITY_STATUSES,
  ACTIONABLE_STATUSES,
  SYNC_STATUSES,
  OD_TP_STATUS,
  URGENCY_ORDER,
  odDate,
  toCents,
  qualifyProcedure,
  groupByPatient,
  hasNewProcedure,
  isFrozen,
  planRowChange,
  planExistingCaseFlips,
  verifyClaimPhases,
  caseUrgencyFromPhases,
  isShowablePatientStatus,
  cutoffDate,
};
