'use strict';

/*
 * The one constant the two D-7 scripts must agree on, and NOTHING ELSE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN FILE
 * ─────────────────────────────────────────────────────────────────────────────
 * The write probe and the read sweep have to target the SAME ids — two scripts
 * disagreeing about which ids to check would make the sweep worthless, since it
 * would be proving that ids nobody wrote to were not written to.
 *
 * The sweep used to get that agreement by importing the probe. That is what made
 * the 2026-08-24 staging run re-issue every write verb from inside a script named
 * "read sweep": the probe called `main()` at module load, so importing it ran it.
 * Both scripts now guard `main()` behind `require.main === module`, but the
 * deeper fix is that neither has any reason to import the other at all.
 *
 * So: one constant, no requires, no side effects. There is nothing here that
 * importing could run.
 */

/**
 * Far outside any real Open Dental id range in either practice — the id the
 * probe writes to precisely because it does not exist, and the id the sweep
 * re-reads to prove nothing appeared at it.
 * @type {number}
 */
const GHOST = 999888777;

module.exports = { GHOST };
