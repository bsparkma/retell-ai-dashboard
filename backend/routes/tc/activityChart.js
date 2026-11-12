'use strict';

/**
 * AT-2 — "Log to chart": one TC activity-feed item written to the patient's
 * Open Dental chart as a commlog, under that office's "CareIN TC" type, ONLY by
 * a person (tc.full) who has seen and approved the exact text.
 *
 *   GET  /api/tc/cases/:caseId/activity/:itemId/chart   the preview: may it be
 *        charted, the server-composed default text, the office and the type
 *   POST /api/tc/cases/:caseId/activity/:itemId/chart   { text, conversationDate? }
 *        strict; text ≤ 2000, already trimmed and OD-safe
 *
 * The R6.10 referral chart note (routes/tc/referralChartNotes.js) applied to
 * the AT-1 feed, ratified 11/10.
 *
 * NOTHING WRITES ON ITS OWN. writeFromFeed is reached from exactly one place,
 * the POST handler in routes/tc/cases.js, which a person's click calls. No
 * timer, scheduler, webhook, nurture step or other route calls it, and
 * routes/tc/tcActivityChart.test.js fails the build if anything else requires
 * this module or the Open Dental half it drives (services/tc/tcChartNote.js).
 *
 * WHAT THE CLIENT SAYS, AND WHAT IT CANNOT. The body is the approved text and
 * an optional conversation date — any other field is a 400. The office is
 * req.tcOffice; the PatNum comes from the CASE ROW read in that office; the
 * item is RE-READ from its own source row (never the client's copy) and judged
 * by the same pure rule the feed draws the button by (./activityChartable.js);
 * the commlog type is THAT office's configured "CareIN TC" (config/odOffices —
 * never crossed, never a fallback); CommDateTime is the moment it is written,
 * as the office's wall clock — never backdated. A conversation date the person
 * gives goes INTO the note text as "[Conversation date: MM/DD/YYYY]" and
 * nowhere else.
 *
 * In order — the first refusal stops everything, and nothing before step 5
 * touches a chart:
 *   1. the environment's write switch (OPENDENTAL_WRITE_DISABLED) → 403;
 *   2. the office's Open Dental readiness and its configured "CareIN TC" type
 *      → its named refusal (TC_COMMTYPE_NOT_CONFIGURED 409, …);
 *   3. the final text is ≤ 2000 and already what Open Dental will store → 400;
 *   4. in one tenant transaction, HOLDING the case row lock and a per-item
 *      advisory lock across the Open Dental call: the case in this office with
 *      a PatNum; no tc_chart_writes row for this item yet; the item re-read and
 *      chart-worthy; the type in THIS office's own commlog-type list under the
 *      name "CareIN TC";
 *   5. the Open Dental half (services/tc/tcChartNote.js): an identical note
 *      already on the chart refuses; the voice module's writer creates it; it
 *      is READ BACK and must match before anything is claimed;
 *   6. THEN the tc_chart_writes row and ONE audit row (CREATE commlog,
 *      source_ref = the feed item id, no note text), in that transaction.
 *
 * A failure at 5 records nothing and is answered with its own named code
 * (CHART_NOTE_UNCONFIRMED 502 on a read-back mismatch). A write that landed
 * but could not be recorded at 6 says so — 500 TC_CHART_WRITTEN_UNRECORDED with
 * the CommlogNum and "do not write again" — and a same-text retry is then
 * refused at 5 because the note is already on the chart.
 */

const { randomUUID } = require('node:crypto');

const { contract, actorEmail, auditTc } = require('./helpers');
const { audit } = require('../../platform/audit');
const { withTenantTx } = require('./tx');
const activityFeed = require('./activityFeed');
const { chartEligibility } = require('./activityChartable');
const odOffices = require('../../config/odOffices');
const commlogTypes = require('../../services/commlogTypes');
const { isOdWriteDisabled } = require('../../middleware/envGuards');
const tcChartNote = require('../../services/tc/tcChartNote');

/** The Definition.ItemName the configured DefNum must carry in the office's own list. */
const TC_COMMTYPE_NAME = 'CareIN TC';
/** Open Dental's practical commlog note ceiling we hold every chart note to. */
const MAX_NOTE = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Open Dental half's failure codes → HTTP status (as R6.10). */
const WRITE_FAILURE_STATUS = Object.freeze({
  CHART_NOTE_API_MODE_ONLY: 409,
  CHART_NOTE_ALREADY_IN_CHART: 409,
  CHART_NOTE_UNVERIFIABLE: 502,
  CHART_NOTE_WRITE_FAILED: 502,
  CHART_NOTE_UNCONFIRMED: 502,
});

