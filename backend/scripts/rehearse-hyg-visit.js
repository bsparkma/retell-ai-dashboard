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

const { Pool } = require('pg');

const visitStore = require('../services/hyg/visitStore');
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

    // Slice 3 will set these together, and the database permits exactly that.
    await pool.query(
      `UPDATE hyg_staged_write SET state = 'Written', sent_by = $2, sent_at = now()
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
