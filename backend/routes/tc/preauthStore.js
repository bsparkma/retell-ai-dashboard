'use strict';

/**
 * Pre-auth data access that crosses into tc_cases. Every query is
 * office-scoped; every column is named; every value is a parameter.
 *
 * WHY. tc_preauth_cases.case_id has a foreign key to tc_cases(case_id) ALONE
 * (1785373200000_tc_schema), not to (office_id, case_id), so the database
 * accepts a link to ANOTHER office's case. The office check therefore lives
 * here, and both routes that take a client-typed case id (create and PUT) ask
 * it before writing.
 */

/**
 * Is this case id a case IN THIS OFFICE? A case that exists only in the other
 * office answers exactly like one that does not exist at all, so the caller's
 * refusal cannot be used to learn about the other office's cases.
 * @param {{ query: Function }} q
 * @returns {Promise<boolean>}
 */
async function caseInOffice(q, office, caseId) {
  const res = await q.query('SELECT case_id FROM tc_cases WHERE office_id = $1 AND case_id = $2', [office, caseId]);
  return res.rows.length > 0;
}

/**
 * Pre-auths already linked to a case in ANOTHER office (written before this
 * check existed). Read only; counts only, per pre-auth office — no ids, no
 * names. For the report and the cleanup decision; nothing here changes data.
 */
const CROSS_OFFICE_LINKS_SQL = `SELECT p.office_id AS preauth_office, c.office_id AS case_office, count(*)::int AS n
  FROM tc_preauth_cases p
  JOIN tc_cases c ON c.case_id = p.case_id
 WHERE p.case_id IS NOT NULL AND c.office_id <> p.office_id
 GROUP BY p.office_id, c.office_id
 ORDER BY p.office_id, c.office_id`;

/**
 * @param {{ query: Function }} q
 * @returns {Promise<{ total: number, pairs: Array<{ preauthOffice: string, caseOffice: string, count: number }> }>}
 */
async function countCrossOfficeCaseLinks(q) {
  const res = await q.query(CROSS_OFFICE_LINKS_SQL);
  const pairs = res.rows.map((r) => ({ preauthOffice: r.preauth_office, caseOffice: r.case_office, count: Number(r.n) }));
  return { total: pairs.reduce((s, p) => s + p.count, 0), pairs };
}

module.exports = { caseInOffice, countCrossOfficeCaseLinks, CROSS_OFFICE_LINKS_SQL };
