'use strict';

/**
 * On-demand transcription ledger (Mango slice M4).
 *
 * Every click of "Transcribe & Summarize" lands here — completed, deduped, refused for
 * budget, refused for a missing recording, or failed. Two jobs:
 *
 *  1. OPERATIONAL AUDIT. The platform audit_log (platform/audit.js) records the HIPAA
 *     facts — actor, action, resource, result — but its schema has no room for the
 *     outcome, the office, or the minutes billed. Those live here, in a bounded
 *     most-recent list, so "who transcribed what, and what did it cost" is answerable
 *     without a DB query. The HIPAA row is still written; this does not replace it.
 *
 *  2. USAGE & COSTS. Per-office counts for today and a running month total, which is what
 *     the dashboard's Mango transcription card reads. transcriptionService.getStats()
 *     only knows process-lifetime totals — those reset on every container restart, so
 *     they cannot answer "what has this month cost".
 *
 * NO PHI. Call ids, office keys, actor emails, outcomes, minutes. Never transcript text,
 * never a caller number, never a patient name.
 *
 * Accounted in the offices' local day (America/Chicago), the SAME boundary the
 * transcription budget breaker rolls on — a ledger on UTC days would disagree with the
 * budget it is reporting against for the 5-7pm block every single evening.
 */

const { DurableState } = require('./durableState');

/** Must match transcriptionService's BUDGET_TIMEZONE so the day boundaries agree. */
const LEDGER_TIMEZONE = process.env.TRANSCRIPTION_BUDGET_TZ || 'America/Chicago';

/** How many individual attempts to retain. Bounded so the doc cannot grow without limit. */
const MAX_RECENT = 200;

/** Azure AI Speech standard (S0) list rate ≈ $1 per audio hour. */
const SPEECH_COST_PER_MINUTE = 1 / 60;

/**
 * Every outcome the on-demand endpoint can produce. A closed set — each attempt lands in
 * exactly one bucket, so the per-office numbers reconcile against the attempt count.
 */
const OUTCOMES = [
  'completed',              // transcribed + summarized + persisted
  'exists',                 // already had a transcript; dedup guard, zero spend
  'in_progress',            // another click for this call was already running
  'budget_exhausted',       // daily audio-minute breaker was spent
  'recording_not_ready',    // Mango has not published the recording yet
  'recording_unavailable',  // Mango no longer serves a recording for this call
  'no_speech',              // Azure Speech returned no text (billed, nothing to store)
  'unavailable',            // Azure Speech is not configured in this environment
  'error',                  // anything else
];

const round3 = (n) => Number(Number(n).toFixed(3));
const round4 = (n) => Number(Number(n).toFixed(4));

function blankOffice() {
  const o = { attempts: 0, minutes: 0 };
  for (const k of OUTCOMES) o[k] = 0;
  return o;
}

function blankMonth() {
  return { transcriptions: 0, minutes: 0, speech_cost: 0, summary_cost: 0 };
}

const state = new DurableState('mango_ondemand_transcription.json', {
  day_key: null,
  by_office: {},
  month_key: null,
  month: blankMonth(),
  recent: [],
});

/** 'YYYY-MM-DD' in the ledger timezone (en-CA formats as YYYY-MM-DD). */
function dayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: LEDGER_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 'YYYY-MM' in the ledger timezone. */
function monthKey(now = new Date()) {
  return dayKey(now).slice(0, 7);
}

/**
 * Read the doc with the day/month buckets rolled forward if the calendar moved. Pure —
 * the roll is only PERSISTED when something is actually recorded, so a read on a new day
 * never writes.
 */
function rolled(now = new Date()) {
  const doc = state.read();
  const today = dayKey(now);
  const thisMonth = monthKey(now);

  const byOffice = doc.day_key === today && doc.by_office && typeof doc.by_office === 'object'
    ? doc.by_office
    : {};
  const month = doc.month_key === thisMonth && doc.month && typeof doc.month === 'object'
    ? { ...blankMonth(), ...doc.month }
    : blankMonth();

  return {
    day_key: today,
    by_office: byOffice,
    month_key: thisMonth,
    month,
    recent: Array.isArray(doc.recent) ? doc.recent : [],
  };
}

