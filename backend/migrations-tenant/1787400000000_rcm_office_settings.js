'use strict';

/**
 * The shadow gate — a per-office switch that decides whether the drain may
 * write to Open Dental at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS COLUMNS ON AN EXISTING TABLE, NOT A NEW ONE
 * ─────────────────────────────────────────────────────────────────────────────
 * `rcm_office_settings` has existed since Slice 1 (`1786622400000_rcm_schema`)
 * and already means exactly this: one row per office, keyed on `office_id`,
 * holding what that practice runs under. It carries the VCC merchant fee today.
 * A second table would be a second answer to "what is configured for this
 * office", and the two would eventually disagree about which offices exist.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A ROW, WHEN §9 ALREADY REFUSES AN ENV VAR
 * ─────────────────────────────────────────────────────────────────────────────
 * `OFFICES_ENABLED_FOR_POSTING` is a CEILING: the list of practices whose
 * DefNums have been read from their own database, whose key's write groups have
 * been proven, and whose end-to-end has been run. It is a code change with the
 * evidence in the same commit, and this migration does not touch it.
 *
 * What it does not express is the OPERATOR's decision. Roland clears the
 * ceiling, and Roland still goes to production in SHADOW MODE: a real biller
 * works real EOBs end to end — upload, match, confirm, review, approve — while
 * a chart write stays impossible until a human decides otherwise. The ceiling
 * cannot say that, because it is a statement about validation rather than about
 * today.
 *
 * So there are TWO conditions on any Open Dental write in the drain, and both
 * must hold: the office is in the code-level ceiling AND this row says
 * `drain_enabled`. Neither can substitute for the other.
 *
 * §9 refuses an env var for the ceiling because a typo in an app setting would
 * open a practice nobody validated. This switch refuses one for a second
 * reason: an app setting is invisible to the people who work in the practice.
 * The biller working a shadow queue must be able to SEE that posting is off,
 * and the person who turns it on must leave a name and an instant behind. A
 * container restart must not change the answer, and a redeploy must not lose it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE SWITCH GETS ITS OWN TIMESTAMP
 * ─────────────────────────────────────────────────────────────────────────────
 * The table already has `updated_at` — the row's modification time, which a
 * merchant-fee edit moves too. "When was posting last switched" is a different
 * question from "when did this row last change", and answering the first with
 * the second would date the gate to whenever somebody last edited a VCC fee.
 * Hence `drain_updated_at` / `drain_updated_by`, paired.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** The least-privilege application role — same constant as every RCM migration. */
const APP_ROLE = process.env.AUDIT_APP_ROLE || 'carein_app';

/** The frozen office keys, identical to every other rcm_* office CHECK. */
const OFFICES = ['roland', 'valley'];

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('rcm_office_settings', {
    /**
     * THE SWITCH. `NOT NULL DEFAULT false`, so an office row that already
     * exists for its merchant fee arrives switched OFF without anyone deciding
     * — the only safe direction for a default that governs chart writes.
     */
    drain_enabled: { type: 'boolean', notNull: true, default: false },
    /**
     * When the SWITCH was last moved. Distinct from the row's `updated_at`, and
     * NULL until somebody moves it — "never switched" is a different fact from
     * "switched off at some instant", and the screen says so.
     */
    drain_updated_at: { type: 'timestamptz' },
    /**
     * Who moved it, as the D-5 crosswalk key every other actor column in this
     * schema uses, with the same `RESTRICT`: a person who authorised something
     * cannot be deleted out from under the record of it.
     */
    drain_updated_by: { type: 'text', references: 'rcm_user_map', onDelete: 'RESTRICT' },
  });

  /*
   * A CHANGE IMPLIES ITS EVIDENCE.
   *
   * The same pairing rule `blocked_reason` and the withdrawal columns carry: a
   * switch that says it was moved without saying by whom, or by whom without
   * saying when, is a decision nobody can account for. A row nobody has touched
   * carries neither.
   */
  pgm.addConstraint('rcm_office_settings', 'rcm_office_settings_drain_evidence_check', {
    check: `(drain_updated_at IS NULL AND drain_updated_by IS NULL)
            OR (drain_updated_at IS NOT NULL AND drain_updated_by IS NOT NULL)`,
  });

  /*
   * BOTH OFFICES GET A ROW, SWITCHED OFF.
   *
   * Seeded here rather than lazily by the app, so "no row" never becomes a
   * normal state the reader has to interpret — and `postingGate` treats a
   * missing row as OFF anyway, which is the one honest reading of "there is no
   * record of anyone switching this on".
   *
   * ON CONFLICT DO NOTHING because Slice 1 gave this table a purpose of its
   * own: a practice that already has a merchant-fee row keeps it, and the new
   * column's DEFAULT has already made that row's answer `false`.
   */
  pgm.sql(
    `INSERT INTO rcm_office_settings (office_id, drain_enabled) VALUES ` +
      `${OFFICES.map((o) => `('${o}', false)`).join(', ')} ` +
      `ON CONFLICT (office_id) DO NOTHING;`
  );

  /*
   * Re-assert the grant, as every migration in this module does. A column added
   * to a granted table inherits the table's grant, but saying so costs nothing
   * and the call_record gap is why this line is a habit here.
   */
  pgm.sql(`
    DO $$
    DECLARE r text := '${APP_ROLE}';
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I',
                       'rcm_office_settings', r);
        RAISE NOTICE 'rcm shadow gate: grants re-asserted on rcm_office_settings for role %', r;
      ELSE
        RAISE NOTICE 'rcm shadow gate: app role % absent — grants SKIPPED.', r;
      END IF;
    END $$;
  `);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  /*
   * ROLLS BACK CLEANLY, unlike the 6c/6d/withdraw rollbacks.
   *
   * Those refuse while a row uses a word the earlier vocabulary has no name
   * for. There is no such hazard here: dropping these columns takes the gate
   * back to "no switch", which the route reads as OFF — a rollback therefore
   * makes posting MORE restricted, never less. That is the safe direction, and
   * the reason this one needs no guard.
   *
   * The seeded rows are LEFT BEHIND on purpose. They are `rcm_office_settings`
   * rows for two real offices, which is what this table is for with or without
   * the switch; deleting them would take a practice's merchant-fee settings
   * with them if anyone had edited one.
   *
   * COLUMNS LAST. Postgres silently drops a CHECK when a column it references
   * goes, so dropping the columns first would make the explicit
   * `dropConstraint` fail — the ordering bug PR #113's rollback found by being
   * run.
   */
  pgm.dropConstraint('rcm_office_settings', 'rcm_office_settings_drain_evidence_check');
  pgm.dropColumns('rcm_office_settings', [
    'drain_enabled',
    'drain_updated_at',
    'drain_updated_by',
  ]);
};

module.exports.OFFICES = OFFICES;
