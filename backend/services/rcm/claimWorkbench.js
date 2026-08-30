'use strict';

/**
 * The workbench's view of one claim: who this is, what the chart holds, and
 * where the patient's number lands.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PURE, AND THAT IS THE POINT
 * ═════════════════════════════════════════════════════════════════════════════
 * Nothing here reads Open Dental, touches a database or looks at a request. It
 * assembles a view out of two things that have already been gathered and
 * stored: our own claim rows, and the match snapshot a human confirmed. That is
 * what lets the claim read, the approval gate and a unit test all produce the
 * same answer from the same facts — and it is why the gate cannot end up
 * disagreeing with the screen a biller just read.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IDENTITY IS A GATE CHECK, NOT A WARNING
 * ═════════════════════════════════════════════════════════════════════════════
 * A claim posted onto the wrong patient's chart is the worst outcome this module
 * has, and a name alone does not separate two people. So the workbench renders
 * the remittance's name, date of birth and subscriber id against Open Dental's,
 * and the answer feeds a gate check rather than a banner:
 *
 *   name or date of birth disagrees  → BLOCKING. The remedy is to match it up
 *                                      again, never an override.
 *   subscriber id disagrees alone    → reported, not blocking. Carriers reformat
 *                                      these constantly — dashes, leading
 *                                      letters, a member prefix stripped — and
 *                                      refusing on one would refuse most of a
 *                                      normal day's work for no safety gained.
 *
 * A field Open Dental did not send is NOT a mismatch. `patientBirthdate` and
 * `subscriberId` are both null when OD had nothing to say, and comparing against
 * a value nobody holds would manufacture a disagreement out of an absence — the
 * same failure `no_candidate` versus "examined, none offered" exists to avoid.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NAMES ARE COMPARED THE WAY A PERSON WOULD READ THEM
 * ═════════════════════════════════════════════════════════════════════════════
 * Open Dental spells a name `"Last, First"`; a remittance spells it however the
 * carrier's system does. Comparing those as strings would flag every single
 * claim. So both sides are reduced to a sorted set of alphabetic tokens, which
 * is the same reduction `claimMatch.nameTokens` already uses for scoring, and
 * the comparison asks whether one side's tokens are contained in the other's —
 * a middle name on one side and not the other is not two different people.
 */

const { nameTokens } = require('./claimMatch');
const lineDecisions = require('./lineDecisions');

/**
 * Is what the remittance calls this patient compatible with what Open Dental
 * calls them?
 *
 * Containment either way, over the sorted token sets. `"Smith, Joanna R"` and
 * `"JOANNA SMITH"` agree; `"Smith, Joanna"` and `"Smith, Jonathan"` do not.
 * Either side being empty is NOT agreement — an unnamed patient is a fact to
 * report, not a match.
 *
 * @param {unknown} ours
 * @param {unknown} theirs
 * @returns {boolean}
 */
function namesAgree(ours, theirs) {
  const a = nameTokens(ours);
  const b = nameTokens(theirs);
  if (a.length === 0 || b.length === 0) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  return a.every((t) => setB.has(t)) || b.every((t) => setA.has(t));
}

/**
 * The identity block: three facts, side by side, each with a verdict.
 *
 * Every field reports one of three states, and the third is why this is not a
 * boolean: `agrees`, `differs`, and `unknown` — Open Dental sent nothing, or we
 * have no confirmed candidate to read from. `unknown` never blocks, because
 * refusing on an absence is refusing on nothing.
 *
 * @param {{ patientName?: unknown, patientDob?: unknown, subscriberId?: unknown }} claim
 * @param {{ od?: Record<string, unknown> }|null} candidate the confirmed candidate
 * @returns {{
 *   matched: boolean,
 *   blocking: boolean,
 *   fields: Array<{ field: 'name'|'dob'|'subscriber', label: string,
 *                   eob: string|null, od: string|null,
 *                   status: 'agrees'|'differs'|'unknown', blocking: boolean }>,
 * }}
 */