const { z } = contract;

/** The whole body. Strict: an office, PatNum, DefNum or date smuggled in is a 400. */
const ChartWriteBody = z
  .object({
    text: z.string().min(1).max(MAX_NOTE),
    conversationDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();

let clock = () => new Date();
/** TESTS ONLY: pin the write time. */
function setClockForTests(fn) {
  clock = fn || (() => new Date());
}

/** The Open Dental write landed; recording it did not. Carries the CommlogNum out of the rolled-back transaction. */
class WrittenUnrecordedError extends Error {
  constructor(commLogNum, cause) {
    super(`TC chart note ${commLogNum} written but not recorded: ${cause && cause.message}`);
    this.commLogNum = commLogNum;
  }
}

/** A refusal raised inside the transaction (so it rolls back) and answered as-is. */
class Refusal extends Error {
  constructor(status, code, error, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.publicError = error;
    this.extra = extra;
  }
}

const refuse = (status, code, error, extra = {}) => ({ status, body: { success: false, error, code, ...extra } });

// ── dates ───────────────────────────────────────────────────────────────────

const TZ = () => process.env.OFFICE_TIMEZONE || 'America/Chicago';

/** "YYYY-MM-DD" of `d` in the office's time zone. */
function officeDay(d) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ(), year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}`;
}

/** "MM/DD/YYYY h:mm AM" of an ISO instant, office-local, for the default text. */
function officeStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  })
    .format(d)
    .replace(',', '');
}

/**
 * A real calendar day "YYYY-MM-DD", not after the office's today. Returns the
 * note-text form "MM/DD/YYYY", or null when it is not acceptable.
 * @param {string} ymd
 * @param {Date} now
 */
function conversationDateText(ymd, now) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 2000) return null;
  if (ymd > officeDay(now)) return null;
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
}

/**
 * The exact text that will be written: what the person approved, plus — only
 * when they gave one — the conversation date line. Pure.
 * @param {string} text
 * @param {string|null} dateText "MM/DD/YYYY" or null
 */
function finalNoteText(text, dateText) {
  return dateText ? `${text}\n[Conversation date: ${dateText}]` : text;
}

// ── the item, re-read from its own row ──────────────────────────────────────

/** The feed's own source list; anything else is not an item id. */
const ITEM_ID = /^([a-z_]+):(.+)$/;

/**
 * Re-read ONE feed item from its source row, in this office and this case, and
 * map it with the feed's own mapper. Returns null when there is no such item
 * here (a 404). Sources whose items are never chart-worthy are not read at
 * all: they are answered with a minimal item the classifier refuses by source.
 *
 * @param {{ query: Function }} q
 * @param {{ office: string, header: Record<string, unknown>, itemId: string }} args
 * @returns {Promise<{ item: Record<string, any>, facts: Record<string, unknown> } | null>}
 */
async function resolveFeedItem(q, { office, header, itemId }) {
  const m = ITEM_ID.exec(String(itemId || ''));
  if (!m || !activityFeed.SOURCES.includes(m[1])) return null;
  const [, source, rowId] = m;
  const caseId = String(header.case_id);
  const scopeOfCase = (id) => (String(id) === caseId ? 'case' : 'patient');
  const patNum = header.od_patient_id == null ? null : Number(header.od_patient_id);

  switch (source) {
    case 'case_event': {
      if (!UUID.test(rowId)) return null;
      const res = await q.query(
        'SELECT event_id, case_id, ts, type, description, actor, detail, source_call_id FROM tc_case_events WHERE office_id = $1 AND event_id = $2',
        [office, rowId]
      );
      const r = res.rows[0];
      if (!r || String(r.case_id) !== caseId) return null;
      const item = activityFeed.mapCaseEvent(r, { scopeOfCase });
      const facts = { type: r.type, detail: activityFeed.json(r.detail) };
      if (r.type === 'status_change') {
        // The lost reason lives on the case (overwritten in place), so it is
        // only ever added for the LATEST status change, into 'lost', while the
        // case is still lost — the one moment the current value IS this event's.
        const parts = activityFeed.splitStatusDescription(r.description);
        if (parts && parts.to === 'lost' && header.status === 'lost' && activityFeed.text(header.lost_reason)) {
          const latest = await q.query(
            "SELECT event_id FROM tc_case_events WHERE office_id = $1 AND case_id = $2 AND type = 'status_change' ORDER BY ts DESC, event_id DESC LIMIT 1",
            [office, caseId]
          );
          if (latest.rows[0] && String(latest.rows[0].event_id) === String(r.event_id)) {
            facts.lostReason = String(header.lost_reason);
          }
        }
      }
      return { item, facts };
    }
    case 'objection': {
      if (!UUID.test(rowId)) return null;
      const res = await q.query(
        'SELECT objection_id, case_id, category, note, patient_words, logged_at FROM tc_case_objections WHERE office_id = $1 AND objection_id = $2',
        [office, rowId]
      );
      const r = res.rows[0];
      if (!r || String(r.case_id) !== caseId) return null;
      return { item: activityFeed.mapObjectionRow(r, scopeOfCase(r.case_id)), facts: {} };
    }
    case 'followup': {
      if (!UUID.test(rowId)) return null;
      const res = await q.query(
        'SELECT followup_id, case_id, status, talking_point, outcome_note, completed_at, completed_by FROM tc_followups WHERE office_id = $1 AND followup_id = $2',
        [office, rowId]
      );
      const r = res.rows[0];
      // Only a SKIPPED follow-up is a followup item; a completed one is its event.
      if (!r || String(r.case_id) !== caseId || r.status !== 'skipped' || r.completed_at == null) return null;
      return { item: activityFeed.mapFollowupSkippedRow(r, scopeOfCase(r.case_id)), facts: {} };
    }
    case 'checkout': {
      const cm = /^([0-9a-f-]{36}):(outcome|dismissed|reopened)$/i.exec(rowId);
      if (!cm || !UUID.test(cm[1]) || patNum == null) return null;
      const res = await q.query(
        'SELECT handoff_id, case_id, od_patient_id, status, dismissed_reason, dismissed_by, dismissed_at, outcome_by, outcome_at, appointment_note, reopened_from FROM tc_checkout_handoffs WHERE office_id = $1 AND handoff_id = $2',
        [office, cm[1]]
      );
      const r = res.rows[0];
      if (!r || Number(r.od_patient_id) !== patNum) return null;
      const checkoutScope = (cid) => (cid == null || String(cid) === caseId ? 'case' : 'patient');
      const item = activityFeed.mapCheckoutRow(r, checkoutScope).find((it) => it.id === `checkout:${rowId}`);
      return item ? { item, facts: {} } : null;
    }
    case 'message': {
      if (!UUID.test(rowId)) return null;
      const res = await q.query(`SELECT ${activityFeed.MSG_COLS} FROM tc_messages WHERE office_id = $1 AND message_id = $2`, [office, rowId]);
      const r = res.rows[0];
      if (!r) return null;
      // An inbound on no case is "not linked to this case" in the feed: refused, not charted.
      const unlinked = r.case_id == null;
      const item = activityFeed.mapMessage((row) => (row.case_id == null ? 'patient' : scopeOfCase(row.case_id)), unlinked)(r);
      return { item: unlinked ? { ...item, alwaysShow: true } : item, facts: { subject: activityFeed.text(r.subject) } };
    }
    default: {
      // case_notes / preauth / consent (current value), hygiene / referral /
      // voice (charted their own way), email_log (no body), pre-auth history:
      // never chart-worthy, so their rows are not read at all.
      const currentValue =
        source === 'case_notes' || source === 'consent' || (source === 'preauth' && rowId.endsWith(':current'));
      return {
        item: {
          id: `${source}:${rowId}`,
          source,
          kind: source,
          scope: 'case',
          actor: { system: false },
          body: null,
          completeness: currentValue ? 'current_value_only' : 'full',
          chart: { onChart: false, via: null },
        },
        facts: {},
      };
    }
  }
}

// ── the default text ────────────────────────────────────────────────────────

/** "contact attempt (phone, no answer)" style detail for a contact_attempt. */
function contactDetail(detail) {
  if (!activityFeed.isObject(detail)) return '';
  const bits = [detail.channel, detail.outcome].filter((v) => typeof v === 'string' && v.trim()).map((v) => String(v).replace(/_/g, ' '));
  return bits.length ? ` (${bits.join(', ')})` : '';
}

/**
 * The server-composed default the person starts from (and may edit): a header
 * naming what it is, when, and who — then the item's own words verbatim
 * (an objection keeps the patient's exact words). Made OD-safe, so what the
 * person sees is what Open Dental would store. Pure.
 * @param {Record<string, any>} item
 * @param {Record<string, unknown>} facts
 */
function defaultText(item, facts) {
  const who =
    item.actor && !item.actor.system && item.actor.display && !['Not recorded', 'Unknown'].includes(item.actor.display)
      ? ` by ${item.actor.display}`
      : '';
  const when = item.at ? ` ${officeStamp(item.at)}` : '';
  const title = facts.type === 'contact_attempt' ? `Contact attempt${contactDetail(facts.detail)}` : String(item.title || '');
  const lines = [`CareIN TC - ${title}${when}${who}`];
  if (item.source === 'message' && item.kind.startsWith('email') && facts.subject) lines.push(`Subject: ${facts.subject}`);
  if (typeof item.body === 'string' && item.body.trim()) lines.push(item.body.trim());
  if (facts.lostReason) lines.push(`Lost reason: ${String(facts.lostReason).replace(/_/g, ' ')}`);
  return contract.referralChartNoteOdSafe(lines.join('\n')).trim();
}

// ── the type, checked against THIS office's own list ────────────────────────

/**
 * The office's configured "CareIN TC" DefNum, PROVEN against that office's own
 * commlog-type list: present, visible, and named "CareIN TC". A number that is
 * missing there, or names something else (a valley number configured for
 * roland, or 401 — a real type in both practices meaning different things) is
 * refused before anything is written.
 * @param {import('../../config/odOffices').OdOfficeHandle} od
 * @returns {Promise<number>}
 */
async function assertTcCommType(od) {
  const defNum = od.tcCommTypeDefNum;
  if (!Number.isInteger(defNum) || defNum <= 0) {
    throw new Refusal(409, 'TC_COMMTYPE_NOT_CONFIGURED', `No "${TC_COMMTYPE_NAME}" chart note type is configured for ${od.officeName}, so nothing was written.`);
  }
  const catalogue = await commlogTypes.listForOffice(od);
  if (!catalogue.available) {
    throw new Refusal(
      503,
      'COMMLOG_TYPE_UNVERIFIABLE',
      `Can't check the "${TC_COMMTYPE_NAME}" chart note type against ${od.officeName}'s Open Dental right now, so nothing was written. Try again shortly.`
    );
  }
  const option = catalogue.options.find((o) => o.defNum === defNum);
  if (!option || option.name !== TC_COMMTYPE_NAME) {
    console.error(
      `[activityChart] BLOCKED TC chart note for office '${od.officeKey}': DefNum ${defNum} is ` +
        (option ? `named '${option.name}'` : 'not a visible commlog type') +
        ` in that practice's Open Dental, not '${TC_COMMTYPE_NAME}'`
    );
    throw new Refusal(
      409,
      'TC_COMMTYPE_INVALID',
      `The "${TC_COMMTYPE_NAME}" chart note type configured for ${od.officeName} is not that office's own "${TC_COMMTYPE_NAME}" commlog type, so nothing was written.`
    );
  }
  return defNum;
}

