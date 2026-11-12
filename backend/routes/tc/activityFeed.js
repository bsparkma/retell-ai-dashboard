'use strict';

/**
 * AT-1: the case view's Activity feed — every communication and note source
 * for a case (and, with scope=patient, for the same patient's other cases in
 * the same office), merged newest first and paged by keyset.
 *
 * READ-ONLY. Nothing here writes; the route writes one READ audit row per page.
 *
 * Office and PatNum come from the CASE HEADER the route has already loaded in
 * req.tcOffice — never from the request. Every query below keys on that
 * header's office_id plus its case_id(s) or od_patient_id.
 *
 * Ordering is (at DESC, id DESC), where `at` is the fact's own ISO time and
 * `id` is "source:rowId". A page asks each SQL source for rows at-or-before the
 * cursor's `at` (ORDER BY at DESC LIMIT n+1), drops the ones at-or-after the
 * cursor in JS (ties on `at` are broken by id, which SQL cannot see across
 * sources), merges, and takes n. Keyset, so rows inserted while someone pages
 * land above the cursor and never shift or duplicate a page already read.
 *
 * Feed honesty: a source that is overwritten in place (the case notes box, a
 * pre-auth record, a contact-consent row) can only be shown as it is NOW, so
 * its item is completeness 'current_value_only' and the UI says "current
 * value", never history.
 *
 * Deliberately NOT in the feed: checkout workup ticks, attestations, and nurture
 * system bookkeeping beyond the nurture events the case timeline already has.
 */

const { getOfficeForCall } = require('../../config/officeAgents');
const retention = require('../../services/callRetention');
const { normalizePhone, normalizeEmail } = require('../../services/messaging/address');
// AT-2: the one rule for which items "Log to chart" applies to.
const { chartEligibility } = require('./activityChartable');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** How close (ms) an objection row's created_at must be to its logged event. */
const OBJECTION_MATCH_MS = 10_000;
/** A source re-asks with a bigger LIMIT at most this many times (see pull()). */
const MAX_WIDEN = 4;
/** Hard ceiling on rows read from a source that is filtered in JS. */
const SMALL_SOURCE_CAP = 1000;

const SOURCES = Object.freeze([
  'case_event',
  'case_notes',
  'objection',
  'followup',
  'hygiene_intake',
  'checkout',
  'message',
  'email_log',
  'referral_event',
  'preauth',
  'voice_call',
  'consent',
]);

// ── small helpers ───────────────────────────────────────────────────────────

