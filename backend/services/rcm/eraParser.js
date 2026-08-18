'use strict';

/**
 * X12 835 (ERA) parser — ported from `rcm-posting @ fix/prod-acr-registry-identity`
 * (9bf5ac8), `server/services/eraParser.ts`, for RCM Slice 5.
 *
 * The parser is PURE: bytes in, a structure out. It touches no database, no
 * blob store, and — hard rule 1 of this slice — no Open Dental. Matching a
 * remittance line to a real OD claim is Slice 6's job.
 *
 * ─── What survives the port unchanged ──────────────────────────────────────
 *
 * The two regression fixes the source earned in production are preserved
 * exactly, and `eraParser.test.js` still pins both:
 *
 *  1. **The CAS window is the 2110 loop, not a fixed 5 segments.** A service
 *     line's adjustments run until the next SVC/CLP/PLB/LX/SE. The original
 *     fixed slice silently dropped adjustments on lines carrying extra
 *     DTM/REF/AMT segments first — write-offs and patient responsibility
 *     posted as zero.
 *  2. **The check number is TRN02, not BPR16.** BPR16 is the check-issue date
 *     (CCYYMMDD). Reading it as a number stamped `20260203` where a check
 *     number belonged, into `claimpayment.CheckNum` and into the OD leg of the
 *     three-way reconciliation — neither could ever line up against the bank.
 *
 * ─── Deviations from the source, all deliberate ────────────────────────────
 *
 * Every one of these is written up in `docs/RCM_ERA_UPLOAD.md` §"Porting
 * notes". D4 and D5 were escalated to the PM and RULED ON in Slice 5 review;
 * both rulings are recorded at their notes below.
 *
 *  D1 `x12-parser` → `./x12.js`, and `parse835` is synchronous. See x12.js.
 *  D2 **The payment date never falls back to today.** The source's last-resort
 *     `new Date()` invents a check date that disagrees with the bank, and it
 *     would flow straight into the remittance key — making the dedupe
 *     primitive time-dependent, which is the one thing it must never be.
 *     `paymentDate` is `null` when the file carries neither DTM*405 nor BPR16,
 *     and the upload route refuses rather than guessing.
 *  D3 **One remittance per ST/BPR transaction.** The source merged every
 *     transaction in a file into a single check — summing all the amounts
 *     while keeping only the FIRST trace number, which describes no real
 *     payment. `remittances[]` keeps them separate so each gets its own
 *     remittance key. The merged top-level fields remain for the ported tests.
 *  D4 **SVC06 is read as the ORIGINAL SUBMITTED code (X12 spec)**, which two
 *     fixtures were authored the other way round. See NOTE ON DOWNCODES below.
 *  D5 **An implausible CARC token is flagged, never invented.** See NOTE ON
 *     CAS PAIRS below.
 *  D6 `subscriber_id` comes from NM1*IL/NM1*QC element 9; `group_number` from
 *     REF*1L. The source read REF*1L (Group or Policy Number) as the
 *     subscriber id and hardcoded the group to the string "N/A".
 *  D7 Provider NPI falls back to NM1*82 element 9 when REF*1G is absent —
 *     which is every file in the corpus. The source returned "0000000000".
 *  D8 **CLP02 is surfaced.** The source parsed the claim status code into a
 *     variable and never read it, so a DENIAL and a REVERSAL were
 *     indistinguishable from a clean payment in the output. This slice's
 *     honest-states rule (reversals are detect-and-flag, never posted) is not
 *     implementable without it.
 *  D9 RARC remark codes are read from LQ*HE. The source never read LQ, so
 *     `rcm_procedure_adjustments.remark_code` had no source of data at all.
 * D10 CARC 97's description is corrected to the bundling text. The source's
 *      table said "Benefit maximum reached", which is CARC 119; that string
 *      lands in `reason_description` in front of billing staff.
 * D11 A missing DOB is `null`, not the string "0001-01-01". That sentinel is
 *      Open Dental's null-date convention and has no business in a Postgres
 *      `date` column, where NULL says the same thing truthfully.
 * D12 **Every claim's segment window is bounded by the next CLP.** The source
 *      searched `slice(clpIndex)` to the end of the transaction, so a claim
 *      missing its own NM1/DMG/REF would silently inherit the NEXT PATIENT'S
 *      name, date of birth, or subscriber id. In a multi-claim file — the
 *      primary real-world shape — that is a PHI mix-up, not a cosmetic bug.
 *
 * ─── NOTE ON DOWNCODES (D4) — SETTLED: THE SPEC WINS ──────────────────────
 *
 * X12 005010X221A1 defines SVC01 as the ADJUDICATED procedure code and SVC06
 * as the ORIGINAL SUBMITTED code, present only when the payer changed it. This
 * parser follows the specification.
 *
 * Two fixtures in the repository corpus were AUTHORED TRANSPOSED — the
 * submitted code in SVC01 and the downgraded one in SVC06:
 *
 *     Test_Cigna_Downcode.edi     SVC*AD:D0150*102*57***AD:D0120
 *     Test_Bundled_Downgraded.edi SVC*AD:D2740*1258*485***AD:D2791
 *
 * The author's intent is legible — a comprehensive exam downcoded to a
 * periodic one, a porcelain crown downgraded to full cast — but it is not what
 * the bytes say.
 *
 * PM RULING (Slice 5 review): the parser's job is to read REAL payer files
 * correctly, and real payers follow X12. The parser stays spec-correct, the
 * fixture BYTES stay frozen (the corpus rule protects bytes, not authoring
 * mistakes), and the corpus README records the transposition. Slice 6 posts
 * money against whichever code we recorded, so recording per spec is the only
 * defensible choice.
 *
 * The consequence is pinned in `eraParser.test.js`: against those two files
 * this parser reports billedCode=D0120/paidCode=D0150 and
 * billedCode=D2791/paidCode=D2740 — spec positions, not the author's intent.
 * `isDowncoded` is symmetric (the codes differ), so DETECTION is correct
 * either way; only which column each code lands in was ever at stake.
 *
 * A spec-conformant downcode scenario is a NEW fixture file, never an edit to
 * these two.
 *
 * ─── NOTE ON CAS PAIRS (D5) — SETTLED: THIS IS PRODUCTION BEHAVIOUR ───────
 *
 * CAS repeats as reason/amount/QUANTITY triples: CAS02-03-04, CAS05-06-07,
 * CAS08-09-10. `Test_Mixed_Adjustments.edi` writes
 *
 *     CAS*PR*1*50*2*25.50
 *
 * which under the specification reads as (PR-1, $50.00, qty 2) followed by a
 * reason code of "25.50" with no amount. The arithmetic shows what the author
 * meant: the claim's PR amounts only sum to its CLP05 patient responsibility
 * of $257.50 if this is two pairs, PR-1 $50.00 and PR-2 $25.50 — i.e. the
 * empty quantity element (`CAS*PR*1*50**2*25.50`) was omitted.
 *
 * This parser reads the specification, validates that each reason token could
 * be a CARC at all, and on failure records NOTHING for that pair while raising
 * the `unexplained_adj` line flag and an `unparseable_cas` review reason. The
 * two alternatives were both worse: writing `reason_code = '25.50'` puts a
 * fabricated code in front of billing staff, and dropping it silently loses
 * $25.50 of patient responsibility with no trace.
 *
 * PM RULING (Slice 5 review): this is the PRODUCTION behaviour, not a fixture
 * workaround. Real payer files are malformed too, and validating the token
 * rather than trusting it is the honest-states law applied to parsing. The
 * flag must remain visible on the review path — it reaches
 * `rcm_claims.needs_review_reasons`, holds the batch at 'open', and Slice 7
 * renders it.
 */