/**
 * Record one attempt. Best-effort: the ledger is accounting, never a gate — a write
 * failure must not turn a successful transcription into an error for the user.
 *
 * @param {{
 *   callId: string,
 *   office?: string|null,
 *   actor?: {name?: string|null, email?: string|null}|null,
 *   outcome: string,
 *   minutes?: number,
 *   summaryCost?: number,
 *   now?: Date,
 * }} entry
 */
function record(entry) {
  try {
    const now = entry.now || new Date();
    const outcome = OUTCOMES.includes(entry.outcome) ? entry.outcome : 'error';
    const office = entry.office || 'unknown';
    // Minutes are only ever charged when audio actually reached Azure Speech.
    const minutes = Number.isFinite(entry.minutes) && entry.minutes > 0 ? entry.minutes : 0;
    const summaryCost = Number.isFinite(entry.summaryCost) && entry.summaryCost > 0 ? entry.summaryCost : 0;

    const doc = rolled(now);

    const oc = doc.by_office[office] || (doc.by_office[office] = blankOffice());
    oc.attempts++;
    oc[outcome]++;
    oc.minutes = round3(oc.minutes + minutes);

    if (outcome === 'completed') doc.month.transcriptions++;
    doc.month.minutes = round3(doc.month.minutes + minutes);
    doc.month.speech_cost = round4(doc.month.speech_cost + minutes * SPEECH_COST_PER_MINUTE);
    doc.month.summary_cost = round4(doc.month.summary_cost + summaryCost);

    const recent = [
      {
        call_id: entry.callId,
        office,
        actor: (entry.actor && (entry.actor.email || entry.actor.name)) || null,
        outcome,
        minutes: round3(minutes),
        at: now.toISOString(),
      },
      ...doc.recent,
    ].slice(0, MAX_RECENT);

    state.write({ ...doc, recent });
  } catch (e) {
    console.error('[M4 ledger] failed to record attempt (accounting only, not a gate):', e.message);
  }
}

/** Today's per-office attempt counts, in the ledger timezone. */
function today(now = new Date()) {
  const doc = rolled(now);
  const byOffice = doc.by_office;
  const total = Object.values(byOffice).reduce((n, o) => n + (o.attempts || 0), 0);
  const completed = Object.values(byOffice).reduce((n, o) => n + (o.completed || 0), 0);
  const minutes = round3(Object.values(byOffice).reduce((n, o) => n + (o.minutes || 0), 0));
  return { day_key: doc.day_key, timezone: LEDGER_TIMEZONE, total, completed, minutes, by_office: byOffice };
}

/** This month's on-demand totals + estimated spend at list rates. */
function month(now = new Date()) {
  const doc = rolled(now);
  return {
    month_key: doc.month_key,
    timezone: LEDGER_TIMEZONE,
    transcriptions: doc.month.transcriptions,
    minutes: round3(doc.month.minutes),
    speech_cost: round4(doc.month.speech_cost),
    summary_cost: round4(doc.month.summary_cost),
    estimated_cost: round4(doc.month.speech_cost + doc.month.summary_cost),
  };
}

/** The most recent attempts (newest first) — the operational audit trail. */
function recent(limit = 50) {
  return rolled().recent.slice(0, Math.max(0, limit));
}

/** Clear all stored ledger state (tests only). */
function _reset() {
  state.reset();
  state.write({ day_key: null, by_office: {}, month_key: null, month: blankMonth(), recent: [] });
  state.reset();
}

module.exports = {
  record,
  today,
  month,
  recent,
  OUTCOMES,
  SPEECH_COST_PER_MINUTE,
  LEDGER_TIMEZONE,
  MAX_RECENT,
  _state: state,
  _reset,
};
