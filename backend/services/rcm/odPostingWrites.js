'use strict';

/**
 * RCM Slice 6c — THE ONLY FILE IN THIS PLATFORM'S RCM MODULE THAT WRITES TO A
 * PATIENT'S CHART.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * READ THIS BEFORE CHANGING ANYTHING BELOW
 * ═════════════════════════════════════════════════════════════════════════════
 * Slices 1–6b built a remittance review system that had never touched Open
 * Dental with anything but a GET, and `routes/rcm/rcmNoOdWrites.test.js` proved
 * it by driving the whole surface against a client whose every write verb threw.
 * That test still exists and still passes — it now carries an allow-list of
 * exactly ONE file, and this is that file.
 *
 * Nothing else in `services/rcm/` or `routes/rcm/` may name `apiWriteRaw`, and
 * the test fails the build if a second file does. The reason is not tidiness: a
 * second writer is a second policy about when money moves, and the second one is
 * always the one nobody reviewed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY CALL HERE IS ONE THE SPIKE 0b TRANSCRIPT EXECUTED
 * ─────────────────────────────────────────────────────────────────────────────
 * `docs/RCM_OD_WRITES.md` is not a design document. It is a transcript of 13
 * live write tests against the Roland practice database on 2026-08-13, with the
 * refusals quoted verbatim. Every verb, every field name and every constraint
 * below traces to a numbered test in it:
 *
 *   PUT  /claimprocs/{n}    {Status, InsPayAmt, WriteOff, DedApplied}   test 2
 *   PUT  /claims/{n}        {ClaimStatus:"R", DateReceived}             test 3
 *   POST /claimpayments     {claimNum, CheckAmt, PayType, CheckNum}     test 4
 *   POST /claimpayments/Batch {claimNums[], CheckAmt, PayType}          test 10
 *
 * **Do not add a call this module does not already make.** An unproven write
 * path is the one thing the whole spike existed to eliminate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * G2 — A 200 IS NOT PROOF, AND THIS IS THE MOST IMPORTANT LINE IN THE FILE
 * ─────────────────────────────────────────────────────────────────────────────
 * Spike 0b test 2b: `PUT /claimprocs/{n} {DateCP: "2026-07-01"}` returns
 * **200 OK and changes nothing**. There is no error to catch and nothing echoed
 * back to compare against unless you re-read. *"A posting engine that believes
 * its own 200 will report back-dated adjudication it never performed."*
 *
 * So every write function here is a WRITE-THEN-READ-BACK pair that returns a
 * verdict, never a status. `agreed: false` is a FAILURE of that step with the
 * disagreement recorded, whatever the HTTP status said. There is no code path in
 * this file that reports success from a response code.
 *
 * And `DateCP` is never sent. Not "sent and tolerated" — never sent. The
 * carrier's adjudication date lives in `rcm_posting_queue.carrier_eob_date` and
 * in the note text, and the module never claims to have back-dated a chart.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────────────
 * No DELETE — the transport has no delete verb at all, `DELETE /claimprocs` does
 * not exist on this Open Dental build (test 12), and the documented unwind is a
 * human-run script against a test patient (docs/RCM_POSTING.md), not a code
 * path.
 *
 * No `POST /claimprocs/Supplemental` — that is the recoupment path, it is the
 * single IRREVERSIBLE Open Dental operation (G10: cannot be reverted, cannot be
 * deleted, and it then pins its claim and procedure forever), and it belongs to
 * 6d behind its own harder gate. The drain REFUSES a recoupment row rather than
 * posting one.
 *
 * No `POST /documents/Upload` — the EOB attach is 6d. The seam exists in the
 * state machine as an unimplemented step, reported honestly as "not yet".
 *
 * No `/payments`, no `/paysplits` — the patient-portion flow is PRD-deferred and
 * `ApiPayments` is not even enabled on this key (G11).
 */

const odOffices = require('../../config/odOffices');
const odPacer = require('./odPacer');

/** Per-OD-call timeout. Same default and reasoning as the RCM read layer. */
const OD_CALL_TIMEOUT_MS = 30000;

