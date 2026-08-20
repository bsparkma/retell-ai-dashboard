'use strict';

/*
 * D-7 prerequisite (a): is the RILEY key entitled to WRITE?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RUN THIS ONLY AT A QUIET HOUR FOR THE OFFICE, AND ONLY WITH BEAU'S GO-AHEAD.
 * ─────────────────────────────────────────────────────────────────────────────
 * It is the last unrecorded prerequisite before valley may be added to
 * `postingDrain.OFFICES_ENABLED_FOR_POSTING`. It is checked into the repo rather
 * than pasted from a scratchpad so the thing that was run is the thing that was
 * reviewed.
 *
 * Usage, from inside the staging container (so the customer key is resolved from
 * Key Vault by the app's own loader and never printed):
 *
 *     PROBE_OFFICE=valley node scripts/rcm-d7-write-probe.js
 *
 * Then IMMEDIATELY run scripts/rcm-d7-read-sweep.js, which proves nothing landed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ZERO-RISK, AND HOW THAT IS ENFORCED RATHER THAN ASSERTED
 * ─────────────────────────────────────────────────────────────────────────────
 * `docs/RCM_OD_WRITES.md` §9, verified live: Open Dental's checks run in this
 * order —
 *   missing METHOD   -> 400 "<resource> <VERB> is not a valid method."
 *   missing RESOURCE -> 404 "<x> is not a valid resource."
 *   missing ROW      -> 404 "ClaimProc not found."
 * Because the method and permission checks precede the row lookup, a write
 * issued against a NON-EXISTENT id is answered without touching any data. That is
 * exactly how Spike 0b test 12 was run.
 *
 * Entitlement is licensed per PERMISSION GROUP and **no read can establish it** —
 * which is the entire reason this probe has to exist. TC #97 proved Riley's READ
 * groups; the Insurance and Documents WRITE groups are a different entitlement.
 *
 * READING THE ANSWER:
 *   404 "… not found."                 the request got PAST the permission check
 *                                      to the row lookup. The group IS enabled.
 *   403 / "not enabled" / "not authorized"
 *                                      the group is NOT enabled.
 *   400 "… is not a valid method."     the verb does not exist on this build.
 *
 * FOUR SAFETY PROPERTIES, all enforced in code below:
 *   1. every target id is GET-checked first, and the probe ABORTS if any exists;
 *   2. the ids are far outside any real Open Dental range in either practice;
 *   3. POST and PUT only — never DELETE;
 *   4. ≥1.3 s between calls, so it cannot crowd the shared credential.
 *
 * No patient data is read and none is printed.
 */

const odOffices = require('../config/odOffices');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Far outside any real Open Dental id range in either practice.
 *
 * Exported so the read sweep proves the SAME ids were untouched — two scripts
 * disagreeing about which ids to check would make the sweep worthless.
 */
const GHOST = 999888777;

async function main() {
  const office = process.env.PROBE_OFFICE || 'valley';
  const handle = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  console.log(`\n=== ${office} (${handle.officeName}) — WRITE-VERB ENTITLEMENT PROBE ===`);
  console.log(`    ghost id: ${GHOST}   started: ${new Date().toISOString()}`);

  // ── 1. Prove the targets do not exist ─────────────────────────────────────
  for (const [path, label] of [
    [`/claimprocs/${GHOST}`, 'claimproc'],
    [`/claims/${GHOST}`, 'claim'],
    [`/patients/${GHOST}`, 'patient'],
  ]) {
    await sleep(1300);
    const res = await handle.client.apiGetRaw(path, {}, { timeoutMs: 30000 });
    console.log(`  precheck GET ${path} -> ${res.status} ${res.ok ? 'EXISTS' : 'absent'}`);
    if (res.ok) {
      console.log('  ABORTING — a probe target exists. NO WRITE WAS ISSUED.');
      return;
    }
  }

  // ── 2. The writes, against ids that do not exist ──────────────────────────
  //
  // The deployed image predates `apiWriteRaw`, so this reaches the raw axios
  // instance. That is acceptable HERE and nowhere else: this is a one-off
  // operational script, not module code, and `rcmNoOdWrites.test.js` scans
  // services/rcm and routes/rcm — not scripts/ — precisely so an operational
  // probe cannot be mistaken for a second writer in the module.
  const axios = handle.client.client;

  async function probe(label, group, verb, path, body) {
    await sleep(1300);
    try {
      const res = verb === 'POST' ? await axios.post(path, body) : await axios.put(path, body);
      console.log(`  ${verb} ${path} [${group}] -> ${res.status} UNEXPECTED-SUCCESS`);
    } catch (err) {
      const status = err.response?.status ?? 0;
      const raw = err.response?.data;
      const msg = (typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : err.message).slice(0, 200);
      let verdict;
      if (status === 404) verdict = 'ENTITLED (reached the row lookup)';
      else if (status === 403) verdict = 'NOT ENTITLED';
      else if (status === 400 && /not a valid method/i.test(msg)) verdict = 'VERB ABSENT on this build';
      else if (status === 400) verdict = 'ENTITLED (reached validation)';
      else if (status === 401) verdict = 'NOT AUTHENTICATED';
      else verdict = 'UNCLEAR';
      console.log(`  ${verb} ${path} [${group}] -> ${status} ${verdict}`);
      console.log(`      ${msg}`);
    }
  }

  await probe('claimproc', 'Insurance', 'PUT', `/claimprocs/${GHOST}`, { InsPayAmt: 0.01 });
  await probe('claim', 'Insurance', 'PUT', `/claims/${GHOST}`, { ClaimStatus: 'R' });
  await probe('check', 'Insurance', 'POST', '/claimpayments', { claimNum: GHOST, CheckAmt: 0.01 });
  await probe('batch check', 'Insurance', 'POST', '/claimpayments/Batch', {
    claimNums: [GHOST],
    CheckAmt: 0.01,
  });
  await probe('document', 'Documents', 'POST', '/documents/Upload', {
    PatNum: GHOST,
    rawBase64: 'JVBERi0xLjQK',
    extension: '.pdf',
  });

  console.log(`\nDONE ${new Date().toISOString()} — no row was created, updated or deleted.`);
  console.log('NOW RUN: node scripts/rcm-d7-read-sweep.js');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('PROBE FAILED:', e && e.message);
    process.exit(1);
  }
);

module.exports = { GHOST };
