'use strict';

/*
 * RESEED, STEP 2 OF 2 — THE FOUR SYNTHETIC 835s.
 *
 *     PROBE_OFFICE=roland node scripts/rcm/reseed-835.js
 *     PROBE_OFFICE=roland node scripts/rcm/reseed-835.js --out <dir>
 *
 * NO OPEN DENTAL ACCESS AT ALL. No secrets, no network, no office handle. It
 * reads the manifest `reseed-prep.js` wrote and emits four files, printing each
 * body to stdout because the container's filesystem is not where Beau uploads
 * from.
 *
 *   rcm-reseed-835-R1.txt   DELTA DENTAL OF OKLAHOMA · 3 claims, 2 patients,
 *                           one line leaving the patient owing $9.20   (CC-5)
 *   rcm-reseed-835-R2.txt   METLIFE DENTAL · one contractual-only line and one
 *                           the office should eat (office_writeoff)
 *   rcm-reseed-835-R3.txt   CIGNA DENTAL · the takeback. CLP02=22.
 *   rcm-reseed-835-R4.txt   CIGNA DENTAL · §15.1c, the one the matcher cannot
 *                           resolve. On purpose.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THESE ARE GENERATED FROM THE MANIFEST AND NOT WRITTEN BY HAND
 * ─────────────────────────────────────────────────────────────────────────────
 * `CLP01` carries the real `ClaimNum` and `NM1*QC` carries the chart's own name,
 * so neither can be known before the claims exist. Hand-authoring X12 beside a
 * live chart database is how an evening turns into a debugging session.
 *
 * `DTM*472` is the CLAIM's service date, from the manifest — never `new Date()`.
 * These files are written at prep time and uploaded later; the matcher scores
 * the 835's service date against the chart's, so it must be the chart's date
 * however many days pass in between.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MONEY, IN THE MODULE'S OWN DEFINITIONS
 * ─────────────────────────────────────────────────────────────────────────────
 * `services/rcm/lineDecisions.js`: `W = billed − allowed` is the contractual
 * write-off, `R = allowed − paid` is the patient remainder. In X12 that is
 * `CAS*CO*45*<W>` and a `CAS*PR*…` group summing to `R`, with `CLP05` carrying
 * the claim's `R`.
 *
 * An 835 balances per line — billed = paid + Σ CAS — and per claim: CLP05 must
 * equal the sum of the PR group, or the parser flags the file for review
 * (defect A1) and the walk starts on a detour. `assertBalanced` below proves
 * both for every line before a byte is written, because a fixture that is
 * quietly unbalanced teaches the operator something false about the product.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * R4 — THE DEAD END, AND WHY IT IS AUTHORED RATHER THAN BROKEN
 * ─────────────────────────────────────────────────────────────────────────────
 * §15.1c: "if the right claim exists in Open Dental but is not among the
 * candidates the matcher returned, the biller has no way to say so. Her only
 * exit is *save for tomorrow*." That is a known limit 6d.2 owes a fix for, and
 * Beau needs to hit it himself before his biller does.
 *
 * R4's claim is REAL — `reseed-prep.js` created it on a designated test patient,
 * and it is visible in Open Dental from the other window. What R4 changes is one
 * thing: `NM1*QC` carries a TRANSPOSED SURNAME. The matcher's only route to a
 * patient is `findClaimCandidates`, which searches `/patients?LName=` and
 * `?FName=` (PREFIX matches) and returns before it ever looks at a claim when
 * neither finds anybody. So there are zero candidates — not a weak one, not an
 * ambiguous pair — and `no_candidate` means exactly what it is documented to
 * mean: a search ran against this office's Open Dental and found nothing.
 *
 * `CLP01` still carries the REAL ClaimNum. That is deliberate and it makes the
 * dead end sharper rather than softer: candidates are gathered by PATIENT and
 * never by claim number, so the right number being in the file changes nothing.
 *
 * NOTHING HERE LOOSENS THE MATCHER, and nothing here should be "fixed" by doing
 * so. `assertTransposition` proves the transposed tokens cannot prefix-match the
 * chart's real ones in either direction — because Open Dental prefix-matches,
 * and a transposition that happened to still match would make this file a
 * SILENTLY WORKING fixture, which is worse than no fixture at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING IN THESE FILES RESEMBLES A REAL PERSON OR A REAL ENTITY
 * ─────────────────────────────────────────────────────────────────────────────
 * The payer names are real carriers because the fixture is about whether the
 * screens read plausibly, and `CAREIN SYNTHETIC PAYER` on every row does not
 * test that. They name a company, not a person, and no payer id, NPI or TIN is
 * invented — an invented 10-digit NPI is a number that belongs to somebody.
 * There is no `DMG` (so no date of birth), no subscriber id, no `REF*1L` group
 * number and no `NM1*82`.
 *
 * The one identifying string is the TEST PATIENT'S OWN chart name, which is what
 * makes the match work at all. 12827 and 12828 are designated synthetic fixtures
 * (CLAUDE.md), and the files are written outside the repository, to the /data
 * volume, unless `--out` says otherwise.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GETTING THE FILES OUT OF THE CONTAINER
 * ─────────────────────────────────────────────────────────────────────────────
 * `POST /api/rcm/era` needs the SSO session: the shared `DASHBOARD_API_TOKEN`
 * carries no user identity, so `tenantContext` fails it closed with
 * `403 TENANT_UNRESOLVED` before the handler is reached. Copy each body out of
 * this script's stdout, save it locally as a `.txt`, and upload it from
 * the "Bring in" control on /rcm, signed in as `admin` or `office`.
 */