const { parseInterchange, subElement, X12FormatError } = require('./x12');
const vocabulary = require('./rcmVocabulary');

// ─── Vocabularies ───────────────────────────────────────────────────────────

/**
 * CARC (Claim Adjustment Reason Code) descriptions.
 *
 * `describeCarc` is the SHARED accessor over the published X12 list ingested in
 * ./x12Codes.generated.js — one home for "what does this code mean", read at
 * parse time here and again at render time by the Slice 6a review workbench.
 *
 * Called rather than indexed on purpose: the accessor normalizes the token
 * (`trim().toUpperCase()`) and this file's raw `reasonCode` does not, so
 * indexing the table directly would miss ` b15 ` where the workbench found it —
 * and the two layers would then disagree about the same adjustment.
 *
 * These land in `rcm_procedure_adjustments.reason_description`, which is what a
 * human reads when asking why a line paid short. D10 (CARC 97 is the bundling
 * text, not "Benefit maximum reached" — that is 119) is satisfied by the
 * published list itself rather than by a hand-maintained correction.
 */
const { describeCarc } = require('./adjustmentCodes');

/** PLB (Provider Level Balance) adjustment reason codes. Ported verbatim. */
const PLB_REASON_DESCRIPTIONS = Object.freeze({
  50: 'Late charge',
  51: 'Interest penalty charge',
  72: 'Authorized return',
  90: 'Early payment allowance',
  AH: 'Origination fee',
  AM: "Applied to borrower's account",
  AP: 'Acceleration of benefits',
  B2: 'Rebate',
  B3: 'Recovery allowance',
  BD: 'Bad debt adjustment',
  BN: 'Bonus',
  C5: 'Temporary allowance',
  CR: 'Capitation interest',
  CS: 'Adjustment',
  CT: 'Capitation payment',
  CV: 'Capital passthrough',
  CW: 'Certified registered nurse anesthetist passthrough',
  DM: 'Direct medical education passthrough',
  E3: 'Withholding',
  FB: 'Forwarding balance',
  FC: 'Fund allocation',
  GO: 'Graduate medical education passthrough',
  HM: 'Hemophilia clotting factor supplement',
  IP: 'Incentive premium payment',
  IR: 'Internal revenue service withholding',
  IS: 'Interim settlement',
  J1: 'Nonreimbursable',
  L3: 'Penalty',
  L6: 'Interest owed',
  LE: 'Levy',
  LS: 'Lump sum',
  OA: 'Organ acquisition passthrough',
  OB: 'Offset for affiliated providers',
  PI: 'Periodic interim payment',
  PL: 'Payment final',
  RA: 'Retro-activity adjustment',
  RE: 'Return on equity',
  SL: 'Student loan repayment',
  TL: 'Third party liability',
  WO: 'Overpayment recovery',
  WU: 'Unspecified recovery',
});

/**
 * CLP02 — Claim Status Code. Only the values that change what we DO with the
 * claim are named; anything else is carried through as its raw code.
 */
const CLAIM_STATUS = Object.freeze({
  1: { label: 'processed_as_primary', cobSequence: 1 },
  2: { label: 'processed_as_secondary', cobSequence: 2 },
  3: { label: 'processed_as_tertiary', cobSequence: 3 },
  4: { label: 'denied', cobSequence: 1 },
  19: { label: 'processed_as_primary_forwarded', cobSequence: 1 },
  20: { label: 'processed_as_secondary_forwarded', cobSequence: 2 },
  21: { label: 'processed_as_tertiary_forwarded', cobSequence: 3 },
  22: { label: 'reversal_of_previous_payment', cobSequence: 1 },
  23: { label: 'not_our_claim_forwarded', cobSequence: 1 },
  25: { label: 'predetermination_pricing_only', cobSequence: 1 },
});

const COB_SEQUENCE_TO_INSURANCE_TYPE = Object.freeze({
  1: 'primary',
  2: 'secondary',
  3: 'tertiary',
});

/**
 * The `rcm_procedure_lines.flags` vocabulary, verbatim from that table's CHECK
 * constraint. Writing a flag outside this set is a constraint violation at
 * INSERT time, so the mapping below may only ever produce these.
 */
const LINE_FLAGS = vocabulary.LINE_FLAGS;

/** CARC → line flag. A code absent here contributes no flag. */
const CARC_TO_LINE_FLAG = Object.freeze({
  54: 'bundled',
  97: 'bundled',
  B15: 'bundled',
  50: 'not_covered',
  96: 'not_covered',
  109: 'not_covered',
  119: 'frequency_limit',
  151: 'frequency_limit',
  197: 'pre_auth_required',
});

/**
 * Machine-readable claim-level review reasons — the values that reach
 * `rcm_claims.needs_review_reasons`. That column has no CHECK constraint, so
 * this frozen set is the only thing keeping it a vocabulary rather than prose.
 */
const REVIEW_REASONS = vocabulary.ERA_REVIEW_REASONS;

/**
 * Remittance-level flags — structures we parsed but will not act on. These
 * reach the API response and the upload record, never a posting path.
 */
const REMITTANCE_FLAGS = Object.freeze({
  PLB_PRESENT: 'plb_adjustments_present',
  NEGATIVE_PAYMENT: 'negative_total_payment',
  NO_PAYMENT_MADE: 'no_payment_made',
  NO_CLAIMS: 'no_claims_in_remittance',
  CLAIM_TOTAL_MISMATCH: 'claim_total_mismatch',
  // ── Slice 5.5 ──
  /** B3. SE01/GE01/IEA01 disagree with what we counted — likely truncation. */
  ENVELOPE_COUNTS_MISMATCH: 'envelope_counts_mismatch',
  /** B3. A trailer segment is missing outright. */
  ENVELOPE_INCOMPLETE: 'envelope_incomplete',
  /** A5. A repeating PLB segment was only partly consumed. */
  PARTIAL_ADJUSTMENT_SEGMENT: 'partial_adjustment_segment',
  /** A4. A token where an amount belonged did not validate as a number. */
  UNREADABLE_AMOUNT: 'unreadable_amount',
  /** B4. The file carried more than one ST/SE transaction set. */
  MULTI_TRANSACTION: 'multi_transaction_file',
});

// ─── Small helpers ──────────────────────────────────────────────────────────

