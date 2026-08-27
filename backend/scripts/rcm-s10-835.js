'use strict';

/*
 * §10 PREP, STEP 3 OF 3 — THE TWO SYNTHETIC 835s.
 *
 *     node scripts/rcm-s10-835.js
 *
 * NO OPEN DENTAL ACCESS AT ALL. No secrets, no network, no office handle. It
 * reads the manifest `rcm-s10-prep.js` wrote and emits two files:
 *
 *     /data/rcm-s10/rcm-s10-835-A.txt   pays $1.00 on target A's claim
 *     /data/rcm-s10/rcm-s10-835-B.txt   pays $1.00 on target B's claim
 *
 * (`/data` is the AzureFile volume. `/app` is read-only to the user the container
 * runs as; `S10_OUT_DIR` overrides the location for local runs.)
 *
 * and prints both to stdout, because the container's filesystem is not where
 * Beau uploads from. See "GETTING THE FILES OUT" at the bottom of this header.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THESE ARE GENERATED AT PREP TIME AND NOT TYPED ON THE NIGHT
 * ─────────────────────────────────────────────────────────────────────────────
 * Because they cannot be written before the claims exist — CLP01 carries the
 * real ClaimNum — and because hand-authoring X12 at 10pm beside a live chart
 * database is how a walk turns into a debugging session. Everything that is not
 * a human decision is built, checked, and sitting ready before the night. The
 * only things left on the night are review, approve, drain, verify, kill,
 * replay, unwind.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT MAKES THE MATCHER FIND THEM
 * ─────────────────────────────────────────────────────────────────────────────
 * `services/rcm/claimMatch.js` scores candidates; it never picks one. Four
 * pieces of evidence are deliberately arranged here so the biller is shown ONE
 * strong candidate rather than an ambiguous pair:
 *
 *   CLP01 = the real ClaimNum      -> CLAIM_NUMBER_MATCH (35/100). "The carrier
 *                                     echoes the payer's own claim id in CLP01,
 *                                     which for a claim Open Dental submitted IS
 *                                     the ClaimNum."
 *   NM1*QC = the chart's own name  -> PATIENT_NAME_MATCH. Read from Open Dental
 *                                     by the prep script and carried in the
 *                                     manifest, NOT guessed here. A name a script
 *                                     believes a test patient has is a name that
 *                                     is quietly wrong one rename later, and on
 *                                     the name-search lane a mismatch is
 *                                     DISQUALIFYING, not merely costly.
 *   DTM*472 = the claim's date     -> the date-near band. From the manifest, so
 *                                     it stays the CLAIM's date however many days
 *                                     pass between prep and the walk.
 *   SVC billed 1.00 / paid 1.00    -> exact-amount and matching-code evidence.
 *
 * There is no CO-45 and no CAS at all: nothing is disallowed, so the write-off is
 * zero and the arithmetic on the night is $1.00 in, $1.00 out, one line, one
 * check. A walk that has to reason about a contractual adjustment is measuring
 * two things at once.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING IN THESE FILES RESEMBLES A REAL PERSON OR A REAL ENTITY
 * ─────────────────────────────────────────────────────────────────────────────
 * The payer is `CAREIN SYNTHETIC PAYER`. The checks are `S10A-<claim>` and
 * `S10B-<claim>`, which say what they are on their face. There is no DMG (so no
 * date of birth), no subscriber id, no REF*1L group number, and no NM1*82
 * rendering provider — so no NPI and no TIN, real or invented. The payee is the
 * practice's own name and its own NPI is omitted rather than fabricated: an
 * invented 10-digit NPI is a number that belongs to somebody.
 *
 * The one identifying string in the file is the TEST PATIENT'S OWN chart name,
 * which is what makes the match work at all. 12827 is a designated synthetic
 * fixture (CLAUDE.md), the files are written outside the repository entirely (to
 * the /data volume), and this script does not print that name outside the file
 * bodies it emits.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE BUILDER IS HERE RATHER THAN REUSED
 * ─────────────────────────────────────────────────────────────────────────────
 * The only 835 builder in the repo is `build835` inside
 * `services/rcm/eraParser.test.js` — a local, unexported test helper that hard-
 * codes a $150 ACH from DELTA DENTAL and takes only a claim block. It is not a
 * generator; exporting it would make a fixed test scaffold into an API, and
 * every corpus assertion in that file would then move whenever this walk needed
 * a different header. The 13 `.edi` files under `test/fixtures/rcm` are FIXED by
 * contract — "no file may be edited, ever". So this builds its own, in ~40 lines,
 * against the same 005010X221A1 shape.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GETTING THE FILES OUT OF THE CONTAINER
 * ─────────────────────────────────────────────────────────────────────────────
 * The upload route is `POST /api/rcm/era` and it CANNOT be driven by the shared
 * `DASHBOARD_API_TOKEN`: `tenantContext` fails closed on a request with no user
 * identity (403 TENANT_UNRESOLVED), so a token-only caller never reaches the
 * handler. Uploading needs the SSO session. So: copy both file bodies out of
 * this script's stdout, save them locally as `.txt`, and upload them from the
 * Remittances screen under /rcm, signed in as `admin` or `office`.
 */