function identityFor(claim, candidate) {
  const od = (candidate && candidate.od) || null;

  const text = (value) => {
    if (value == null) return null;
    const s = String(value).trim();
    return s.length > 0 ? s : null;
  };

  const eobName = text(claim && claim.patientName);
  const odName = text(od && od.patientName);
  const eobDob = text(claim && claim.patientDob);
  const odDob = text(od && od.patientBirthdate);
  const eobSub = text(claim && claim.subscriberId);
  const odSub = text(od && od.subscriberId);

  /**
   * `agrees` / `differs` / `unknown`, from a pair and a comparison.
   * EITHER side missing is `unknown`: an absence is not a disagreement.
   */
  const state = (ours, theirs, agree) => {
    if (ours == null || theirs == null) return 'unknown';
    return agree(ours, theirs) ? 'agrees' : 'differs';
  };

  const nameState = state(eobName, odName, namesAgree);
  /*
   * DATES ARE COMPARED AS DAYS, and both sides are already day strings:
   * `rcm_claims.patient_dob` is a `date` column, and `claimMatch.odBirthdate`
   * takes the date part only precisely so an instant can never print — or
   * compare as — the wrong day for anybody east of UTC.
   */
  const dobState = state(eobDob, odDob, (a, b) => a.slice(0, 10) === b.slice(0, 10));
  /*
   * SUBSCRIBER IDS ARE COMPARED WITH THEIR PUNCTUATION AND CASE REMOVED, and
   * are reported rather than blocking either way. `ABC-123456` and `abc123456`
   * are one id written by two systems; even when they genuinely differ, the
   * ordinary cause is a carrier reformatting a member number, not the wrong
   * patient — the name and the date of birth are what identify a person.
   */
  const normalSub = (v) => v.replace(/[^a-z0-9]/gi, '').toUpperCase();
  const subState = state(eobSub, odSub, (a, b) => normalSub(a) === normalSub(b));

  const fields = [
    {
      field: 'name',
      label: 'Name',
      eob: eobName,
      od: odName,
      status: nameState,
      blocking: nameState === 'differs',
    },
    {
      field: 'dob',
      label: 'Date of birth',
      eob: eobDob,
      od: odDob,
      status: dobState,
      blocking: dobState === 'differs',
    },
    {
      field: 'subscriber',
      label: 'Subscriber ID',
      eob: eobSub,
      od: odSub,
      status: subState,
      /** Reported, never blocking. See the file header. */
      blocking: false,
    },
  ];

  return {
    /** True when nothing disagrees — including when everything is unknown. */
    matched: fields.every((f) => f.status !== 'differs'),
    blocking: fields.some((f) => f.blocking),
    fields,
  };
}

/**
 * What Open Dental holds for the confirmed claim, per line and in total.
 *
 * Read out of the SNAPSHOT, which is a record of an observation rather than a
 * cache to serve from — every figure here is stamped with when it was read and
 * the screen says so. The drain re-verifies against Open Dental at post time;
 * this is what the biller compares by eye, and labelling it as "as read on
 * <date>" is the difference between a comparison and a claim about now.
 *
 * @param {{ odClaimNum?: unknown }} claim
 * @param {Record<string, unknown>|null} snapshot the stored match snapshot
 * @returns {{
 *   odClaimNum: number|null, claimStatus: string|null, fetchedAt: string|null,
 *   billedCents: number|null, insPaidCents: number|null, writeOffCents: number|null,
 *   lines: Array<{ odClaimProcNum: number, code: string, status: string,
 *                  feeBilledCents: number, insEstCents: number|null,
 *                  insPayAmtCents: number, writeOffCents: number }>,
 * }|null}
 */
function chartFor(claim, snapshot) {
  const candidate = confirmedCandidate(claim, snapshot);
  if (!candidate) return null;
  const od = candidate.od || {};
  const lines = Array.isArray(od.lines) ? od.lines : [];

  return {
    odClaimNum: Number(candidate.odClaimNum) || null,
    claimStatus: od.claimStatus ? String(od.claimStatus) : null,
    fetchedAt: snapshot && snapshot.fetchedAt ? String(snapshot.fetchedAt) : null,
    billedCents: od.billedCents == null ? null : Number(od.billedCents),
    insPaidCents: od.insPaidCents == null ? null : Number(od.insPaidCents),
    writeOffCents: od.writeOffCents == null ? null : Number(od.writeOffCents),
    lines: lines
      /*
       * A DELETED LINE IS NOT PART OF WHAT THE CHART HOLDS, and `'unknown'` is
       * not `false`. `deleted === false` rather than `!deleted`, the same
       * comparison `pairLines` makes and for the same reason: a line whose
       * procedure could not be read may be a soft-deleted one, and putting it in
       * a side-by-side as though it were live invites a biller to reconcile
       * against a procedure that is not there.
       */
      .filter((l) => l && l.deleted === false)
      .map((l) => ({
        odClaimProcNum: Number(l.claimProcNum),
        code: String(l.code || ''),
        status: String(l.status || ''),
        feeBilledCents: Number(l.feeBilledCents) || 0,
        /** `null` = Open Dental has not calculated one. Never printed as $0. */
        insEstCents: l.insEstCents == null ? null : Number(l.insEstCents),
        insPayAmtCents: Number(l.insPayAmtCents) || 0,
        writeOffCents: Number(l.writeOffCents) || 0,
      })),
  };
}

