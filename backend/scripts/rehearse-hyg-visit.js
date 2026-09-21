#!/usr/bin/env node
'use strict';

/**
 * Rehearse the hygiene visit schema against a REAL Postgres.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY A REHEARSAL AND NOT JUST THE UNIT TESTS
 * ═════════════════════════════════════════════════════════════════════════════
 * `routes/hyg/hygTestUtils.js`'s FakeHygDb enforces the constraints that carry
 * meaning, which is what makes the route tests worth reading. What it CANNOT do
 * is prove that the DDL in migrations-tenant/1788200000000_hyg_visit.js says the
 * same thing — a fake is a second implementation of the rules, and the failure
 * mode of two implementations is that they agree with each other and not with
 * Postgres.
 *
 * RCM learned this twice: `rcm_office_settings` already existed and only a live
 * rehearsal caught it, and a CHECK that evaluates to NULL is ACCEPTED by
 * Postgres, which no fake would have shown. So this script runs the real
 * migration and the real services/hyg/visitStore.js against a real database and
 * tries to break each constraint on purpose.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * HOW TO RUN IT (the CI ephemeral-Postgres steps, reproduced locally)
 * ═════════════════════════════════════════════════════════════════════════════
 *   docker run -d --name hygpg -e POSTGRES_USER=carein_owner \
 *     -e POSTGRES_PASSWORD=carein_owner_devpw -e POSTGRES_DB=carein_control \
 *     -p 55433:5432 postgres:16
 *   # then, as carein_owner: CREATE ROLE carein_app LOGIN PASSWORD '...';
 *   #                        CREATE DATABASE carein_t_carein OWNER carein_owner;
 *   #                        GRANT USAGE ON SCHEMA public TO carein_app;
 *   MIGRATE_TENANT_DB_URL=<owner url> node scripts/migrate-tenant.js up --tenant carein
 *   HYG_REHEARSAL_DB_URL=<carein_app url> node scripts/rehearse-hyg-visit.js
 *
 * It connects as **carein_app**, the least-privilege role, on purpose: a table
 * created without a GRANT block fails in production as a permission error and
 * not as a red migration, so the grant is only proven by using it.
 *
 * NO PHI. Every PatNum here is a designated staging fixture (roland 12827 /
 * 12828, valley 7115) or an obviously synthetic number.
 */

const crypto = require('node:crypto');
const { Pool } = require('pg');

const visitStore = require('../services/hyg/visitStore');
const perioSendStore = require('../services/hyg/perioSendStore');
/** Item 13: the one definition of what a Written chart says it wrote. */
const perioSend = require('../services/hyg/perioSend');
const composer = require('../services/hyg/stagedWriteComposer');
const contract = require('../hyg/contract.gen.cjs');

const ACTOR = 'rehearsal@carein.ai';

let passed = 0;
let failed = 0;

function ok(name, detail) {
  passed += 1;
  console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`);
}

function bad(name, detail) {
  failed += 1;
  console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`);
}

/** Assert that `fn` is REFUSED by the database, and by the named constraint. */
async function refuses(name, constraint, fn) {
  try {
    await fn();
    bad(name, 'the database ACCEPTED it');
  } catch (err) {
    const message = (err && err.message) || String(err);
    if (constraint && !message.includes(constraint)) {
      bad(name, `refused, but not by ${constraint}: ${message.slice(0, 120)}`);
      return;
    }
    ok(name, 'refused' + (constraint ? ` by ${constraint}` : ''));
  }
}

function item(over = {}) {
  return {
    teeth: [3],
    code: 'Crown',
    category: 'Restorative',
    surfaces: ['O'],
    dx: ['D'],
    priority: 'urgent',
    motivation: ['pain'],
    status: 'proposed',
    scheduleNext: true,
    photos: [],
    ...over,
  };
}