/**
 * An X12 monetary amount: optional sign, digits, optional decimal part.
 *
 * DELIBERATELY NARROW. `parseFloat` reads `"1,250.00"` as `1` and `"250USD"` as
 * `250` — it stops at the first character it does not understand and reports
 * nothing. That stored **$1.00 where $1,250.00 belonged** (Slice 5.5 defect A4),
 * and only tripped a reconciliation if that value happened to participate in a
 * checked sum. Anything this pattern rejects is refused rather than truncated.
 */
const AMOUNT_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/**
 * Dollars (as they appear in the file) to integer cents.
 *
 * An ABSENT or EMPTY value is 0 — an optional amount the payer did not send
 * genuinely is zero. A PRESENT but unreadable one is not: `onUnreadable` is
 * called with the offending token and the result is 0 **with the caller
 * obliged to flag it**. There is no third state available: the cents columns
 * are `bigint NOT NULL`, so "unknown" cannot be stored as NULL without a
 * schema change. The flag is what carries the honesty, and the totals
 * reconciliation fires alongside it — see docs/RCM_ERA_FIDELITY.md §A4.
 *
 * @param {unknown} value
 * @param {(token: string) => void} [onUnreadable]
 * @returns {number}
 */
function toCents(value, onUnreadable) {
  if (value == null) return 0;
  const token = String(value).trim();
  if (token === '') return 0;

  if (!AMOUNT_RE.test(token)) {
    if (typeof onUnreadable === 'function') onUnreadable(token);
    return 0;
  }
  const n = Number.parseFloat(token);
  if (!Number.isFinite(n)) {
    if (typeof onUnreadable === 'function') onUnreadable(token);
    return 0;
  }
  return Math.round(n * 100);
}

/**
 * CCYYMMDD → YYYY-MM-DD. Anything else passes through untouched, and a blank
 * yields null — never today (D2).
 * @param {string|undefined} raw
 * @returns {string|null}
 */
function toIsoDate(raw) {
  const v = (raw || '').trim();
  if (!v) return null;
  if (/^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  return v;
}

/**
 * BPR04 — Payment Method Code.
 *   CHK paper check · ACH/BOP/FWT electronic · NON no payment
 * Returns null for NON and for anything unrecognised: `paymentMethod` is a
 * fact about how money moved, and there is no honest guess when it did not.
 * @param {string|undefined} bpr04
 * @returns {'check'|'eft'|null}
 */
function parsePaymentMethod(bpr04) {
  switch ((bpr04 || '').trim().toUpperCase()) {
    case 'CHK':
      return 'check';
    case 'ACH':
    case 'BOP':
    case 'FWT':
      return 'eft';
    default:
      return null;
  }
}

/**
 * Could `token` be a CARC at all? (D5.)
 *
 * Real CARCs are 1–3 digits with an optional letter prefix — 1, 45, 253, B15,
 * P12, W1. A decimal, a dollar sign, or an empty string cannot be one, and the
 * only way such a token reaches here is a malformed CAS.
 * @param {unknown} token
 * @returns {boolean}
 */
function isPlausibleCarc(token) {
  return /^[A-Z]{0,2}\d{1,3}[A-Z]?$/.test(String(token || '').trim().toUpperCase());
}

/** Add `value` to `list` if absent. Keeps flag arrays stable and deduped. */
function addFlag(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

/** A segment's numbered elements, in element order. */
function elementsOf(segment) {
  return Object.keys(segment)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => segment[k]);
}

/**
 * Read one or more CAS segments into adjustments.
 *
 * CAS repeats as reason/amount/QUANTITY triples — CAS02-03-04, CAS05-06-07,
 * CAS08-09-10, and so on to CAS19.
 *
 * SLICE 5.5 DEFECT A5. The old loop did `break` on the first empty reason and
 * on the first implausible one, with NO flag in the empty case. A padded
 * segment — `CAS*PR*1*50***2*25.50`, which is legal — silently lost every pair
 * after the gap, and the only trace was a downstream total mismatch, if the
 * amount happened to be in a checked sum. This SKIPS and FLAGS instead: a
 * partially consumed repeating segment is a visible review reason, because some
 * of the money in it is not represented anywhere.
 *
 * @param {import('./x12').X12Segment[]} casSegments
 * @param {'claim'|'line'} scope where the payer reported these
 * @param {(token: string) => void} onUnreadable
 * @returns {{ adjustments: ParsedAdjustment[], flags: string[],
 *             deductibleCents: number, copayCents: number, patientRespCents: number }}
 */
function readCasSegments(casSegments, scope, onUnreadable) {
  /** @type {ParsedAdjustment[]} */
  const adjustments = [];
  /** @type {string[]} */
  const flags = [];
  let deductibleCents = 0;
  let copayCents = 0;
  let patientRespCents = 0;

  for (const cas of casSegments) {
    const groupCode = (cas['1'] || 'OA').trim().toUpperCase();
    const values = elementsOf(cas);

    for (let i = 1; i < values.length; i += 3) {
      const reasonCode = (values[i] || '').trim();

      if (!reasonCode) {
        // A gap. Only a defect if something FOLLOWS it — trailing empties are
        // just how a segment ends.
        if (values.slice(i + 1).some((v) => (v || '').trim() !== '')) {
          addFlag(flags, 'partial_adjustment_segment');
        }
        continue;
      }

      if (!isPlausibleCarc(reasonCode)) {
        // Refuse to invent an adjustment, and keep going: the pairs after a bad
        // one are usually fine, and dropping them too compounds the loss.
        addFlag(flags, 'unexplained_adj');
        addFlag(flags, 'partial_adjustment_segment');
        continue;
      }

      const amountCents = toCents(values[i + 1], onUnreadable);
      const quantityRaw = Number.parseInt(values[i + 2] || '1', 10);

      adjustments.push({
        scope,
        groupCode,
        reasonCode,
        description: describeCarc(reasonCode) || `Adjustment code ${reasonCode}`,
        amountCents,
        quantity: Number.isFinite(quantityRaw) && quantityRaw > 0 ? quantityRaw : 1,
      });

      // PR is the PATIENT's money. PR-1 deductible, PR-2/PR-3 coinsurance and
      // copay; any other PR code is still patient responsibility, which is why
      // patientRespCents sums the whole group rather than the three we name.
      if (groupCode === 'PR') {
        patientRespCents += amountCents;
        if (reasonCode === '1') deductibleCents += amountCents;
        else if (reasonCode === '2' || reasonCode === '3') copayCents += amountCents;
      }
    }
  }

  return { adjustments, flags, deductibleCents, copayCents, patientRespCents };
}

/**
 * The contractual write-off in a set of adjustments.
 *
 * SLICE 5.5 DEFECT A3, half of it. The old code counted only `CO`. A payer who
 * takes the contractual reduction under `OA` or `PI` — both ordinary — had that
 * reduction counted as if it were still allowed, which inflated the allowed
 * amount and therefore produced a WRONG `write_off_cents`, a number Slice 6c
 * writes into Open Dental.
 *
 * `PR` is excluded because it is the patient's money, not a write-off, and `CR`
 * is a correction/reversal rather than a reduction.
 */
const CONTRACTUAL_GROUPS = Object.freeze(['CO', 'OA', 'PI']);

function contractualCentsOf(adjustments) {
  return adjustments.reduce(
    (sum, adj) => (CONTRACTUAL_GROUPS.includes(adj.groupCode) ? sum + adj.amountCents : sum),
    0
  );
}

/**
 * How far a reported and a derived amount may differ before it is a defect.
 *
 * One cent, not zero: X12 amounts are decimal strings and a payer rounding a
 * coinsurance split can legitimately land a cent away from our arithmetic.
 * Anything wider than this is a disagreement about money, not rounding.
 */
const ALLOWED_TOLERANCE_CENTS = 1;

/** Reducer: the patient-responsibility total in a set of adjustments. */
function prSum(sum, adj) {
  return adj.groupCode === 'PR' ? sum + adj.amountCents : sum;
}

/**
 * A RARC, loosely: a letter prefix (M, MA, N) and digits, e.g. N19, M27, MA61.
 *
 * Used only to pick remark codes out of MOA/MIA, whose remark-code positions
 * differ between the two segments — matching the SHAPE is more robust than
 * hardcoding element numbers that are right for one segment and wrong for the
 * other, and the cost of a false positive is a spurious code in a list a human
 * reads, not a wrong number.
 */
const RARC_RE = /^(M|MA|N)\d{1,3}$/;

// ─── Parser ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ParsedAdjustment
 * @property {string} groupCode CARC group — CO/PR/OA/PI/CR
 * @property {string} reasonCode CARC
 * @property {string} description
 * @property {number} amountCents
 * @property {number} quantity
 * @property {string|null} remarkCode RARC, from LQ*HE
 */

/**
 * @typedef {Object} ParsedProcedure
 * @property {string} code the adjudicated code — what `rcm_procedure_lines.code` takes
 * @property {string} billedCode the submitted code (SVC06 when the payer changed it)
 * @property {string|null} paidCode set only when it differs from billedCode
 * @property {string} description
 * @property {number} billedCents
 * @property {number} allowedCents
 * @property {number} deductibleCents
 * @property {number} copayCents
 * @property {number} paidCents
 * @property {boolean} isDowncoded
 * @property {boolean} isBundled
 * @property {boolean} isDenied
 * @property {string[]} flags subset of LINE_FLAGS
 * @property {ParsedAdjustment[]} adjustments
 */

/**
 * @typedef {Object} ParsedClaim
 * @property {string} claimNumber
 * @property {string} claimStatusCode raw CLP02
 * @property {string} claimStatusLabel
 * @property {string} payerClaimControlNumber CLP07
 * @property {string} patientName
 * @property {string|null} patientDOB
 * @property {string} subscriberId
 * @property {string} groupNumber
 * @property {string} payer
 * @property {string|null} serviceDate
 * @property {string} providerNPI
 * @property {string} renderingProvider
 * @property {number} totalBilledCents
 * @property {number} totalAllowedCents
 * @property {number} totalDeductibleCents
 * @property {number} totalCopayCents
 * @property {number} totalPaidCents
 * @property {number} patientRespCents CLP05
 * @property {number} priorPayerPaidCents AMT*D
 * @property {string} insuranceType primary|secondary|tertiary
 * @property {number} cobSequence
 * @property {boolean} isDenied
 * @property {boolean} isReversal
 * @property {string[]} needsReviewReasons subset of REVIEW_REASONS values
 * @property {ParsedProcedure[]} procedures
 */

/**
 * @typedef {Object} ParsedRemittance
 * @property {number} index 0-based ST/BPR transaction ordinal within the file
 * @property {string} checkNumber TRN02
 * @property {string|null} paymentDate DTM*405, else BPR16. Never today (D2).
 * @property {'check'|'eft'|null} paymentMethod
 * @property {string} bpr04 raw code, kept because NON and absent are different
 * @property {string} payerName N1*PR
 * @property {string} payeeName N1*PE
 * @property {number} totalPaymentCents BPR02
 * @property {string} traceNumber TRN02
 * @property {string} traceOriginatorId TRN03
 * @property {Array<{reasonCode:string,reasonDescription:string,referenceId:string,amountCents:number}>} plbAdjustments
 * @property {number} plbTotalCents
 * @property {string[]} flags subset of REMITTANCE_FLAGS values
 * @property {ParsedClaim[]} claims
 */

/**
 * Parse an X12 835 file.
 *
 * Synchronous by design (D1) — `await parse835(…)` still works, which is what
 * keeps the ported test bodies untouched.
 *
 * @param {string} fileContent
 * @returns {{
 *   checkNumber: string, checkDate: string|null, paymentMethod: 'check'|'eft'|null,
 *   bpr04: string, payerName: string, payeeName: string, payerIdentifier: string,
 *   totalPaymentCents: number, traceNumber: string, traceOriginatorId: string,
 *   plbAdjustments: ParsedRemittance['plbAdjustments'], plbTotalCents: number,
 *   claims: ParsedClaim[], remittances: ParsedRemittance[], transactionCount: number
 * }}
 * @throws {X12FormatError} when the file is not a parseable 835
 */
function parse835(fileContent) {
  const { segments, delimiters } = parseInterchange(fileContent);
  const componentSep = delimiters.component;

  const hasIsa = segments.some((s) => s.name === 'ISA');
  const hasGs = segments.some((s) => s.name === 'GS');
  if (!hasIsa || !hasGs) {
    throw new X12FormatError('Missing required segments (ISA/GS) in 835 file');
  }

  const stIndexes = [];
  segments.forEach((s, i) => {
    if (s.name === 'ST' && s['1'] === '835') stIndexes.push(i);
  });
  if (stIndexes.length === 0) {
    throw new X12FormatError('No 835 transactions found');
  }

  // B3. Envelope integrity, computed once for the whole interchange.
  const envelope = checkEnvelope(segments, stIndexes);

  /** @type {ParsedRemittance[]} */
  const remittances = [];

  for (let t = 0; t < stIndexes.length; t += 1) {
    const start = stIndexes[t];
    const end = t < stIndexes.length - 1 ? stIndexes[t + 1] : segments.length;
    const tx = segments.slice(start, end);

    const parsed = parseTransaction(tx, remittances.length, componentSep);
    // A transaction with no BPR carries no payment information at all — there
    // is nothing to key, batch, or reconcile. Skipped rather than half-built.
    if (parsed) remittances.push(parsed);
  }

  // B3/B4 are properties of the FILE, so they land on every remittance in it:
  // a batch row is what a human looks at, and "this came out of a truncated
  // transmission" has to be visible from whichever one they opened.
  for (const remittance of remittances) {
    for (const flag of envelope.flags) addFlag(remittance.flags, flag);
    if (stIndexes.length > 1) addFlag(remittance.flags, REMITTANCE_FLAGS.MULTI_TRANSACTION);
  }

  // Merged view. Kept because the ported regression tests read it, and because
  // single-transaction files — every fixture in the corpus, and the
  // overwhelming majority of real ERAs — are exactly described by it. Anything
  // that writes rows reads `remittances` instead (D3).
  const first = remittances[0];
  const allClaims = remittances.flatMap((r) => r.claims);
  const allPlb = remittances.flatMap((r) => r.plbAdjustments);

  return {
    checkNumber: first ? first.checkNumber : 'UNKNOWN',
    checkDate: first ? first.paymentDate : null,
    paymentMethod: first ? first.paymentMethod : null,
    bpr04: first ? first.bpr04 : '',
    payerName: first ? first.payerName : 'Unknown Payer',
    payeeName: first ? first.payeeName : '',
    // Never populated by the source either; the remittance key uses the payer
    // NAME (see remittanceKey.js). Kept so the shape does not change silently.
    payerIdentifier: '',
    totalPaymentCents: remittances.reduce((sum, r) => sum + r.totalPaymentCents, 0),
    traceNumber: first ? first.traceNumber : '',
    traceOriginatorId: first ? first.traceOriginatorId : '',
    plbAdjustments: allPlb,
    plbTotalCents: remittances.reduce((sum, r) => sum + r.plbTotalCents, 0),
    claims: allClaims,
    remittances,
    transactionCount: remittances.length,
    envelope,
  };
}

/**
 * B3. Does the interchange's own bookkeeping agree with what we counted?
 *
 * X12 closes every level with a count, and NONE of them were read before Slice
 * 5.5. The consequence is the worst kind: **a truncated 835 that still contains
 * a valid BPR and some CLPs parses and ingests as if complete.** A transmission
 * cut in half yields a batch whose claims are simply the ones that survived,
 * with nothing anywhere saying so.
 *
 *   SE01  segments in the transaction set, ST and SE inclusive
 *   GE01  transaction sets in the functional group
 *   IEA01 functional groups in the interchange
 *
 * A missing trailer and a wrong count are different facts and get different
 * flags: the first says the file stops early, the second says it disagrees with
 * itself. Neither is fatal — we still parse what is there, because a partial
 * remittance a human is TOLD is partial is more useful than a refusal.
 *
 * @param {import('./x12').X12Segment[]} segments
 * @param {number[]} stIndexes
 * @returns {{ flags: string[], expected: object, actual: object }}
 */
function checkEnvelope(segments, stIndexes) {
  /** @type {string[]} */
  const flags = [];

  const seSegments = segments.filter((s) => s.name === 'SE');
  const geSegment = segments.find((s) => s.name === 'GE');
  const ieaSegment = segments.find((s) => s.name === 'IEA');

  if (seSegments.length === 0 || !geSegment || !ieaSegment) {
    addFlag(flags, REMITTANCE_FLAGS.ENVELOPE_INCOMPLETE);
  }

  // SE01 per transaction set, against the segments actually between ST and SE.
  const seCounts = [];
  for (let t = 0; t < stIndexes.length; t += 1) {
    const start = stIndexes[t];
    const end = t < stIndexes.length - 1 ? stIndexes[t + 1] : segments.length;
    const tx = segments.slice(start, end);
    const se = tx.find((s) => s.name === 'SE');
    if (!se) continue;

    // Count ST through SE inclusive — anything after SE belongs to the next
    // group, not this set.
    const seOffset = tx.findIndex((s) => s.name === 'SE');
    const actual = seOffset + 1;
    const declared = Number.parseInt(se['1'] || '', 10);
    seCounts.push({ declared, actual });
    if (Number.isFinite(declared) && declared !== actual) {
      addFlag(flags, REMITTANCE_FLAGS.ENVELOPE_COUNTS_MISMATCH);
    }
  }

  const declaredGe = geSegment ? Number.parseInt(geSegment['1'] || '', 10) : NaN;
  if (Number.isFinite(declaredGe) && declaredGe !== stIndexes.length) {
    addFlag(flags, REMITTANCE_FLAGS.ENVELOPE_COUNTS_MISMATCH);
  }

  const declaredIea = ieaSegment ? Number.parseInt(ieaSegment['1'] || '', 10) : NaN;
  const gsCount = segments.filter((s) => s.name === 'GS').length;
  if (Number.isFinite(declaredIea) && declaredIea !== gsCount) {
    addFlag(flags, REMITTANCE_FLAGS.ENVELOPE_COUNTS_MISMATCH);
  }

  return {
    flags,
    expected: {
      transactionSets: Number.isFinite(declaredGe) ? declaredGe : null,
      functionalGroups: Number.isFinite(declaredIea) ? declaredIea : null,
      segmentCounts: seCounts.map((c) => (Number.isFinite(c.declared) ? c.declared : null)),
    },
    actual: {
      transactionSets: stIndexes.length,
      functionalGroups: gsCount,
      segmentCounts: seCounts.map((c) => c.actual),
    },
  };
}

/**
 * One ST*835 transaction — one check or EFT.
 * @param {import('./x12').X12Segment[]} tx
 * @param {number} index
 * @returns {ParsedRemittance|null}
 */
function parseTransaction(tx, index, componentSep) {
  const bpr = tx.find((s) => s.name === 'BPR');
  if (!bpr) return null;

  /** @type {string[]} */
  const flags = [];
  const noteUnreadable = () => addFlag(flags, REMITTANCE_FLAGS.UNREADABLE_AMOUNT);

  const totalPaymentCents = toCents(bpr['2'], noteUnreadable);
  const bpr04 = (bpr['4'] || '').trim().toUpperCase();
  const paymentMethod = parsePaymentMethod(bpr04);

  // TRN02 is the number the bank, the EOB and Open Dental all agree on — for a
  // paper check and for an EFT alike. TRN03 is the originating company id.
  const trn = tx.find((s) => s.name === 'TRN');
  const traceNumber = (trn && trn['2']) || '';
  const traceOriginatorId = (trn && trn['3']) || '';

  // DTM*405 (production date) is the standard carrier; BPR16 is the
  // check-issue / EFT-effective date and the correct second choice. There is
  // no third (D2).
  const dtm405 = tx.find((s) => s.name === 'DTM' && s['1'] === '405');
  const paymentDate = toIsoDate((dtm405 && dtm405['2']) || bpr['16']);

  const payerN1 = tx.find((s) => s.name === 'N1' && s['1'] === 'PR');
  const defaultPayerName = (payerN1 && payerN1['2']) || 'Unknown Payer';
  const payeeN1 = tx.find((s) => s.name === 'N1' && s['1'] === 'PE');
  const payeeName = (payeeN1 && payeeN1['2']) || '';

  const plb = parsePlb(tx, componentSep, noteUnreadable);
  const { plbAdjustments, plbTotalCents } = plb;
  for (const f of plb.flags) addFlag(flags, f);

  // Claim windows: [this CLP, next CLP) — never to the end of the transaction,
  // which is how a claim used to inherit the next patient's identity (D12).
  const clpIndexes = [];
  tx.forEach((s, i) => {
    if (s.name === 'CLP') clpIndexes.push(i);
  });

  /** @type {ParsedClaim[]} */
  const claims = [];
  for (let c = 0; c < clpIndexes.length; c += 1) {
    const from = clpIndexes[c];
    const to = c < clpIndexes.length - 1 ? clpIndexes[c + 1] : tx.length;
    claims.push(parseClaim(tx.slice(from, to), defaultPayerName, paymentDate, componentSep));
  }

  if (plbAdjustments.length > 0) addFlag(flags, REMITTANCE_FLAGS.PLB_PRESENT);
  if (totalPaymentCents < 0) addFlag(flags, REMITTANCE_FLAGS.NEGATIVE_PAYMENT);
  if (bpr04 === 'NON') addFlag(flags, REMITTANCE_FLAGS.NO_PAYMENT_MADE);
  if (claims.length === 0) addFlag(flags, REMITTANCE_FLAGS.NO_CLAIMS);

  // BPR02 = sum of claim payments + PLB. A mismatch means we have misread the
  // file or the payer sent an inconsistent one; either way a human decides.
  const claimSum = claims.reduce((sum, cl) => sum + cl.totalPaidCents, 0);
  if (claims.length > 0 && claimSum + plbTotalCents !== totalPaymentCents) {
    addFlag(flags, REMITTANCE_FLAGS.CLAIM_TOTAL_MISMATCH);
  }

  return {
    index,
    checkNumber: traceNumber || 'UNKNOWN',
    paymentDate,
    paymentMethod,
    bpr04,
    payerName: defaultPayerName,
    payeeName,
    totalPaymentCents,
    traceNumber,
    traceOriginatorId,
    plbAdjustments,
    plbTotalCents,
    flags,
    claims,
  };
}

/**
 * PLB — Provider Level Balance. Money moving at the provider level, belonging
 * to no single claim: recoupments of prior overpayments, interest, penalties.
 *
 * Layout: PLB01 provider id · PLB02 fiscal period · then repeating
 * (reasonCode:referenceId, amount) PAIRS from PLB03 onward.
 *
 * SLICE 5.5 DEFECT A5, the PLB half. The old loop `break`s on the first empty
 * element, so a gapped segment lost every pair after the gap. The only trace
 * was a downstream `claim_total_mismatch` — and only when the lost amount
 * happened to move the BPR reconciliation. Skip-and-flag instead.
 *
 * @param {import('./x12').X12Segment[]} tx
 * @param {string} componentSep the ISA16 this interchange declared (A2)
 * @param {(token: string) => void} onUnreadable
 */
function parsePlb(tx, componentSep, onUnreadable) {
  /** @type {ParsedRemittance['plbAdjustments']} */
  const plbAdjustments = [];
  /** @type {string[]} */
  const flags = [];
  let plbTotalCents = 0;

  for (const plb of tx.filter((s) => s.name === 'PLB')) {
    const values = elementsOf(plb);

    // Index 2 is PLB03 — the first reason composite. Pairs from there.
    for (let i = 2; i < values.length; i += 2) {
      const composite = (values[i] || '').trim();
      const amount = values[i + 1];

      if (!composite) {
        if (values.slice(i + 1).some((v) => (v || '').trim() !== '')) {
          addFlag(flags, REMITTANCE_FLAGS.PARTIAL_ADJUSTMENT_SEGMENT);
        }
        continue;
      }
      if (amount === undefined || String(amount).trim() === '') {
        // A reason with no amount is money we cannot account for, not a
        // terminator — the pairs after it may well be readable.
        addFlag(flags, REMITTANCE_FLAGS.PARTIAL_ADJUSTMENT_SEGMENT);
        continue;
      }

      const reasonCode = subElement(composite, 0, componentSep);
      const referenceId = subElement(composite, 1, componentSep);
      const amountCents = toCents(amount, onUnreadable);

      plbAdjustments.push({
        reasonCode,
        reasonDescription:
          PLB_REASON_DESCRIPTIONS[reasonCode] || `Provider adjustment (${reasonCode})`,
        referenceId,
        amountCents,
      });
      // Positive = owed TO the provider, negative = owed BY. A WO recoupment
      // is negative, which is why this sum is not an absolute value.
      plbTotalCents += amountCents;
    }
  }

  return { plbAdjustments, plbTotalCents, flags };
}

/**
 * One CLP loop (2100), bounded by the next CLP.
 * @param {import('./x12').X12Segment[]} win the claim's own segments
 * @param {string} defaultPayerName
 * @param {string|null} paymentDate used only as the service-date fallback
 * @returns {ParsedClaim}
 */
function parseClaim(win, defaultPayerName, paymentDate, componentSep) {
  const clp = win[0];

  /** Raised when a token where an amount belonged did not validate (A4). */
  let sawUnreadableAmount = false;
  const noteUnreadableAmount = () => {
    sawUnreadableAmount = true;
  };

  const claimNumber = clp['1'] || '';
  const claimStatusCode = (clp['2'] || '1').trim();
  const totalBilledCents = toCents(clp['3'], noteUnreadableAmount);
  const totalPaidCents = toCents(clp['4'], noteUnreadableAmount);
  const patientRespCents = toCents(clp['5'], noteUnreadableAmount);
  const payerClaimControlNumber = clp['7'] || '';

  const status = CLAIM_STATUS[claimStatusCode] || { label: `status_${claimStatusCode}`, cobSequence: 1 };
  const isDenied = claimStatusCode === '4';
  const isReversal = claimStatusCode === '22';

  // The payer for THIS claim: an N1*PR inside the claim window overrides the
  // transaction default (a single 835 can carry more than one payer).
  const claimN1 = win.find((s, i) => i > 0 && s.name === 'N1' && s['1'] === 'PR');
  const payer = (claimN1 && claimN1['2']) || defaultPayerName;

  // NM1*QC — the PATIENT. NM1*IL is the SUBSCRIBER, and on a dependent's claim
  // they are different people; the chart note must name the patient.
  const patientNm1 = win.find((s) => s.name === 'NM1' && s['1'] === 'QC');
  const subscriberNm1 = win.find((s) => s.name === 'NM1' && s['1'] === 'IL');
  const patientName =
    `${(patientNm1 && patientNm1['4']) || ''} ${(patientNm1 && patientNm1['3']) || ''}`.trim() ||
    'Unknown Patient';

  const dmg = win.find((s) => s.name === 'DMG');
  const patientDOB = toIsoDate(dmg && dmg['2']);

  // D6: the member id lives in NM1 element 9 (qualified 'MI' at element 8).
  // REF*1L is the GROUP number — the source read it as the subscriber id.
  const idHolder = subscriberNm1 || patientNm1;
  const subscriberId = (idHolder && idHolder['9']) || '';
  const groupRef = win.find((s) => s.name === 'REF' && s['1'] === '1L');
  const groupNumber = (groupRef && groupRef['2']) || '';

  // D7: NM1*82 element 9 carries the NPI when there is no REF*1G.
  const providerNm1 = win.find((s) => s.name === 'NM1' && s['1'] === '82');
  const renderingProvider = providerNm1
    ? `${providerNm1['4'] || ''} ${providerNm1['3'] || ''}`.trim()
    : '';
  const providerRef = win.find((s) => s.name === 'REF' && s['1'] === '1G');
  const providerNPI = (providerRef && providerRef['2']) || (providerNm1 && providerNm1['9']) || '';

  const serviceDtm = win.find((s) => s.name === 'DTM' && s['1'] === '232');
  const serviceDate = toIsoDate(serviceDtm && serviceDtm['2']) || paymentDate;

  // AMT*D — what a PRIOR payer already paid. Its presence is the substantive
  // signal of coordination of benefits, independent of what CLP02 claims.
  const priorPayerAmt = win.find((s) => s.name === 'AMT' && s['1'] === 'D');
  const priorPayerPaidCents = toCents(priorPayerAmt && priorPayerAmt['2'], noteUnreadableAmount);

  const procedures = parseServiceLines(win, isDenied, componentSep);

  // ── A1. CLAIM-LEVEL CAS (loop 2100) ──────────────────────────────────────
  //
  // A CAS between the CLP and the first SVC applies to the whole claim, and
  // payers routinely report deductible and coinsurance there. It used to be
  // DROPPED ENTIRELY, with no flag: the claim stored total_deductible_cents = 0
  // and patient_balance_cents = 0 while its own CLP05 correctly said otherwise
  // — two stored numbers disagreeing, and nothing reconciling them.
  const firstSvc = win.findIndex((s) => s.name === 'SVC');
  const claimHeaderWindow = win.slice(1, firstSvc === -1 ? win.length : firstSvc);
  const claimCas = readCasSegments(
    claimHeaderWindow.filter((s) => s.name === 'CAS'),
    'claim',
    noteUnreadableAmount
  );

  const totalDeductibleCents =
    procedures.reduce((sum, p) => sum + p.deductibleCents, 0) + claimCas.deductibleCents;
  const totalCopayCents =
    procedures.reduce((sum, p) => sum + p.copayCents, 0) + claimCas.copayCents;

  // The claim's allowed amount nets off contractual reductions wherever they
  // were reported — on the lines and at claim level alike (A3 counts OA and PI
  // as contractual now, not only CO).
  const totalAllowedCents =
    totalBilledCents -
    procedures.reduce((sum, p) => sum + contractualCentsOf(p.adjustments), 0) -
    contractualCentsOf(claimCas.adjustments);

  // B2. MOA/MIA carry CLAIM-level remark codes and were not read at all.
  // MOA03-MOA07 and MIA05/MIA20-MIA23 are the remark-code positions; scanning
  // every element and keeping the ones shaped like a RARC is more robust than
  // hardcoding positions that differ between the two segments.
  const claimRemarkCodes = [];
  for (const seg of win.filter((s) => s.name === 'MOA' || s.name === 'MIA')) {
    for (const value of elementsOf(seg)) {
      const token = (value || '').trim().toUpperCase();
      if (RARC_RE.test(token)) addFlag(claimRemarkCodes, token);
    }
  }

  /** @type {string[]} */
  const needsReviewReasons = [];
  for (const f of claimCas.flags) {
    // The claim-header CAS raises the same defect classes a line-level one
    // does; they surface as claim review reasons because there is no line.
    if (f === 'unexplained_adj') addFlag(needsReviewReasons, REVIEW_REASONS.UNPARSEABLE_CAS);
    if (f === 'partial_adjustment_segment') {
      addFlag(needsReviewReasons, REVIEW_REASONS.PARTIAL_ADJUSTMENT_SEGMENT);
    }
    if (f === 'unreadable_amount') addFlag(needsReviewReasons, REVIEW_REASONS.UNREADABLE_AMOUNT);
  }
  if (claimCas.adjustments.length > 0) {
    addFlag(needsReviewReasons, REVIEW_REASONS.CLAIM_LEVEL_ADJUSTMENTS);
  }
  if (isReversal) addFlag(needsReviewReasons, REVIEW_REASONS.REVERSAL);
  if (isDenied) addFlag(needsReviewReasons, REVIEW_REASONS.DENIED);
  if (status.cobSequence > 1) addFlag(needsReviewReasons, REVIEW_REASONS.SECONDARY);
  if (priorPayerPaidCents !== 0) {
    addFlag(needsReviewReasons, REVIEW_REASONS.SECONDARY);
    // The file says "processed as primary" while reporting a prior payer's
    // payment. Both cannot be true; surfaced rather than silently reconciled.
    if (status.cobSequence === 1) addFlag(needsReviewReasons, REVIEW_REASONS.PRIOR_PAYER_ON_PRIMARY);
  }
  if (procedures.length === 0) addFlag(needsReviewReasons, REVIEW_REASONS.NO_SERVICE_LINES);
  for (const proc of procedures) {
    if (proc.isDowncoded) addFlag(needsReviewReasons, REVIEW_REASONS.DOWNCODE);
    if (proc.flags.includes('unexplained_adj')) {
      addFlag(needsReviewReasons, REVIEW_REASONS.UNPARSEABLE_CAS);
    }
    if (proc.flags.includes('partial_adjustment_segment')) {
      addFlag(needsReviewReasons, REVIEW_REASONS.PARTIAL_ADJUSTMENT_SEGMENT);
    }
    if (proc.flags.includes('unreadable_amount')) {
      addFlag(needsReviewReasons, REVIEW_REASONS.UNREADABLE_AMOUNT);
    }
    // A3. A reported allowed amount that disagrees with the derived one.
    if (proc.flags.includes('allowed_mismatch')) {
      addFlag(needsReviewReasons, REVIEW_REASONS.ALLOWED_AMOUNT_MISMATCH);
    }
  }
  if (sawUnreadableAmount) addFlag(needsReviewReasons, REVIEW_REASONS.UNREADABLE_AMOUNT);

  // CLP04 is the payer's own total. If our lines do not reach it we have
  // misread something; a claim that quietly posts short is worse than one held.
  const lineSum = procedures.reduce((sum, p) => sum + p.paidCents, 0);
  if (procedures.length > 0 && lineSum !== totalPaidCents) {
    addFlag(needsReviewReasons, REVIEW_REASONS.LINE_TOTAL_MISMATCH);
  }

  // A1. CLP05 is the payer's own statement of what the patient owes. Reconcile
  // it against every PR adjustment we found, WHEREVER it was reported — that is
  // the check that was structurally impossible while claim-level CAS was being
  // dropped, and it is what would have caught the drop.
  //
  // Only when the payer actually sent a CLP05: an omitted one is 0 here and
  // reconciling against it would flag most of the corpus for a field the file
  // never claimed.
  const reportedPatientResp = (clp['5'] || '').trim() !== '';
  const patientRespSeen =
    procedures.reduce((sum, p) => sum + p.adjustments.reduce(prSum, 0), 0) +
    claimCas.patientRespCents;
  if (reportedPatientResp && patientRespSeen !== patientRespCents) {
    addFlag(needsReviewReasons, REVIEW_REASONS.PATIENT_RESP_MISMATCH);
  }

  return {
    claimLevelAdjustments: claimCas.adjustments,
    remarkCodes: claimRemarkCodes,
    patientRespSeenCents: patientRespSeen,
    claimNumber,
    claimStatusCode,
    claimStatusLabel: status.label,
    payerClaimControlNumber,
    patientName,
    patientDOB,
    subscriberId,
    groupNumber,
    payer,
    serviceDate,
    providerNPI,
    renderingProvider,
    totalBilledCents,
    totalAllowedCents,
    totalDeductibleCents,
    totalCopayCents,
    totalPaidCents,
    patientRespCents,
    priorPayerPaidCents,
    insuranceType: COB_SEQUENCE_TO_INSURANCE_TYPE[status.cobSequence] || 'primary',
    cobSequence: status.cobSequence,
    isDenied,
    isReversal,
    needsReviewReasons,
    procedures,
  };
}

/**
 * The claim's SVC loops (2110).
 *
 * `claimDenied` is the CLP02 = 4 determination, and it is the ONLY thing that
 * marks a line denied. A line can pay zero for several reasons that are not
 * denial — the whole charge went to the deductible (PR-1), a prior payer
 * already covered it (OA-23), it was bundled into another procedure (CO-B15) —
 * and its own CAS adjustments already say which. Inferring "denied" from a zero
 * payment would relabel every one of those as a refusal to pay, which is a
 * different conversation with the carrier and a different worklist for staff.
 *
 * @param {import('./x12').X12Segment[]} win
 * @param {boolean} claimDenied
 * @param {string} componentSep the ISA16 this interchange declared (A2)
 * @returns {ParsedProcedure[]}
 */
function parseServiceLines(win, claimDenied, componentSep) {
  const svcIndexes = [];
  win.forEach((s, i) => {
    if (s.name === 'SVC') svcIndexes.push(i);
  });

  /** @type {ParsedProcedure[]} */
  const procedures = [];

  for (let n = 0; n < svcIndexes.length; n += 1) {
    const svcIndex = svcIndexes[n];
    const svc = win[svcIndex];

    // The 2110 loop runs to the next SVC — or to whatever ends the claim.
    // NEVER a fixed window: that was the bug this parser was fixed for.
    let loopEnd = win.length;
    for (let j = svcIndex + 1; j < win.length; j += 1) {
      const name = win[j].name;
      if (name === 'SVC' || name === 'CLP' || name === 'SE' || name === 'PLB' || name === 'LX') {
        loopEnd = j;
        break;
      }
    }
    const loop = win.slice(svcIndex + 1, loopEnd);

    /** @type {string[]} */
    const flags = [];
    const noteUnreadable = () => addFlag(flags, 'unreadable_amount');

    // SVC01 is the ADJUDICATED code; SVC06 the ORIGINAL SUBMITTED one, present
    // only when the payer changed it. See NOTE ON DOWNCODES (D4).
    const adjudicatedCode = subElement(svc['1'], 1, componentSep) || svc['1'] || '';
    const submittedRaw = svc['6'] ? subElement(svc['6'], 1, componentSep) || svc['6'] : '';
    const billedCode = submittedRaw || adjudicatedCode;
    const isDowncoded = Boolean(submittedRaw) && submittedRaw !== adjudicatedCode;

    const billedCents = toCents(svc['2'], noteUnreadable);
    const paidCents = toCents(svc['3'], noteUnreadable);

    // B1. SVC05 — units actually paid. Fractional units are legal in X12, so
    // this is not an integer.
    const unitsRaw = (svc['5'] || '').trim();
    const unitsPaid = unitsRaw === '' || !AMOUNT_RE.test(unitsRaw) ? null : Number.parseFloat(unitsRaw);

    // B1. REF*6R — the line item control number. The only reliable key for
    // matching a remitted line back to a submitted claim line; without it
    // Slice 6's matcher is positional, which breaks the moment a payer
    // reorders or splits lines.
    const controlRef = loop.find((s) => s.name === 'REF' && s['1'] === '6R');
    const lineItemControlNumber = (controlRef && controlRef['2']) || null;

    // B2. The FULL RARC set. X12 gives no CAS↔LQ association, so these belong
    // to the LINE and are stored on it — not stamped onto every adjustment,
    // which is what used to store the first RARC three times on a 3-CARC line.
    const remarkCodes = loop
      .filter((s) => s.name === 'LQ' && s['1'] === 'HE' && s['2'])
      .map((s) => s['2'].trim())
      .filter(Boolean);

    const cas = readCasSegments(
      loop.filter((s) => s.name === 'CAS'),
      'line',
      noteUnreadable
    );
    const adjustments = cas.adjustments;
    for (const f of cas.flags) addFlag(flags, f);
    const { deductibleCents, copayCents } = cas;

    for (const adj of adjustments) {
      const mapped = CARC_TO_LINE_FLAG[adj.reasonCode];
      if (mapped) addFlag(flags, mapped);
    }

    // A3. The allowed amount, READ when the payer reports it and derived only
    // when it does not. AMT*B6 is the "allowed — actual" amount; the derived
    // form is billed minus the contractual reduction, which now counts OA and
    // PI as well as CO.
    const allowedAmt = loop.find((s) => s.name === 'AMT' && s['1'] === 'B6');
    const derivedAllowedCents = billedCents - contractualCentsOf(adjustments);
    const reportedAllowedCents = allowedAmt
      ? toCents(allowedAmt['2'], noteUnreadable)
      : null;

    const allowedSource = allowedAmt ? 'reported' : 'derived';
    const allowedCents = allowedAmt ? reportedAllowedCents : derivedAllowedCents;

    // The two disagreeing is a disagreement about money — write_off_cents is
    // derived from this and Slice 6c writes it into Open Dental.
    if (
      allowedAmt &&
      Math.abs(reportedAllowedCents - derivedAllowedCents) > ALLOWED_TOLERANCE_CENTS
    ) {
      addFlag(flags, 'allowed_mismatch');
    }

    const isDenied = claimDenied && paidCents === 0;
    if (isDowncoded) addFlag(flags, 'downcode');
    if (isDenied) addFlag(flags, 'denied');
    if (paidCents > 0 && paidCents < allowedCents) addFlag(flags, 'partial_pay');

    procedures.push({
      code: adjudicatedCode,
      billedCode,
      paidCode: isDowncoded ? adjudicatedCode : null,
      description: `Procedure ${adjudicatedCode}`,
      billedCents,
      allowedCents,
      allowedSource,
      reportedAllowedCents,
      derivedAllowedCents,
      deductibleCents,
      copayCents,
      paidCents,
      unitsPaid,
      lineItemControlNumber,
      isDowncoded,
      isBundled: flags.includes('bundled'),
      isDenied,
      flags,
      adjustments,
      remarkCodes,
    });
  }

  return procedures;
}

module.exports = {
  parse835,
  // Exported for tests and for the route's flag handling — not for redefinition.
  PLB_REASON_DESCRIPTIONS,
  CLAIM_STATUS,
  LINE_FLAGS,
  REVIEW_REASONS,
  REMITTANCE_FLAGS,
  X12FormatError,
  // Internals worth pinning directly.
  toCents,
  toIsoDate,
  parsePaymentMethod,
  isPlausibleCarc,
};