// ── availability (feed + preview) ───────────────────────────────────────────

/**
 * Can this office take a TC chart note right now? Pure: the environment switch,
 * then the office's readiness and configured type. The UI disables the button
 * with `message` when `available` is false; the write route re-checks it all.
 * @param {string} office
 * @returns {{ available: boolean, code: string|null, message: string|null }}
 */
function writeAvailability(office) {
  if (isOdWriteDisabled()) {
    return { available: false, code: 'OD_WRITE_DISABLED', message: 'Open Dental writes are switched off in this environment.' };
  }
  const blocked = odOffices.tcChartNoteBlockReason(office);
  return blocked ? { available: false, code: blocked.code, message: blocked.message } : { available: true, code: null, message: null };
}

const HEADER_SQL =
  'SELECT case_id, office_id, phone, email, od_patient_id, status, lost_reason FROM tc_cases WHERE office_id = $1 AND case_id = $2';

/**
 * The preview the dialog opens with. Read-only.
 * @param {{ query: Function }} q tenant pool
 * @param {{ office: string, caseId: string, itemId: string }} args
 * @returns {Promise<{ status: number, body: object }>}
 */
async function preview(q, { office, caseId, itemId }) {
  const head = await q.query(HEADER_SQL, [office, caseId]);
  const header = head.rows[0];
  if (!header) return refuse(404, 'NOT_FOUND', 'case not found');
  const resolved = await resolveFeedItem(q, { office, header, itemId });
  if (!resolved) return refuse(404, 'ACTIVITY_ITEM_NOT_FOUND', 'That activity item is not on this case.');

  const prior = await q.query(
    'SELECT commlog_num, note_text, written_by, written_at FROM tc_chart_writes WHERE office_id = $1 AND feed_item_id = $2',
    [office, resolved.item.id]
  );
  const written = prior.rows[0] || null;
  const item = written ? { ...resolved.item, chart: { onChart: true, via: 'tc', commLogNum: Number(written.commlog_num) } } : resolved.item;
  const chartable = chartEligibility(item);
  return {
    status: 200,
    body: {
      success: true,
      itemId: item.id,
      chartable,
      defaultText: chartable.eligible ? defaultText(item, resolved.facts) : null,
      maxLength: MAX_NOTE,
      office: { id: office, name: odOffices.describeOffice(office).officeName },
      commType: { name: TC_COMMTYPE_NAME },
      hasPatient: header.od_patient_id != null,
      availability: writeAvailability(office),
      onChart: written
        ? {
            commLogNum: Number(written.commlog_num),
            writtenBy: String(written.written_by),
            writtenAt: activityFeed.isoAt(written.written_at),
          }
        : null,
    },
  };
}

