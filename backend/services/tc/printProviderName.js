'use strict';

/**
 * The provider's FULL NAME for a printout (excuse letter, appointment card).
 *
 * WHY. A checkout record stores the provider the way the hygiene day view and
 * the schedule sweep label one: services/hyg/odDay.js#readProviderLabels takes
 * Open Dental's `Abbr` first ("JF"), and only falls back to "FName LName" when a
 * provider has no abbreviation. That is the right label for a card on a busy
 * screen and the wrong one for a letter a school or employer reads, which
 * should be signed "Dr. Jane Example". So the printout looks the abbreviation
 * up again in the same office's provider list and prints the name.
 *
 * WHOSE. The office is the STORED record's (the caller passes the checkout
 * row's office, already matched to the request by requireOffice) and the
 * client is that office's own, office-checked, through
 * routes/tc/checkoutAppointments.js#odGetForOffice. Nothing in a request can
 * choose which practice's list is read.
 *
 * READ-ONLY BY CONSTRUCTION. The only transport is that GET-only closure
 * (client.apiGetRaw). One request, `GET /providers`, served from the hour-long
 * per-office practice-configuration cache (services/odConfigCache.js) the day
 * view already fills, so a warm cache costs no Open Dental request at all.
 *
 * FAIL-SOFT, NEVER BLANK. A print must never wait on, or fail because of, an
 * Open Dental read. If the office has no OD connection, the read fails or runs
 * past PRINT_LOOKUP_DEADLINE_MS, nothing matches, two providers match with
 * different names, or the match has no name on it, the answer is EXACTLY what
 * printed before this file existed: the stored value, trimmed. Never an empty
 * signature, never a guess.
 *
 * "Dr." is for doctors. A provider Open Dental flags `IsHygienist` (the excuse
 * names who the patient was SEEN by, which on a hygiene visit is the
 * hygienist) prints as "FName LName", without a title that is not theirs.
 */

const odDay = require('../hyg/odDay');
const odConfigCache = require('../odConfigCache');
const { odGetForOffice } = require('../../routes/tc/checkoutAppointments');

/**
 * How long a print will wait for the provider list before printing the
 * abbreviation. The read itself is not cancelled; if it completes cleanly it
 * still fills the cache, so the next print has the name.
 */
const PRINT_LOOKUP_DEADLINE_MS = 4000;

/** Open Dental answers booleans as true/false or as the STRINGS "true"/"false". */
function odFlag(v) {
  return v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
}

/** @param {unknown} v @returns {string} */
function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * One OD provider row → its printed name, or '' when it has none. Pure.
 * @param {Record<string, unknown>} r
 * @returns {string}
 */
function printedNameOf(r) {
  const name = [text(r.FName), text(r.LName)].filter(Boolean).join(' ');
  if (!name) return '';
  return odFlag(r.IsHygienist) ? name : `Dr. ${name}`;
}

/**
 * The stored label → the full name, from a provider list. Pure.
 *
 * Matches the way the label was MADE (readProviderLabels): on `Abbr`, and —
 * only when no abbreviation matches — on "FName LName" for a provider that had
 * no abbreviation. More than one distinct name for the label is ambiguity, and
 * ambiguity is a refusal: the label prints as stored.
 *
 * @param {unknown[]} rows Open Dental's /providers rows
 * @param {string} label the stored provider label, trimmed
 * @returns {string|null} the full name, or null when there is no single answer
 */
function fullNameFromRows(rows, label) {
  if (!label) return null;
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object');
  let hits = list.filter((r) => text(r.Abbr) === label);
  if (hits.length === 0) {
    hits = list.filter((r) => !text(r.Abbr) && [text(r.FName), text(r.LName)].filter(Boolean).join(' ') === label);
  }
  const names = new Set(hits.map(printedNameOf));
  if (names.size !== 1) return null;
  const [name] = names;
  return name || null;
}

/** Resolves to `fallback` after `ms`, unless `promise` settles first. */
function withDeadline(promise, ms, fallback) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The name a printout signs with. Never throws, never returns '' for a
 * non-empty label.
 *
 * @param {string} office the STORED record's office key
 * @param {string} stored the record's provider label (providerSeen, else provider)
 * @param {{ deadlineMs?: number }} [opts]
 * @returns {Promise<string>}
 */
async function printProviderName(office, stored, opts = {}) {
  const label = typeof stored === 'string' ? stored.trim() : '';
  if (!label) return '';
  const deadlineMs = opts.deadlineMs ?? PRINT_LOOKUP_DEADLINE_MS;

  const lookup = (async () => {
    try {
      const odGet = odGetForOffice(office);
      const { rows } = await odConfigCache.getList(office, 'providers', () => odDay.pagedList(odGet, '/providers'));
      return fullNameFromRows(rows, label);
    } catch (err) {
      // Not connected, unknown office, transport threw: print what printed before.
      console.warn(
        `[tc/checkout/print] office=${office} provider name lookup failed; printing the stored label: ${
          (err && (err.code || err.name)) || 'error'
        }`
      );
      return null;
    }
  })();

  const name = await withDeadline(lookup, deadlineMs, null);
  return name || label;
}

module.exports = { printProviderName, fullNameFromRows, printedNameOf, PRINT_LOOKUP_DEADLINE_MS };
