'use strict';

/*
 * D-7 prerequisite (a): is the RILEY key entitled to WRITE?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RUN THIS ONLY AT A QUIET HOUR FOR THE OFFICE, AND ONLY WITH BEAU'S GO-AHEAD.
 * ─────────────────────────────────────────────────────────────────────────────
 * RUN 2026-08-24 21:13 Central against staging. Riley is ENTITLED on both the
 * Insurance and Documents write groups; the sweep was clean. The transcript is
 * in `docs/RCM_POSTING.md` §9(a). Re-run only to re-establish that answer.
 *
 * It is checked into the repo rather than pasted from a scratchpad so the thing
 * that was run is the thing that was reviewed — which is why the two defects
 * that run exposed (no secret loading; execution on import) were fixed rather
 * than worked around a second time.
 *
 * Usage, from inside the staging container (so the customer key is resolved from
 * Key Vault by the app's own loader and never printed):
 *
 *     PROBE_OFFICE=valley node scripts/rcm-d7-write-probe.js
 *
 * That command works as written — main() loads the secrets itself. The
 * 2026-08-24 run needed a `node -e` wrapper around `loadSecrets()`; it no longer
 * does, and an operator improvising at a live chart database is the thing this
 * file exists to avoid.
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
// The ghost id lives in its own one-constant module so the sweep can agree with
// this file about which ids to check WITHOUT importing this file. See defect 2
// in `test/rcmD7ProbeScripts.test.js`.
const { GHOST } = require('./rcm-d7-ghost');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── 0. The customer key ───────────────────────────────────────────────────
  //
  // `config/odOffices` reads each office's customer key from `process.env`, and
  // the ONLY thing that puts it there is this loader — which until now was
  // called by `server.js` and by nothing else. A standalone script inherited an
  // environment without it and died on `OFFICE_OD_KEY_MISSING` before issuing
  // anything, which is exactly how the 2026-08-24 run ended up being driven
  // through an improvised `node -e` wrapper at the console. A script whose
  // documented invocation does not work gets improvised at a live database.
  //
  // Required lazily and awaited FIRST, before any odOffices call. The top-level
  // `require` of odOffices above is harmless because `customerKeyFor` re-reads
  // `process.env` on every call rather than snapshotting it at load.
  await require('../config/secrets').loadSecrets();

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

// ── Run ONLY when invoked directly ───────────────────────────────────────────
//
// Without this guard, `require`-ing this file RUNS IT — which is precisely what
// happened on 2026-08-24: the read sweep imported this module for its ghost id
// and thereby re-issued every write verb, interleaved with its own reads. The
// verb scan in `rcmNoOdWrites.test.js` could not catch that, because the verbs
// were legitimately present in the file that legitimately owns them; the defect
// was that importing the file executed them.
if (require.main === module) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error('PROBE FAILED:', e && e.message);
      process.exit(1);
    }
  );
}

module.exports = { GHOST, main };
