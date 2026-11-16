'use strict';

/**
 * AT-2: which TC activity-feed items may be written to the Open Dental chart
 * ("Log to chart"). PURE — no I/O, no requires — so the feed (which decides
 * whether to draw the button) and the write route (which decides whether to
 * write) apply the SAME rule. The route re-reads the item's own row first and
 * runs this on the result, so the client's copy of an item decides nothing.
 *
 * Chart-worthy, and only these — a person's own words, or what was actually
 * said to or by the patient:
 *
 *   case_event  note_added, contact_attempt, status_change (its note; the lost
 *               reason is added to the default text), follow_up_completed
 *               (its outcome), notes_updated (AT-0's immutable revision — the
 *               chartable form of the case notes box)
 *   objection   the objection row's note INCLUDING the patient's verbatim words
 *   followup    a skipped follow-up's outcome note
 *   checkout    the "nothing needed" outcome and the dismiss reason
 *   message     SMS / email bodies that went out, and inbound replies on this case
 *
 * Refused, each with its own code (all 409 at the route):
 *
 *   ALREADY_ON_CHART                 written before (or reached the chart its own way)
 *   NOT_CHARTABLE_CURRENT_VALUE      overwritten in place: no immutable text to point at
 *   NOT_CHARTABLE_CHARTED_ELSEWHERE  voice / referral / hygiene: charted their own way
 *   NOT_CHARTABLE_SYSTEM             system, nurture and Open Dental sync events
 *   NOT_CHARTABLE_OTHER_CASE         another case's item, or an inbound not linked to this case
 *   NOT_CHARTABLE_NOT_SENT           a message still queued / sending
 *   NOT_CHARTABLE_KIND               anything else (case created, pre-auth history, email log, …)
 *   NOT_CHARTABLE_EMPTY              nothing to write (no note text)
 *
 * Drafts and failed sends never reach the feed at all (activityFeed excludes
 * them); the route's own message read refuses them again by status.
 */

/** Feed sources whose notes reach the chart through their own module. */
const CHARTED_ELSEWHERE = Object.freeze(new Set(['voice_call', 'referral_event', 'hygiene_intake']));

/** source → the feed kinds of that source that may be charted. */
const CHARTABLE_KINDS = Object.freeze({
  case_event: Object.freeze(new Set(['note', 'contact_attempt', 'status_change', 'followup_completed', 'notes_revision'])),
  objection: Object.freeze(new Set(['objection'])),
  followup: Object.freeze(new Set(['followup_skipped'])),
  checkout: Object.freeze(new Set(['checkout_outcome', 'checkout_dismissed'])),
  message: Object.freeze(new Set(['sms_out', 'sms_in', 'email_out', 'email_in'])),
});

/** Every refusal code this module can return. */
const REFUSAL_CODES = Object.freeze([
  'ALREADY_ON_CHART',
  'NOT_CHARTABLE_CURRENT_VALUE',
  'NOT_CHARTABLE_CHARTED_ELSEWHERE',
  'NOT_CHARTABLE_SYSTEM',
  'NOT_CHARTABLE_OTHER_CASE',
  'NOT_CHARTABLE_NOT_SENT',
  'NOT_CHARTABLE_KIND',
  'NOT_CHARTABLE_EMPTY',
]);

/**
 * @typedef {{ eligible: true, code: null, reason: null } | { eligible: false, code: string, reason: string }} Chartable
 */

/** @param {string} code @param {string} reason @returns {Chartable} */
function no(code, reason) {
  return { eligible: false, code, reason };
}

const YES = Object.freeze({ eligible: true, code: null, reason: null });

/**
 * May this feed item be charted? Takes the PRE-finalize item (it may carry the
 * feed's helper flags `alwaysShow` — an unlinked inbound — and `pending` — a
 * message not yet sent).
 *
 * @param {{ source: string, kind: string, completeness?: string, scope?: string,
 *           actor?: { system?: boolean }, body?: string|null,
 *           chart?: { onChart?: boolean, via?: string|null },
 *           alwaysShow?: boolean, pending?: boolean }} it
 * @returns {Chartable}
 */
function chartEligibility(it) {
  if (it.chart && it.chart.onChart) {
    return no(
      'ALREADY_ON_CHART',
      it.chart.via === 'tc' ? 'Already on the chart.' : 'Already on the chart through its own note.'
    );
  }
  if (it.completeness === 'current_value_only') {
    return no(
      'NOT_CHARTABLE_CURRENT_VALUE',
      'This shows what the record says now, not a saved note. Chart a saved revision instead.'
    );
  }
  if (CHARTED_ELSEWHERE.has(it.source)) {
    return no('NOT_CHARTABLE_CHARTED_ELSEWHERE', 'Calls, referrals and hygiene notes reach the chart their own way.');
  }
  if (it.actor && it.actor.system) {
    return no('NOT_CHARTABLE_SYSTEM', 'Automatic and system events are not charted.');
  }
  if (it.scope !== 'case' || it.alwaysShow) {
    return no('NOT_CHARTABLE_OTHER_CASE', 'Only this case’s own items can be charted from here.');
  }
  const kinds = Object.prototype.hasOwnProperty.call(CHARTABLE_KINDS, it.source)
    ? CHARTABLE_KINDS[/** @type {keyof typeof CHARTABLE_KINDS} */ (it.source)]
    : null;
  if (!kinds || !kinds.has(it.kind)) {
    return no('NOT_CHARTABLE_KIND', 'This kind of activity is not charted.');
  }
  if (it.pending) {
    return no('NOT_CHARTABLE_NOT_SENT', 'This message has not been sent yet.');
  }
  if (typeof it.body !== 'string' || it.body.trim() === '') {
    return no('NOT_CHARTABLE_EMPTY', 'There is no note text to chart.');
  }
  return YES;
}

module.exports = { chartEligibility, CHARTABLE_KINDS, CHARTED_ELSEWHERE, REFUSAL_CODES };
