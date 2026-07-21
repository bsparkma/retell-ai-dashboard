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
 *   STAGING_URL=https://staging.carein.ai node backend/scripts/inject-staging-mango.cjs
 *
 * Exercises the four cases the Mango slice must handle:
 *   1) confident-match  → od_sync_status 'matched'  (name that resolves to one patient)
 *   2) ambiguous        → od_sync_status 'needs_review' + candidates (shared phone)
 *   3) short call <20s   → transcript-less, no summary (D4); still matched by phone
 *   4) no-recording      → missed/voicemail, no transcript; still ingests + phone-matches
 */
'use strict';

const BASE = process.env.STAGING_URL || 'https://staging.carein.ai';
const nowIso = new Date().toISOString();
const isoAgo = (mins) => new Date(Date.now() - mins * 60 * 1000).toISOString();

// called_number is the office DID (office attribution key). MANGO_LINE_OFFICE is empty
// until Beau supplies real DIDs, so these all fall back to Roland today — that's the
// intended current behaviour and this exercises the fallback path.
const ROLAND_DID = process.env.MANGO_SEED_ROLAND_DID || '+14795550000'; // placeholder DID

const calls = [
  {
    // 1) Confident single match — "Stedi Test 2" is the documented confident name-match
    //    protocol (resolves to one patient). matchAndSetStatus → 'matched' (NO OD write).
    source: 'mango',
    external_id: 'mango_call_seed_confident',
    mango_call_id: 'seed_confident',
    mango_detail_url: 'https://app.mangovoice.com/calls/seed_confident',
    call_date: isoAgo(9),
    caller_number: '+14795551201',
    called_number: ROLAND_DID,
    duration_seconds: 185,
    outcome: 'answered',
    caller_name: 'Stedi Test 2',
    summary: 'Staff took a call from Stedi Test 2 about a balance question. [SYNTHETIC mango confident-match]',
    transcript: 'Staff: Front desk, how can I help? Caller: Hi, this is Stedi Test 2, I have a question about my balance.',
  },
  {
    // 2) Ambiguous — shared phone on >1 patient → needs_review + stored candidates.
    source: 'mango',
    external_id: 'mango_call_seed_ambiguous',
    mango_call_id: 'seed_ambiguous',
    mango_detail_url: 'https://app.mangovoice.com/calls/seed_ambiguous',
    call_date: isoAgo(7),
    caller_number: '+14797394999', // phone shared by >1 patient → ambiguous
    called_number: ROLAND_DID,
    duration_seconds: 140,
    outcome: 'answered',
    caller_name: '',
    summary: 'Caller asked to move a cleaning to next week. [SYNTHETIC mango needs_review]',
    transcript: 'Staff: Thanks for calling. Caller: I need to move my cleaning to next week.',
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
      headers: { 'Content-Type': 'application/json' },
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