/**
 * The forced order, as data.
 *
 * Named because three separate things must agree about it — the state machine's
 * transitions, the queue row's `drain_step` cursor, and the behavioural test
 * that asserts which verbs the drain emits and in what order — and a sequence
 * that lives in three places diverges in two of them.
 *
 * `document_attach` is present and 6d's. It is listed so the machine has a place
 * to report "not yet" rather than silently ending one step early, which would
 * make a plan look complete when the EOB is still unfiled.
 */
const STEPS = Object.freeze([
  'resolve_config',
  'read_od_truth',
  'claimproc_writes',
  'claim_receipts',
  'check',
  'reconcile',
  'document_attach',
]);

// ─── Money ───────────────────────────────────────────────────────────────────

/**
 * Cents → the dollars Open Dental wants on the wire.
 *
 * Everything upstream of this line is integer cents, deliberately: the queue,
 * the parser, the gate's arithmetic. Open Dental takes decimal dollars, so the
 * conversion happens once, here, at the boundary — and `toFixed(2)` before
 * `Number` so 6.005-style float debris can never reach a ledger.
 *
 * @param {number|string|null|undefined} cents
 * @returns {number}
 */
function centsToDollars(cents) {
  const n = Number(cents || 0);
  if (!Number.isFinite(n)) return 0;
  return Number((n / 100).toFixed(2));
}

/**
 * A dollar amount Open Dental read back → cents, for comparison against intent.
 *
 * `Math.round` rather than truncation: OD returns `0.6` for sixty cents and
 * `0.6 * 100` is `60.00000000000001` in IEEE 754. Truncating that is 60 by luck
 * and 59 on the next value that lands the other side of the boundary — which
 * would report a write as disagreeing when it agreed exactly.
 *
 * @param {unknown} dollars
 * @returns {number|null} null when the value is not a number at all
 */
function dollarsToCents(dollars) {
  if (dollars === null || dollars === undefined || dollars === '') return null;
  const n = Number(dollars);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// ─── Shapes ──────────────────────────────────────────────────────────────────

/** OD list endpoints return a bare array; be defensive about envelopes. */
function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

/**
 * A refusal or an outage from Open Dental, carried rather than thrown away.
 *
 * `retryable` is the distinction the state machine turns on: a transport failure
 * may be tried again, a REFUSAL may not. Open Dental refuses cleanly and
 * informatively — `"CheckAmt does not match the total of eligible ClaimProcs."`,
 * `"Cannot change InsPayAmt when Status is Received and attached to a
 * ClaimPayment."` — and re-issuing the same call cannot change either answer.
 * Retrying a refusal is how a drain turns one wrong number into a loop.
 */
class OdWriteError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {{ status?: number, retryable?: boolean, detail?: string }} [extra]
   */
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'OdWriteError';
    this.code = code;
    this.status = extra.status ?? 0;
    // 4xx is Open Dental telling us the request was wrong. Only 0 (transport)
    // and 5xx (their side) are worth another attempt.
    this.retryable =
      extra.retryable !== undefined ? extra.retryable : !(this.status >= 400 && this.status < 500);
    this.detail = extra.detail || '';
  }
}

// ─── Transport ───────────────────────────────────────────────────────────────

/**
 * Resolve THIS office's Open Dental transport for posting, or refuse.
 *
 * The only impure function in the file, and the only place the office's client
 * is touched. Everything below takes the returned `od` object as an argument, so
 * the whole state machine is testable against a recorded-shape fake.
 *
 * `assertOfficeMatch(office, getOdOffice(office))` is the per-call re-check TC
 * #97 adopted: the handle is frozen to one office key, and asserting equality
 * against the operation's own key is what makes a cross-office write a refusal
 * rather than a possibility. Unknown office, not-OD-connected, and switched-on
 * -but-unkeyed all land in `OdOfficeError` here, and none of them falls back to
 * another practice's client. *"A missing valley key can never silently fall back
 * to Roland's key."*
 *
 * BOTH closures are paced through `odPacer` (D-8). The drain is a bulk job
 * sharing one credential with the phones and TC; it yields on every call, reads
 * included.
 *
 * @param {string} office
 * @returns {{ get: Function, write: Function, officeName: string, officeKey: string }}
 * @throws {import('../../config/odOffices').OdOfficeError}
 */