const fs = require('node:fs');
const path = require('node:path');
const T = require('./reseed-targets');

const OFFICE = T.resolveOffice();
const PATHS = T.pathsFor(OFFICE);

/** X12 segment terminator, matching every fixture in `test/fixtures/rcm`. */
const SEG = '~\n';

/** `YYYY-MM-DD` -> `YYYYMMDD`, X12's date form. */
const x12Date = (iso) => String(iso || '').replace(/-/g, '');

/**
 * Cents to an X12 decimal string, SIGN-CORRECT below a dollar.
 *
 * The naive `${Math.trunc(c / 100)}.${abs(c) % 100}` is right for every positive
 * amount and for −100, and WRONG for −50: `Math.trunc(-0.5)` is `-0`, which
 * templates as `"0"`, so fifty cents taken back renders as fifty cents paid.
 * R3 is the first negative this reseed produces, so the sign is carried
 * explicitly rather than inferred from the integer part. (The same defect was
 * found and fixed in `rcm-s10-835.js`; it is repeated here rather than shared
 * because these scripts deliberately do not import one another.)
 *
 * @param {number} c
 * @returns {string}
 */
const x12Amount = (c) => {
  const cents = Math.trunc(c);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

/**
 * Every line must balance twice, and both are proved before a byte is written.
 *
 *   per line   billed = paid + Σ CAS          (Σ CAS = W + R)
 *   per claim  CLP05  = Σ of the PR group     (R)
 *
 * A fixture that fails either is not a harder fixture, it is a WRONG one: the
 * parser flags it `unexplained_adj` / `UNPARSEABLE_CAS` and puts the operator on
 * a detour about the file instead of about the product.
 *
 * @param {{ key: string, billedCents: number, allowedCents: number, paidCents: number }} t
 * @returns {string|null} the refusal sentence, or null
 */
function assertBalanced(t) {
  const W = t.billedCents - t.allowedCents;
  const R = t.allowedCents - t.paidCents;
  if (W < 0) return `${t.key}: allowed ($${t.allowedCents / 100}) exceeds billed ($${t.billedCents / 100}).`;
  if (R < 0) return `${t.key}: paid ($${t.paidCents / 100}) exceeds allowed ($${t.allowedCents / 100}).`;
  if (t.billedCents - t.paidCents !== W + R) {
    return `${t.key}: billed − paid is ${t.billedCents - t.paidCents}c but W + R is ${W + R}c.`;
  }
  return null;
}

/**
 * Prove R4's transposition cannot find anybody.
 *
 * Open Dental matches `LName` and `FName` by PREFIX, so it is not enough that
 * the transposed token differ from the chart's — neither may be a prefix of the
 * other, IN EITHER DIRECTION. `TEST` vs `TSET` is safe; `TEST` vs `TESTX` is
 * not, and neither is `TEST 2` vs `TES`.
 *
 * Checked against EVERY patient this reseed touches, not just R4's, because the
 * search is by name and a name is not scoped to a PatNum: a transposition that
 * accidentally prefix-matched the OTHER test patient would return a candidate
 * and quietly turn the dead end into an ordinary match.
 *
 * @param {{ last: string, first: string }} transposed
 * @param {ReadonlyArray<{ patNum: number, last: string, first: string }>} patients
 * @returns {string|null} the refusal sentence, or null
 */
function assertTransposition(transposed, patients) {
  const prefixes = (a, b) => {
    const x = String(a || '').trim().toUpperCase();
    const y = String(b || '').trim().toUpperCase();
    if (!x || !y) return false;
    return x.startsWith(y) || y.startsWith(x);
  };
  for (const p of patients) {
    for (const [label, token] of [['LName', transposed.last], ['FName', transposed.first]]) {
      for (const [field, chart] of [['LName', p.last], ['FName', p.first]]) {
        if (prefixes(token, chart)) {
          return (
            `R4's transposed ${label} '${token}' PREFIX-MATCHES PatNum ${p.patNum}'s ${field}.\n` +
            '  Open Dental matches names by prefix, so this search would return a real candidate and\n' +
            '  R4 would silently become an ordinary match — the §15.1c dead end would not be\n' +
            '  reachable, and nothing would say so. Choose different tokens in reseed-targets.js\n' +
            '  R4_TRANSPOSED. Do NOT loosen the matcher to compensate.'
          );
        }
      }
    }
  }
  return null;
}

/**
 * The CAS segments for one line.
 *
 * `CO*45` is the contractual obligation — the carrier's own write-off, which
 * this slice always accepts as a fact. The patient remainder is split across the
 * PR codes a real carrier uses so the screens have something with shape in them:
 * `PR*1` deductible, `PR*2` coinsurance, `PR*3` copay. A single `PR*2` for
 * everything would render as one number and teach nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AMOUNTS IN ARE ALWAYS POSITIVE; `reversal` NEGATES WHAT IS RENDERED
 * ─────────────────────────────────────────────────────────────────────────────
 * The guards below are `> 0` — "is there a write-off at all", "does the patient
 * owe anything" — and those are questions about the ORIGINAL payment, not about
 * the direction the money is moving. Handing this function pre-negated amounts
 * would make every guard false on a takeback and emit no CAS at all, so the
 * reversal would silently stop mirroring the payment it reverses.
 *
 * So the sign is applied at the last possible moment, to the rendered string,
 * and the shape of the segment is decided from the positive figures.
 *
 * @param {{ writeOffCents: number, patientCents: number,
 *           patientSplit?: Array<[string, number]>, reversal?: boolean }} spec
 * @returns {string[]}
 */
function casSegmentsFor(spec) {
  const sign = spec.reversal ? -1 : 1;
  const amt = (cents) => x12Amount(sign * cents);
  const out = [];
  if (spec.writeOffCents > 0) out.push(`CAS*CO*45*${amt(spec.writeOffCents)}`);
  if (spec.patientCents > 0) {
    const split = spec.patientSplit && spec.patientSplit.length
      ? spec.patientSplit
      : [['2', spec.patientCents]];
    /*
     * CAS repeats as reason/amount/QUANTITY triples — CAS02-03-04, CAS05-06-07,
     * CAS08-09-10 — and the quantity element is left EMPTY here rather than
     * omitted. `Test_Mixed_Adjustments.edi` and defect A5 are both about a
     * parser that lost the pairs after the first when the empty quantity was
     * dropped; emitting the empty element is the correct X12 and is also the
     * shape the fixed parser is pinned against.
     */
    const parts = split.map(([code, cents]) => `${code}*${amt(cents)}`);
    out.push(`CAS*PR*${parts.join('**')}`);
  }
  return out;
}

/**
 * One complete 835 interchange over one or more claims.
 *
 * BPR02 equals the sum of the claim payments, so the file reconciles — the
 * corpus suite's "BPR02 reconciles against claim payments plus PLB" property,
 * and a check total that disagreed with its claims is precisely the "flagged for
 * review" the fixture must not have to reason about.
 *
 * @param {{ remittance: (typeof T.REMITTANCES)[number],
 *           claims: Array<{ claimNum: number, patLast: string, patFirst: string,
 *                           procCode: string, billedCents: number, allowedCents: number,
 *                           paidCents: number, serviceDate: string,
 *                           patientSplit?: Array<[string, number]> }>,
 *           reversal?: boolean }} spec
 * @returns {string}
 */
function build835(spec) {
  /*
   * `sign = -1` negates every money element and sets CLP02 = 22, the X12 code
   * for REVERSAL OF PREVIOUS PAYMENT. Nothing else changes: same claim, same
   * patient, same service date, same procedure, same CAS — negated. That is what
   * makes a takeback a takeback rather than a second, negative payment, and
   * CLP02 is the field an 835 reader looks at first.
   */
  const sign = spec.reversal ? -1 : 1;
  const day = x12Date(spec.claims[0].serviceDate);
  const ctl = spec.remittance.controlNumber;
  const checkNum = spec.remittance.checkNumber;
  const totalCents = spec.claims.reduce((s, c) => s + c.paidCents, 0) * sign;

  const segments = [
    // Sender/receiver are the payer and the practice, as opaque ids. No real ids.
    `ISA*00*          *00*          *ZZ*CAREINPAYER    *ZZ*CAREINTEST     *${day.slice(2)}*1200*^*00501*${ctl}*0*P*:`,
    `GS*HP*CAREINPAYER*CAREINTEST*${day}*1200*1*X*005010X221A1`,
    `ST*835*${ctl}`,
    /*
     * BPR03 is the credit/debit flag. A reversal is a DEBIT — money coming back
     * off the practice — and a reader looks at this before it looks at the sign
     * on BPR02. BPR02 itself stays SIGNED so the file still reconciles against
     * its claim payments, which is the property the corpus suite checks.
     */
    `BPR*I*${x12Amount(totalCents)}*${spec.reversal ? 'D' : 'C'}*${spec.remittance.paymentMethod}************${day}`,
    // TRN02 is the check number — the parser takes it from here, never from
    // BPR16 (which is a date; that confusion is one of the regressions the
    // ported eraParser suite pins).
    `TRN*1*${checkNum}*9999999999`,
    `DTM*405*${day}`,
    `N1*PR*${spec.remittance.payer}`,
    // Payee: the practice, with NO NPI.
    'N1*PE*CAREIN TEST PRACTICE',
    'LX*1',
  ];

  for (const c of spec.claims) {
    const W = c.billedCents - c.allowedCents;
    const R = c.allowedCents - c.paidCents;
    const cday = x12Date(c.serviceDate);
    segments.push(
      /*
       * CLP01 = the real ClaimNum (the matcher's CLAIM_NUMBER_MATCH, 35/100).
       * CLP02: 1 = processed as primary, 22 = reversal of previous payment.
       * CLP03 billed · CLP04 paid · CLP05 PATIENT RESPONSIBILITY · CLP06=12 PPO
       * · CLP07 the payer's own control number.
       */
      `CLP*${c.claimNum}*${spec.reversal ? '22' : '1'}*${x12Amount(sign * c.billedCents)}*` +
        `${x12Amount(sign * c.paidCents)}*${x12Amount(sign * R)}*12*${checkNum}-${c.claimNum}`,
      `NM1*QC*1*${c.patLast}*${c.patFirst}`,
      `SVC*AD:${c.procCode}*${x12Amount(sign * c.billedCents)}*${x12Amount(sign * c.paidCents)}**1`,
      ...casSegmentsFor({
        writeOffCents: W,
        patientCents: R,
        patientSplit: c.patientSplit,
        reversal: spec.reversal,
      }),
      `DTM*472*${cday}`
    );
  }

  // SE01 counts ST through SE inclusive: the segments from ST onwards, plus SE.
  const stIndex = segments.findIndex((s) => s.startsWith('ST*835*'));
  const segmentCount = segments.length - stIndex + 1;
  segments.push(`SE*${segmentCount}*${ctl}`, 'GE*1*1', `IEA*1*${ctl}`);
  return segments.join(SEG) + SEG;
}

/** `--out <dir>` also writes the four files there, for committing under docs/. */
function outOverride(argv) {
  const i = argv.indexOf('--out');
  if (i === -1) return null;
  const dir = argv[i + 1];
  if (!dir) throw new Error('--out needs a directory');
  return path.resolve(dir);
}

function main() {
  if (!fs.existsSync(PATHS.manifestPath)) {
    console.error(
      `REFUSED: no manifest at\n  ${PATHS.manifestPath}\n` +
        '  These files carry the REAL ClaimNums and the chart\'s own patient names, so they cannot\n' +
        '  be written before the claims exist. Run `node scripts/rcm/reseed-prep.js --execute` first.'
    );
    process.exitCode = 2;
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(PATHS.manifestPath, 'utf8'));

  if (manifest.office !== OFFICE) {
    console.error(`REFUSED: the manifest is for office='${manifest.office}'; this run is '${OFFICE}'.`);
    process.exitCode = 3;
    return;
  }

  /*
   * IS THIS MANIFEST STILL ABOUT ANYTHING?
   *
   * Walk night 2 rebuilt both §10 835s from a manifest whose claims had been
   * unwound two days earlier, and said nothing. The files named ClaimNums that
   * no longer existed, so the match found nothing and the evening lost time to a
   * file that was never going to work. Screened BEFORE a byte is written,
   * because the whole cost of the mistake is uploading a file that looks right.
   */
  const spent = T.screenManifestForSpentIds(manifest);
  if (spent) {
    console.error(`REFUSED: ${spent}`);
    process.exitCode = 4;
    return;
  }

  if (!manifest.complete) {
    console.error(
      'REFUSED: the manifest says `complete: false` — the prep run did not finish.\n' +
        '  Some of the seven claims exist and some do not, so the four files would be a mix of real\n' +
        '  and missing ClaimNums. Unwind what was created and run the prep again.'
    );
    process.exitCode = 5;
    return;
  }

  const targets = manifest.targets || [];
  if (targets.length !== T.TARGETS.length) {
    console.error(
      `REFUSED: the manifest names ${targets.length} target(s); the reseed needs ${T.TARGETS.length}.`
    );
    process.exitCode = 6;
    return;
  }

  // Money, proved rather than assumed.
  for (const t of targets) {
    const problem = assertBalanced(t);
    if (problem) {
      console.error(`REFUSED: ${problem}`);
      process.exitCode = 7;
      return;
    }
  }

  const patients = manifest.patients || [];
  if (!patients.length) {
    console.error('REFUSED: the manifest carries no chart names. Re-run the prep so it reads them.');
    process.exitCode = 8;
    return;
  }
  const nameOf = new Map(patients.map((p) => [Number(p.patNum), p]));

  // R4's dead end, proved unreachable rather than hoped for.
  const transposition = assertTransposition(T.R4_TRANSPOSED, patients);
  if (transposition) {
    console.error(`REFUSED: ${transposition}`);
    process.exitCode = 9;
    return;
  }

  const extraDir = outOverride(process.argv.slice(2));
  const dirs = [PATHS.outDir, ...(extraDir ? [extraDir] : [])];
  for (const dir of dirs) {
    const problem = T.checkOutDirWritable(dir);
    if (problem) {
      console.error(`REFUSED: ${problem}`);
      process.exitCode = 10;
      return;
    }
  }

  console.log(`\n=== RCM RESEED — 4 SYNTHETIC 835s · office ${OFFICE} ===`);

  for (const remittance of T.REMITTANCES) {
    const mine = targets.filter((t) => t.remittance === remittance.label);
    if (!mine.length) {
      console.error(`REFUSED: the manifest names no target for ${remittance.label}.`);
      process.exitCode = 11;
      return;
    }

    const claims = mine.map((t) => {
      const p = nameOf.get(Number(t.patNum));
      if (!p) throw new Error(`the manifest has no chart name for PatNum ${t.patNum}`);
      const R = t.allowedCents - t.paidCents;
      /*
       * R4 IS THE ONE THAT CARRIES A NAME THE CHART DOES NOT HAVE.
       *
       * Every other claim uses the chart's own spelling, read by the prep. R4
       * uses the transposition, which `assertTransposition` has already proved
       * cannot prefix-match anybody.
       */
      const useTransposed = remittance.label === 'R4';
      return {
        claimNum: Number(t.claimNum),
        patLast: useTransposed ? T.R4_TRANSPOSED.last : p.last,
        patFirst: useTransposed ? T.R4_TRANSPOSED.first : p.first,
        procCode: t.procCode,
        billedCents: t.billedCents,
        allowedCents: t.allowedCents,
        paidCents: t.paidCents,
        serviceDate: String(t.serviceDate || ''),
        /*
         * A deductible-and-coinsurance split where the remainder is big enough
         * to be worth splitting. R2-2's $480 is $50 deductible + $430
         * coinsurance, which is the shape a biller actually reads; R1-1's $9.20
         * is plain coinsurance and stays one number.
         */
        patientSplit: t.key === 'R2-2' ? [['1', 5000], ['2', R - 5000]] : undefined,
      };
    });

    for (const c of claims) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(c.serviceDate)) {
        console.error(
          `REFUSED: claim ${c.claimNum} carries no service date (got ${JSON.stringify(c.serviceDate)}).\n` +
            '  The prep records the ProcDate it read back from Open Dental. A manifest without one did\n' +
            '  not come from a completed prep run — re-run it rather than inventing a date the chart\n' +
            '  does not have.'
        );
        process.exitCode = 12;
        return;
      }
    }

    const reversal = remittance.label === 'R3';
    const era = build835({ remittance, claims, reversal });

    for (const dir of dirs) {
      fs.writeFileSync(path.join(dir, `rcm-reseed-835-${remittance.label}.txt`), era, 'utf8');
    }

    console.log(`\n-- ${path.join(PATHS.outDir, `rcm-reseed-835-${remittance.label}.txt`)}`);
    console.log(`   ${remittance.payer} · check ${remittance.checkNumber} · ${claims.length} claim(s)`);
    console.log(`   ${remittance.purpose}`);
    for (const c of claims) {
      console.log(
        `   claim ${c.claimNum}  ${c.procCode}  billed $${(c.billedCents / 100).toFixed(2)}  ` +
          `paid $${(c.paidCents / 100).toFixed(2)}  patient $${((c.allowedCents - c.paidCents) / 100).toFixed(2)}`
      );
    }
    console.log('   ------------------------------ 8< ------------------------------');
    process.stdout.write(era);
    console.log('   ------------------------------ 8< ------------------------------');
  }

  if (extraDir) console.log(`\nAlso written to ${extraDir}`);

  console.log('\nDONE. Nothing was read from or written to Open Dental.');
  console.log('\n! UPLOAD ORDER MATTERS FOR R3.');
  console.log('  R1, R2 and R4 can go up in any order. R3 is a TAKEBACK: it pairs to the PAID');
  console.log('  line, so it can only be matched once its claim has actually POSTED. Matched');
  console.log('  before, the eligible set is empty and the approve refuses NO_REVERSIBLE_LINES —');
  console.log('  correctly. Upload R3 last, and re-match it after the drain if you got there early.');
  console.log('\n! R4 IS SUPPOSED TO FAIL.');
  console.log('  It will report `no_candidate` with nothing offered. That is RCM_POSTING §15.1c —');
  console.log('  the claim is real and in Open Dental, and CareIN has no way to be pointed at it.');
  console.log('  6d.2 owes the fix. Do NOT loosen the matcher to make this one pass.');
  console.log('\nNEXT — this part cannot be scripted:');
  console.log('  POST /api/rcm/era needs the SSO session; the shared DASHBOARD_API_TOKEN carries no');
  console.log('  user identity, so tenantContext fails it closed with 403 TENANT_UNRESOLVED before');
  console.log('  the handler is reached. Copy each body above into a local .txt and upload it from');
  console.log('  /rcm -> Bring in, signed in as admin or office.');
}

// Run ONLY when invoked directly. This file issues no Open Dental call at all,
// but the rule is uniform across all of these scripts precisely so nobody has to
// check which ones are safe to import.
if (require.main === module) {
  main();
  process.exit(process.exitCode || 0);
}

module.exports = {
  main,
  build835,
  casSegmentsFor,
  assertBalanced,
  assertTransposition,
  x12Amount,
};
