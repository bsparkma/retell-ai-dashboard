'use strict';

/**
 * /api/rcm/comparison — reading back the shadow-mode comparison (Stage C-2).
 *
 *   GET /api/rcm/comparison/tally?office=…              the running count, for the biller
 *   GET /api/rcm/comparison/summary?office=&from=&to=   the whole picture, for an admin
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY TWO READS OVER ONE SET OF COLUMNS
 * ─────────────────────────────────────────────────────────────────────────────
 * They are read by two people, for two purposes, at two tiers.
 *
 * The TALLY is the sentence under the yes/no ask on a check: *18 checks
 * compared, 17 marked the same and 1 marked off.* It is what makes the click
 * feel like it went somewhere, and it runs on `rcm.queue` — the tier that
 * already marks a claim reviewed — because the person answering must be able to
 * see her own running count. It carries COUNTS and one date, and no note: she
 * wrote them and can read them on the checks themselves; a tally is a tally.
 *
 * The SUMMARY is the evidence somebody weighs before switching posting on. It
 * carries the checks that did NOT match, with the reason and the sentence, and
 * it runs on `rcm.settings` — **admin only**, the same tier as the switch it
 * informs, narrower than the `rcm.post` that presses Post. That is deliberate:
 * an exit criterion read beside the control it justifies is one screen, and the
 * read being gated means the card is ABSENT rather than greyed for everybody
 * else, on the idiom `officeSettings.js` already established.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NUMBER THAT MATTERS IS `matchedRun`
 * ─────────────────────────────────────────────────────────────────────────────
 * Not a percentage, and deliberately never one. Shadow mode's exit criterion is
 * a RUN of checks that matched — *the last N in a row were the same* — because
 * that is the shape of the question being asked: has it stopped getting things
 * wrong? An average cannot answer that. Nine matches followed by a difference
 * averages 90% and means the opposite of nine matches following a difference.
 *
 * So the run is computed here, server-side, from the answers ordered newest
 * first, and shipped as a number rather than left for a reader to count.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT READS. IT CANNOT REACH POSTING.
 * ─────────────────────────────────────────────────────────────────────────────
 * Two SELECTs against `rcm_payment_batches`, no Open Dental client, no
 * `rcm_posting_queue` write, and nothing here is read by `postingDrain`.
 *
 * NO REAL PATIENT DATA anywhere in this file.
 */

const express = require('express');

// Namespace import — see the note in summary.js.
const tenantDb = require('../../platform/tenantDb');
const { h, auditRcmRead, iso, isoDate } = require('./helpers');
const { describeActors } = require('../../services/rcm/rcmUserMap');
const { requirePermission } = require('../../config/permissions');

const router = express.Router();

/**
 * The columns both reads name. No `SELECT *` in this repo.
 *
 * `check_number`, `payer` and `deposit_date` are here for the summary only —
 * a row saying "a check differed on Aug 22" that nobody can find again is a
 * report about nothing. None of the three is patient data.
 */
const COMPARISON_COLUMNS = [
  'batch_id',
  'check_number',
  'payer',
  'deposit_date',
  'comparison_verdict',
  'comparison_reason',
  'comparison_note',
  'comparison_by',
  'comparison_at',
  'comparison_revision',
].join(', ');

/**
 * Every answered check for one office, newest answer first.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE DATE RANGE IS NOT IN THE WHERE
 * ─────────────────────────────────────────────────────────────────────────────
 * `comparison_at` is a `timestamptz` and the range a person means by "Aug 1 to
 * Aug 22" is in the OFFICE's day boundaries, not UTC's — so the SQL form would
 * be `(comparison_at AT TIME ZONE $n)::date BETWEEN …`. That is one more dialect
 * for every reader of this module to hold, and it would buy nothing: the
 * population is the checks somebody has ANSWERED during a shadow period, which
 * is tens of rows, already narrowed by office and already served by the partial
 * index. The range is applied in JS, once, where the timezone rule is a line of
 * code somebody can read rather than a cast.
 *
 * It stops being the right call the day this is asked over a year of two
 * practices. It is not the right call to pre-build that.
 *
 * @param {{ query: Function }} client
 * @param {string} office
 */
async function answeredChecks(client, office) {
  const { rows } = await client.query(
    `SELECT ${COMPARISON_COLUMNS} FROM rcm_payment_batches ` +
      `WHERE office_id = $1 AND comparison_at IS NOT NULL ORDER BY comparison_at DESC`,
    [office]
  );
  return rows;
}

/** The office's day boundaries — the same env every date in this module uses. */
const officeTz = () => process.env.OFFICE_TIMEZONE || 'America/Chicago';

/**
 * One instant as the office's own calendar day, `YYYY-MM-DD`.
 *
 * `en-CA` formats as YYYY-MM-DD, which is what makes a string comparison
 * against `from`/`to` a date comparison. An invalid `OFFICE_TIMEZONE` falls back
 * to UTC rather than throwing: a summary off by at most a day at its edges is a
 * report somebody can still read, and a 500 is not.
 *
 * @param {Date|string|null} at
 * @returns {string|null}
 */
