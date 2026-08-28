#!/usr/bin/env node
'use strict';

/**
 * Write back into the manifest what the WALK produced, so the unwind can undo it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE MANIFEST HAS TO GROW AFTER THE NIGHT
 * ─────────────────────────────────────────────────────────────────────────────
 * `rcm-s10-prep.js` records what it CREATED — a procedure, a claim, a claimproc.
 * The walk then produces two more Open Dental rows that the prep could not have
 * known about, because they do not exist until the drain runs:
 *
 *   * **the takeback's adjustment** (`od_adjustment_num`) — which the unwind must
 *     offset, since `DELETE /adjustments` does not exist (G6);
 *   * **the EOB document** (`od_doc_num`) — which the unwind **cannot** remove at
 *     all, because `DELETE /documents/{n}` has never been probed. It is recorded
 *     as PERMANENT RESIDUE so the next inventory can name it rather than
 *     rediscovering it as an unexplained row on a test patient.
 *
 * Without this step the unwind reads a manifest describing a chart that has since
 * moved, and quietly does less than the operator believes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT READS THE TENANT DATABASE AND NOTHING ELSE
 * ─────────────────────────────────────────────────────────────────────────────
 * **No Open Dental access at all.** Every number it needs was already written
 * down by the drain, in the row that proves what it did — so asking Open Dental
 * again would be a second, weaker source for a fact the queue already holds. Same
 * stance as `rcm-s10-835.js`, which reads a manifest and touches no chart.
 *
 * Usage:
 *   RCM_TENANT=carein PROBE_OFFICE=roland node scripts/rcm-s10-capture.js
 *   ... add --write to update the manifest; without it, this prints and stops.
 */

const fs = require('node:fs');

const T = require('./rcm-s10-targets');
const { loadSecrets } = require('../config/secrets');

const TARGET = T.resolveTarget();
const PATHS = T.pathsFor(TARGET.office);
const WRITE = process.argv.includes('--write');

async function main() {
  if (!fs.existsSync(PATHS.manifestPath)) {
    console.error(`REFUSED: no manifest at\n  ${PATHS.manifestPath}`);
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(PATHS.manifestPath, 'utf8'));
  if (!Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    console.error('REFUSED: the manifest names no targets.');
    process.exit(2);
  }

  await loadSecrets();
  const tenantDb = require('../platform/tenantDb');
  const registry = require('../platform/registry');

  const slug = process.env.RCM_TENANT || 'carein';
  const tenants = await registry.listTenants();
  const found = (tenants || []).find((t) => t && t.slug === slug);
  if (!found) {
    console.error(`REFUSED: no tenant '${slug}'. Set RCM_TENANT.`);
    process.exit(1);
  }
  const pool = await tenantDb.getTenantPool(found.tenant_id);

  console.log(`=== S10 CAPTURE — ${TARGET.office}, PatNum ${TARGET.patNum} ===`);
  console.log('    READ-ONLY against Open Dental: it is never contacted.\n');

  let changed = 0;
  for (const [i, target] of manifest.targets.entries()) {
    const label = String.fromCharCode(65 + i);
    const claimNum = Number(target.claimNum);
    if (!claimNum) continue;

    /*
     * The takeback's adjustment, from the LINE that produced it. Scoped by
     * office as every read in this module is, and by the claim so a two-target
     * walk cannot cross its own wires.
     */
    const adj = await pool.query(
      `SELECT l.od_adjustment_num, l.od_supplemental_claim_proc_num, l.recoupment_path
         FROM rcm_posting_queue_line l
         JOIN rcm_claims c ON c.posting_queue_id = l.queue_id
        WHERE l.office_id = $1 AND c.od_claim_num = $2
          AND l.od_adjustment_num IS NOT NULL
        ORDER BY l.position
        LIMIT 1`,
      [TARGET.office, claimNum]
    );

    /*
     * The EOB document. PERMANENT: there is no proven `DELETE /documents/{n}`,
     * so this is recorded to be NAMED, not to be removed.
     */
    const doc = await pool.query(
      `SELECT d.od_doc_num, d.od_patient_id
         FROM rcm_posting_document d
         JOIN rcm_claims c ON c.posting_queue_id = d.queue_id
        WHERE d.office_id = $1 AND c.od_claim_num = $2 AND d.od_doc_num IS NOT NULL`,
      [TARGET.office, claimNum]
    );

    const adjNum = adj.rows.length ? Number(adj.rows[0].od_adjustment_num) : 0;
    const docNums = doc.rows.map((r) => Number(r.od_doc_num)).filter(Boolean);

    console.log(`   ${label}: claim ${claimNum}`);
    console.log(`       od_adjustment_num   ${adjNum || '(none)'}${adjNum ? `  path=${adj.rows[0].recoupment_path}` : ''}`);
    console.log(`       od_doc_num          ${docNums.length ? docNums.join(', ') : '(none)'}   ** PERMANENT — no proven DELETE /documents`);

    if (adjNum && Number(target.odAdjustmentNum) !== adjNum) {
      target.odAdjustmentNum = adjNum;
      /*
       * NO ADJTYPE IS COPIED HERE, deliberately.
       *
       * An earlier draft wrote the reversal's DefNum into the manifest so the
       * unwind would not have to resolve anything. That is a number in a JSON
       * file that is correct until somebody edits a definitions list in one
       * practice — after which the unwind books a reversal under whatever that
       * number now means, in a patient's ledger, silently. DefNums resolve BY
       * NAME, at the moment of use, or not at all. The unwind does it itself
       * through `odOfficeConfig.pickAdjType`, name and sign both checked.
       */
      changed++;
    }
    if (docNums.length) {
      const existing = Array.isArray(target.odDocNums) ? target.odDocNums : [];
      const merged = [...new Set([...existing, ...docNums])].sort((a, b) => a - b);
      if (merged.join(',') !== existing.join(',')) {
        target.odDocNums = merged;
        changed++;
      }
    }
  }

  if (!WRITE) {
    console.log(`\nDRY RUN — ${changed} field(s) would change. Add --write to record them.`);
    return;
  }
  if (changed === 0) {
    console.log('\nNothing to record; the manifest already matches.');
    return;
  }

  manifest.capturedAt = manifest.capturedAt || null;
  fs.writeFileSync(PATHS.manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  // Read it back. A manifest we cannot re-read is a manifest the unwind cannot
  // trust, and the unwind is the only thing that will ever act on it.
  const back = JSON.parse(fs.readFileSync(PATHS.manifestPath, 'utf8'));
  const ok = back.targets.some((t) => Number(t.odAdjustmentNum) > 0 || (t.odDocNums || []).length);
  console.log(`\n   manifest updated: ${PATHS.manifestPath}`);
  if (!ok) {
    console.error('   ! the re-read does not show the captured ids. Do not trust the line above.');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[rcm-s10-capture] failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { main };