function postingTransportFor(office) {
  const handle = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  return {
    officeKey: handle.officeKey,
    officeName: handle.officeName,
    get: odPacer.pacedOdGet((path, params, opts) => handle.client.apiGetRaw(path, params, opts)),
    /*
     * The single write verb in the RCM module.
     *
     * Paced through the same queue as the reads rather than a second one: the
     * throttle belongs to the CREDENTIAL, so a writer that paced itself
     * separately from the readers would put two RCM calls on the wire inside one
     * interval and defeat the whole mechanism.
     */
    write: (method, path, body, opts) =>
      odPacer.paced(() =>
        handle.client.apiWriteRaw(method, path, body, {
          ...(opts || {}),
          minIntervalMs: odPacer.resolveMinIntervalMs(),
          module: 'rcm',
        })
      ),
  };
}

// ─── Reads (resume, read-back, reconciliation) ───────────────────────────────

/**
 * One claim's header, by ClaimNum.
 *
 * `GET /claims/{n}` is a single-item endpoint, so there is no list filter to
 * distrust here — the id IS the selector.
 *
 * @param {{ get: Function }} od
 * @param {number} claimNum
 * @returns {Promise<Record<string, unknown>>}
 */
async function readClaim(od, claimNum) {
  const res = await od.get(`/claims/${claimNum}`, {}, { timeoutMs: OD_CALL_TIMEOUT_MS });
  if (!res.ok) {
    throw new OdWriteError(
      `GET /claims/${claimNum} failed (${res.status})`,
      'OD_CLAIM_READ_FAILED',
      { status: res.status, detail: res.error || '' }
    );
  }
  const row = Array.isArray(res.data) ? res.data[0] : res.data;
  if (!row || typeof row !== 'object') {
    throw new OdWriteError(
      `GET /claims/${claimNum} returned no claim`,
      'OD_CLAIM_NOT_FOUND',
      { status: res.status, retryable: false }
    );
  }
  return /** @type {Record<string, unknown>} */ (row);
}

/**
 * Every claimproc on a claim, re-filtered client-side.
 *
 * THE RE-FILTER IS NOT DEFENSIVE PROGRAMMING, it is the documented behaviour of
 * this API: *"Never trust an OD list filter you have not proven returns a
 * different result for a different value. An unrecognized filter yields a
 * plausible wrong answer, not an error."* `?ClaimNum=` IS proven (§Probe B, 4
 * rows) — and it is re-applied anyway, because the cost is a loop over 100 rows
 * and the failure it prevents is adjudicating another patient's claim.
 *
 * @param {{ get: Function }} od
 * @param {number} claimNum
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function readClaimProcsForClaim(od, claimNum) {
  const res = await od.get('/claimprocs', { ClaimNum: claimNum }, { timeoutMs: OD_CALL_TIMEOUT_MS });
  if (!res.ok) {
    throw new OdWriteError(
      `GET /claimprocs?ClaimNum=${claimNum} failed (${res.status})`,
      'OD_CLAIMPROC_READ_FAILED',
      { status: res.status, detail: res.error || '' }
    );
  }
  return asArray(res.data).filter(
    (r) => r && typeof r === 'object' && Number(r.ClaimNum) === Number(claimNum)
  );
}

/**
 * Every claimproc attached to a check — THE RECONCILIATION READ.
 *
 * *"`?ClaimPaymentNum=<n>` returning exactly the lines on a check is the natural
 * post-write verification read"* (§9, verified: 2 rows across 2 claims on the
 * batch check in test 10). Re-filtered for the same reason as above, and here
 * the stakes are higher: an ignored filter would hand back an arbitrary page of
 * claimprocs which a naive comparison could read as "our lines are missing".
 *
 * @param {{ get: Function }} od
 * @param {number} claimPaymentNum
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function readClaimProcsForPayment(od, claimPaymentNum) {
  const res = await od.get(
    '/claimprocs',
    { ClaimPaymentNum: claimPaymentNum },
    { timeoutMs: OD_CALL_TIMEOUT_MS }
  );
  if (!res.ok) {
    throw new OdWriteError(
      `GET /claimprocs?ClaimPaymentNum=${claimPaymentNum} failed (${res.status})`,
      'OD_RECONCILE_READ_FAILED',
      { status: res.status, detail: res.error || '' }
    );
  }
  return asArray(res.data).filter(
    (r) => r && typeof r === 'object' && Number(r.ClaimPaymentNum) === Number(claimPaymentNum)
  );
}

// ─── Read-back comparison ────────────────────────────────────────────────────

/**
 * The four fields a claimproc write must be verified on.
 *
 * `Status` is included because a write that set the money but not the status
 * leaves the line invisible to `POST /claimpayments`'s eligible-total rule, and
 * the drain would then fail at the check with a mismatch it could not explain.
 */
const CLAIMPROC_VERIFY_FIELDS = Object.freeze(['Status', 'InsPayAmt', 'WriteOff', 'DedApplied']);

/**
 * Compare what we sent against what Open Dental read back.
 *
 * Money fields are compared in CENTS (see `dollarsToCents`); `Status` is
 * compared as a trimmed string, because Open Dental's API returns status as a
 * string enum rather than the legacy integer.
 *
 * A field Open Dental did not return at all is a MISMATCH, not a pass. Absence
 * reading as agreement is this module's recurring defect shape — it is what
 * `NO_BLOCKING_PREFLIGHT` failed on in the 6b review — and here it would mean
 * reporting a verified write against a response that never mentioned the field.
 *
 * @param {{ Status: string, InsPayAmt: number, WriteOff: number, DedApplied: number }} sent
 * @param {Record<string, unknown>} read
 * @returns {{ agreed: boolean, sent: object, read: object, mismatches: Array<{field:string,sent:unknown,read:unknown}> }}
 */
function compareClaimProc(sent, read) {
  /** @type {Array<{field:string,sent:unknown,read:unknown}>} */
  const mismatches = [];
  /** @type {Record<string, unknown>} */
  const readShown = {};

  for (const field of CLAIMPROC_VERIFY_FIELDS) {
    const raw = read ? read[field] : undefined;
    readShown[field] = raw === undefined ? null : raw;

    if (field === 'Status') {
      const got = typeof raw === 'string' ? raw.trim() : null;
      if (got !== sent.Status) mismatches.push({ field, sent: sent.Status, read: got });
      continue;
    }

    const wantCents = dollarsToCents(sent[field]);
    const gotCents = dollarsToCents(raw);
    if (gotCents === null || gotCents !== wantCents) {
      mismatches.push({ field, sent: sent[field], read: raw === undefined ? null : raw });
    }
  }

  return { agreed: mismatches.length === 0, sent, read: readShown, mismatches };
}

/**
 * The claim-level equivalent. `ClaimStatus` must be `"R"` and `DateReceived`
 * must be the date we sent.
 *
 * Open Dental returns dates as `"yyyy-MM-dd"` on this resource; comparison is on
 * the first ten characters so a server that appends a time does not read as a
 * disagreement about the date.
 *
 * @param {{ ClaimStatus: string, DateReceived: string }} sent
 * @param {Record<string, unknown>} read
 */
function compareClaim(sent, read) {
  /** @type {Array<{field:string,sent:unknown,read:unknown}>} */
  const mismatches = [];
  const status = read && typeof read.ClaimStatus === 'string' ? read.ClaimStatus.trim() : null;
  if (status !== sent.ClaimStatus) {
    mismatches.push({ field: 'ClaimStatus', sent: sent.ClaimStatus, read: status });
  }
  const received =
    read && read.DateReceived != null ? String(read.DateReceived).slice(0, 10) : null;
  if (received !== sent.DateReceived) {
    mismatches.push({ field: 'DateReceived', sent: sent.DateReceived, read: received });
  }
  return {
    agreed: mismatches.length === 0,
    sent,
    read: { ClaimStatus: status, DateReceived: received },
    mismatches,
  };
}

