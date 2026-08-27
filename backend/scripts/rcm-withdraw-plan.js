#!/usr/bin/env node
'use strict';

/**
 * Retire one posting plan, by hand, from inside a container.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SCRIPT AND NOT JUST THE BUTTON
 * ─────────────────────────────────────────────────────────────────────────────
 * The button is the normal path and it exists. This is for the case the button
 * cannot reach: a plan already in a state nobody wants to click through, on an
 * environment where the operator is `az containerapp exec` rather than a
 * browser. It is how the 2026-08-26 walk's orphan (queue `9ad950ad-…`, claim
 * 53805, deleted by the §11 unwind) gets retired without a biller having to
 * press Drain on it first to find out it is dead.
 *
 * It uses the SAME `withdrawRow` the route uses, so every guard applies: it
 * cannot touch a `posted`, `partially_posted` or `posting` plan, and the
 * database's own CHECK refuses a withdrawal carrying money.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT CONSULTS NO DENY-LIST, AND THAT IS CORRECT
 * ─────────────────────────────────────────────────────────────────────────────
 * `SPIKE_0B_RESIDUE` and `WALK_SPENT_IDS` screen OPEN DENTAL ids — ClaimNums,
 * ProcNums, ClaimProcNums, AdjNums — because the scripts that name them issue
 * writes and DELETEs against a live chart, and a manifest naming a spent id did
 * not come from a prep run.
 *
 * This script names a `queue_id`: a uuid in the tenant database, minted by the
 * approval gate, referring to nothing in any chart. It issues no Open Dental
 * call at all. Screening it against a list of ClaimNums would be a check that
 * could never fire and would read, to the next person, as though it were doing
 * something. The guard that matters here is the money guard below.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A PREFIX, NOT A FULL ID
 * ─────────────────────────────────────────────────────────────────────────────
 * Queue ids are uuids and they reach an operator through a screenshot or a log
 * line, usually truncated. Retyping 36 characters into a shell that splits on
 * whitespace is how the wrong plan gets retired.
 *
 * So it takes a PREFIX and **refuses unless exactly one plan matches** —
 * ambiguity is a refusal, never a coin flip. Eight characters is plenty for one
 * office's queue and is what a truncated id usually shows.
 *
 * Usage:
 *   RCM_TENANT=carein node scripts/rcm-withdraw-plan.js \
 *     --office roland --queue 9ad950ad --note "the claim was deleted by the s11 unwind"
 *
 * Add `--execute` to actually write. Without it this is a dry run that prints
 * the plan it WOULD retire and stops — the same default every other script in
 * this walk uses, and for the same reason: there is no un-withdraw.
 */