async function main() {
  const url = process.env.HYG_REHEARSAL_DB_URL || process.env.TENANT_CAREIN_DB_URL;
  if (!url) {
    console.error(
      'Set HYG_REHEARSAL_DB_URL (or TENANT_CAREIN_DB_URL) to a migrated tenant database, ' +
        'connected as the least-privilege app role.'
    );
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url });

  try {
    // ── 0. the grant ────────────────────────────────────────────────────────
    const who = await pool.query('SELECT current_user AS role');
    ok('connected', 'as ' + who.rows[0].role);
    for (const table of ['hyg_visit', 'hyg_treatment_item', 'hyg_staged_write']) {
      await pool.query(`SELECT count(*) FROM ${table}`);
    }
    ok('grants: the app role can read all three hyg_* tables');

    // Leave nothing behind, and start from nothing.
    await pool.query("DELETE FROM hyg_visit WHERE created_by = $1", [ACTOR]);

    // ── 1. one visit per appointment ────────────────────────────────────────
    const first = await visitStore.openVisit(pool, {
      office: 'roland',
      aptNum: 990001,
      patNum: 12827,
      visitDate: '2026-09-08',
      actor: ACTOR,
    });
    const second = await visitStore.openVisit(pool, {
      office: 'roland',
      aptNum: 990001,
      patNum: 12827,
      visitDate: '2026-09-08',
      actor: ACTOR,
    });
    if (first.visitId === second.visitId) {
      ok('re-opening an appointment finds the visit already there', first.visitId);
    } else {
      bad('re-opening an appointment finds the visit already there', 'two rows');
    }

    // The same aptNum in the OTHER office is a DIFFERENT visit. AptNum
    // numbering restarts per database, like PatNum.
    const valley = await visitStore.openVisit(pool, {
      office: 'valley',
      aptNum: 990001,
      patNum: 7115,
      visitDate: '2026-09-08',
      actor: ACTOR,
    });
    if (valley.visitId !== first.visitId) {
      ok('the same aptNum in the other office is a different visit');
    } else {
      bad('the same aptNum in the other office is a different visit');
    }

    // ── 2. the two axes ─────────────────────────────────────────────────────
    await visitStore.addItem(pool, {
      office: 'roland',
      visitId: first.visitId,
      input: item(),
      actor: ACTOR,
    });
    ok('a well-formed treatment item stores');

    // The database's own refusal, bypassing the zod schema entirely — because
    // the point of the CHECK is to outlive every process that writes to it.
    await refuses(
      'a CATEGORY value in the priority column is refused',
      'hyg_treatment_item_priority_check',
      () =>
        pool.query(
          `INSERT INTO hyg_treatment_item
             (visit_id, office, teeth, whole_mouth, code, category, priority, status, created_by)
           VALUES ($1, 'roland', '[3]'::jsonb, false, 'Crown', 'Restorative', 'Cosmetic', 'proposed', $2)`,
          [first.visitId, ACTOR]
        )
    );
    await refuses(
      'a PRIORITY value in the category column is refused',
      'hyg_treatment_item_category_check',
      () =>
        pool.query(
          `INSERT INTO hyg_treatment_item
             (visit_id, office, teeth, whole_mouth, code, category, priority, status, created_by)
           VALUES ($1, 'roland', '[3]'::jsonb, false, 'Crown', 'cosmetic', 'urgent', 'proposed', $2)`,
          [first.visitId, ACTOR]
        )
    );

    // ── 3. office, everywhere ───────────────────────────────────────────────
    await refuses(
      "a child row whose office disagrees with its parent's is refused",
      'hyg_treatment_item_visit_fk',
      () =>
        visitStore.addItem(pool, {
          office: 'valley',
          visitId: first.visitId,
          input: item(),
          actor: ACTOR,
        })
    );
    await refuses('an office that is not ours is refused', 'hyg_visit_office_check', () =>
      pool.query(
        `INSERT INTO hyg_visit (office, apt_num, pat_num, created_by)
         VALUES ('springfield', 990009, 1, $1)`,
        [ACTOR]
      )
    );

    // And the queries are office-scoped: valley cannot read roland's visit.
    const crossRead = await visitStore.getVisit(pool, { office: 'valley', aptNum: 990001 });
    if (crossRead && crossRead.items.length === 0) {
      ok("a valley read of the same aptNum sees valley's own empty visit");
    } else {
      bad("a valley read of the same aptNum sees valley's own empty visit");
    }

    // ── 4. whole-mouth vs teeth ─────────────────────────────────────────────
    await visitStore.addItem(pool, {
      office: 'roland',
      visitId: first.visitId,
      input: item({ teeth: 'mouth', code: 'SRP', category: 'Perio', priority: 'preventative' }),
      actor: ACTOR,
    });
    ok('a whole-mouth item stores with no teeth');
    await refuses(
      'a whole-mouth item that also names teeth is refused',
      'hyg_treatment_item_teeth_check',
      () =>
        pool.query(
          `INSERT INTO hyg_treatment_item
             (visit_id, office, teeth, whole_mouth, code, category, priority, status, created_by)
           VALUES ($1, 'roland', '[3]'::jsonb, true, 'SRP', 'Perio', 'urgent', 'proposed', $2)`,
          [first.visitId, ACTOR]
        )
    );
    await refuses(
      'a tooth-level item that names no teeth is refused',
      'hyg_treatment_item_teeth_check',
      () =>
        pool.query(
          `INSERT INTO hyg_treatment_item
             (visit_id, office, teeth, whole_mouth, code, category, priority, status, created_by)
           VALUES ($1, 'roland', '[]'::jsonb, false, 'Crown', 'Restorative', 'urgent', 'proposed', $2)`,
          [first.visitId, ACTOR]
        )
    );

    // ── 5. the slip round-trips as jsonb ────────────────────────────────────
    const slip = {
      ...contract.emptySlip(),
      doneToday: ['prophy'],
      recareScheduled: 'yes',
      nextVisit: { type: 'Prophy', intervalMonths: 6, lengthMin: 60, withDoctor: true },
    };
    const saved = await visitStore.saveSlip(pool, {
      office: 'roland',
      aptNum: 990001,
      slip,
      actor: ACTOR,
    });
    if (
      saved.slip.recareScheduled === 'yes' &&
      saved.slip.nextVisit.intervalMonths === 6 &&
      contract.HygSlipSchema.safeParse(saved.slip).success
    ) {
      ok('the slip round-trips through jsonb and still parses');
    } else {
      bad('the slip round-trips through jsonb and still parses', JSON.stringify(saved.slip));
    }

    // ── 6. staged writes ────────────────────────────────────────────────────
    const reloaded = await visitStore.getVisit(pool, { office: 'roland', aptNum: 990001 });
    const staged = await visitStore.stageWrite(pool, {
      office: 'roland',
      visit: reloaded,
      kind: 'router',
      actor: ACTOR,
      compose: composer.compose,
    });
    if (staged.ok && staged.staged.state === 'Staged') {
      ok('a router slip stages', staged.staged.summary);
    } else {
      bad('a router slip stages', JSON.stringify(staged));
    }

    const restaged = await visitStore.stageWrite(pool, {
      office: 'roland',
      visit: reloaded,
      kind: 'router',
      actor: ACTOR,
      compose: composer.compose,
    });
    const stagedCount = await pool.query(
      'SELECT count(*)::int AS n FROM hyg_staged_write WHERE visit_id = $1',
      [first.visitId]
    );
    if (restaged.ok && stagedCount.rows[0].n === 1) {
      ok('re-staging replaces rather than adding a second row');
    } else {
      bad('re-staging replaces rather than adding a second row', 'n=' + stagedCount.rows[0].n);
    }

    await refuses(
      'a Failed staged write with no reason is refused',
      'hyg_staged_write_failed_reason_check',
      () =>
        pool.query(
          `UPDATE hyg_staged_write SET state = 'Failed', error_message = NULL
            WHERE visit_id = $1 AND kind = 'router'`,
          [first.visitId]
        )
    );
    await refuses(
      'half an attribution (sent_by with no sent_at) is refused',
      'hyg_staged_write_sent_pair_check',
      () =>
        pool.query(
          `UPDATE hyg_staged_write SET sent_by = $2, sent_at = NULL
            WHERE visit_id = $1 AND kind = 'router'`,
          [first.visitId, ACTOR]
        )
    );

    // The send path sets all four together, and the database permits exactly
    // that combination and no other: state, attribution, and the reference.
    await pool.query(
      `UPDATE hyg_staged_write
          SET state = 'Written', sent_by = $2, sent_at = now(), written_ref = 'Document 1 in Routers'
        WHERE visit_id = $1 AND kind = 'router'`,
      [first.visitId, ACTOR]
    );
    const immutable = await visitStore.stageWrite(pool, {
      office: 'roland',
      visit: reloaded,
      kind: 'router',
      actor: ACTOR,
      compose: composer.compose,
    });
    if (!immutable.ok && immutable.code === 'STAGED_WRITE_IMMUTABLE') {
      ok('a Written row cannot be re-staged');
    } else {
      bad('a Written row cannot be re-staged', JSON.stringify(immutable));
    }

    // ── 6b. slice 3's written_ref, and the pairing it enforces ──────────────
    await refuses(
      'a Written row with no reference is refused',
      'hyg_staged_write_written_ref_check',
      () =>
        pool.query(
          `UPDATE hyg_staged_write SET state = 'Written', written_ref = NULL,
                  sent_by = $2, sent_at = now()
            WHERE visit_id = $1 AND kind = 'router'`,
          [first.visitId, ACTOR]
        )
    );
    await refuses(
      'a reference on a row that was never Written is refused',
      'hyg_staged_write_written_ref_check',
      () =>
        pool.query(
          `UPDATE hyg_staged_write SET state = 'Staged', written_ref = 'Document 4711'
            WHERE visit_id = $1 AND kind = 'router'`,
          [first.visitId]
        )
    );
    // And the pair the send path actually writes is accepted.
    await pool.query(
      `UPDATE hyg_staged_write SET state = 'Written', written_ref = 'Document 4711 in Routers',
              sent_by = $2, sent_at = now()
        WHERE visit_id = $1 AND kind = 'router'`,
      [first.visitId, ACTOR]
    );
    const written = await pool.query(
      `SELECT written_ref FROM hyg_staged_write WHERE visit_id = $1 AND kind = 'router'`,
      [first.visitId]
    );
    if (written.rows[0].written_ref === 'Document 4711 in Routers') {
      ok('a Written row carries the reference the send recorded');
    } else {
      bad('a Written row carries the reference the send recorded');
    }

    // ── 6c. the perio chart (H4 slice 10) ───────────────────────────────────
    // The chart is the visit's `perio` row in Draft. What only a real Postgres
    // can prove: the ON CONFLICT … WHERE really refuses a row a send has
    // claimed, and jsonb's key reordering does not make an unchanged chart
    // look changed.
    const perioVisit = await visitStore.openVisit(pool, {
      office: 'roland',
      aptNum: 990002,
      patNum: 12828,
      visitDate: '2026-09-08',
      actor: ACTOR,
    });
    let chart = contract.emptyPerioChart();
    for (const c of contract.chartingOrder(chart.sweep).slice(0, 84)) {
      chart = contract.withPerioSite(chart, c.tooth, c.surface, { depth: 3, bleeding: c.tooth === 3 });
    }
    const draft = await visitStore.savePerioDraft(pool, {
      office: 'roland', visit: perioVisit, chart, actor: ACTOR,
    });
    if (draft.ok && draft.row.state === 'Draft' && draft.changed) {
      ok('a perio chart stores as the visit\'s Draft perio row');
    } else {
      bad('a perio chart stores as the visit\'s Draft perio row', JSON.stringify(draft));
    }

    const readBack = await visitStore.getPerio(pool, { office: 'roland', visitId: perioVisit.visitId });
    if (
      !readBack.unreadable &&
      JSON.stringify(readBack.chart) === JSON.stringify(contract.normalizePerioChart(chart))
    ) {
      ok('the chart reads back through jsonb as the same canonical chart');
    } else {
      bad('the chart reads back through jsonb as the same canonical chart');
    }

    const again = await visitStore.savePerioDraft(pool, {
      office: 'roland', visit: perioVisit, chart, actor: ACTOR,
    });
    if (again.ok && again.changed === false) {
      ok('saving the same chart again changes nothing (jsonb key order is not a change)');
    } else {
      bad('saving the same chart again changes nothing', JSON.stringify(again));
    }

    const perioStaged = await visitStore.stageWrite(pool, {
      office: 'roland',
      visit: perioVisit,
      kind: 'perio',
      actor: ACTOR,
      compose: composer.compose,
    });
    if (
      perioStaged.ok &&
      perioStaged.staged.state === 'Staged' &&
      perioStaged.staged.preview[0] === 'Partial chart: 84 of 192 sites charted'
    ) {
      ok('a partial chart stages from its stored draft, labelled partial');
    } else {
      bad('a partial chart stages from its stored draft', JSON.stringify(perioStaged));
    }

    const flippedSweep = { ...chart, sweep: { ...chart.sweep, lowerFacial: 'ltr' } };
    const sweepOnly = await visitStore.savePerioDraft(pool, {
      office: 'roland', visit: perioVisit, chart: flippedSweep, actor: ACTOR,
    });
    if (sweepOnly.ok && sweepOnly.row.state === 'Staged') {
      ok('changing only the entry direction leaves a staged chart staged');
    } else {
      bad('changing only the entry direction leaves a staged chart staged', JSON.stringify(sweepOnly));
    }

    const moreChart = contract.withPerioSite(chart, 32, 'DB', { depth: 5 });
    const unstaged = await visitStore.savePerioDraft(pool, {
      office: 'roland', visit: perioVisit, chart: moreChart, actor: ACTOR,
    });
    if (unstaged.ok && unstaged.row.state === 'Draft' && unstaged.row.preview.length === 0) {
      ok('changing a reading on a staged chart takes it back to Draft (ON CONFLICT … WHERE accepts Staged)');
    } else {
      bad('changing a reading on a staged chart takes it back to Draft', JSON.stringify(unstaged));
    }

    await visitStore.stageWrite(pool, {
      office: 'roland', visit: perioVisit, kind: 'perio', actor: ACTOR, compose: composer.compose,
    });
    const offList = await visitStore.unstageWrite(pool, {
      office: 'roland', visitId: perioVisit.visitId, kind: 'perio', actor: ACTOR,
    });
    const afterUnstage = await visitStore.getPerio(pool, { office: 'roland', visitId: perioVisit.visitId });
    if (
      offList.ok &&
      afterUnstage.row.state === 'Draft' &&
      contract.countPerioChart(afterUnstage.chart).sitesCharted === 85
    ) {
      ok('un-staging a chart returns it to Draft with every reading kept');
    } else {
      bad('un-staging a chart returns it to Draft with every reading kept', JSON.stringify(offList));
    }

    // The race the pre-check cannot see: a send claims the row between the
    // store's SELECT and its INSERT. Simulated by hiding the row from that one
    // SELECT, so the statement that answers is Postgres's own conflict WHERE.
    await pool.query(
      `UPDATE hyg_staged_write SET state = 'Sending' WHERE visit_id = $1 AND kind = 'perio'`,
      [perioVisit.visitId]
    );
    let hidden = false;
    const racingPool = {
      query: (sql, params) => {
        if (!hidden && /SELECT[\s\S]*FROM hyg_staged_write/.test(sql)) {
          hidden = true;
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return pool.query(sql, params);
      },
    };
    const raced = await visitStore.savePerioDraft(racingPool, {
      office: 'roland', visit: perioVisit, chart: contract.emptyPerioChart(), actor: ACTOR,
    });
    const stillSending = await pool.query(
      `SELECT state, payload FROM hyg_staged_write WHERE visit_id = $1 AND kind = 'perio'`,
      [perioVisit.visitId]
    );
    if (
      !raced.ok &&
      raced.code === 'STAGED_WRITE_IMMUTABLE' &&
      stillSending.rows[0].state === 'Sending' &&
      contract.countPerioChart(stillSending.rows[0].payload.chart).sitesCharted === 85
    ) {
      ok('a save racing a send cannot drag a Sending chart back to Draft (the conflict WHERE refuses)');
    } else {
      bad('a save racing a send cannot drag a Sending chart back to Draft', JSON.stringify(raced));
    }

    // ── 6d. the perio send (item 12) ────────────────────────────────────────
    // What only a real Postgres can prove about hyg_perio_send: the long-way
    // CHECKs refuse what they say, the in-flight index refuses a second send, the
    // lease UPDATE is exclusive, every store WHERE really scopes by office, the
    // app role cannot DELETE a send, and a visit with a send cannot be deleted
    // from under it. ONE transaction, rolled back — the app role, correctly,
    // could not delete what this leaves behind.
    const sendClient = await pool.connect();
    try {
      await sendClient.query('BEGIN');
      const refusesInTx = async (name, constraint, fn) => {
        await sendClient.query('SAVEPOINT refusal');
        try {
          await fn();
          bad(name, 'the database ACCEPTED it');
        } catch (err) {
          const message = (err && err.message) || String(err);
          if (constraint && !message.includes(constraint)) {
            bad(name, `refused, but not by ${constraint}: ${message.slice(0, 120)}`);
          } else {
            ok(name, 'refused' + (constraint ? ` by ${constraint}` : ''));
          }
        } finally {
          await sendClient.query('ROLLBACK TO SAVEPOINT refusal');
        }
      };

      await sendClient.query('SELECT count(*) FROM hyg_perio_send');
      ok('grants: the app role can read hyg_perio_send');

      const sendVisit = await visitStore.openVisit(sendClient, {
        office: 'roland', aptNum: 990003, patNum: 12828, visitDate: '2026-09-08', actor: ACTOR,
      });
      let sendChart = contract.emptyPerioChart();
      for (const c of contract.chartingOrder(sendChart.sweep)) {
        sendChart = contract.withPerioSite(sendChart, c.tooth, c.surface, { depth: 3 });
      }
      sendChart = contract.withPerioSite(sendChart, 3, 'DB', { depth: 12 });
      await visitStore.savePerioDraft(sendClient, { office: 'roland', visit: sendVisit, chart: sendChart, actor: ACTOR });
      await visitStore.stageWrite(sendClient, {
        office: 'roland', visit: sendVisit, kind: 'perio', actor: ACTOR, compose: composer.compose,
      });
      const stagedRow = await visitStore.getStagedWrite(sendClient, {
        office: 'roland', visitId: sendVisit.visitId, kind: 'perio',
      });
      const plan = contract.planPerioSend(sendChart);
      const base = {
        office: 'roland',
        visitId: sendVisit.visitId,
        stagedWriteId: stagedRow.staged_write_id,
        patNum: 12828,
        examDate: '2026-09-08',
        provNum: 7,
        previewFingerprint: visitStore.fingerprintPreview(stagedRow.preview),
        plan,
        actor: ACTOR,
      };

      const created = await perioSendStore.createSend(sendClient, base);
      // jsonb REORDERS object keys (shorter keys first), so `strings` comes back
      // LowerFacial, LowerLingual — harmless, because it becomes an object body
      // whose key order means nothing. `arches` is an array and keeps its order.
      const storedStrings = Object.keys(created.plan.strings).sort().join(',');
      const storedArches = created.plan.arches.map((a) => a.field).join(',');
      if (
        created.state === 'posting' &&
        created.pat_num === 12828 &&
        created.prov_num === 7 &&
        created.exam_date === '2026-09-08' &&
        created.plan.rows.length === 16 &&
        storedStrings === 'LowerFacial,LowerLingual' &&
        created.plan.strings.LowerLingual === plan.strings.LowerLingual &&
        storedArches === 'UpperFacial,UpperLingual,LowerLingual,LowerFacial'
      ) {
        ok('a send stores its frozen plan through jsonb, exam_date as text, bigints as numbers');
      } else {
        bad(
          'a send stores its frozen plan',
          JSON.stringify({
            state: created.state,
            pat_num: created.pat_num,
            prov_num: created.prov_num,
            exam_date: created.exam_date,
            rows: created.plan.rows.length,
            storedStrings,
            storedArches,
          })
        );
      }
      const sendId = created.send_id;

      await refusesInTx('a second send in flight for one chart', 'hyg_perio_send_in_flight_key', () =>
        perioSendStore.createSend(sendClient, base)
      );
      await refusesInTx('an exam date that is not YYYY-MM-DD', 'hyg_perio_send_exam_date_check', () =>
        sendClient.query(`UPDATE hyg_perio_send SET exam_date = '09/08/2026' WHERE send_id = $1`, [sendId])
      );
      await refusesInTx('a send for another office', 'hyg_perio_send_office_check', () =>
        sendClient.query(`UPDATE hyg_perio_send SET office = 'nope' WHERE send_id = $1`, [sendId])
      );
      await refusesInTx('filling with no exam number (the long-way CHECK)', 'hyg_perio_send_exam_num_check', () =>
        sendClient.query(`UPDATE hyg_perio_send SET state = 'filling' WHERE send_id = $1`, [sendId])
      );
      await refusesInTx('refused while holding an exam number', 'hyg_perio_send_exam_num_check', () =>
        sendClient.query(
          `UPDATE hyg_perio_send SET state = 'refused', exam_num = 7001, error_message = 'x' WHERE send_id = $1`,
          [sendId]
        )
      );
      await refusesInTx('incomplete with no reason', 'hyg_perio_send_reason_check', () =>
        sendClient.query(`UPDATE hyg_perio_send SET state = 'incomplete' WHERE send_id = $1`, [sendId])
      );
      await refusesInTx('half a lease (a token and no time)', 'hyg_perio_send_lease_check', () =>
        sendClient.query(`UPDATE hyg_perio_send SET step_token = gen_random_uuid() WHERE send_id = $1`, [sendId])
      );

      const cutoff = new Date(Date.now() - 120000);
      const tokenA = crypto.randomUUID();
      const tokenB = crypto.randomUUID();
      const claimedA = await perioSendStore.claimStep(sendClient, { office: 'roland', sendId, token: tokenA, leaseCutoff: cutoff });
      const claimedB = await perioSendStore.claimStep(sendClient, { office: 'roland', sendId, token: tokenB, leaseCutoff: cutoff });
      const strangerRenews = await perioSendStore.renewStep(sendClient, { office: 'roland', sendId, token: tokenB });
      const holderRenews = await perioSendStore.renewStep(sendClient, { office: 'roland', sendId, token: tokenA });
      const valleyClaims = await perioSendStore.claimStep(sendClient, {
        office: 'valley', sendId, token: tokenB, leaseCutoff: new Date(Date.now() + 60000),
      });
      if (claimedA && !claimedB && !strangerRenews && holderRenews && !valleyClaims) {
        ok('the step lease is exclusive: a second claim, a stranger renewing, and another office all fail');
      } else {
        bad('the step lease is exclusive', JSON.stringify({ claimedA, claimedB, strangerRenews, holderRenews, valleyClaims }));
      }
      const takenOver = await perioSendStore.claimStep(sendClient, {
        office: 'roland', sendId, token: tokenB, leaseCutoff: new Date(Date.now() + 60000),
      });
      await perioSendStore.releaseStep(sendClient, { office: 'roland', sendId, token: tokenA });
      const stillHeld = await sendClient.query('SELECT step_token FROM hyg_perio_send WHERE send_id = $1', [sendId]);
      await perioSendStore.releaseStep(sendClient, { office: 'roland', sendId, token: tokenB });
      const released = await sendClient.query('SELECT step_token, step_claimed_at FROM hyg_perio_send WHERE send_id = $1', [sendId]);
      if (takenOver && stillHeld.rows[0].step_token === tokenB && released.rows[0].step_token === null && released.rows[0].step_claimed_at === null) {
        ok('a lapsed lease is taken over, and only its holder can release it');
      } else {
        bad('a lapsed lease is taken over, and only its holder can release it');
      }

      await perioSendStore.setPriorExamNums(sendClient, { office: 'roland', sendId, priorExamNums: [2001, 2002] });
      const valleyFills = await perioSendStore.markFilling(sendClient, { office: 'valley', sendId, examNum: 7001 });
      const filled = await perioSendStore.markFilling(sendClient, { office: 'roland', sendId, examNum: 7001 });
      await perioSendStore.addRowsWritten(sendClient, { office: 'roland', sendId, count: 12 });
      const stopped = await perioSendStore.finishSend(sendClient, {
        office: 'roland', sendId, state: 'incomplete',
        errorMessage: 'Exam 7001 does not match at #3 DB',
        mismatches: [{ tooth: 3, surface: 'DB', kind: 'depth', expected: '12 mm', found: '1 mm' }],
      });
      const writtenAfterStop = await perioSendStore.finishSend(sendClient, { office: 'roland', sendId, state: 'written' });
      const valleyReads = await perioSendStore.getLatestSend(sendClient, { office: 'valley', stagedWriteId: stagedRow.staged_write_id });
      const incomplete = await perioSendStore.getLatestSend(sendClient, { office: 'roland', stagedWriteId: stagedRow.staged_write_id });
      if (
        !valleyFills && filled && stopped && !writtenAfterStop && valleyReads === null &&
        incomplete.state === 'incomplete' && incomplete.exam_num === 7001 && incomplete.rows_written === 12 &&
        JSON.stringify(incomplete.prior_exam_nums) === '[2001,2002]' &&
        incomplete.mismatches[0].found === '1 mm' && incomplete.finished_at !== null
      ) {
        ok('posting → filling → incomplete through the store; a finished send is not re-finished; office scopes every read and write');
      } else {
        bad('posting → filling → incomplete through the store', JSON.stringify({ valleyFills, filled, stopped, writtenAfterStop, valleyReads, incomplete }));
      }

      // With the first send incomplete, the in-flight index no longer blocks a second.
      const second = await perioSendStore.createSend(sendClient, base);
      const deletedFirst = await perioSendStore.markDeleted(sendClient, { office: 'roland', sendId, actor: ACTOR });
      const deletedSecond = await perioSendStore.markDeleted(sendClient, { office: 'roland', sendId: second.send_id, actor: ACTOR });
      const firstRow = (await sendClient.query('SELECT state, deleted_by, deleted_at FROM hyg_perio_send WHERE send_id = $1', [sendId])).rows[0];
      if (deletedFirst && !deletedSecond && firstRow.state === 'deleted' && firstRow.deleted_by === ACTOR && firstRow.deleted_at) {
        ok('only a send that knows its exam can be marked deleted, and it records who');
      } else {
        bad('only a send that knows its exam can be marked deleted', JSON.stringify({ deletedFirst, deletedSecond, firstRow }));
      }

      await visitStore.markSending(sendClient, { office: 'roland', visitId: sendVisit.visitId, kind: 'perio' });
      const valleyRestages = await perioSendStore.restageChart(sendClient, { office: 'valley', visitId: sendVisit.visitId });
      const restaged = await perioSendStore.restageChart(sendClient, { office: 'roland', visitId: sendVisit.visitId });
      const chartState = (await visitStore.getStagedWrite(sendClient, { office: 'roland', visitId: sendVisit.visitId, kind: 'perio' })).state;
      if (!valleyRestages && restaged && chartState === 'Staged') {
        ok('a chart whose send left nothing behind goes back to Staged — for its own office only');
      } else {
        bad('restaging the chart', JSON.stringify({ valleyRestages, restaged, chartState }));
      }

      await refusesInTx('the app role deleting a send record', 'permission denied', () =>
        sendClient.query('DELETE FROM hyg_perio_send WHERE send_id = $1', [sendId])
      );
      await refusesInTx('deleting a visit that has a send record', 'hyg_perio_send', () =>
        sendClient.query('DELETE FROM hyg_visit WHERE visit_id = $1', [sendVisit.visitId])
      );

      // ── 6e. correcting a sent chart (item 13) ─────────────────────────────
      // What only a real Postgres can prove: `Amending` is a state the CHECK
      // now accepts, the swap columns refuse the shapes that would let a
      // correction lie, and the `written` send really is found as the live one.
      const amendVisit = await visitStore.openVisit(sendClient, {
        office: 'roland', aptNum: 990004, patNum: 12828, visitDate: '2026-09-08', actor: ACTOR,
      });
      let amendChart = contract.emptyPerioChart();
      for (const c of contract.chartingOrder(amendChart.sweep)) {
        amendChart = contract.withPerioSite(amendChart, c.tooth, c.surface, { depth: 3 });
      }
      await visitStore.savePerioDraft(sendClient, {
        office: 'roland', visit: amendVisit, chart: amendChart, actor: ACTOR,
      });
      await visitStore.stageWrite(sendClient, {
        office: 'roland', visit: amendVisit, kind: 'perio', actor: ACTOR, compose: composer.compose,
      });
      const amendStaged = await visitStore.getStagedWrite(sendClient, {
        office: 'roland', visitId: amendVisit.visitId, kind: 'perio',
      });
      const firstSend = await perioSendStore.createSend(sendClient, {
        office: 'roland',
        visitId: amendVisit.visitId,
        stagedWriteId: amendStaged.staged_write_id,
        patNum: 12828,
        examDate: '2026-09-08',
        provNum: 7,
        previewFingerprint: visitStore.fingerprintPreview(amendStaged.preview),
        plan: contract.planPerioSend(amendChart),
        actor: ACTOR,
      });
      await perioSendStore.markFilling(sendClient, { office: 'roland', sendId: firstSend.send_id, examNum: 8001 });
      await perioSendStore.setSendChart(sendClient, {
        office: 'roland', sendId: firstSend.send_id, chart: amendChart,
      });
      await perioSendStore.finishSend(sendClient, { office: 'roland', sendId: firstSend.send_id, state: 'written' });
      await visitStore.markWritten(sendClient, {
        office: 'roland', visitId: amendVisit.visitId, kind: 'perio', actor: ACTOR,
        writtenRef: 'Perio exam 8001: 192 sites read back and match',
      });

      const liveBefore = await perioSendStore.getLiveSend(sendClient, {
        office: 'roland', stagedWriteId: amendStaged.staged_write_id,
      });
      const valleySeesLive = await perioSendStore.getLiveSend(sendClient, {
        office: 'valley', stagedWriteId: amendStaged.staged_write_id,
      });
      if (
        liveBefore && liveBefore.exam_num === 8001 && valleySeesLive === null &&
        contract.countPerioChart(liveBefore.chart).sitesCharted === 192
      ) {
        ok('the live send is the one that verified, it carries the chart it wrote, and office scopes it');
      } else {
        bad('the live send', JSON.stringify({ liveBefore: liveBefore && liveBefore.exam_num, valleySeesLive }));
      }

      // `Amending` — a state the original CHECK did not have.
      const opened = await visitStore.beginPerioAmendment(sendClient, {
        office: 'roland', visitId: amendVisit.visitId,
      });
      const openedRow = await visitStore.getStagedWrite(sendClient, {
        office: 'roland', visitId: amendVisit.visitId, kind: 'perio',
      });
      const notWritten = await visitStore.beginPerioAmendment(sendClient, {
        office: 'roland', visitId: amendVisit.visitId,
      });
      // written_ref goes with the state: `hyg_staged_write_written_ref_check` is
      // a biconditional, and only a Written row may carry one. The exam number
      // is not lost — it is on the send row, which getLiveSend just proved.
      if (opened && openedRow.state === 'Amending' && openedRow.written_ref === null && !notWritten) {
        ok('a Written chart opens for a correction, drops its written_ref with the state, and cannot be opened twice');
      } else {
        bad(
          'opening a correction',
          JSON.stringify({ opened, state: openedRow.state, written_ref: openedRow.written_ref, notWritten })
        );
      }

      // A correction rests in `Amending`, not `Draft` — through the real UPDATE.
      const corrected = contract.withPerioSite(amendChart, 14, 'B', { depth: 9 });
      const savedCorrection = await visitStore.savePerioDraft(sendClient, {
        office: 'roland', visit: amendVisit, chart: corrected, actor: ACTOR, amending: true,
      });
      if (savedCorrection.ok && savedCorrection.row.state === 'Amending') {
        ok('an unsent correction rests in Amending');
      } else {
        bad('an unsent correction rests in Amending', JSON.stringify(savedCorrection));
      }

      const amendDiff = contract.perioChartChanges(amendChart, corrected);
      const secondSend = await perioSendStore.createSend(sendClient, {
        office: 'roland',
        visitId: amendVisit.visitId,
        stagedWriteId: amendStaged.staged_write_id,
        patNum: 12828,
        examDate: '2026-09-08',
        provNum: 7,
        previewFingerprint: 'fp-correction',
        plan: contract.planPerioSend(corrected),
        actor: ACTOR,
        supersedesExamNum: 8001,
        amendDiff,
      });
      if (
        secondSend.supersedes_exam_num === 8001 &&
        secondSend.amend_diff.length === 1 &&
        secondSend.amend_diff[0].to === '9 mm'
      ) {
        ok('a correction records the exam it replaces and the sites it changes, through jsonb');
      } else {
        bad('a correction records what it replaces', JSON.stringify(secondSend.amend_diff));
      }

      await refusesInTx('a diff with nothing to replace', 'hyg_perio_send_amend_diff_check', () =>
        sendClient.query(
          `UPDATE hyg_perio_send SET supersedes_exam_num = NULL WHERE send_id = $1`,
          [secondSend.send_id]
        )
      );
      await refusesInTx('a send that supersedes the exam it created', 'hyg_perio_send_supersedes_self_check', () =>
        sendClient.query(
          `UPDATE hyg_perio_send SET exam_num = 8001, state = 'filling' WHERE send_id = $1`,
          [secondSend.send_id]
        )
      );
      await refusesInTx('a delete recorded for an exam nothing replaced', 'hyg_perio_send_supersedes_check', () =>
        sendClient.query(
          `UPDATE hyg_perio_send SET supersedes_deleted_at = now() WHERE send_id = $1`,
          [firstSend.send_id]
        )
      );

      // The swap's last step, and the fact that it is a SEPARATE step.
      await perioSendStore.markFilling(sendClient, { office: 'roland', sendId: secondSend.send_id, examNum: 8002 });
      await perioSendStore.finishSend(sendClient, { office: 'roland', sendId: secondSend.send_id, state: 'written' });
      const beforeSwap = await perioSendStore.getLiveSend(sendClient, {
        office: 'roland', stagedWriteId: amendStaged.staged_write_id,
      });
      const valleySwaps = await perioSendStore.markSupersededDeleted(sendClient, {
        office: 'valley', sendId: secondSend.send_id,
      });
      const swapped = await perioSendStore.markSupersededDeleted(sendClient, {
        office: 'roland', sendId: secondSend.send_id,
      });
      const twice = await perioSendStore.markSupersededDeleted(sendClient, {
        office: 'roland', sendId: secondSend.send_id,
      });
      const afterSwap = await perioSendStore.getLiveSend(sendClient, {
        office: 'roland', stagedWriteId: amendStaged.staged_write_id,
      });
      if (
        beforeSwap.exam_num === 8002 && beforeSwap.supersedes_deleted_at === null &&
        !valleySwaps && swapped && !twice && afterSwap.exam_num === 8002 &&
        afterSwap.supersedes_deleted_at !== null
      ) {
        ok('a verified correction is the live exam, and the replaced one is recorded gone exactly once');
      } else {
        bad(
          'the swap record',
          JSON.stringify({
            liveBefore: beforeSwap.exam_num,
            deletedBefore: beforeSwap.supersedes_deleted_at,
            liveAfter: afterSwap.exam_num,
            deletedAfter: afterSwap.supersedes_deleted_at,
            valleySwaps, swapped, twice,
          })
        );
      }

      // Abandoning one: back to Written, with the readings Open Dental holds.
      await visitStore.beginPerioAmendment(sendClient, { office: 'roland', visitId: amendVisit.visitId });
      const composedBack = composer.compose('perio', {
        visit: amendVisit, items: [], actor: ACTOR, draft: { chart: amendChart },
      });
      const liveNow = await perioSendStore.getLiveSend(sendClient, {
        office: 'roland', stagedWriteId: amendStaged.staged_write_id,
      });
      const restoredRef = perioSend.writtenRefFor(liveNow, amendChart);
      const cancelled = await visitStore.cancelPerioAmendment(sendClient, {
        office: 'roland', visit: amendVisit, chart: amendChart, composed: composedBack, actor: ACTOR,
        writtenRef: restoredRef,
      });
      const backRow = await visitStore.getStagedWrite(sendClient, {
        office: 'roland', visitId: amendVisit.visitId, kind: 'perio',
      });
      const cancelAgain = await visitStore.cancelPerioAmendment(sendClient, {
        office: 'roland', visit: amendVisit, chart: amendChart, composed: composedBack, actor: ACTOR,
        writtenRef: restoredRef,
      });
      if (
        cancelled && backRow.state === 'Written' && !cancelAgain &&
        backRow.written_ref === restoredRef &&
        contract.perioChartChanges(amendChart, backRow.payload.chart).length === 0
      ) {
        ok('an abandoned correction returns the chart to Written, with its reference and the readings Open Dental holds');
      } else {
        bad(
          'abandoning a correction',
          JSON.stringify({ cancelled, state: backRow.state, written_ref: backRow.written_ref, cancelAgain })
        );
      }

      await refusesInTx('a staged-write state the CHECK does not know', 'hyg_staged_write_state_check', () =>
        sendClient.query(
          `UPDATE hyg_staged_write SET state = 'Amended' WHERE staged_write_id = $1`,
          [amendStaged.staged_write_id]
        )
      );
    } finally {
      await sendClient.query('ROLLBACK');
      sendClient.release();
    }
    const leftover = await pool.query('SELECT count(*)::int AS n FROM hyg_perio_send');
    if (leftover.rows[0].n === 0) ok('the send rehearsal left nothing behind');
    else bad('the send rehearsal left rows behind', String(leftover.rows[0].n));

    // ── 7. the cascade, and cleanup ─────────────────────────────────────────
    await pool.query('DELETE FROM hyg_visit WHERE created_by = $1', [ACTOR]);
    const orphans = await pool.query(
      `SELECT (SELECT count(*)::int FROM hyg_treatment_item) AS items,
              (SELECT count(*)::int FROM hyg_staged_write) AS staged`
    );
    if (orphans.rows[0].items === 0 && orphans.rows[0].staged === 0) {
      ok('deleting a visit cascades to its items and staged writes');
    } else {
      bad('deleting a visit cascades', JSON.stringify(orphans.rows[0]));
    }
  } catch (err) {
    bad('rehearsal threw', (err && err.message) || String(err));
  } finally {
    await pool.end();
  }

  console.log(`\n[rehearse-hyg-visit] ${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

// Guarded, so requiring this file (a future test, a runbook) does not run it.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };
