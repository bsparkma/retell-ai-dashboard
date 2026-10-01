'use strict';

/**
 * ARCHIVE A CHECK THAT NEVER WENT ANYWHERE — the third way off the board, for
 * the narrow case the first two don't cover.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A THIRD STATE, WHEN PARK AND SET-ASIDE EXIST
 * ─────────────────────────────────────────────────────────────────────────────
 * A test upload, a wrong office's PDF, a duplicate scan caught before anybody
 * worked it — these checks have no posting history and never will, and the
 * owner wants them OFF the board entirely: out of Today, out of the Checks
 * tabs, out of every count. Set-aside deliberately does less than that (it
 * stays under `view=all`, because a set-aside check is still a real check that
 * explains real money). An archived check explains nothing: nothing was queued,
 * nothing posted, no plan exists. Hiding it hides no money BY CONSTRUCTION,
 * and the route enforces that construction — any posting history refuses.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A STATUS, NEVER A DELETE
 * ─────────────────────────────────────────────────────────────────────────────
 * Three stamp columns on `rcm_payment_batches`, the same shape as `set_aside_*`
 * (1787500000000). The row, its claims, its lines and its blob all stay exactly
 * where they are; `audit_log` is untouched as ever. Unarchiving clears the
 * stamps and the check rejoins every list it left.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHIVING FREES THE DUP-HASH — the one effect beyond the stamps
 * ─────────────────────────────────────────────────────────────────────────────
 * The whole point of archiving a test check is that the same file can come in
 * again, cleanly. EOB dedupe lives on `rcm_eob_uploads` (the behavioural probe
 * in routes/rcm/eob.js plus the partial unique index below); ERA dedupe lives
 * on `rcm_remittance_keys` (released by the route, no schema change needed).
 * So this migration:
 *
 *   1. widens the `rcm_eob_uploads.status` CHECK with `archived`, and
 *   2. rebuilds `rcm_eob_uploads_office_hash_unique` so an `archived` upload
 *      no longer holds its hash — the same partiality `failed` already has,
 *      for the same reason: a row that no longer blocks a re-upload must not
 *      block it at the index either, or the race-loser gets a 23505 where the
 *      probe said "go ahead".
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** The least-privilege application role — same constant as every RCM migration. */
const APP_ROLE = process.env.AUDIT_APP_ROLE || 'carein_app';

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.addColumns('rcm_payment_batches', {
    archived_at: { type: 'timestamptz' },
    /** The crosswalk key, with the same RESTRICT FK every actor column carries (D-5). */
    archived_by: { type: 'text', references: 'rcm_user_map', onDelete: 'RESTRICT' },
    /**
     * REQUIRED — her own line about why ("test upload", "wrong office's file").
     * Free text rather than a slug: the set-aside slugs exist because "why would
     * nobody work this" has a small argued-about answer set, and "why is this
     * check not a real piece of work" does not — it is one sentence, every time.
     * PHI-capable by nature, so never copied into an audit row or a log line.
     */
    archived_reason: { type: 'text' },
  });

  /*
   * ARCHIVED IMPLIES ITS EVIDENCE, IN BOTH DIRECTIONS — the same pairing the
   * parked and set-aside stamps carry, for the same reason: a stamp with no
   * actor is a state no screen can attribute, and a reason left behind on an
   * unarchived row is prose about a state the row is not in.
   */
  pgm.addConstraint('rcm_payment_batches', 'rcm_payment_batches_archived_check', {
    check: `(archived_at IS NOT NULL AND archived_by IS NOT NULL AND archived_reason IS NOT NULL)
            OR (archived_at IS NULL AND archived_by IS NULL AND archived_reason IS NULL)`,
  });

  /*
   * Partial, like the set-aside index and on the same argument: every list read
   * already filters office_id, archived rows are the small minority, and the
   * only new question is "which of this office's checks are archived".
   */
  pgm.createIndex('rcm_payment_batches', 'archived_at', {
    name: 'rcm_payment_batches_archived_idx',
    where: 'archived_at IS NOT NULL',
  });

  // ── The EOB dedupe surface learns the word `archived` ──────────────────────

  pgm.sql(`
    ALTER TABLE rcm_eob_uploads DROP CONSTRAINT rcm_eob_uploads_status_check;
  `);
  pgm.addConstraint('rcm_eob_uploads', 'rcm_eob_uploads_status_check', {
    check: "status IN ('uploaded','processing','extracted','failed','archived')",
  });

  /*
   * REBUILT, NOT ALTERED — Postgres cannot change a partial index's predicate
   * in place. Dropping and recreating inside one migration transaction means
   * no window where two uploads of one file could both insert.
   */
  pgm.dropIndex('rcm_eob_uploads', ['office_id', 'file_hash'], {
    name: 'rcm_eob_uploads_office_hash_unique',
  });
  pgm.createIndex('rcm_eob_uploads', ['office_id', 'file_hash'], {
    name: 'rcm_eob_uploads_office_hash_unique',
    unique: true,
    where: "status NOT IN ('failed', 'archived') AND file_hash IS NOT NULL",
  });

  // Re-assert the grants, as every migration in this module does.
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON rcm_payment_batches TO ${APP_ROLE};`);
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON rcm_eob_uploads TO ${APP_ROLE};`);
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  /*
   * `archived` IS a word in the uploads' status vocabulary, so this `down`
   * follows the withdraw migration's rule rather than the set-aside one: it
   * refuses while any row uses the word, because rolling the vocabulary back
   * under a live row leaves a row no constraint recognises. Unarchive the
   * checks first — the route restores the uploads to `extracted` — and the
   * rollback then runs clean.
   */
  pgm.sql(`
    DO $$
    DECLARE n integer;
    BEGIN
      SELECT count(*) INTO n FROM rcm_eob_uploads WHERE status = 'archived';
      IF n > 0 THEN
        RAISE EXCEPTION
          'rcm_eob_uploads holds % archived row(s). Unarchive those checks first — '
          'rolling the status vocabulary back under them would leave rows no constraint recognises.',
          n;
      END IF;
    END $$;
  `);

  pgm.dropIndex('rcm_eob_uploads', ['office_id', 'file_hash'], {
    name: 'rcm_eob_uploads_office_hash_unique',
  });
  pgm.createIndex('rcm_eob_uploads', ['office_id', 'file_hash'], {
    name: 'rcm_eob_uploads_office_hash_unique',
    unique: true,
    where: "status <> 'failed' AND file_hash IS NOT NULL",
  });

  pgm.dropConstraint('rcm_eob_uploads', 'rcm_eob_uploads_status_check');
  pgm.addConstraint('rcm_eob_uploads', 'rcm_eob_uploads_status_check', {
    check: "status IN ('uploaded','processing','extracted','failed')",
  });

  // Constraints before columns — the PR #113 ordering rule.
  pgm.dropIndex('rcm_payment_batches', 'archived_at', {
    name: 'rcm_payment_batches_archived_idx',
  });
  pgm.dropConstraint('rcm_payment_batches', 'rcm_payment_batches_archived_check');
  pgm.dropColumns('rcm_payment_batches', ['archived_at', 'archived_by', 'archived_reason']);
};