const { loadSecrets } = require('../config/secrets');
const postingDrain = require('../services/rcm/postingDrain');

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { execute: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--execute') out.execute = true;
    else if (a === '--office') out.office = argv[++i];
    else if (a === '--queue') out.queue = argv[++i];
    else if (a === '--note') out.note = argv[++i];
    else if (a === '--by') out.by = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tenant = process.env.RCM_TENANT || 'carein';

  if (!args.office || !args.queue) {
    console.error('usage: --office <roland|valley> --queue <id-or-prefix> --note "why" [--execute]');
    process.exit(2);
  }
  if (!args.note || args.note.trim().length < 3) {
    console.error(
      'REFUSED: --note is required. It is the only record of why money that was approved\n' +
        '  is not going to post — nothing else on the row will ever explain it.'
    );
    process.exit(2);
  }

  // Standalone scripts must load secrets themselves; nothing has booted the app.
  await loadSecrets();
  const tenantDb = require('../platform/tenantDb');
  const registry = require('../platform/registry');

  const tenants = await registry.listTenants();
  const found = (tenants || []).find((t) => t && t.slug === tenant);
  if (!found) {
    console.error(`REFUSED: no tenant '${tenant}'. Set RCM_TENANT.`);
    process.exit(1);
  }
  const pool = await tenantDb.getTenantPool(found.tenant_id);

  /*
   * The prefix is resolved by a READ first, and printed in full, so the operator
   * sees which plan is about to be retired before anything is written. `LIKE`
   * with a bound parameter, not string interpolation.
   */
  const matches = await pool.query(
    `SELECT queue_id, status, remittance_key, intended_total_cents, od_claim_payment_num,
            posted_total_cents, reconciled_at
       FROM rcm_posting_queue
      WHERE office_id = $1 AND queue_id::text LIKE $2
      ORDER BY queue_id`,
    [args.office, `${args.queue}%`]
  );

  if (matches.rows.length === 0) {
    console.error(`REFUSED: no plan in '${args.office}' whose id starts with '${args.queue}'.`);
    process.exit(1);
  }
  if (matches.rows.length > 1) {
    console.error(
      `REFUSED: '${args.queue}' matches ${matches.rows.length} plans. Ambiguity is a refusal,\n` +
        '  never a coin flip. Give more characters:'
    );
    for (const r of matches.rows) console.error(`    ${r.queue_id}  ${r.status}  ${r.remittance_key}`);
    process.exit(1);
  }

  const plan = matches.rows[0];

  /*
   * ─── THE MONEY GUARD, HERE AS WELL AS IN THE DATABASE ─────────────────────
   *
   * `rcm_posting_queue_withdrawn_no_money_check` already refuses a withdrawal
   * carrying a check number, a reconciliation or a posted total, and
   * `withdrawRow`'s own `WHERE status = ANY(...)` already excludes `posted` and
   * `partially_posted`. This is a third check on the same fact, and it is here
   * on purpose.
   *
   * A CHECK VIOLATION IS A STACK TRACE. This is an operator on
   * `az containerapp exec` at the end of a walk night, and the difference
   * between "refused, here is why, nothing was written" and a Postgres error
   * about a constraint they have never heard of is the difference between
   * stopping and guessing.
   *
   * It also catches a shape the state list alone would not: a row somehow
   * `approved` while carrying a ClaimPaymentNum. That should be impossible, and
   * "should be impossible" is exactly what a belt is for.
   */
  const paymentNum = plan.od_claim_payment_num == null ? null : Number(plan.od_claim_payment_num);
  const postedCents = Number(plan.posted_total_cents || 0);
  if (paymentNum || postedCents > 0) {
    console.error(
      `REFUSED: this plan has already put money in a chart.\n` +
        `  od_claim_payment_num  ${paymentNum ?? '(none)'}\n` +
        `  posted_total_cents    ${postedCents}\n` +
        '  Retiring it would make the queue disagree with Open Dental. Reverse it in Open\n' +
        '  Dental instead. Nothing was written.'
    );
    process.exit(1);
  }

  console.log('PLAN');
  console.log(`   queue_id            ${plan.queue_id}`);
  console.log(`   office              ${args.office}`);
  console.log(`   status              ${plan.status}`);
  console.log(`   remittance_key      ${plan.remittance_key}`);
  console.log(`   intended            ${Number(plan.intended_total_cents) / 100}`);
  console.log(`   od_claim_payment    ${plan.od_claim_payment_num ?? '(none)'}`);
  console.log(`   note                ${args.note.trim()}`);

  if (!args.execute) {
    console.log('\nDRY RUN — nothing was written. Add --execute to retire it.');
    return;
  }

  const outcome = await postingDrain.withdrawRow(pool, args.office, String(plan.queue_id), {
    reason: postingDrain.WITHDRAW_REASONS.MANUAL,
    note: args.note.trim(),
    // Null rather than a guessed crosswalk key. `withdrawn_by` has a RESTRICT FK
    // to rcm_user_map, and inventing a key to fill a column would be worse than
    // an honest absence — the note says who, in the operator's own words.
    by: args.by || null,
  });

  if (!outcome.withdrawn) {
    console.error(
      `REFUSED: a plan in '${outcome.status}' cannot be retired.\n` +
        '  Money that moved happened; retiring it would make the queue disagree with the chart.'
    );
    process.exit(1);
  }

  // Read it back. A success we cannot show the operator is a lie.
  const after = await pool.query(
    `SELECT status, withdrawn_reason, withdrawn_note, withdrawn_at
       FROM rcm_posting_queue WHERE queue_id = $1`,
    [plan.queue_id]
  );
  const row = after.rows[0];
  console.log('\nRETIRED, read back:');
  console.log(`   status              ${row.status}`);
  console.log(`   withdrawn_reason    ${row.withdrawn_reason}`);
  console.log(`   withdrawn_at        ${row.withdrawn_at}`);
  console.log(`   withdrawn_note      ${row.withdrawn_note}`);
  if (row.status !== 'withdrawn') {
    console.error('\n! The read-back does not say withdrawn. Do not trust the line above.');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[rcm-withdraw-plan] failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { parseArgs };
