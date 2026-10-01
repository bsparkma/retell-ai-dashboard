#!/usr/bin/env node
'use strict';

/*
 * READ-ONLY: the per-upload field dump behind docs/reports/rcm-extraction-quality.md.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A CHECKED-IN SCRIPT
 * ─────────────────────────────────────────────────────────────────────────────
 * The 2026-09-30 extraction-quality diagnosis needed the stored money fields of
 * the scanned EOB uploads on prod, field by field, to classify what changed at
 * #206. The in-container upload-and-run dance was refused by the session's
 * safety layer, so the row-level half of that report was reconstructed from
 * code paths, logs and fixtures instead. This script is the missing half, in
 * the image, runnable the sanctioned way (the same shape as rcm-d7-read-sweep):
 *
 *     az containerapp exec -n ca-carein-prod-backend -g rg-carein-prod \
 *       --command "sh -c \"node /app/scripts/rcm-extraction-quality-probe.js\""
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT PRINTS, AND WHAT IT NEVER PRINTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Uploads from the last N days (default 7, RCM_PROBE_DAYS to change) with their
 * provenance, and every claim and line in integer cents with its review
 * reasons. Ids, timestamps, page counts, confidences, amounts, codes, flags —
 * NOTHING ELSE. No patient name, DOB, subscriber id, filename, payer-assigned
 * claim number, or document text: the columns are named, never *, and the
 * PHI-bearing ones are deliberately not in the list. Output is one JSON line
 * per upload so it survives the exec websocket intact.
 *
 * No Open Dental module is required here — this file reads the tenant Postgres
 * and nothing else, and writes nowhere.
 */

const WINDOW_DAYS = (() => {
  const n = Number.parseInt(process.env.RCM_PROBE_DAYS || '7', 10);
  return Number.isFinite(n) && n > 0 && n <= 90 ? n : 7;
})();

async function main() {
  await require('../config/secrets').loadSecrets();
  const registry = require('../platform/registry');
  const tenantDb = require('../platform/tenantDb');

  const tenants = await registry.listTenants();
  for (const tenant of tenants) {
    if (tenant.status && tenant.status !== 'active') continue;
    const pool = await tenantDb.getTenantPool(tenant.tenant_id);

    const uploads = await pool.query(
      `SELECT upload_id, office_id, status, text_source, ocr_page_count,
              ocr_mean_confidence, failure_code, result_batch_id, result_claim_id,
              created_at, processed_at
         FROM rcm_eob_uploads
        WHERE created_at > now() - ($1 || ' days')::interval
        ORDER BY created_at ASC`,
      [String(WINDOW_DAYS)]
    );

    for (const u of uploads.rows) {
      const claims = u.result_batch_id
        ? await pool.query(
            `SELECT c.claim_id, c.office_id, c.status, c.source, c.confidence,
                    c.total_billed_cents, c.total_allowed_cents, c.total_deductible_cents,
                    c.total_copay_cents, c.total_paid_cents, c.needs_review_reasons,
                    c.created_at
               FROM rcm_claims c
               JOIN rcm_batch_claim_payments b ON b.claim_id = c.claim_id
              WHERE b.batch_id = $1
              ORDER BY b.position ASC`,
            [u.result_batch_id]
          )
        : { rows: [] };

      const out = {
        tenant: tenant.slug,
        upload: {
          uploadId: u.upload_id,
          office: u.office_id,
          status: u.status,
          textSource: u.text_source,
          ocrPages: u.ocr_page_count,
          ocrMeanConfidence: u.ocr_mean_confidence,
          failureCode: u.failure_code,
          createdAt: u.created_at,
          processedAt: u.processed_at,
        },
        claims: [],
      };

      for (const c of claims.rows) {
        const lines = await pool.query(
          `SELECT line_id, position, code, billed_cents, allowed_cents,
                  deductible_cents, copay_cents, paid_cents, write_off_cents,
                  flags
             FROM rcm_procedure_lines
            WHERE claim_id = $1
            ORDER BY position ASC`,
          [c.claim_id]
        );
        out.claims.push({
          claimId: c.claim_id,
          status: c.status,
          confidence: c.confidence,
          totals: {
            billed: c.total_billed_cents,
            allowed: c.total_allowed_cents,
            deductible: c.total_deductible_cents,
            copay: c.total_copay_cents,
            paid: c.total_paid_cents,
          },
          reviewReasons: c.needs_review_reasons,
          lines: lines.rows.map((l) => ({
            lineId: l.line_id,
            position: l.position,
            code: l.code,
            billed: l.billed_cents,
            allowed: l.allowed_cents,
            deductible: l.deductible_cents,
            copay: l.copay_cents,
            // THE FIELD THE WHOLE REPORT IS ABOUT. null = the page does not
            // state a payment for this line; 0 = the plan paid nothing.
            paid: l.paid_cents,
            writeOff: l.write_off_cents,
            flags: l.flags,
          })),
        });
      }

      console.log(JSON.stringify(out));
    }
  }
}

// Guarded like every probe since D-7: importing this file must run nothing.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[rcm-extraction-quality-probe] failed:', err && err.message);
      process.exit(1);
    });
}

module.exports = { WINDOW_DAYS };
