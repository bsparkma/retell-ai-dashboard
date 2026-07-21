/**
 * Seed STAGING with synthetic needs_review calls via SIGNED Retell webhooks.
 *
 * Staging scales to zero and the unified call store is ephemeral: a cold start
 * rebuilds it from the Retell API sync (~1000 real calls) but drops any synthetic
 * calls that aren't in Retell. Re-run this whenever the review pile is empty and
 * you want to exercise the candidates-first Pick Patient flow.
 *
 * Signature scheme mirrors backend/routes/webhooks.js (verify stays ON):
 *   header x-retell-signature = `v=<ms>,d=<hmacSha256(RETELL_API_KEY, rawBody + ms)>`
 *   5-minute replay window → uses Date.now().
 *
 * Inputs are Beau's known-AMBIGUOUS values so the OD match returns >1 candidate
 * → needs_review + stored candidates and NEVER a confident single match (the only
 * path that writes a commlog). No OD write occurs. Run from the admin workstation
 * (staging ingress is IP-allowlisted); the key is injected from Key Vault, never
 * printed:
 *
 *   RETELL_API_KEY=$(az keyvault secret show --vault-name kv-carein-staging \
 *     --name retell-api-key --query value -o tsv) \
 *     node backend/scripts/inject-staging-needs-review.cjs
 */
'use strict';

const crypto = require('crypto');

const KEY = process.env.RETELL_API_KEY;
const BASE = process.env.STAGING_URL || 'https://staging.carein.ai';
if (!KEY) {
  console.error('RETELL_API_KEY not set (inject it from kv-carein-staging — see header).');
  process.exit(1);
}

const now = Date.now();

const calls = [
  {
    call_id: 'wh-staging-needsreview-1',
    from_number: '+14797394999', // phone shared by >1 patient → ambiguous
    start_timestamp: now - 3 * 60 * 1000,
    end_timestamp: now - 3 * 60 * 1000 + 95_000,
    transcript: 'Agent: Thanks for calling. User: Hi, I need to move my cleaning to next week.',
    call_analysis: {
      caller_name: '',
      call_summary: 'Caller asked to reschedule an upcoming cleaning. [SYNTHETIC needs_review test]',
      appointment_booked: false,
    },
  },
  {
    call_id: 'wh-staging-needsreview-2',
    from_number: '+15550100002', // not in OD → falls to name_fuzzy on the ambiguous name
    start_timestamp: now - 2 * 60 * 1000,
    end_timestamp: now - 2 * 60 * 1000 + 60_000,
    transcript: 'Agent: Who am I speaking with? User: This is Stedi Test, I have a billing question.',
    call_analysis: {
      caller_name: 'Stedi Test', // prefix collision → multiple candidates
      call_summary: 'Caller Stedi Test had a billing question. [SYNTHETIC needs_review test]',
      appointment_booked: false,
    },
  },
  {
    call_id: 'wh-staging-needsreview-3',
    from_number: '+14797394999', // phone-ambiguous again, different call
    start_timestamp: now - 1 * 60 * 1000,
    end_timestamp: now - 1 * 60 * 1000 + 70_000,
    transcript: 'Agent: How can I help? User: I think I left something at the office yesterday.',
    call_analysis: {
      caller_name: '',
      call_summary: 'Caller asked about a lost item. [SYNTHETIC needs_review test]',
      appointment_booked: false,
    },
  },
];

function sign(rawBody) {
  const ts = Date.now();
  const d = crypto.createHmac('sha256', KEY).update(rawBody + ts, 'utf8').digest('hex');
  return `v=${ts},d=${d}`;
}

(async () => {
  for (const call of calls) {
    const body = JSON.stringify({ event: 'call_analyzed', call });
    try {
      const res = await fetch(`${BASE}/api/webhooks/retell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-retell-signature': sign(body) },
        body,
      });
      console.log(`${call.call_id}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    } catch (err) {
      console.log(`${call.call_id}: ERROR ${err.message}`);
    }
  }
  console.log('done. needs_review writes NO commlog — confirm in staging logs (🟡 needs_review).');
})();
