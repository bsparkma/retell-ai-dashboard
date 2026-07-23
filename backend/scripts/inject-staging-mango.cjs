/**
 * Seed STAGING with synthetic MANGO-source (staff) calls via the staging-only
 * POST /api/mango/dev/seed endpoint (disabled in production).
 *
 * Companion to inject-staging-needs-review.cjs (which seeds Retell calls via signed
 * webhooks). Mango has no ingest webhook, so this posts raw Mango call shapes to the
 * dev seed endpoint, which runs them through the REAL source-agnostic path
 * (addMangoCalls → matchAndSetStatus). NO Open Dental write occurs (review-then-send).
 *
 * Staging's unified store is ephemeral (scales to zero) — re-run after a cold start /
 * deploy to repopulate the Mango side of the worklist. Run from the admin workstation
 * (staging ingress is IP-allowlisted):
 *
 * The /api/mango/* surface is behind the dashboard auth middleware, so this presents the
 * shared bearer token (DASHBOARD_API_TOKEN), injected from Key Vault and never printed:
 *
 *   DASHBOARD_API_TOKEN=$(az keyvault secret show --vault-name kv-carein-staging \
 *     --name dashboard-api-token --query value -o tsv) \
 *     STAGING_URL=https://staging.carein.ai node backend/scripts/inject-staging-mango.cjs
 *
 * Exercises the four cases the Mango slice must handle:
 *   1) confident-match  → od_sync_status 'matched'  (MangoTest Test / PatNum 12828 via its UNIQUE phone)
 *   2) ambiguous        → od_sync_status 'needs_review' + candidates ("Stedi Test 2" shares a
 *                         phone with "Stedi Test" → always >1 candidate, never confident)
 *   3) short call <20s   → transcript-less, no summary (D4); still matched by phone
 *   4) no-recording      → missed/voicemail, no transcript; still ingests + phone-matches
 */
'use strict';

const BASE = process.env.STAGING_URL || 'https://staging.carein.ai';
const TOKEN = process.env.DASHBOARD_API_TOKEN;
if (!TOKEN) {
  console.error('DASHBOARD_API_TOKEN not set (inject it from kv-carein-staging — see header).');
  process.exit(1);
}
const nowIso = new Date().toISOString();
const isoAgo = (mins) => new Date(Date.now() - mins * 60 * 1000).toISOString();

// called_number is the office DID (office attribution key). Defaults to Roland's real
// line so the synthetics attribute to Roland via MANGO_LINE_OFFICE (not the fallback).
const ROLAND_DID = process.env.MANGO_SEED_ROLAND_DID || '+19185036262'; // Roland Family Dental

// MangoTest fixture (Roland): PatNum 12828 "MangoTest Test". Its primary phone
// +14795554999 is on exactly ONE record (verified read-only), so phone_exact yields a
// single 0.95 match → 'matched'. Carried in the request body per-seed (NOT an env var).
// (11373 "Test" was rejected as a fixture — its number is a shared McGee family phone.)
const CONFIRM_PHONE = '+14795554999';

const calls = [
  {
    // 1) Confident single match — MangoTest Test (PatNum 12828) via its unique phone.
    //    matchByPhoneExact → single patient (0.95) → matchAndSetStatus → 'matched' (NO OD write).
    source: 'mango',
    external_id: 'mango_call_seed_confident',
    mango_call_id: 'seed_confident',
    mango_detail_url: 'https://app.mangovoice.com/calls/seed_confident',
    call_date: isoAgo(9),
    caller_number: CONFIRM_PHONE,
    called_number: ROLAND_DID,
    duration_seconds: 185,
    outcome: 'answered',
    caller_name: 'MangoTest Test',
    summary: 'Staff took a call from MangoTest Test about a balance question. [SYNTHETIC mango confident-match → PatNum 12828]',
    transcript: 'Staff: Front desk, how can I help? Caller: Hi, this is MangoTest Test, I have a question about my balance.',
  },
  {
    // 2) Ambiguous — "Stedi Test 2" shares a phone with "Stedi Test" → >1 candidate →
    //    needs_review + stored candidates. Also the designated resolve target.
    source: 'mango',
    external_id: 'mango_call_seed_ambiguous',
    mango_call_id: 'seed_ambiguous',
    mango_detail_url: 'https://app.mangovoice.com/calls/seed_ambiguous',
    call_date: isoAgo(7),
    caller_number: '+14797394999', // phone shared by >1 patient → ambiguous
    called_number: ROLAND_DID,
    duration_seconds: 140,
    outcome: 'answered',
    caller_name: 'Stedi Test 2',
    summary: 'Caller Stedi Test 2 asked to move a cleaning to next week. [SYNTHETIC mango needs_review]',
    transcript: 'Staff: Thanks for calling. Caller: This is Stedi Test 2, I need to move my cleaning to next week.',
  },
  {
    // 3) Short call under MANGO_SUMMARY_MIN_SECONDS (20s): transcript-less, no summary
    //    (D4 skips the LLM). Still ingests + matches by phone → worklist per D1.
    source: 'mango',
    external_id: 'mango_call_seed_short',
    mango_call_id: 'seed_short',
    mango_detail_url: 'https://app.mangovoice.com/calls/seed_short',
    call_date: isoAgo(5),
    caller_number: '+15550100002', // not in OD → no confident match → needs_review
    called_number: ROLAND_DID,
    duration_seconds: 12,
    outcome: 'answered',
    // no transcript / summary — represents a sub-20s call
  },
  {
    // 4) No recording (missed / voicemail): no transcript. Still ingests + phone-matches.
    source: 'mango',
    external_id: 'mango_call_seed_norecording',
    mango_call_id: 'seed_norecording',
    mango_detail_url: 'https://app.mangovoice.com/calls/seed_norecording',
    call_date: isoAgo(3),
    caller_number: '+15550100003',
    called_number: ROLAND_DID,
    duration_seconds: 0,
    outcome: 'voicemail',
    // no recording, no transcript
  },
];

(async () => {
  const body = JSON.stringify({ calls });
  try {
    const res = await fetch(`${BASE}/api/mango/dev/seed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
      },
      body,
    });
    const text = await res.text();
    console.log(`HTTP ${res.status}: ${text.slice(0, 600)}`);
    if (res.status === 403) {
      console.log('Seed endpoint is production-disabled — confirm this is the STAGING URL.');
    }
  } catch (err) {
    console.log(`ERROR ${err.message}`);
  }
  console.log(`seeded ${calls.length} synthetic Mango calls at ${nowIso}. No OD write occurs (review-then-send).`);
})();