// ── the write ───────────────────────────────────────────────────────────────

/** A failed chart write is still a chart write somebody asked for: one audit row, no text. */
async function auditAttempt(req, office, caseId, itemId, result) {
  await audit(req, {
    action: 'CREATE',
    resourceType: 'commlog',
    resourceId: caseId,
    office,
    sourceRef: itemId,
    result,
  });
}

/**
 * Write one approved feed item to the case's patient's chart.
 * @param {import('express').Request} req
 * @param {{ caseId: string, itemId: string, body: unknown, office?: string }} args
 * @returns {Promise<{ status: number, body: object }>}
 */
async function writeFromFeed(req, { caseId, itemId, body: rawBody, office = req.tcOffice }) {
  const parsed = ChartWriteBody.safeParse(rawBody);
  if (!parsed.success) {
    return refuse(400, 'VALIDATION_ERROR', 'The request may carry only the approved text and an optional conversation date.', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const body = parsed.data;

  // 1. The environment's switch. A dev box shares the practices' credentials.
  if (isOdWriteDisabled()) {
    return refuse(403, 'OD_WRITE_DISABLED', 'Open Dental writes are switched off in this environment');
  }

  // 2. Can this office's charts take a TC note at all?
  const blocked = odOffices.tcChartNoteBlockReason(office);
  if (blocked) {
    const status = blocked.code === 'TC_COMMTYPE_NOT_CONFIGURED' ? 409 : odOffices.httpStatusFor({ code: blocked.code });
    return refuse(status, blocked.code, blocked.message);
  }

  // 3. The person must have seen the text that lands.
  const now = clock();
  let dateText = null;
  if (body.conversationDate !== undefined) {
    dateText = conversationDateText(body.conversationDate, now);
    if (!dateText) {
      return refuse(400, 'CONVERSATION_DATE_INVALID', 'The conversation date must be a real date, today or earlier.');
    }
  }
  if (body.text !== body.text.trim()) {
    return refuse(400, 'CHART_NOTE_NOT_TRIMMED', 'The note starts or ends with blank space. Review the text shown and write it again.');
  }
  const note = finalNoteText(body.text, dateText);
  if (note.length > MAX_NOTE) {
    return refuse(400, 'CHART_NOTE_TOO_LONG', `The note is ${note.length} characters; the most a chart note can hold is ${MAX_NOTE}.`);
  }
  if (contract.referralChartNoteOdSafe(note) !== note) {
    return refuse(
      400,
      'CHART_NOTE_NOT_OD_SAFE',
      'The note has characters Open Dental would change (curly quotes, long dashes). Review the text shown and write it again.'
    );
  }

  const feedItemId = String(itemId);
  let outcome;
  try {
    outcome = await withTenantTx(req, async (client) => {
      // 4. The locks first, held across the Open Dental call below: the case
      // row, and the item itself (a checkout item can show on more than one of
      // the patient's cases, so the case lock alone would not serialize it).
      const head = await client.query(`${HEADER_SQL} FOR UPDATE`, [office, caseId]);
      const header = head.rows[0];
      if (!header) throw new Refusal(404, 'NOT_FOUND', 'case not found');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tc_chart_write:${office}:${feedItemId}`]);

      const patNum = Number(header.od_patient_id);
      if (header.od_patient_id == null || !Number.isInteger(patNum) || patNum <= 0) {
        throw new Refusal(409, 'CASE_NO_PATIENT', 'This case is not linked to an Open Dental patient, so there is no chart to write to.');
      }

      // CareIN's own dedupe: a feed item reaches the chart once, ever.
      const prior = await client.query(
        'SELECT commlog_num, written_by, written_at FROM tc_chart_writes WHERE office_id = $1 AND feed_item_id = $2',
        [office, feedItemId]
      );
      if (prior.rows[0]) {
        const p = prior.rows[0];
        throw new Refusal(409, 'ALREADY_ON_CHART', 'This item was already written to the chart.', {
          commLogNum: Number(p.commlog_num),
          writtenBy: String(p.written_by),
          writtenAt: activityFeed.isoAt(p.written_at),
        });
      }

      const resolved = await resolveFeedItem(client, { office, header, itemId: feedItemId });
      if (!resolved) throw new Refusal(404, 'ACTIVITY_ITEM_NOT_FOUND', 'That activity item is not on this case.');
      const chartable = chartEligibility(resolved.item);
      if (!chartable.eligible) throw new Refusal(409, chartable.code, chartable.reason);

      const od = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
      const commType = await assertTcCommType(od);

      // 5. The chart write, read back. Dated NOW — when a person wrote it —
      // never the item's own time (the #290 lesson): a note written today
      // filed under last week is where nobody looks for today's work.
      const writtenAt = now.toISOString();
      const written = await tcChartNote.writeTcChartNote(od, { patNum, note, commType, at: writtenAt });
      if (!written.ok) return { failed: written };

      // 6. Recorded only now. Anything that fails here rolls the row back, but
      // the note IS on the chart — carried out so the answer says so.
      try {
        await client.query(
          'INSERT INTO tc_chart_writes (write_id, office_id, case_id, feed_item_id, od_patient_id, commlog_num, commtype_defnum, note_text, conversation_date, written_by, written_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
          [
            randomUUID(),
            office,
            String(header.case_id),
            feedItemId,
            patNum,
            written.commLogNum,
            commType,
            note,
            body.conversationDate ?? null,
            actorEmail(req),
            writtenAt,
          ]
        );
        await auditTc(req, 'CREATE', 'commlog', String(written.commLogNum), { office, sourceRef: feedItemId });
      } catch (err) {
        throw new WrittenUnrecordedError(written.commLogNum, err);
      }
      return { written: written.commLogNum, writtenAt };
    });
  } catch (err) {
    if (err instanceof WrittenUnrecordedError) {
      console.error(`[activityChart] ${office}: ${err.message}`);
      return refuse(
        500,
        'TC_CHART_WRITTEN_UNRECORDED',
        `The note was written to the chart (Open Dental note ${err.commLogNum}) but could not be recorded here. Do not write it again.`,
        { commLogNum: err.commLogNum }
      );
    }
    if (err instanceof Refusal) {
      // Refused before Open Dental was asked to write; a type refusal is still an attempt.
      if (err.code === 'TC_COMMTYPE_INVALID' || err.code === 'COMMLOG_TYPE_UNVERIFIABLE') {
        await auditAttempt(req, office, caseId, feedItemId, err.code === 'COMMLOG_TYPE_UNVERIFIABLE' ? 'ERROR' : 'UNAUTHORIZED');
      }
      return refuse(err.status, err.code, err.publicError, err.extra);
    }
    if (err instanceof odOffices.OdOfficeError) {
      return refuse(odOffices.httpStatusFor(err), err.code, err.publicMessage);
    }
    throw err;
  }

  if (outcome.failed) {
    await auditAttempt(req, office, caseId, feedItemId, 'ERROR');
    const f = outcome.failed;
    return refuse(WRITE_FAILURE_STATUS[f.code] || 502, f.code, f.error, {
      ...(f.commLogNum !== undefined ? { commLogNum: f.commLogNum } : {}),
    });
  }
  return {
    status: 201,
    body: {
      success: true,
      itemId: feedItemId,
      commLogNum: outcome.written,
      writtenAt: outcome.writtenAt,
      chart: { onChart: true, via: 'tc', commLogNum: outcome.written },
    },
  };
}

module.exports = {
  preview,
  writeFromFeed,
  writeAvailability,
  setClockForTests,
  TC_COMMTYPE_NAME,
  MAX_NOTE,
  /** Exposed for tests. */
  defaultText,
  finalNoteText,
  conversationDateText,
  resolveFeedItem,
};