/**
 * The candidate the human confirmed, or null.
 *
 * Found by the claim's own `od_claim_num` rather than by the snapshot's
 * `confirmed` block, so a snapshot whose confirmation was superseded cannot hand
 * back a candidate the claim is no longer linked to.
 */
function confirmedCandidate(claim, snapshot) {
  const odClaimNum = Number(claim && claim.odClaimNum);
  if (!Number.isFinite(odClaimNum) || odClaimNum <= 0) return null;
  const candidates = snapshot && Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
  return candidates.find((c) => Number(c.odClaimNum) === odClaimNum) || null;
}

/**
 * Our billed figure minus Open Dental's, per line id, from the confirmation.
 *
 * `linePairs` is written by `confirmMatch` and is the only place the two billed
 * figures were ever compared. A line with no pair contributes nothing here — its
 * absence from the chart is reported by `verdictFor` as its own problem, and
 * reporting it twice under two names would make one claim look like two.
 *
 * @returns {Map<string, number|null>}
 */
function feeDeltasByLine(snapshot) {
  const pairs =
    snapshot && snapshot.confirmed && Array.isArray(snapshot.confirmed.linePairs)
      ? snapshot.confirmed.linePairs
      : [];
  const out = new Map();
  for (const pair of pairs) {
    if (!pair || typeof pair.lineId !== 'string') continue;
    out.set(pair.lineId, pair.billedDeltaCents == null ? null : Number(pair.billedDeltaCents));
  }
  return out;
}

/**
 * The whole workbench view for one claim.
 *
 * @param {{
 *   claim: Record<string, unknown>,
 *   lines: ReadonlyArray<Record<string, unknown>>,
 *   snapshot: Record<string, unknown>|null,
 *   register?: 'projection'|'confirmed',
 * }} input
 * @returns {{ identity: ReturnType<typeof identityFor>,
 *             chart: ReturnType<typeof chartFor>,
 *             verdict: ReturnType<typeof lineDecisions.verdictFor> }}
 */
function buildWorkbenchView({ claim, lines = [], snapshot = null, register = 'projection' }) {
  const candidate = confirmedCandidate(claim, snapshot);
  const deltas = feeDeltasByLine(snapshot);

  return {
    identity: identityFor(claim, candidate),
    chart: chartFor(claim, snapshot),
    verdict: lineDecisions.verdictFor({
      register,
      lines: lines.map((line) => ({
        lineId: line.lineId,
        code: line.billedCode || line.code,
        billedCents: line.billedCents,
        allowedCents: line.allowedCents,
        paidCents: line.paidCents,
        decision: line.decision,
        decisionReason: line.decisionReason,
        decidedBy: line.decidedBy,
        decidedAt: line.decidedAt,
        odClaimProcNum: line.odClaimProcNum,
        /*
         * `undefined` when this line was never paired — which `verdictFor`
         * treats as "nothing to compare", and the missing pairing is already
         * reported by the `odClaimProcNum == null` branch there. A line paired
         * with an unknown delta (a snapshot from before the field existed)
         * lands here as null and is likewise not judged.
         */
        odFeeDeltaCents: deltas.has(line.lineId) ? deltas.get(line.lineId) : null,
      })),
    }),
  };
}

module.exports = {
  namesAgree,
  identityFor,
  chartFor,
  confirmedCandidate,
  feeDeltasByLine,
  buildWorkbenchView,
};