const fs = require('node:fs');
const T = require('./rcm-s10-targets');


/*
 * ─────────────────────────────────────────────────────────────────────────────
 * 6d: WHICH PRACTICE THIS RUN ADDRESSES, RESOLVED ONCE, AT LOAD.
 * ─────────────────────────────────────────────────────────────────────────────
 * `PROBE_OFFICE` selects; an office the registry does not name THROWS here,
 * before `main()` and before any Open Dental client exists. Failing at require
 * time rather than mid-run is deliberate: a typo must not get as far as holding
 * a credential.
 *
 * Every id below is per-office, because ClaimNum, ProcNum and ClaimProcNum
 * numbering restarts in every Open Dental database — and PatNum 7115 is valley's
 * test patient and a DIFFERENT, REAL person in Roland.
 */
const TARGET = T.resolveTarget();
const PATHS = T.pathsFor(TARGET.office);
const DENY = T.denyIdsFor(TARGET);

/** X12 segment terminator, matching every fixture in `test/fixtures/rcm`. */
const SEG = '~\n';

/** `YYYY-MM-DD` -> `YYYYMMDD`, X12's date form. */
const x12Date = (iso) => String(iso || '').replace(/-/g, '');

/** Cents -> the plain decimal X12 wants: 100 -> "1.00". */
/*
 * Cents to an X12 decimal string, SIGN-CORRECT below a dollar.
 *
 * The old form was `${Math.trunc(c / 100)}.${abs(c) % 100}`, which is right for
 * every positive amount and for -100, and WRONG for -50: `Math.trunc(-0.5)` is
 * `-0`, which templates as `"0"`, so fifty cents taken back rendered as fifty
 * cents paid. Nothing exercised it while every amount here was +$1.00. The
 * recoupment file is the first negative this function has ever seen, so the sign
 * is now carried explicitly rather than inferred from the integer part.
 */
