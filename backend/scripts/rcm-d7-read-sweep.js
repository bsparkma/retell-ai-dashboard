'use strict';

/*
 * D-7 prerequisite (a), second half: PROVE THE PROBE LANDED NOTHING.
 *
 * Run IMMEDIATELY after `scripts/rcm-d7-write-probe.js`, and paste the output
 * into `docs/RCM_POSTING.md` §9 beside the probe transcript.
 *
 *     PROBE_OFFICE=valley node scripts/rcm-d7-read-sweep.js
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SWEEP AT ALL, WHEN THE PROBE WAS ZERO-RISK BY CONSTRUCTION
 * ─────────────────────────────────────────────────────────────────────────────
 * Because "zero-risk by construction" is an argument, and this module's whole
 * discipline is that an argument about a chart is not evidence about a chart.
 * G2 is the same lesson one level down: Open Dental answers 200 to writes it
 * ignores, so the only thing that establishes what a call did is reading back.
 *
 * Three questions, all READ-ONLY:
 *   1. do the ghost ids still not exist?
 *   2. did a claimpayment appear? — the one probe that could have created a row
 *      rather than modified one, and the only one whose damage would be money;
 *   3. did a document appear?
 *
 * The claimpayment sweep is the load-bearing one. `POST /claimpayments` against a
 * non-existent claim SHOULD 404, but if Open Dental were to create a detached
 * check instead, the newest ClaimPaymentNum would move. So the sweep prints the
 * most recent checks with their dates: a check created in the last few minutes,
 * for $0.01, would be unmissable.
 *
 * NO PATIENT DATA IS PRINTED — ids, amounts, dates and counts only.
 */

const odOffices = require('../config/odOffices');
const { GHOST } = require('./rcm-d7-write-probe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** OD list endpoints return a bare array; be defensive about envelopes. */
function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

async function main() {
  const office = process.env.PROBE_OFFICE || 'valley';
  const handle = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  const od = handle.client;
  console.log(`\n=== ${office} (${handle.officeName}) — POST-PROBE READ SWEEP ===`);
  console.log(`    ghost id: ${GHOST}   swept: ${new Date().toISOString()}\n`);

  let clean = true;

  // ── 1. The ghost ids still do not exist ───────────────────────────────────
  for (const path of [`/claimprocs/${GHOST}`, `/claims/${GHOST}`, `/patients/${GHOST}`]) {
    await sleep(1300);
    const res = await od.apiGetRaw(path, {}, { timeoutMs: 30000 });
    const ok = !res.ok;
    if (!ok) clean = false;
    console.log(`  GET ${path} -> ${res.status} ${ok ? 'still absent  OK' : 'EXISTS  <-- INVESTIGATE'}`);
  }

  // ── 2. No claimpayment was created ────────────────────────────────────────
  //
  // The probe used claimNum = GHOST, so any claimproc that somehow attached
  // would be findable this way. An empty result is the expected answer.
  await sleep(1300);
  const attached = await od.apiGetRaw('/claimprocs', { ClaimNum: GHOST }, { timeoutMs: 30000 });
  const attachedRows = asArray(attached.data).filter((r) => Number(r.ClaimNum) === GHOST);
  if (attachedRows.length) clean = false;
  console.log(
    `\n  GET /claimprocs?ClaimNum=${GHOST} -> ${attached.status}  rows=${attachedRows.length}` +
      `${attachedRows.length ? '  <-- INVESTIGATE' : '  OK'}`
  );

  // The most recent checks, so a $0.01 row minted in the last few minutes is
  // unmissable. Amounts and dates only.
  await sleep(1300);
  const checks = await od.apiGetRaw('/claimpayments', {}, { timeoutMs: 30000 });
  const rows = asArray(checks.data);
  const recent = rows
    .slice()
    .sort((a, b) => Number(b.ClaimPaymentNum || 0) - Number(a.ClaimPaymentNum || 0))
    .slice(0, 10);
  console.log(`\n  GET /claimpayments -> ${checks.status}  ${rows.length} rows; newest 10:`);
  for (const r of recent) {
    const flag = Number(r.CheckAmt) === 0.01 ? '   <-- INVESTIGATE ($0.01)' : '';
    if (flag) clean = false;
    console.log(
      `      ClaimPaymentNum=${r.ClaimPaymentNum}  CheckDate=${r.CheckDate}  ` +
        `CheckAmt=${r.CheckAmt}  PayType=${r.PayType}${flag}`
    );
  }

  // ── 3. No document was created ────────────────────────────────────────────
  await sleep(1300);
  const docs = await od.apiGetRaw('/documents', { PatNum: GHOST }, { timeoutMs: 30000 });
  const docRows = asArray(docs.data).filter((r) => Number(r.PatNum) === GHOST);
  if (docRows.length) clean = false;
  console.log(
    `\n  GET /documents?PatNum=${GHOST} -> ${docs.status}  rows=${docRows.length}` +
      `${docRows.length ? '  <-- INVESTIGATE' : '  OK'}`
  );

  console.log(
    `\nSWEEP ${clean ? 'CLEAN — nothing landed.' : 'NOT CLEAN — see the flagged lines above.'}`
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('SWEEP FAILED:', e && e.message);
    process.exit(1);
  }
);