// ─── Step 1: the per-line claimproc write ────────────────────────────────────

/**
 * `PUT /claimprocs/{n}` — finalize one line's adjudication, then PROVE it.
 *
 * The four fields are exactly the ones test 2 wrote and read back:
 * `{Status: "Received", InsPayAmt: 0.60, WriteOff: 0.20, DedApplied: 0.20}` →
 * 200 → read-back `Status="Received" InsPayAmt=0.6 WriteOff=0.2 DedApplied=0.2`.
 *
 * `DateCP` IS NOT SENT (G2). Nothing else is sent either: `PUT` is documented
 * sparse — *"If a field is not included in a PUT, then it will not change the
 * original field"* — so the smallest possible body is also the safest one.
 *
 * The read-back is `GET /claimprocs?ClaimNum=` rather than the single-item
 * endpoint, on purpose: it re-reads EVERY line on the claim, so each line's
 * verification doubles as a running check that no earlier line drifted, and the
 * final one is the eligible-total evidence the check POST needs.
 *
 * @param {{ get: Function, write: Function }} od
 * @param {{ claimNum: number, claimProcNum: number, insPayAmtCents: number,
 *           writeOffCents: number, dedAppliedCents: number }} line
 * @returns {Promise<{ verdict: object, claimProcs: Record<string,unknown>[] }>}
 * @throws {OdWriteError} on a transport failure or an Open Dental refusal
 */
async function writeClaimProcReceived(od, line) {
  const sent = {
    Status: 'Received',
    InsPayAmt: centsToDollars(line.insPayAmtCents),
    WriteOff: centsToDollars(line.writeOffCents),
    DedApplied: centsToDollars(line.dedAppliedCents),
  };

  const res = await od.write('PUT', `/claimprocs/${line.claimProcNum}`, sent, {
    timeoutMs: OD_CALL_TIMEOUT_MS,
  });
  if (!res.ok) {
    /*
     * Two refusals are expected here and both are DESIGNED-FOR, not bugs:
     *   400 "Cannot change InsPayAmt when Status is Received and attached to a
     *        ClaimPayment."                                          (test 11)
     *   400 on a line whose Status is Adjustment/InsHist/Cap*, or IsTransfer.
     * Both are terminal for this line. The caller records the sentence.
     */
    throw new OdWriteError(
      `PUT /claimprocs/${line.claimProcNum} refused (${res.status})`,
      'OD_CLAIMPROC_WRITE_REFUSED',
      { status: res.status, detail: res.error || '' }
    );
  }

  const claimProcs = await readClaimProcsForClaim(od, line.claimNum);
  const row = claimProcs.find((r) => Number(r.ClaimProcNum) === Number(line.claimProcNum));
  if (!row) {
    // The write returned 200 and the line is not on the claim we were told it
    // belonged to. That is a plan built on a stale snapshot, and continuing
    // would post the rest of the claim around a line nobody can find.
    throw new OdWriteError(
      `claimproc ${line.claimProcNum} is not on claim ${line.claimNum} after the write`,
      'OD_CLAIMPROC_MISSING_AFTER_WRITE',
      { status: 200, retryable: false }
    );
  }

  return { verdict: compareClaimProc(sent, row), claimProcs };
}

// ─── Step 2: the per-claim receipt ───────────────────────────────────────────