const x12Amount = (c) => {
  const cents = Math.trunc(c);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

/**
 * One complete 835 interchange paying `feeCents` on exactly one claim, one line.
 *
 * BPR02 equals the single claim's payment, so the file reconciles: the corpus
 * suite's `BPR02 reconciles against claim payments plus PLB` is the property
 * being honoured, and a check total that disagreed with its claims is precisely
 * the kind of "flagged for review" the walk must not have to reason about.
 *
 * @param {{ label: string, claimNum: number, patLast: string, patFirst: string,
 *           procCode: string, feeCents: number, serviceDate: string,
 *           controlNumber: string }} spec
 * @returns {string}
 */
function build835(spec) {
  /*
   * ─── THE RECOUPMENT FILE IS THE NEGATED MIRROR OF THE PAYMENT ─────────────
   *
   * `sign = -1` negates every money element and sets CLP02 = 22, the X12 code
   * for *reversal of previous payment*. Nothing else about the file changes:
   * same claim, same patient, same service date, same procedure.
   *
   * WHY A MIRROR RATHER THAN A CAS-BALANCED CLAW-BACK, which is what the brief
   * asked for and is worth saying plainly. An 835 balances per line: billed =
   * paid + the sum of its CAS adjustments. File A carries **no CAS at all** on
   * purpose — nothing is disallowed, so the write-off is zero and the night's
   * arithmetic is one number. A reversal of a claim with no adjustments has no
   * adjustments to reverse. Expressing the takeback as `CLP03 = 1.00,
   * CLP04 = -1.00` would need `CAS = 2.00` to balance, and that two dollars is
   * not a real contractual write-off — it is an artefact of forcing a CAS into a
   * file that has nothing for one to describe. The walk would then be measuring
   * the takeback AND a phantom write-off at once.
   *
   * So the negation is generic rather than special-cased: `spec.adjustments`
   * are negated along with everything else, and the day File A grows a CO-45
   * the reversal will carry `CAS*CO*45*-<that>` without another line of code.
   * Today that array is empty, so no CAS segment is emitted — which is the
   * correct 835, not a shortcut.
   */
  const sign = spec.sign === -1 ? -1 : 1;
  const reversal = sign === -1;
  const amount = x12Amount(sign * spec.feeCents);
  const day = x12Date(spec.serviceDate);
  const checkNum = `S10${spec.label}-${spec.claimNum}`;
  const ctl = spec.controlNumber;
  /*
   * CLP02: 1 = processed as primary, 22 = REVERSAL OF PREVIOUS PAYMENT. This is
   * what tells a human reading the file that it is a takeback rather than a
   * second, negative payment — and it is the field an 835 reader looks at first.
   */
  const claimStatus = reversal ? '22' : '1';
  /** Reversed adjustments, if the file being mirrored had any. Today: none. */
  const casSegments = (spec.adjustments || []).map(
    (a) => `CAS*${a.group}*${a.reason}*${x12Amount(sign * a.cents)}`
  );

  const segments = [
    // Sender/receiver are the synthetic payer and the practice. No real ids.
    `ISA*00*          *00*          *ZZ*CAREINSYNTH    *ZZ*CAREINTEST     *${day.slice(2)}*1200*^*00501*${ctl}*0*P*:`,
    `GS*HP*CAREINSYNTH*CAREINTEST*${day}*1200*1*X*005010X221A1`,
    `ST*835*${ctl}`,
    // BPR04=CHK, a paper check. BPR16 is the payment date; DTM*405 below is what
    // the parser actually prefers, and both say the same thing here.
    // BPR03 is the credit/debit flag. A reversal is a DEBIT — money coming back
    // off the practice — and an 835 reader looks at this before it looks at the
    // sign on BPR02. BPR02 itself stays SIGNED so the file still reconciles
    // against its claim payments, which is the property the corpus suite checks.
    `BPR*I*${amount}*${reversal ? 'D' : 'C'}*CHK************${day}`,
    // TRN02 is the check number — the parser takes it from here, never from
    // BPR16 (which is a date; that confusion is one of the two regressions the
    // ported eraParser suite pins).
    `TRN*1*${checkNum}*9999999999`,
    `DTM*405*${day}`,
    'N1*PR*CAREIN SYNTHETIC PAYER',
    // Payee: the practice, with NO NPI. An invented 10-digit NPI is a number that
    // belongs to somebody.
    'N1*PE*CAREIN TEST PRACTICE',
    'LX*1',
    // CLP01 = the real ClaimNum (the matcher's CLAIM_NUMBER_MATCH, 35/100).
    // CLP02=1 processed as primary, CLP03 billed, CLP04 paid, CLP05 patient
    // responsibility 0, CLP06=12 PPO, CLP07 the payer's own control number.
    `CLP*${spec.claimNum}*${claimStatus}*${amount}*${amount}*0*12*${checkNum}`,
    `NM1*QC*1*${spec.patLast}*${spec.patFirst}`,
    // Billed and paid are equal and, on a reversal, both negative. One unit.
    // CAS only if the file being mirrored carried adjustments — see build835's
    // header for why forcing one in would put a phantom write-off on the walk.
    `SVC*AD:${spec.procCode}*${amount}*${amount}**1`,
    ...casSegments,
    `DTM*472*${day}`,
  ];
  // SE01 counts ST through SE inclusive: the segments from ST onwards, plus SE.
  const stIndex = segments.findIndex((s) => s.startsWith('ST*835*'));
  const segmentCount = segments.length - stIndex + 1;
  segments.push(`SE*${segmentCount}*${ctl}`, `GE*1*1`, `IEA*1*${ctl}`);
  return segments.join(SEG) + SEG;
}

/**
 * The recoupment file: −$1.00 off target A's claim, as a reversal.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * IT IS ONLY UPLOADED AFTER A HAS POSTED, AND THAT IS NOT A CONVENTION
 * ──────────────────────────────────────────────────────────────────────────────
 * A takeback acts on a claimproc that is already `Received` and already on a
 * check — that is what makes it a takeback rather than a negative payment. Sent
 * before A has drained, there is nothing on the chart to take back from, and the
 * drain's own line decision would read the claimproc as unpaid.
 *
 * Written to its own filename (`…-R-recoupment.txt`) rather than as a `-C`
 * continuing the series, so nobody uploads all three together.
 *
 * The CHECK NUMBER differs from A's (`S10R-…` against `S10A-…`), so the
 * office-scoped remittance key cannot dedupe one against the other.
 *
 * @param {object} manifest
 * @param {object} target   target A, from the manifest
 * @param {string} patLast
 * @param {string} patFirst
 * @returns {string}
 */
function buildRecoupment(manifest, target, patLast, patFirst) {
  return build835({
    label: 'R',
    sign: -1,
    claimNum: Number(target.claimNum),
    patLast,
    patFirst,
    procCode: manifest.procCode || T.PROC_CODE,
    feeCents: Number(manifest.feeCents) || T.PROC_FEE_CENTS,
    serviceDate: String(target.serviceDate || ''),
    controlNumber: '000000009',
    // Nothing to reverse: File A carries no CAS. See build835's header.
    adjustments: [],
  });
}

/**
 * `--recoupment` also emits the takeback file. Off by default — see the flag's
 * use below for why it is not simply always written.
 */
const RECOUPMENT = process.argv.includes('--recoupment');

function main() {
  if (!fs.existsSync(PATHS.manifestPath)) {
    console.error(
      `REFUSED: no manifest at\n  ${PATHS.manifestPath}\n` +
        '  These files carry the REAL ClaimNums, so they cannot be written before the claims\n' +
        '  exist. Run `node scripts/rcm-s10-prep.js` first.'
    );
    process.exitCode = 2;
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(PATHS.manifestPath, 'utf8'));

  if (manifest.office !== TARGET.office || Number(manifest.patNum) !== TARGET.patNum) {
    console.error(
      `REFUSED: the manifest is for office='${manifest.office}' patNum=${manifest.patNum}; ` +
        `these scripts are '${TARGET.office}'/${TARGET.patNum} only.`
    );
    process.exitCode = 3;
    return;
  }

  const usable = (manifest.targets || []).filter((t) => Number(t.claimNum) > 0);
  if (usable.length !== T.TARGET_COUNT) {
    console.error(
      `REFUSED: the manifest names ${usable.length} claim(s); the walk needs ${T.TARGET_COUNT}\n` +
        '  (one for the drain, one for the kill-mid-drain). Read the prep transcript.'
    );
    process.exitCode = 4;
    return;
  }

  const patLast = String(manifest.patLast || '').trim();
  const patFirst = String(manifest.patFirst || '').trim();
  if (!patLast) {
    console.error(
      'REFUSED: the manifest carries no surname for the patient.\n' +
        '  Without it the matcher scores PATIENT_NAME_MISMATCH and, on the name-search lane,\n' +
        '  refuses to offer the candidate at all. Re-run the prep so it reads the chart name.'
    );
    process.exitCode = 5;
    return;
  }

  const paths = [PATHS.eraAPath, PATHS.eraBPath];
  // Same gate the prep uses, for the same reason: fail on the precondition
  // rather than half way through emitting the pair. This script touches no
  // chart, so the cost of a late failure is smaller — but an operator who has
  // file A and a stack trace where B should be is still worse off than one who
  // has a sentence.
  const outDirProblem = T.checkOutDirWritable(PATHS.outDir);
  if (outDirProblem) {
    console.error(`REFUSED: ${outDirProblem}`);
    process.exitCode = 7;
    return;
  }

  console.log(`\n=== S10 SYNTHETIC 835s — ${T.TARGET_COUNT} files, $${(T.PROC_FEE_CENTS / 100).toFixed(2)} each ===`);

  for (const [i, target] of usable.entries()) {
    const label = String.fromCharCode(65 + i);
    /*
     * The service date comes from the manifest and from NOWHERE ELSE.
     *
     * It used to fall back to the day the target was created, which was a fallback
     * for a value that might be absent. It cannot be absent any more: `ProcDate`
     * is a REQUIRED field on `POST /procedurelogs`, so the prep now sends it
     * explicitly, checks the read-back agrees, and records the chart's version.
     * The fallback was dead code that could only ever fire when something had
     * gone wrong upstream — and its effect would have been to paper over that by
     * inventing a plausible date.
     *
     * NOT `new Date()` at any point. These files are written at prep time and
     * uploaded days later; the matcher scores the 835's service date against the
     * chart's, so it must be the CHART's date, however long the gap.
     */
    const serviceDate = String(target.serviceDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
      console.error(
        [
          `REFUSED: target ${label} carries no service date (got ${JSON.stringify(target.serviceDate)}).`,
          '  The prep records the ProcDate it read back from Open Dental. A manifest without one',
          '  did not come from a completed prep run — re-run it rather than inventing a date the',
          '  chart does not have.',
        ].join('\n')
      );
      process.exitCode = 6;
      return;
    }

    const era = build835({
      label,
      claimNum: Number(target.claimNum),
      patLast,
      patFirst,
      procCode: manifest.procCode || T.PROC_CODE,
      feeCents: Number(manifest.feeCents) || T.PROC_FEE_CENTS,
      serviceDate,
      // Interchange control numbers must differ between the two files; the
      // office-scoped remittance key (services/rcm/remittanceKey.js) also sees
      // two different check numbers, so neither file can dedupe the other away.
      controlNumber: `S10${label}0000${i + 1}`.slice(-9).padStart(9, '0'),
    });

    fs.writeFileSync(paths[i], era, 'utf8');
    console.log(`\n-- ${paths[i]}`);
    console.log(`   claim ${target.claimNum}  claimproc ${target.claimProcNum}  service ${serviceDate}  check S10${label}-${target.claimNum}`);
    console.log('   ------------------------------ 8< ------------------------------');
    process.stdout.write(era);
    console.log('   ------------------------------ 8< ------------------------------');
  }

  /*
   * ─── THE RECOUPMENT FILE, ONLY WHEN ASKED FOR ─────────────────────────────
   *
   * Behind a flag rather than emitted always, because it is the one file here
   * that cannot be uploaded alongside the others. A prep run that produced all
   * three side by side would invite exactly that.
   */
  if (RECOUPMENT) {
    const targetA = usable[0];
    const era = buildRecoupment(manifest, targetA, patLast, patFirst);
    fs.writeFileSync(PATHS.eraRPath, era, 'utf8');
    console.log(`\n-- ${PATHS.eraRPath}`);
    console.log(
      `   RECOUPMENT -$${(Number(manifest.feeCents) || T.PROC_FEE_CENTS) / 100} off claim ` +
        `${targetA.claimNum}  check S10R-${targetA.claimNum}  CLP02=22 reversal_of_previous_payment`
    );
    console.log('   ------------------------------ 8< ------------------------------');
    process.stdout.write(era);
    console.log('   ------------------------------ 8< ------------------------------');
    console.log('\n  ! UPLOAD THIS ONE LAST, and only after target A has actually POSTED.');
    console.log('    A takeback acts on a claimproc that is already Received and already on a');
    console.log('    check. Before A drains there is nothing on the chart to take back from.');
    console.log('\n  ! THE APPROVAL GATE REFUSES THIS FILE TODAY. A real reversal carries');
    console.log('    `reversal_not_postable` on the claim and `negative_total_payment` on the');
    console.log('    remittance, and BOTH are `blocking` in rcmVocabulary -- so');
    console.log('    NO_BLOCKING_REASON fails even on the recoupment approve. See');
    console.log('    docs/RCM_POSTING.md section 10.6. That is a ruling, not a change here.');
  }

  console.log('\nDONE. Nothing was read from or written to Open Dental.');
  console.log('\nNEXT — this part cannot be scripted:');
  console.log('  The upload route POST /api/rcm/era needs the SSO session. The shared');
  console.log('  DASHBOARD_API_TOKEN carries no user identity, so tenantContext fails it closed');
  console.log('  with 403 TENANT_UNRESOLVED before the handler is reached.');
  console.log('  Copy each body above into a local .txt file and upload both from');
  console.log('  /rcm -> Remittances, signed in as admin or office. Then run the match on each.');
  console.log('  Do NOT mark reviewed, confirm, or approve — those are decisions for the night.');
}

// Run ONLY when invoked directly. This file issues no Open Dental call at all,
// but the rule is uniform across all four scripts precisely so nobody has to
// check which ones are safe to import.
if (require.main === module) {
  main();
  process.exit(process.exitCode || 0);
}

module.exports = { main, build835, buildRecoupment };