function officeDay(at) {
  if (at == null) return null;
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: officeTz(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** `YYYY-MM-DD` from a query param, or null for "no bound". */
function dateBound(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * HOW MANY OF THE MOST RECENT ANSWERS IN A ROW WERE `same`.
 *
 * The shadow exit criterion, as a number. Counts from the newest answer
 * backwards and stops at the first `differed`; a set with no answers at all is
 * 0, which reads correctly as "nothing has matched in a row yet" rather than as
 * a perfect record.
 *
 * Computed over the WHOLE office's answers and never over a filtered range — a
 * run that a `from` date happens to cut in half is not a run, and reporting one
 * would overstate exactly the thing this number exists to be honest about.
 *
 * @param {ReadonlyArray<{ comparison_verdict: string }>} newestFirst
 * @returns {number}
 */
function matchedRun(newestFirst) {
  let n = 0;
  for (const row of newestFirst) {
    if (row.comparison_verdict !== 'same') break;
    n += 1;
  }
  return n;
}

/** The counts both endpoints report, over whatever set they were handed. */
function countOf(rows) {
  return {
    compared: rows.length,
    same: rows.filter((r) => r.comparison_verdict === 'same').length,
    differed: rows.filter((r) => r.comparison_verdict === 'differed').length,
  };
}

// ─── GET /tally — the running count under the ask ────────────────────────────

/**
 * The sentence beneath the yes/no on a check.
 *
 * `rcm.queue` — an EXPLICIT gate rather than the mount's read tier, on the rule
 * `rcmGuard.test.js` holds: a route that a narrower reading of the module might
 * later want to open must say for itself who may reach it. `rcm.queue` is the
 * tier that marks a claim reviewed; reviewer, rcm_biller, office and admin all
 * hold it, and the person answering the question is by definition one of them.
 *
 * NO NOTES, and no per-check rows. A tally is counts and one date. The one
 * detail it does carry is the most recent difference's reason and day, because
 * "1 marked off" with no hint of which one reads as an accusation rather than
 * as a record.
 */
router.get(
  '/tally',
  requirePermission('rcm.queue'),
  h(async (req, res) => {
    const office = req.rcmOffice;

    const rows = await tenantDb.withTenantDb(req, (pool) => answeredChecks(pool, office));

    await auditRcmRead(req, 'rcm_comparison_tally', { office });

    const latest = rows.find((r) => r.comparison_verdict === 'differed') || null;

    return res.json({
      success: true,
      office,
      ...countOf(rows),
      matchedRun: matchedRun(rows),
      /**
       * The newest check that did not match — its slug and its day, and nothing
       * else. Null when every answer so far has been `same`, which the screen
       * reads as "there is no difference to name" rather than as a blank.
       */
      latestDifference: latest
        ? { reason: latest.comparison_reason || null, at: iso(latest.comparison_at) }
        : null,
    });
  })
);

// ─── GET /summary — the evidence behind switching posting on ─────────────────

/**
 * For a date range: how many checks were compared, how many matched, and the
 * ones that did not — with their reason and the biller's own sentence.
 *
 * `rcm.settings`, admin only. See the header.
 *
 * `from` and `to` are inclusive `YYYY-MM-DD` in the office's timezone, and
 * either may be omitted for an unbounded end. A malformed one is treated as
 * ABSENT rather than refused: this is a read whose whole job is to be pullable,
 * and a 400 over a date box would be a report somebody could not get.
 */
router.get(
  '/summary',
  requirePermission('rcm.settings'),
  h(async (req, res) => {
    const office = req.rcmOffice;
    const from = dateBound(req.query.from);
    const to = dateBound(req.query.to);

    const loaded = await tenantDb.withTenantDb(req, async (pool) => {
      const rows = await answeredChecks(pool, office);
      const actors = await describeActors(
        pool,
        rows.map((r) => r.comparison_by)
      );
      return { rows, actors };
    });

    await auditRcmRead(req, 'rcm_comparison_summary', { office });

    const { rows, actors } = loaded;
    const inRange = rows.filter((r) => {
      const day = officeDay(r.comparison_at);
      if (day == null) return false;
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    });

    return res.json({
      success: true,
      office,
      from,
      to,
      ...countOf(inRange),
      /**
       * THE NUMBER THAT MATTERS, and it is deliberately computed over the whole
       * office rather than over the range. See `matchedRun`.
       */
      matchedRun: matchedRun(rows),
      /** How many answers exist at all, so a range's counts can be read in context. */
      comparedAllTime: rows.length,
      /**
       * The checks that did not match. In range, newest first, with the slug,
       * the sentence and the check's own identifiers so somebody can go and look
       * at it.
       *
       * `answeredBy` falls back to the raw crosswalk key rather than to
       * "somebody", on the same contract `parkedBy` has: an un-crosswalked actor
       * is a fact worth seeing rather than one worth hiding.
       */
      differences: inRange
        .filter((r) => r.comparison_verdict === 'differed')
        .map((r) => ({
          batchId: String(r.batch_id),
          checkNumber: r.check_number || null,
          payer: r.payer || null,
          depositDate: isoDate(r.deposit_date),
          reason: r.comparison_reason || null,
          note: r.comparison_note || null,
          answeredAt: iso(r.comparison_at),
          answeredBy: r.comparison_by
            ? (actors[r.comparison_by] || {}).displayName || r.comparison_by
            : null,
          /** > 1 means the answer on this check was changed after it was first given. */
          revision: Number(r.comparison_revision) || 0,
        })),
    });
  })
);

module.exports = router;
module.exports.matchedRun = matchedRun;
module.exports.officeDay = officeDay;