/**
 * Build the free-text note Open Dental can hold about who did this.
 *
 * ATTRIBUTION IS A COMPROMISE AND THIS IS WHERE IT SHOWS. Every API write logs
 * `UserNum: 0` and *"Created by Sparkman DDS through API."* — the OD user bound
 * to the developer key (Spike 0b test 13). Open Dental's own audit trail
 * therefore cannot say WHICH CareIN operator posted a payment, and no field
 * exists to tell it. Free text is all it can hold, so free text is what it gets;
 * the real record is `audit_log`, one row per write, with office, queue row,
 * claim, line and the read-back verdict.
 *
 * The carrier's adjudication date rides here too, because `DateCP` is not
 * writable (G2) and this is the only place in the chart it can live.
 *
 * NO PATIENT IDENTITY. The note names the operator, the plan and the carrier's
 * date, all of which we minted or the payer stated — nothing about the patient,
 * who is already identified by the chart the note is in.
 *
 * @param {{ queueId: string, operator: string, carrierEobDate: string|null }} ctx
 * @returns {string}
 */
function buildPostingNote(ctx) {
  const parts = [`CareIN RCM posting ${ctx.queueId}`, `posted by ${ctx.operator}`];
  if (ctx.carrierEobDate) parts.push(`carrier EOB date ${ctx.carrierEobDate}`);
  return parts.join(' · ');
}

/**
 * Append our line to an existing `ClaimNote` without destroying what is there.
 *
 * A PUT that includes `ClaimNote` REPLACES it. The practice writes real notes in
 * that field — a denial narrative, a call reference — and overwriting one to
 * stamp our attribution would destroy a person's work to record our own. So the
 * existing note is read (we already hold it from the resume read) and ours is
 * appended.
 *
 * Idempotent: a note that already carries this queue id is returned UNCHANGED,
 * so a resume does not stack a second copy on every attempt.
 *
 * @param {unknown} existing
 * @param {string} line
 * @param {string} queueId
 * @returns {string|null} null when nothing needs to change
 */
function appendClaimNote(existing, line, queueId) {
  const current = typeof existing === 'string' ? existing : '';
  if (current.includes(queueId)) return null;
  return current.trim() ? `${current.trim()}\n${line}` : line;
}

/**
 * `PUT /claims/{n}` — mark the claim received, then PROVE it.
 *
 * Test 3: `{ClaimStatus: "R", DateReceived: "2026-08-13"}` → 200 → read-back
 * `ClaimStatus="R" DateReceived="2026-08-13"`, and the claim's own
 * `InsPayAmt`/`WriteOff` roll up AUTOMATICALLY from its claimprocs. A poster
 * never writes those, and this function does not.
 *
 * `DateReceived` IS SET FROM THE CARRIER'S EOB DATE when the remittance carried
 * one, falling back to today. This is a deliberate choice and the alternative
 * was considered: `DateReceived` is the claim-level "when did the response
 * arrive", the carrier's own remittance date is the truest available answer, and
 * unlike `DateCP` this field is writable AND verifiable by read-back. Using
 * "today" would stamp the date the drain happened to run, which is an artefact
 * of our scheduling rather than a fact about the claim.
 *
 * @param {{ get: Function, write: Function }} od
 * @param {{ claimNum: number, dateReceived: string, note: string|null }} claim
 * @returns {Promise<{ verdict: object, claim: Record<string,unknown> }>}
 */
async function writeClaimReceived(od, claim) {
  /** @type {Record<string, unknown>} */
  const sent = { ClaimStatus: 'R', DateReceived: claim.dateReceived };
  // Only sent when there is something to add — see appendClaimNote. A PUT that
  // omits the field leaves it alone, which is the correct no-op.
  if (claim.note) sent.ClaimNote = claim.note;

  const res = await od.write('PUT', `/claims/${claim.claimNum}`, sent, {
    timeoutMs: OD_CALL_TIMEOUT_MS,
  });
  if (!res.ok) {
    throw new OdWriteError(
      `PUT /claims/${claim.claimNum} refused (${res.status})`,
      'OD_CLAIM_WRITE_REFUSED',
      { status: res.status, detail: res.error || '' }
    );
  }

  const row = await readClaim(od, claim.claimNum);
  // The note is NOT part of the verdict. It is attribution, not money, and a
  // practice that trims or reformats free text must not turn a correct
  // adjudication into a failed step.
  return { verdict: compareClaim({ ClaimStatus: 'R', DateReceived: claim.dateReceived }, row), claim: row };
}