/** Normalized ISO instant, or null for an absent / unparseable value. */
function isoAt(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function json(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v;
}

function isObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function text(v) {
  if (v == null) return null;
  const s = String(v);
  return s.trim() === '' ? null : s;
}

/** The actor shape. A 'system:*' string (or none, for system rows) is a system actor. */
function actorOf(raw, { system = false, display = null } = {}) {
  const s = raw == null ? '' : String(raw).trim();
  if (!s) {
    return system
      ? { display: display || 'CareIN', email: null, system: true }
      : { display: display || 'Unknown', email: null, system: false };
  }
  if (s.startsWith('system:') || s === 'system') {
    return { display: display || 'CareIN', email: null, system: true };
  }
  const isEmail = /^[^@\s]+@[^@\s]+$/.test(s);
  return { display: display || s, email: isEmail ? s : null, system: false };
}

const NO_CHART = Object.freeze({ onChart: false, via: null });

function item(fields) {
  return {
    direction: undefined,
    links: {},
    chart: NO_CHART,
    completeness: 'full',
    body: null,
    ...fields,
    id: `${fields.source}:${fields.rowId}`,
    rowId: undefined,
  };
}

/** Strip helper fields the wire shape does not carry. */
function finalize(it) {
  const out = { ...it };
  delete out.rowId;
  delete out.alwaysShow;
  delete out.pending;
  if (out.direction === undefined) delete out.direction;
  return out;
}

/** (at DESC, id DESC): negative when a sorts first. */
function compareDesc(a, b) {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/** Is this item strictly after the cursor in feed order (i.e. on a later page)? */
function afterCursor(it, cursor) {
  if (!cursor) return true;
  return it.at < cursor.at || (it.at === cursor.at && it.id < cursor.id);
}

// ── cursor ──────────────────────────────────────────────────────────────────

function encodeCursor(it) {
  return Buffer.from(JSON.stringify({ at: it.at, id: it.id }), 'utf8').toString('base64url');
}

/** @returns {{at: string, id: string} | null | undefined} undefined ⇒ malformed */
function decodeCursor(raw) {
  if (raw == null || raw === '') return null;
  try {
    const v = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (!isObject(v) || typeof v.at !== 'string' || typeof v.id !== 'string') return undefined;
    const at = isoAt(v.at);
    if (!at || at !== v.at || !/^[a-z_]+:.+/.test(v.id)) return undefined;
    return { at: v.at, id: v.id };
  } catch {
    return undefined;
  }
}

// ── the keyset pull ─────────────────────────────────────────────────────────

/**
 * Pull one SQL source: rows at-or-before the cursor's `at`, newest first, then
 * the JS tie-break. If many rows share the cursor's exact `at` the LIMIT could
 * be spent on rows the tie-break then drops, so a full-but-short answer asks
 * again with a wider LIMIT (bounded) instead of silently ending the source.
 *
 * @param {(lim: number, cursorAt: string|null) => Promise<object[]>} fetchRows
 * @param {(rows: object[]) => object[]} mapRows
 * @param {number} need items wanted after the tie-break (the page size + 1)
 */
async function pull(fetchRows, mapRows, cursor, need) {
  let lim = need;
  let items = [];
  for (let i = 0; i < MAX_WIDEN; i += 1) {
    const rows = await fetchRows(lim, cursor ? cursor.at : null);
    items = mapRows(rows).filter((it) => it.at && afterCursor(it, cursor));
    if (items.length >= need || rows.length < lim) return items;
    lim *= 4;
  }
  return items;
}

/** `AND <col> <= $n` when paging; the cursor's `at` is always a bound parameter. */
function keyset(col, cursorAt, params) {
  if (!cursorAt) return '';
  params.push(cursorAt);
  return ` AND ${col} <= $${params.length}`;
}

/** LIMIT is a clamped integer we computed, never request text. */
function limitClause(n) {
  const v = Math.max(1, Math.min(Math.floor(Number(n)) || 1, 10_000));
  return ` LIMIT ${v}`;
}

// ── case events ─────────────────────────────────────────────────────────────

const EVENT_LABEL = Object.freeze({
  status_change: 'Status change',
  follow_up_completed: 'Follow-up completed',
  objection_logged: 'Objection',
  note_added: 'Note',
  case_created: 'Case created',
  nurture_enrolled: 'Nurture enrolled',
  contact_attempt: 'Contact attempt',
  voice_handoff: 'Sent to TC from a call',
  nurture_paused: 'Nurture paused',
  nurture_resumed: 'Nurture resumed',
  nurture_stopped: 'Nurture stopped',
  nurture_completed: 'Nurture completed',
  nurture_touch_queued: 'Nurture draft queued',
  notes_updated: 'Case notes edited',
});

/** "A → B" or "A → B: note" (the status route's format) → its parts. */
function splitStatusDescription(desc) {
  const m = /^(\S+) → (\S+)(?:: ([\s\S]*))?$/.exec(String(desc || ''));
  if (!m) return null;
  return { from: m[1], to: m[2], note: text(m[3]) };
}

function mapCaseEvent(r, ctx) {
  const scope = ctx.scopeOfCase(r.case_id);
  const base = {
    source: 'case_event',
    rowId: String(r.event_id),
    at: isoAt(r.ts),
    actor: actorOf(r.actor, { system: !r.actor }),
    audience: 'internal',
    scope,
    links: {},
  };
  const detail = json(r.detail);
  switch (r.type) {
    case 'status_change': {
      const parts = splitStatusDescription(r.description);
      return item({
        ...base,
        kind: 'status_change',
        title: parts ? `Status: ${parts.from} → ${parts.to}` : 'Status change',
        body: parts ? parts.note : text(r.description),
      });
    }
    case 'notes_updated': {
      const notes = isObject(detail) && typeof detail.notes === 'string' ? detail.notes : null;
      return item({
        ...base,
        kind: 'notes_revision',
        title: notes === '' ? 'Case notes cleared' : 'Case notes edited',
        body: notes === '' ? null : notes,
      });
    }
    case 'objection_logged': {
      const category = String(r.description || '').replace(/^Objection logged:\s*/, '');
      return item({
        ...base,
        kind: 'objection',
        title: 'Objection (since removed)',
        body: text(category),
      });
    }
    case 'follow_up_completed':
      return item({
        ...base,
        kind: 'followup_completed',
        title: 'Follow-up completed',
        body: text(String(r.description || '').replace(/^Follow-up completed:?\s*/, '')),
      });
    case 'voice_handoff': {
      const summary = isObject(detail) && typeof detail.callSummary === 'string' ? detail.callSummary : null;
      return item({
        ...base,
        kind: 'voice_handoff',
        title: EVENT_LABEL.voice_handoff,
        body: text(summary) ?? text(r.description),
        links: r.source_call_id ? { callId: String(r.source_call_id) } : {},
      });
    }
    case 'note_added':
      return item({ ...base, kind: 'note', title: 'Note', body: text(r.description) });
    default:
      return item({
        ...base,
        kind: String(r.type),
        title: EVENT_LABEL[r.type] || String(r.type),
        body: text(r.description),
      });
  }
}

/**
 * Objection rows are the record; the objection_logged event is a duplicate of
 * one unless that row was later removed. An event is an orphan when no row of
 * the same case has its category and a created_at within OBJECTION_MATCH_MS.
 * Each row absorbs at most one event.
 */
function objectionOrphanFilter(objectionRows) {
  const pool = objectionRows.map((o) => ({
    caseId: String(o.case_id),
    category: String(o.category),
    t: new Date(isoAt(o.created_at) || 0).getTime(),
    used: false,
  }));
  return (eventRow) => {
    const category = String(eventRow.description || '').replace(/^Objection logged:\s*/, '');
    const t = new Date(isoAt(eventRow.ts) || 0).getTime();
    const hit = pool.find(
      (o) => !o.used && o.caseId === String(eventRow.case_id) && o.category === category && Math.abs(o.t - t) <= OBJECTION_MATCH_MS
    );
    if (hit) {
      hit.used = true;
      return false;
    }
    return true;
  };
}

// ── single-row mappers (AT-2 re-maps one row with these, see activityChart.js) ─

function mapObjectionRow(r, scope) {
  return item({
    source: 'objection',
    rowId: String(r.objection_id),
    kind: 'objection',
    at: isoAt(r.logged_at),
    actor: { display: 'Not recorded', email: null, system: false },
    audience: 'internal',
    title: `Objection: ${r.category}`,
    body: [text(r.note), text(r.patient_words) ? `Patient said: “${r.patient_words}”` : null].filter(Boolean).join('\n') || null,
    scope,
  });
}

function mapFollowupSkippedRow(r, scope) {
  return item({
    source: 'followup',
    rowId: String(r.followup_id),
    kind: 'followup_skipped',
    at: isoAt(r.completed_at),
    actor: actorOf(r.completed_by),
    audience: 'internal',
    title: 'Follow-up skipped',
    body: text(r.outcome_note) ?? text(r.talking_point),
    scope,
  });
}

/** One checkout handoff row → its 0–3 feed items. `checkoutScope(caseId)` names the scope. */
function mapCheckoutRow(r, checkoutScope) {
  const items = [];
  const links = { handoffId: String(r.handoff_id) };
  if (r.status === 'nothing_needed') {
    items.push(
      item({
        source: 'checkout',
        rowId: `${r.handoff_id}:outcome`,
        kind: 'checkout_outcome',
        at: isoAt(r.outcome_at),
        actor: actorOf(r.outcome_by),
        audience: 'internal',
        title: 'Checkout: nothing needed',
        body: text(r.appointment_note),
        scope: checkoutScope(r.case_id),
        links,
      })
    );
  }
  if (r.status === 'dismissed') {
    items.push(
      item({
        source: 'checkout',
        rowId: `${r.handoff_id}:dismissed`,
        kind: 'checkout_dismissed',
        at: isoAt(r.dismissed_at),
        actor: actorOf(r.dismissed_by),
        audience: 'internal',
        title: 'Checkout card dismissed',
        body: text(r.dismissed_reason),
        scope: checkoutScope(r.case_id),
        links,
      })
    );
  }
  const prior = json(r.reopened_from);
  if (isObject(prior) && typeof prior.outcome === 'string') {
    items.push(
      item({
        source: 'checkout',
        rowId: `${r.handoff_id}:reopened`,
        kind: 'checkout_reopened',
        at: isoAt(prior.reopenedAt) ?? isoAt(prior.outcomeAt),
        actor: { display: 'CareIN', email: null, system: true },
        audience: 'internal',
        title: `Checkout reopened by a later hygiene visit (was: ${String(prior.outcome).replace(/_/g, ' ')})`,
        body: text(prior.appointmentNote),
        scope: checkoutScope(prior.caseId ?? r.case_id),
        links,
      })
    );
  }
  return items;
}

/** Outbound statuses that mean the message actually went out. */
const SENT_STATUSES = Object.freeze(['sent', 'delivered']);

/**
 * tc_messages row → feed item. `pending` (stripped by finalize) marks a message
 * that is not communication that happened yet — an outbound one not sent, or
 * an inbound one not 'received' — so AT-2 never charts it.
 */
const mapMessage = (scopeFor, unlinked) => (r) =>
  item({
    source: 'message',
    rowId: String(r.message_id),
    kind: `${r.channel === 'email' ? 'email' : 'sms'}_${r.direction === 'inbound' ? 'in' : 'out'}`,
    at: isoAt(r.direction === 'outbound' && r.sent_at ? r.sent_at : r.created_at),
    actor:
      r.direction === 'inbound'
        ? { display: 'Patient', email: null, system: false }
        : actorOf(r.sent_by || r.created_by, { system: !(r.sent_by || r.created_by) }),
    audience: 'patient_facing',
    direction: r.direction === 'inbound' ? 'inbound' : 'outbound',
    title: unlinked
      ? `${r.channel === 'email' ? 'Email' : 'Text'} from this number — not linked to this case`
      : r.channel === 'email'
        ? text(r.subject) ?? (r.direction === 'inbound' ? 'Email received' : 'Email sent')
        : r.direction === 'inbound'
          ? 'Text received'
          : r.status === 'queued' || r.status === 'sending'
            ? 'Text sending'
            : 'Text sent',
    body: r.body == null ? null : String(r.body),
    scope: scopeFor(r),
    links: { messageId: String(r.message_id) },
    pending: r.direction === 'inbound' ? r.status !== 'received' : !SENT_STATUSES.includes(String(r.status)),
  });

const MSG_COLS = 'message_id, case_id, direction, channel, body, subject, status, created_by, sent_by, created_at, sent_at';

// ── AT-2: the chart overlay ─────────────────────────────────────────────────

/**
 * Mark the page's items already charted from TC ("On chart", with the
 * CommlogNum), and say for every item whether "Log to chart" applies. Runs on
 * PRE-finalize items, so the classifier sees the helper flags.
 */
async function overlayChart(q, office, items) {
  const ids = items.map((it) => it.id);
  const written = new Map();
  if (ids.length) {
    const res = await q.query(
      'SELECT feed_item_id, commlog_num FROM tc_chart_writes WHERE office_id = $1 AND feed_item_id = ANY($2)',
      [office, ids]
    );
    for (const r of res.rows) written.set(String(r.feed_item_id), Number(r.commlog_num));
  }
  return items.map((it) => {
    const charted = written.has(it.id) ? { ...it, chart: { onChart: true, via: 'tc', commLogNum: written.get(it.id) } } : it;
    return { ...charted, chartable: chartEligibility(charted) };
  });
}

// ── the page ────────────────────────────────────────────────────────────────

/**
 * @param {{ query: Function }} q tenant pool/client
 * @param {object} opts
 * @param {string} opts.office            the header's office (=== req.tcOffice)
 * @param {object} opts.header            the case row the route loaded
 * @param {'case'|'patient'} opts.scope
 * @param {{at: string, id: string}|null} opts.cursor
 * @param {number} opts.limit
 * @param {{ entitled: boolean, store: { calls: Map<string, object> } } | null} opts.voice
 */
async function buildActivityPage(q, { office, header, scope, cursor, limit, voice }) {
  const caseId = String(header.case_id);
  const patNum = header.od_patient_id == null ? null : Number(header.od_patient_id);
  // n+1 from every source: the extra item is how the page knows there is a next one.
  const need = limit + 1;

  // The case set: this case, plus (scope=patient) the same patient's other
  // cases in THIS office. A case without a PatNum has no "same patient".
  let cases = [{ case_id: caseId, notes: header.notes, updated_at: header.updated_at }];
  if (scope === 'patient' && patNum != null) {
    const res = await q.query(
      'SELECT case_id, notes, updated_at FROM tc_cases WHERE office_id = $1 AND od_patient_id = $2',
      [office, patNum]
    );
    const others = res.rows.filter((r) => String(r.case_id) !== caseId);
    cases = cases.concat(others.map((r) => ({ case_id: String(r.case_id), notes: r.notes, updated_at: r.updated_at })));
  }
  const caseIds = cases.map((c) => c.case_id);
  const ctx = {
    scopeOfCase: (id) => (String(id) === caseId ? 'case' : 'patient'),
  };

  const collected = [];
  const take = (items) => {
    for (const it of items) collected.push(it);
  };

  // tc_case_events (+ the objection rows that decide which objection events are orphans)
  const objectionAll = await q.query(
    `SELECT objection_id, case_id, category, created_at FROM tc_case_objections WHERE office_id = $1 AND case_id = ANY($2)${limitClause(SMALL_SOURCE_CAP)}`,
    [office, caseIds]
  );
  const keepEvent = objectionOrphanFilter(objectionAll.rows);
  take(
    await pull(
      async (lim, at) => {
        const params = [office, caseIds];
        const where = keyset('ts', at, params);
        const res = await q.query(
          `SELECT event_id, case_id, ts, type, description, actor, detail, source_call_id FROM tc_case_events WHERE office_id = $1 AND case_id = ANY($2)${where} ORDER BY ts DESC, event_id DESC${limitClause(lim)}`,
          params
        );
        return res.rows;
      },
      (rows) => rows.filter((r) => r.type !== 'objection_logged' || keepEvent(r)).map((r) => mapCaseEvent(r, ctx)),
      cursor,
      need
    )
  );

  // tc_cases.notes — the box as it is now (overwritten in place; pre-AT-0 saves had no actor)
  take(
    cases
      .filter((c) => text(c.notes))
      .map((c) =>
        item({
          source: 'case_notes',
          rowId: c.case_id,
          kind: 'notes_current',
          at: isoAt(c.updated_at),
          actor: { display: 'Not recorded', email: null, system: false },
          audience: 'internal',
          title: 'Case notes (current value)',
          body: String(c.notes),
          scope: ctx.scopeOfCase(c.case_id),
          completeness: 'current_value_only',
        })
      )
      .filter((it) => it.at && afterCursor(it, cursor))
  );

  // tc_case_objections
  take(
    await pull(
      async (lim, at) => {
        const params = [office, caseIds];
        const where = keyset('logged_at', at, params);
        const res = await q.query(
          `SELECT objection_id, case_id, category, note, patient_words, logged_at FROM tc_case_objections WHERE office_id = $1 AND case_id = ANY($2)${where} ORDER BY logged_at DESC, objection_id DESC${limitClause(lim)}`,
          params
        );
        return res.rows;
      },
      (rows) => rows.map((r) => mapObjectionRow(r, ctx.scopeOfCase(r.case_id))),
      cursor,
      need
    )
  );

  // tc_followups — SKIPPED only; a completed one already arrives as its event
  take(
    await pull(
      async (lim, at) => {
        const params = [office, caseIds];
        const where = keyset('completed_at', at, params);
        const res = await q.query(
          `SELECT followup_id, case_id, kind, channel, talking_point, outcome_note, completed_at, completed_by FROM tc_followups WHERE office_id = $1 AND case_id = ANY($2) AND status = 'skipped' AND completed_at IS NOT NULL${where} ORDER BY completed_at DESC, followup_id DESC${limitClause(lim)}`,
          params
        );
        return res.rows;
      },
      (rows) => rows.map((r) => mapFollowupSkippedRow(r, ctx.scopeOfCase(r.case_id))),
      cursor,
      need
    )
  );

  // Hygiene intake — one item at submitted_at; "on chart" when that visit's
  // hygiene writes reached Open Dental (a Written staged write).
  const chartedVisitDates = new Set();
  if (patNum != null) {
    const visits = await q.query(
      `SELECT visit_id, visit_date FROM hyg_visit WHERE office = $1 AND pat_num = $2${limitClause(SMALL_SOURCE_CAP)}`,
      [office, patNum]
    );
    if (visits.rows.length) {
      const written = await q.query(
        `SELECT visit_id FROM hyg_staged_write WHERE office = $1 AND visit_id = ANY($2) AND state = 'Written'${limitClause(SMALL_SOURCE_CAP)}`,
        [office, visits.rows.map((v) => v.visit_id)]
      );
      const writtenIds = new Set(written.rows.map((w) => String(w.visit_id)));
      for (const v of visits.rows) {
        if (writtenIds.has(String(v.visit_id))) chartedVisitDates.add(String(isoAt(v.visit_date) || v.visit_date).slice(0, 10));
      }
    }
  }
  take(
    await pull(
      async (lim, at) => {
        const params = [office, caseIds];
        const where = keyset('submitted_at', at, params);
        const res = await q.query(
          `SELECT intake_id, case_id, submitted_by, submitted_by_name, submitted_at, visit_date, chief_concern, hygienist_recommendation FROM tc_hygiene_intakes WHERE office_id = $1 AND case_id = ANY($2)${where} ORDER BY submitted_at DESC, intake_id DESC${limitClause(lim)}`,
          params
        );
        return res.rows;
      },
      (rows) =>
        rows.map((r) => {
          const day = r.visit_date ? String(isoAt(r.visit_date) || r.visit_date).slice(0, 10) : null;
          const charted = day != null && chartedVisitDates.has(day);
          return item({
            source: 'hygiene_intake',
            rowId: String(r.intake_id),
            kind: 'hygiene_intake',
            at: isoAt(r.submitted_at),
            actor: actorOf(r.submitted_by, { display: text(r.submitted_by_name) }),
            audience: 'internal',
            title: 'Hygiene handoff',
            body:
              [
                text(r.chief_concern) ? `Chief concern: ${r.chief_concern}` : null,
                text(r.hygienist_recommendation) ? `Recommendation: ${r.hygienist_recommendation}` : null,
              ]
                .filter(Boolean)
                .join('\n') || null,
            scope: ctx.scopeOfCase(r.case_id),
            chart: charted ? { onChart: true, via: 'hygiene' } : NO_CHART,
          });
        }),
      cursor,
      need
    )
  );

  // Checkout handoffs, joined by (office, PatNum): only what no case event
  // already says — Nothing needed, Dismissed (with its reason), and the prior
  // answer a reopened card kept. A card tied to ANOTHER case is scope 'patient'.
  if (patNum != null) {
    const res = await q.query(
      `SELECT handoff_id, case_id, status, dismissed_reason, dismissed_by, dismissed_at, outcome_by, outcome_at, appointment_note, reopened_from FROM tc_checkout_handoffs WHERE office_id = $1 AND od_patient_id = $2 ORDER BY updated_at DESC${limitClause(SMALL_SOURCE_CAP)}`,
      [office, patNum]
    );
    const checkoutScope = (cid) => (cid == null || String(cid) === caseId ? 'case' : 'patient');
    const items = res.rows.flatMap((r) => mapCheckoutRow(r, checkoutScope));
    take(items.filter((it) => it.at && afterCursor(it, cursor)));
  }

  // tc_messages — bodies verbatim. Drafts, failed and skipped sends are not
  // communication that happened, so they are excluded. Three keyed reads so
  // each item's `at` is the column its query pages on.
  // mapMessage / MSG_COLS are module-level (AT-2 maps one row with them).
  const byCaseScope = (r) => ctx.scopeOfCase(r.case_id);
  // (a) outbound that went out: paged on sent_at
  take(
    await pull(
      async (lim, at) => {
        const params = [office, caseIds, ['sent', 'delivered']];
        const where = keyset('sent_at', at, params);
        const res = await q.query(
          `SELECT ${MSG_COLS} FROM tc_messages WHERE office_id = $1 AND case_id = ANY($2) AND direction = 'outbound' AND status = ANY($3) AND sent_at IS NOT NULL${where} ORDER BY sent_at DESC, message_id DESC${limitClause(lim)}`,
          params
        );
        return res.rows;
      },
      (rows) => rows.map(mapMessage(byCaseScope, false)),
      cursor,
      need
    )
  );
  // (b) outbound still going out, and inbound received: paged on created_at
  take(
    await pull(
      async (lim, at) => {
        const params = [office, caseIds, ['queued', 'sending', 'received']];
        const where = keyset('created_at', at, params);
        const res = await q.query(
          `SELECT ${MSG_COLS} FROM tc_messages WHERE office_id = $1 AND case_id = ANY($2) AND status = ANY($3)${where} ORDER BY created_at DESC, message_id DESC${limitClause(lim)}`,
          params
        );
        return res.rows;
      },
      // A row marked 'sent' with no sent_at cannot reach (a); one in (b) is never 'sent'.
      (rows) => rows.map(mapMessage(byCaseScope, false)),
      cursor,
      need
    )
  );
  // (c) inbound for the case's phone / email in this office that no case claimed
  const unlinkedAddresses = [
    ['sms', normalizePhone(header.phone)],
    ['email', normalizeEmail(header.email)],
  ].filter(([, a]) => a);
  for (const [channel, address] of unlinkedAddresses) {
    take(
      await pull(
        async (lim, at) => {
          const params = [office, channel, address];
          const where = keyset('created_at', at, params);
          const res = await q.query(
            `SELECT ${MSG_COLS} FROM tc_messages WHERE office_id = $1 AND direction = 'inbound' AND status = 'received' AND case_id IS NULL AND channel = $2 AND from_address = $3${where} ORDER BY created_at DESC, message_id DESC${limitClause(lim)}`,
            params
          );
          return res.rows;
        },
        (rows) => rows.map((r) => ({ ...mapMessage(() => 'patient', true)(r), alwaysShow: true })),
        cursor,
        need
      )
    );
  }

  // tc_communications — the legacy email log: a subject, never a body (none exists)
  take(
    await pull(
      async (lim, at) => {
        const params = [office, caseIds];
        const where = keyset('sent_at', at, params);
        const res = await q.query(
          `SELECT comm_id, case_id, template_name, sender, sender_name, subject, status, sent_at FROM tc_communications WHERE office_id = $1 AND case_id = ANY($2) AND sent_at IS NOT NULL${where} ORDER BY sent_at DESC, comm_id DESC${limitClause(lim)}`,
          params
        );
        return res.rows;
      },
      (rows) =>
        rows.map((r) =>
          item({
            source: 'email_log',
            rowId: String(r.comm_id),
            kind: 'email_out',
            at: isoAt(r.sent_at),
            actor: actorOf(r.sender, { display: text(r.sender_name) }),
            audience: 'patient_facing',
            direction: 'outbound',
            title: text(r.subject) ?? text(r.template_name) ?? 'Email sent',
            body: null,
            scope: ctx.scopeOfCase(r.case_id),
          })
        ),
      cursor,
      need
    )
  );

  // Referral events — through tc_referrals.tc_case_id (and, scope=patient, PatNum)
  const referralRows = [];
  {
    const res = await q.query(
      `SELECT referral_id, tc_case_id, specialty FROM tc_referrals WHERE office_id = $1 AND tc_case_id = ANY($2)${limitClause(SMALL_SOURCE_CAP)}`,
      [office, caseIds]
    );
    for (const r of res.rows) referralRows.push(r);
    if (scope === 'patient' && patNum != null) {
      const byPat = await q.query(
        `SELECT referral_id, tc_case_id, specialty FROM tc_referrals WHERE office_id = $1 AND od_patient_id = $2${limitClause(SMALL_SOURCE_CAP)}`,
        [office, patNum]
      );
      const seen = new Set(referralRows.map((r) => String(r.referral_id)));
      for (const r of byPat.rows) if (!seen.has(String(r.referral_id))) referralRows.push(r);
    }
  }
  if (referralRows.length) {
    const refById = new Map(referralRows.map((r) => [String(r.referral_id), r]));
    take(
      await pull(
        async (lim, at) => {
          const params = [office, [...refById.keys()]];
          const where = keyset('at', at, params);
          const res = await q.query(
            `SELECT event_id, referral_id, from_status, to_status, actor, at, note, verb, recipient_address, correspondence_direction, correspondence_party, correspondence_channel, chart_note_milestone, chart_note_commlog_num, letter_snapshot FROM tc_referral_events WHERE office_id = $1 AND referral_id = ANY($2)${where} ORDER BY at DESC, event_id DESC${limitClause(lim)}`,
            params
          );
          return res.rows;
        },
        (rows) => rows.map((r) => mapReferralEvent(r, refById.get(String(r.referral_id)), caseId)),
        cursor,
        need
      )
    );
  }

  // Pre-auths: the record as it is now, plus its append-only history (AT-0)
  const preauths = [];
  {
    const res = await q.query(
      `SELECT preauth_id, case_id, preauth_type, description, insurance_carrier, status, submitted_date, decision_date, reference_number, notes, updated_at FROM tc_preauth_cases WHERE office_id = $1 AND case_id = ANY($2)${limitClause(SMALL_SOURCE_CAP)}`,
      [office, caseIds]
    );
    for (const r of res.rows) preauths.push(r);
    if (scope === 'patient' && patNum != null) {
      const byPat = await q.query(
        `SELECT preauth_id, case_id, preauth_type, description, insurance_carrier, status, submitted_date, decision_date, reference_number, notes, updated_at FROM tc_preauth_cases WHERE office_id = $1 AND od_patient_id = $2${limitClause(SMALL_SOURCE_CAP)}`,
        [office, patNum]
      );
      const seen = new Set(preauths.map((r) => String(r.preauth_id)));
      for (const r of byPat.rows) if (!seen.has(String(r.preauth_id))) preauths.push(r);
    }
  }
  const preauthScope = (p) => (p && p.case_id != null && String(p.case_id) === caseId ? 'case' : 'patient');
  take(
    preauths
      .map((p) =>
        item({
          source: 'preauth',
          rowId: `${p.preauth_id}:current`,
          kind: 'preauth_current',
          at: isoAt(p.updated_at),
          actor: { display: 'Not recorded', email: null, system: false },
          audience: 'internal',
          title: `Pre-auth${text(p.preauth_type) ? ` (${p.preauth_type})` : ''}: ${String(p.status || '').replace(/_/g, ' ')} (current value)`,
          body:
            [
              text(p.insurance_carrier) ? `Carrier: ${p.insurance_carrier}` : null,
              text(p.description),
              text(p.reference_number) ? `Reference: ${p.reference_number}` : null,
              text(p.notes),
            ]
              .filter(Boolean)
              .join('\n') || null,
          scope: preauthScope(p),
          links: { preauthId: String(p.preauth_id) },
          completeness: 'current_value_only',
        })
      )
      .filter((it) => it.at && afterCursor(it, cursor))
  );
  if (preauths.length) {
    const paById = new Map(preauths.map((p) => [String(p.preauth_id), p]));
    take(
      await pull(
        async (lim, at) => {
          const params = [office, [...paById.keys()]];
          const where = keyset('ts', at, params);
          const res = await q.query(
            `SELECT event_id, preauth_id, ts, actor, type, changes FROM tc_preauth_events WHERE office_id = $1 AND preauth_id = ANY($2)${where} ORDER BY ts DESC, event_id DESC${limitClause(lim)}`,
            params
          );
          return res.rows;
        },
        (rows) => rows.map((r) => mapPreauthEvent(r, preauthScope(paById.get(String(r.preauth_id))))),
        cursor,
        need
      )
    );
  }

  // tc_contact_consent — overwritten in place, so the current state only
  {
    const addresses = [
      ['sms', normalizePhone(header.phone)],
      ['email', normalizeEmail(header.email)],
    ].filter(([, a]) => a);
    for (const [channel, address] of addresses) {
      const res = await q.query(
        `SELECT consent_id, channel, address, state, source, note, updated_by, updated_at FROM tc_contact_consent WHERE office_id = $1 AND channel = $2 AND address = $3${limitClause(10)}`,
        [office, channel, address]
      );
      take(
        res.rows
          .map((r) =>
            item({
              source: 'consent',
              rowId: String(r.consent_id),
              kind: 'consent',
              at: isoAt(r.updated_at),
              actor: actorOf(r.updated_by),
              audience: 'internal',
              title: `${channel === 'email' ? 'Email' : 'Text'} consent: ${String(r.state).replace(/_/g, ' ')} (current value)`,
              body: text(r.note),
              scope: 'case',
              completeness: 'current_value_only',
            })
          )
          .filter((it) => it.at && afterCursor(it, cursor))
      );
    }
  }

  // Voice calls — in-memory store, filtered and merged in JS.
  if (voice && voice.entitled && voice.store) {
    // EVERY handoff link on the case set, not just this page's events: a call
    // is placed by its own call_date, which need not sit on the page its
    // handoff event does.
    const linked = await q.query(
      `SELECT event_id, case_id, source_call_id FROM tc_case_events WHERE office_id = $1 AND case_id = ANY($2) AND source_call_id IS NOT NULL${limitClause(SMALL_SOURCE_CAP)}`,
      [office, caseIds]
    );
    take(
      voiceItems({ office, caseId, caseIds, patNum, eventRows: linked.rows, store: voice.store }).filter((it) =>
        afterCursor(it, cursor)
      )
    );
  }

  // Merge, dedupe by id (a widened re-pull can return a row twice), take n.
  const byId = new Map();
  for (const it of collected) if (it.at && !byId.has(it.id)) byId.set(it.id, it);
  let merged = [...byId.values()];
  // scope=case shows this case's items, plus inbound from the case's own
  // number/address that no case claimed (labelled "not linked to this case").
  if (scope === 'case') merged = merged.filter((it) => it.scope === 'case' || it.alwaysShow);
  merged.sort(compareDesc);
  const page = merged.slice(0, limit);
  const hasMore = merged.length > limit;
  // AT-2: "On chart" for items charted from TC, and whether "Log to chart" applies.
  const charted = await overlayChart(q, office, page);
  return {
    items: charted.map(finalize),
    nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null,
  };
}

// ── referral events ─────────────────────────────────────────────────────────

const REFERRAL_KIND = Object.freeze({
  send: 'referral_sent',
  send_conflict: 'referral_sent',
  send_failed: 'referral_send_failed',
  patient_email_sent: 'referral_patient_email',
  patient_email_skipped: 'referral_patient_email_skipped',
  patient_email_failed: 'referral_patient_email_failed',
  correspondence: 'correspondence',
  chart_note_written: 'chart_note',
});

const WITHHELD_LABEL = Object.freeze({
  date_of_birth: 'date of birth',
  patient_contact: 'patient contact',
  insurance: 'insurance',
});

function mapReferralEvent(r, referral, caseId) {
  const verb = r.verb ? String(r.verb) : null;
  const scope = referral && referral.tc_case_id != null && String(referral.tc_case_id) === caseId ? 'case' : 'patient';
  const specialty = referral && text(referral.specialty) ? ` (${referral.specialty})` : '';
  const base = {
    source: 'referral_event',
    rowId: String(r.event_id),
    at: isoAt(r.at),
    actor: actorOf(r.actor, { system: !r.actor }),
    audience: 'internal',
    scope,
    links: { referralId: String(r.referral_id) },
  };
  const snap = json(r.letter_snapshot);

  if (verb === 'send' || verb === 'send_conflict' || verb === 'patient_email_sent') {
    const toPatient = verb === 'patient_email_sent';
    const label = toPatient ? `Referral email to the patient${specialty}` : `Referral letter sent${specialty}`;
    if (isObject(snap) && typeof snap.text === 'string') {
      const withheld = Array.isArray(snap.withheld) ? snap.withheld.map((w) => WITHHELD_LABEL[w] || String(w)) : [];
      return item({
        ...base,
        kind: REFERRAL_KIND[verb],
        audience: toPatient ? 'patient_facing' : 'external',
        direction: 'outbound',
        title: label,
        body: [
          typeof snap.subject === 'string' && snap.subject ? `Subject: ${snap.subject}` : null,
          snap.text,
          withheld.length ? `(Not stored with this copy: ${withheld.join(', ')}.)` : null,
        ]
          .filter(Boolean)
          .join('\n\n'),
      });
    }
    // Pre-AT-0: what was sent was never kept. Say so; never re-render today's fields.
    return item({
      ...base,
      kind: REFERRAL_KIND[verb],
      audience: toPatient ? 'patient_facing' : 'external',
      direction: 'outbound',
      title: `${label} — letter as sent was not stored`,
      body: text(r.note),
    });
  }

  if (verb === 'correspondence') {
    const party = r.correspondence_party === 'patient' ? 'the patient' : 'the specialist';
    // The column says which way it went: 'from' the party or 'to' them.
    const inbound = r.correspondence_direction === 'from';
    const dir = inbound ? 'from' : 'to';
    return item({
      ...base,
      kind: 'correspondence',
      audience: r.correspondence_party === 'patient' ? 'patient_facing' : 'external',
      direction: inbound ? 'inbound' : 'outbound',
      title: `Referral correspondence ${dir} ${party}${r.correspondence_channel ? ` (${r.correspondence_channel})` : ''}`,
      body: text(r.note),
    });
  }

  if (verb === 'chart_note_written') {
    const commLogNum = r.chart_note_commlog_num == null ? null : Number(r.chart_note_commlog_num);
    return item({
      ...base,
      kind: 'chart_note',
      title: `Referral chart note written${r.chart_note_milestone ? ` (${r.chart_note_milestone})` : ''}`,
      body: text(r.note),
      chart: commLogNum != null ? { onChart: true, via: 'referral', commLogNum } : { onChart: true, via: 'referral' },
    });
  }

  const transition =
    r.from_status && r.to_status && r.from_status !== r.to_status
      ? `: ${String(r.from_status).replace(/_/g, ' ')} → ${String(r.to_status).replace(/_/g, ' ')}`
      : '';
  return item({
    ...base,
    kind: REFERRAL_KIND[verb] || `referral_${verb || 'status'}`,
    title: `Referral ${verb ? verb.replace(/_/g, ' ') : 'status change'}${specialty}${transition}`,
    body: text(r.note),
  });
}

// ── pre-auth history ────────────────────────────────────────────────────────

const PREAUTH_TITLE = Object.freeze({
  created: 'Pre-auth created',
  updated: 'Pre-auth edited',
  status_change: 'Pre-auth status changed',
  deleted: 'Pre-auth deleted',
});

function fmtValue(v) {
  if (v == null || v === '') return '(blank)';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function mapPreauthEvent(r, scope) {
  const changes = json(r.changes);
  const lines = isObject(changes)
    ? Object.entries(changes)
        .filter(([, c]) => isObject(c))
        .map(([field, c]) =>
          r.type === 'created'
            ? `${field}: ${fmtValue(c.to)}`
            : r.type === 'deleted'
              ? `${field} was ${fmtValue(c.from)}`
              : `${field}: ${fmtValue(c.from)} → ${fmtValue(c.to)}`
        )
    : [];
  return item({
    source: 'preauth',
    rowId: String(r.event_id),
    kind: `preauth_${r.type}`,
    at: isoAt(r.ts),
    actor: actorOf(r.actor),
    audience: 'internal',
    title: PREAUTH_TITLE[r.type] || 'Pre-auth change',
    body: lines.length ? lines.join('\n') : null,
    scope,
    links: { preauthId: String(r.preauth_id) },
  });
}

// ── voice ───────────────────────────────────────────────────────────────────

/**
 * Calls for this case: by call.tc_case_id, by a case event's source_call_id, or
 * (scope 'patient') by PatNum + office. A call whose derived office is not the
 * case's office is dropped silently — wherever it was linked from. A pruned
 * stub is reachable only through a handoff event and shows as a placeholder.
 */
function voiceItems({ office, caseId, caseIds, patNum, eventRows, store }) {
  const caseSet = new Set(caseIds.map(String));
  const viaEvent = new Map(); // callId → case id of the event that names it
  for (const e of eventRows) {
    if (e.source_call_id) viaEvent.set(String(e.source_call_id), String(e.case_id));
  }
  const out = [];
  const seen = new Set();
  const consider = (call, linkedCase) => {
    if (!call || seen.has(String(call.id))) return;
    seen.add(String(call.id));
    const stub = retention.isStub(call);
    const callOffice = stub ? call.office : getOfficeForCall(call);
    if (callOffice !== office) return; // office mismatch: dropped silently
    const scope = linkedCase === caseId ? 'case' : 'patient';
    const at = isoAt(call.call_date);
    if (!at) return;
    if (stub) {
      out.push(
        item({
          source: 'voice_call',
          rowId: String(call.id),
          kind: 'call',
          at,
          actor: { display: 'Phone call', email: null, system: true },
          audience: 'patient_facing',
          title: 'Call record pruned; summary kept on handoff',
          body: null,
          scope,
          links: { callId: String(call.id) },
        })
      );
      return;
    }
    const commLogNum = call.od_commlog_num == null ? null : Number(call.od_commlog_num);
    const minutes = Number(call.duration_seconds) > 0 ? ` · ${Math.max(1, Math.round(Number(call.duration_seconds) / 60))} min` : '';
    out.push(
      item({
        source: 'voice_call',
        rowId: String(call.id),
        kind: 'call',
        at,
        actor: { display: text(call.handler_name) || (call.source === 'retell' ? 'CareIN voice agent' : 'Phone call'), email: null, system: call.source === 'retell' },
        audience: 'patient_facing',
        direction: call.direction === 'outbound' ? 'outbound' : 'inbound',
        title: `Phone call${minutes}`,
        body: text(call.summary),
        scope,
        links: { callId: String(call.id) },
        chart: commLogNum != null ? { onChart: true, via: 'voice', commLogNum } : NO_CHART,
      })
    );
  };

  for (const [callId, linkedCase] of viaEvent) consider(store.calls.get(callId), linkedCase);
  for (const call of store.calls.values()) {
    if (!call || retention.isStub(call) || seen.has(String(call.id))) continue;
    if (call.link_role === 'duplicate_leg') continue; // the twin's primary leg carries it
    if (call.tc_case_id != null && caseSet.has(String(call.tc_case_id))) {
      consider(call, String(call.tc_case_id));
    } else if (
      patNum != null &&
      call.od_patient_id != null &&
      Number(call.od_patient_id) === patNum &&
      call.od_patient_office === office
    ) {
      consider(call, null); // PatNum-only ⇒ scope 'patient'
    }
  }
  return out;
}

module.exports = {
  SOURCES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  buildActivityPage,
  encodeCursor,
  decodeCursor,
  splitStatusDescription,
  // AT-2: the single-row mappers and helpers the chart writer re-maps a row with.
  mapCaseEvent,
  mapObjectionRow,
  mapFollowupSkippedRow,
  mapCheckoutRow,
  mapMessage,
  MSG_COLS,
  isoAt,
  json,
  isObject,
  text,
};