// ─── Step 3: the check ───────────────────────────────────────────────────────

/**
 * Open Dental's own definition of an ELIGIBLE claimproc, from its refusal text.
 *
 * Test 5's error names it: *"CheckAmt does not match the total of eligible
 * ClaimProcs."* — and §1 pins what eligible means: the total of the ClaimProcs'
 * `InsPayAmt` *"with ClaimPaymentNum=0"*. So eligibility is a property of the
 * CHART, not of our plan, and computing our own sum and hoping is how a drain
 * eats a 400 in the worst possible window.
 *
 * This is computed from the read-back rows and compared to our intent BEFORE the
 * POST. A disagreement means the chart holds money we did not plan — another
 * unposted line on the same claim, most likely — and that is a refusal that
 * stops the row, never an adjustment to the number we send.
 *
 * @param {Record<string, unknown>[]} claimProcs
 * @returns {number} cents
 */
function eligibleTotalCents(claimProcs) {
  let total = 0;
  for (const row of claimProcs) {
    if (Number(row.ClaimPaymentNum || 0) !== 0) continue;
    const cents = dollarsToCents(row.InsPayAmt);
    if (cents !== null) total += cents;
  }
  return total;
}

/**
 * Is this claimproc already attached to a check?
 *
 * Test 11 proved that PUTting one is refused, and it would be wrong even if it
 * were not. Resume uses this to skip rather than re-write.
 * @param {Record<string, unknown>} row
 * @returns {number} the ClaimPaymentNum, or 0
 */
function attachedCheckNum(row) {
  const n = Number(row && row.ClaimPaymentNum);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * `POST /claimpayments` or `POST /claimpayments/Batch` — create the check.
 *
 * Test 4 (single) and test 10 (batch). The batch form is the REAL-WORLD EOB
 * SHAPE — one carrier check across many claims — and it is what the per-office
 * `ClaimPaymentBatchOnly` preference may make mandatory.
 *
 * `CheckAmt` must equal the eligible total EXACTLY (test 5). The caller has
 * already proven that from the read-back; this function does not re-derive it,
 * because two places computing the same number is how they come to disagree.
 *
 * @param {{ write: Function }} od
 * @param {{ endpoint: 'single'|'batch', claimNums: number[], checkAmtCents: number,
 *           payTypeDefNum: number, checkNumber: string|null, checkDate: string|null,
 *           carrierName: string|null, note: string }} check
 * @returns {Promise<{ claimPaymentNum: number, raw: Record<string, unknown> }>}
 */
async function writeClaimPayment(od, check) {
  const amount = centsToDollars(check.checkAmtCents);

  /** @type {Record<string, unknown>} */
  const body =
    check.endpoint === 'batch'
      ? { claimNums: check.claimNums, CheckAmt: amount }
      : { claimNum: check.claimNums[0], CheckAmt: amount };

  body.PayType = check.payTypeDefNum;
  if (check.checkNumber) body.CheckNum = check.checkNumber;
  if (check.checkDate) body.CheckDate = check.checkDate;
  if (check.carrierName) body.CarrierName = check.carrierName;
  body.Note = check.note;
  /*
   * `ClinicNum` is deliberately unset. Roland's is 0 everywhere and the customer
   * key already scopes to one practice database (§9). Sending a clinic we have
   * not verified exists in that database would be a guess about the practice's
   * own structure.
   */

  const path = check.endpoint === 'batch' ? '/claimpayments/Batch' : '/claimpayments';
  const res = await od.write('POST', path, body, { timeoutMs: OD_CALL_TIMEOUT_MS });
  if (!res.ok) {
    throw new OdWriteError(
      `POST ${path} refused (${res.status})`,
      'OD_CHECK_WRITE_REFUSED',
      { status: res.status, detail: res.error || '' }
    );
  }

  const row = Array.isArray(res.data) ? res.data[0] : res.data;
  const claimPaymentNum = Number(row && row.ClaimPaymentNum);
  if (!Number.isInteger(claimPaymentNum) || claimPaymentNum <= 0) {
    /*
     * A 201 WITHOUT A CHECK NUMBER IS A REFUSAL, NOT A SUCCESS.
     *
     * The same ruling as send-to-TC's `TC_BAD_RESPONSE`: *"persisting a
     * half-known linkage would be worse than refusing."* Here it is worse still
     * — without the ClaimPaymentNum we cannot run the reconciliation read, so we
     * could neither prove the money landed nor find the check again to adopt it
     * on a resume. Not retryable: a second POST would risk a second check.
     */
    throw new OdWriteError(
      `POST ${path} returned no ClaimPaymentNum`,
      'OD_CHECK_NO_PAYMENT_NUM',
      { status: res.status, retryable: false }
    );
  }
  return { claimPaymentNum, raw: /** @type {Record<string, unknown>} */ (row || {}) };
}

// ─── Step 4: reconciliation ──────────────────────────────────────────────────

/**
 * Does the check contain EXACTLY the lines this plan intended?
 *
 * Set equality both ways, and the amounts too. Three distinct failures this
 * catches, all of which look identical from a 201:
 *   - a planned line that did not attach (money on the claim, not on the check);
 *   - a line on the check we never planned (somebody else's unposted line swept
 *     into our check by the eligible-total rule);
 *   - an amount that landed differently from what we sent.
 *
 * `posted` is unreachable unless this returns `matched: true`. That is a CHECK
 * constraint in the migration as well as a branch here, because the whole value
 * of the state is that a screen may trust it without re-deriving.
 *
 * @param {Record<string, unknown>[]} attached rows from `?ClaimPaymentNum=`
 * @param {Array<{ odClaimProcNum: number, intendedInsPayAmtCents: number }>} planned
 * @returns {{ matched: boolean, missing: number[], unexpected: number[],
 *             amountMismatches: Array<{claimProcNum:number,intendedCents:number,readCents:number|null}>,
 *             attachedTotalCents: number }}
 */
function reconcileCheck(attached, planned) {
  const byNum = new Map();
  for (const row of attached) byNum.set(Number(row.ClaimProcNum), row);

  const plannedNums = new Set(planned.map((p) => Number(p.odClaimProcNum)));

  const missing = [];
  /** @type {Array<{claimProcNum:number,intendedCents:number,readCents:number|null}>} */
  const amountMismatches = [];
  for (const p of planned) {
    const row = byNum.get(Number(p.odClaimProcNum));
    if (!row) {
      missing.push(Number(p.odClaimProcNum));
      continue;
    }
    const readCents = dollarsToCents(row.InsPayAmt);
    if (readCents !== Number(p.intendedInsPayAmtCents)) {
      amountMismatches.push({
        claimProcNum: Number(p.odClaimProcNum),
        intendedCents: Number(p.intendedInsPayAmtCents),
        readCents,
      });
    }
  }

  const unexpected = [...byNum.keys()].filter((n) => !plannedNums.has(n));

  let attachedTotalCents = 0;
  for (const row of attached) {
    const cents = dollarsToCents(row.InsPayAmt);
    if (cents !== null) attachedTotalCents += cents;
  }

  return {
    matched: missing.length === 0 && unexpected.length === 0 && amountMismatches.length === 0,
    missing,
    unexpected,
    amountMismatches,
    attachedTotalCents,
  };
}

module.exports = {
  STEPS,
  OD_CALL_TIMEOUT_MS,
  CLAIMPROC_VERIFY_FIELDS,
  OdWriteError,
  centsToDollars,
  dollarsToCents,
  postingTransportFor,
  readClaim,
  readClaimProcsForClaim,
  readClaimProcsForPayment,
  compareClaimProc,
  compareClaim,
  writeClaimProcReceived,
  writeClaimReceived,
  writeClaimPayment,
  buildPostingNote,
  appendClaimNote,
  eligibleTotalCents,
  attachedCheckNum,
  reconcileCheck,
};
