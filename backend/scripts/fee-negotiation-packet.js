#!/usr/bin/env node
'use strict';

/*
 * Fee negotiation packet generator. READ-ONLY, per office.
 *
 *     node scripts/fee-negotiation-packet.js --office roland
 *     node scripts/fee-negotiation-packet.js --office valley
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PRODUCES, AND WHO READS IT
 * ─────────────────────────────────────────────────────────────────────────────
 * The ranking analysis answers "which schedules pay badly". This answers "so
 * what do I say on the phone". The audience is an office manager with a payer
 * rep on the line, not an analyst — so every sheet leads with the dollar gap on
 * the codes the practice actually does, names the procedure in words, and puts
 * the biggest asks at the top.
 *
 * Output: docs/reports/negotiation-packet-<office>-<YYYY-MM-DD>/
 *     connection-comparison.csv/.md   Roland only — the two practices' Connection
 *                                     Dental 2024 rates side by side
 *     carrier-asks/<carrier>.md       one ask sheet per directly-negotiable carrier
 *     priority.md                     carriers ranked by estimated recovery
 *     letters/                        three merge templates
 *     README.md                       how to run the process
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY DOLLAR HERE CAME FROM THE API
 * ─────────────────────────────────────────────────────────────────────────────
 * No fee in this packet is back-computed from a percentage. Percentages are
 * DERIVED from the dollars (`fee / ucrFee`), never the other way round. That
 * direction is the whole point: a percentage recovered from a rounded percentage
 * would put a wrong dollar figure in front of a payer, and the practice would be
 * the one holding it.
 *
 * Reads go through lib/odFeeBasket.js — `apiGetRaw` only, five configuration
 * resources, the shared 1 req/s slot, no patient-scoped endpoint, no PatNum.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ROLAND PACKET READS RILEY TOO
 * ─────────────────────────────────────────────────────────────────────────────
 * The Connection Dental comparison is the reason this project exists: the two
 * practices share ownership and sit on the same leased network at materially
 * different rates. Building that sheet means holding two live Open Dental
 * clients in one process. Both are opened through
 * `assertOfficeMatch(key, getOdOffice(key))`, both are labelled with the office
 * they are bound to, and the CodeNum maps are resolved SEPARATELY per database
 * — CodeNum is a per-database surrogate key, so sharing one map across offices
 * would compare two different procedures while looking perfectly reasonable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT KNOW
 * ─────────────────────────────────────────────────────────────────────────────
 * It has no procedure volumes: the basket weights are a general-practice proxy,
 * not this practice's mix, because measuring the real mix needs patient-scoped
 * reads this script is forbidden to make. Every recovery figure is therefore an
 * ESTIMATE and is labelled as one on every sheet it appears on.
 *
 * It also knows nothing about the CONTRACTS — effective dates, terms, whether a
 * schedule is even negotiable. Nothing here asserts a contract fact, and the
 * letter templates carry placeholders rather than invented specifics.
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config();

const {
  BASKET,
  CODE_LABELS,
  money,
  pct,
  squash,
  toCsv,
  todayStamp,
  fetchFeeSchedules,
  fetchBasketCodeNums,
  fetchBasketFees,
  fetchScheduleBasketFees,
  fetchCarriers,
  fetchInsPlans,
  inferUcr,
  openOffice,
  OdReadError,
} = require('./lib/odFeeBasket');

// ─── Who is negotiable, and with whom ────────────────────────────────────────

/**
 * The carriers a practice can take a fee schedule up with DIRECTLY.
 *
 * `listed` is the name to match in Open Dental's carrier table; `label` is what
 * the sheet is titled. Delta Dental and Blue Cross Blue Shield are deliberately
 * ABSENT: at both practices they are the two largest books, and neither is a
 * fee-schedule negotiation — Delta is a participation-tier decision (Premier vs
 * PPO vs out) and BCBS is a network-participation question. Putting them in a
 * "propose these fees" sheet would frame them as something they are not. The
 * README says where they go instead.
 *
 * @type {ReadonlyArray<{ label: string, listed: string, aliases: ReadonlyArray<string> }>}
 */
const DIRECT_CARRIERS = Object.freeze([
  { label: 'Cigna', listed: 'Cigna', aliases: [] },
  { label: 'MetLife', listed: 'MetLife', aliases: [] },
  { label: 'Guardian', listed: 'Guardian', aliases: [] },
  { label: 'Ameritas', listed: 'Ameritas', aliases: [] },
  { label: 'Humana', listed: 'Humana', aliases: [] },
  // The carrier table spells it PRINCIPAL FINANCIAL, so the listed name alone
  // matches nothing. Established by the ranking analysis's near-miss check.
  { label: 'Principal', listed: 'Principal Life Insurance Company', aliases: ['PRINCIPAL'] },
  { label: 'United Healthcare (UHC)', listed: 'United Healthcare', aliases: [] },
  { label: 'GEHA', listed: 'GEHA', aliases: [] },
]);

/**
 * Schedule-name patterns that mean "these rates are set by a leased network,
 * not by this carrier".
 *
 * A leased (rented) network sells its negotiated schedule to many payers at
 * once. Phoning Cigna to ask for a better rate on a Connection Dental schedule
 * does not work — Cigna did not set it and cannot change it. Getting that wrong
 * wastes the one call an office manager gets, which is why every sheet whose
 * dominant schedule matches one of these carries a banner.
 *
 * `connection`, `zelis` and `dnoa` are the three named in the brief.
 * `careington` and `dentemax` are added because they are leased networks by the
 * same definition and both carry live plans here — Careington CP50 alone holds
 * 312 plans at Roland. The addition is stated in the README rather than made
 * silently, so it can be corrected if either is in fact directly negotiable.
 *
 * @type {ReadonlyArray<string>}
 */
const LEASED_NETWORK_TOKENS = Object.freeze([
  'connection', 'zelis', 'dnoa', 'careington', 'dentemax',
]);

/**
 * Payer names that may appear in a fee schedule's title.
 *
 * Used only by `foreignPayerInScheduleName` to notice a carrier sitting on a
 * schedule named after SOMEBODY ELSE. It cannot be built from DIRECT_CARRIERS:
 * Roland's Guardian plans ride a schedule called "Aetna 2024", and Aetna is not
 * a directly-negotiable carrier in this packet, so searching the negotiable list
 * alone finds nothing — which is exactly the bug this constant fixes.
 *
 * Squashed tokens, matched as substrings of the squashed schedule description.
 *
 * @type {Readonly<Record<string, string>>} token -> display name
 */
const PAYER_NAME_TOKENS = Object.freeze({
  aetna: 'Aetna',
  cigna: 'Cigna',
  metlife: 'MetLife',
  guardian: 'Guardian',
  ameritas: 'Ameritas',
  humana: 'Humana',
  principal: 'Principal',
  geha: 'GEHA',
  delta: 'Delta Dental',
  unitedhealthcare: 'United Healthcare',
  uhc: 'United Healthcare',
  anthem: 'Anthem',
  bcbs: 'Blue Cross Blue Shield',
  bluecross: 'Blue Cross Blue Shield',
  healthchoice: 'HealthChoice',
  mutualofomaha: 'Mutual of Omaha',
  lincoln: 'Lincoln Financial',
  unitedconcordia: 'United Concordia',
  soonercare: 'SoonerCare',
  medicaid: 'Medicaid',
  mcna: 'MCNA',
});

/** What the Connection Dental comparison looks for, per office. */
const CONNECTION_SCHEDULE_TOKEN = 'connectiondental2024';

/** Basket codes, ordered as the basket declares them. */
const CODES = Object.freeze(Object.keys(BASKET));

// ─── Small helpers ───────────────────────────────────────────────────────────

/** A filesystem-safe slug for a carrier label. */
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** @param {string} description @returns {boolean} */
function isLeasedNetwork(description) {
  const name = squash(description);
  return LEASED_NETWORK_TOKENS.some((t) => name.includes(t));
}

/**
 * Is this carrier's schedule NAMED AFTER A DIFFERENT PAYER?
 *
 * Roland's Guardian plans ride a schedule called "Aetna 2024". A carrier sitting
 * on a schedule bearing another payer's name is a strong signal of a rented
 * network — the practice contracted with one payer and a second payer is
 * adjudicating off that payer's schedule. Whether Guardian in fact leases
 * Aetna's network is a contract fact this script cannot see, so it is raised as
 * a question rather than asserted as a leased network: the point is to stop an
 * office manager phoning Guardian about a rate Guardian may not own.
 *
 * A token matching the carrier's OWN name is skipped, so Aetna's own sheet is
 * not flagged for riding an "Aetna 2024" schedule.
 *
 * @param {{ label: string, listed: string }} spec
 * @param {string} description
 * @returns {string|null} the other payer's display name, or null
 */
function foreignPayerInScheduleName(spec, description) {
  const name = squash(description);
  const mine = `${squash(spec.listed)} ${squash(spec.label)}`;
  for (const [token, display] of Object.entries(PAYER_NAME_TOKENS)) {
    if (!name.includes(token)) continue;
    // Not foreign if it is this carrier's own name under either spelling.
    if (mine.includes(token)) continue;
    return display;
  }
  return null;
}

/** Markdown table escape — schedule descriptions contain pipes rarely, but do. */
function md(s) {
  return String(s === null || s === undefined ? '' : s).replace(/\|/g, '\\|');
}

/**
 * Match a listed carrier name against the practice's carrier table.
 *
 * Normalised on both sides (letters and digits only) plus explicit aliases. The
 * literal-substring rule the first analysis used silently missed 118 plans
 * across the two practices — the table spells it `HEALTHCHOICE`, one word, and
 * `PRINCIPAL FINANCIAL`, a different suffix.
 *
 * @param {{ listed: string, aliases: ReadonlyArray<string> }} spec
 * @param {ReadonlyArray<{ carrierNum: number, carrierName: string, isHidden: boolean }>} carriers
 * @returns {Array<{ carrierNum: number, carrierName: string, isHidden: boolean }>}
 */
function matchCarrier(spec, carriers) {
  const needles = [spec.listed, ...spec.aliases].map(squash).filter((n) => n.length > 0);
  return carriers.filter((c) => {
    const name = squash(c.carrierName);
    return needles.some((n) => name.includes(n));
  });
}

// ─── Office data ─────────────────────────────────────────────────────────────

/**
 * Everything one office contributes, read in one pass.
 *
 * @param {string} officeKey
 * @param {number|null} ucrOverride
 * @returns {Promise<object>}
 */
async function loadOffice(officeKey, ucrOverride) {
  const { reader, officeName } = openOffice(officeKey);
  process.stdout.write(`  [${officeKey}] /feescheds ... `);
  const schedules = await fetchFeeSchedules(reader);
  console.log(`${schedules.length}`);

  process.stdout.write(`  [${officeKey}] /procedurecodes ... `);
  const { codeNumByProcCode, missing } = await fetchBasketCodeNums(reader);
  console.log(`${codeNumByProcCode.size}/${CODES.length} basket codes`);

  process.stdout.write(`  [${officeKey}] /carriers ... `);
  const carriers = await fetchCarriers(reader);
  console.log(`${carriers.length}`);

  process.stdout.write(`  [${officeKey}] /insplans ... `);
  const plans = await fetchInsPlans(reader);
  console.log(`${plans.length} (${plans.filter((p) => !p.isHidden).length} non-hidden)`);

  process.stdout.write(`  [${officeKey}] /fees (basket) ... `);
  const { fees, overrideRows, zeroRows, filterIgnoredOn } = await fetchBasketFees(
    reader,
    codeNumByProcCode
  );
  console.log(`${[...fees.values()].reduce((n, m) => n + m.size, 0)} priced fees`);

  const inferred = inferUcr(plans);
  const ucrNum = ucrOverride !== null ? ucrOverride : inferred.feeSchedNum;
  if (ucrNum === null) {
    throw new OdReadError(
      `Could not identify a UCR schedule for ${officeKey}: ${inferred.basis}. ` +
        'Re-run with --ucr <FeeSchedNum>.',
      'UCR_UNRESOLVED'
    );
  }

  /** @type {Map<number, number>} non-hidden plan count per schedule */
  const planCounts = new Map();
  for (const p of plans) {
    if (p.isHidden) continue;
    planCounts.set(p.feeSched, (planCounts.get(p.feeSched) || 0) + 1);
  }

  const byNum = new Map(schedules.map((s) => [s.feeSchedNum, s]));
  const ucrFees = fees.get(ucrNum) || new Map();

  return {
    officeKey,
    officeName,
    reader,
    schedules,
    byNum,
    carriers,
    plans,
    planCounts,
    fees,
    ucrNum,
    ucrFees,
    ucrSchedule: byNum.get(ucrNum) || null,
    ucrBasis: ucrOverride !== null ? `explicit --ucr ${ucrOverride}` : inferred.basis,
    ucrFromOverride: ucrOverride !== null,
    codeNumByProcCode,
    missingBasketCodes: missing,
    overrideRows,
    zeroRows,
    filterIgnoredOn,
  };
}

/**
 * Find this office's live "Connection Dental 2024" schedule.
 *
 * Discovered by name rather than hardcoded, because the FeeSchedNum differs per
 * database (Roland 68, Riley 87) and hardcoding a surrogate key is how the wrong
 * schedule ends up in a comparison. Both practices also hold a HIDDEN schedule
 * of the same name, so the pick is the non-hidden candidate carrying the most
 * live plans, and an ambiguous or absent match is reported rather than guessed.
 *
 * @param {object} office
 * @returns {{ schedule: object|null, candidates: Array<object>, note: string }}
 */
function findConnectionSchedule(office) {
  const candidates = office.schedules
    .filter((s) => squash(s.description).includes(CONNECTION_SCHEDULE_TOKEN))
    .map((s) => ({ ...s, planCount: office.planCounts.get(s.feeSchedNum) || 0 }))
    .sort((a, b) => b.planCount - a.planCount);

  const live = candidates.filter((s) => !s.isHidden);
  if (!live.length) {
    return {
      schedule: null,
      candidates,
      note: candidates.length
        ? `no NON-HIDDEN schedule named "Connection Dental 2024"; ${candidates.length} hidden candidate(s) exist`
        : 'no schedule named "Connection Dental 2024" exists in this practice',
    };
  }
  return {
    schedule: live[0],
    candidates,
    note:
      live.length > 1
        ? `${live.length} non-hidden candidates; picked \`${live[0].feeSchedNum}\` (most live plans)`
        : 'single non-hidden match',
  };
}

// ─── Carrier view ────────────────────────────────────────────────────────────

/**
 * One carrier's position at one office: which schedules its live plans ride, and
 * what each of those costs against UCR on the basket.
 *
 * @param {{ label: string, listed: string, aliases: ReadonlyArray<string> }} spec
 * @param {object} office
 * @returns {object}
 */
function carrierView(spec, office) {
  const matched = matchCarrier(spec, office.carriers);
  const nums = new Set(matched.map((c) => c.carrierNum));

  /** @type {Map<number, number>} */
  const bySchedule = new Map();
  let planCount = 0;
  for (const p of office.plans) {
    if (p.isHidden || !nums.has(p.carrierNum)) continue;
    planCount += 1;
    bySchedule.set(p.feeSched, (bySchedule.get(p.feeSched) || 0) + 1);
  }

  const schedules = [...bySchedule.entries()]
    .map(([feeSchedNum, plans]) => {
      const sched = office.byNum.get(feeSchedNum) || null;
      const description =
        feeSchedNum === 0 ? '(no schedule — adjudicated off UCR)' : sched ? sched.description : '(not in /feescheds)';
      const fees = office.fees.get(feeSchedNum) || new Map();
      return {
        feeSchedNum,
        description,
        isHidden: sched ? sched.isHidden : false,
        plans,
        fees,
        pricedBasketCodes: CODES.filter((c) => fees.has(c)).length,
        leased: feeSchedNum !== 0 && isLeasedNetwork(description),
        isUcr: feeSchedNum === office.ucrNum,
      };
    })
    .sort((a, b) => b.plans - a.plans);

  // The dominant schedule is the one the ask sheet is built around: it is where
  // the carrier's book actually sits, and an office manager negotiating gets one
  // conversation, not one per schedule.
  const dominant =
    schedules.find((s) => s.feeSchedNum !== 0 && s.pricedBasketCodes > 0 && !s.isUcr) || null;

  return { spec, matched, planCount, schedules, dominant };
}

/**
 * The per-code ask table for one schedule against this office's UCR.
 *
 * Ranked by `weight x (ucr - current)` — the brief's rule, and the right one:
 * it puts the code where the most money is actually sitting at the top, which is
 * neither the biggest percentage gap (often a code nobody does) nor the biggest
 * dollar gap (often a code done twice a year).
 *
 * Only codes priced in BOTH schedules appear. A code the schedule does not
 * price has no current rate to improve on, and a code UCR does not price has no
 * ask to make — printing either as $0.00 would put a false number in a payer's
 * hands.
 *
 * @param {Map<string, number>} schedFees
 * @param {Map<string, number>} ucrFees
 * @returns {Array<object>}
 */
function askRows(schedFees, ucrFees) {
  /** @type {Array<object>} */
  const rows = [];
  for (const code of CODES) {
    const current = schedFees.get(code);
    const ucr = ucrFees.get(code);
    if (current === undefined || ucr === undefined) continue;
    const weight = BASKET[code];
    const gap = ucr - current;
    rows.push({
      code,
      label: CODE_LABELS[code] || code,
      weight,
      current,
      ucr,
      gap,
      gapPct: ucr > 0 ? gap / ucr : null,
      currentPctOfUcr: ucr > 0 ? current / ucr : null,
      // The ask is the office's own full fee. Industry practice is to open at
      // full fee and settle at 70-85%; opening at the number you want to land on
      // leaves nowhere to move.
      proposed: ucr,
      weightedGap: weight * gap,
    });
  }
  return rows.sort((a, b) => b.weightedGap - a.weightedGap);
}

/** Σ weight × (proposed − current) over the basket. The brief's recovery metric. */
function estimatedRecovery(rows) {
  return rows.reduce((n, r) => n + r.weightedGap, 0);
}

// ─── Writers ─────────────────────────────────────────────────────────────────

const LEASED_BANNER =
  '> ⚠️ **Rates are set at network level — negotiate with the network, not this carrier.**  \n' +
  '> This carrier\'s plans ride a leased (rented) network schedule. The carrier did not set these\n' +
  '> rates and cannot change them on its own. **This sheet is for reference**: use it to see what\n' +
  '> the network schedule costs you, then take it to the network. See `connection-comparison.md`\n' +
  '> and the Connection Dental letter template.';

/**
 * The Roland-only sheet: the same leased network's schedule at both practices,
 * side by side, with the office's own full fee for scale.
 *
 * This is the whole argument in one table. Same owner, same network, same
 * schedule name, two different rates — so the ask is not "please pay us more",
 * it is "extend the schedule you already agreed with our other location".
 */
function writeConnectionComparison(outDir, ctx) {
  const { office, here, there, thereOffice, note, thereNote } = ctx;

  /** @type {Array<object>} */
  const rows = [];
  for (const code of CODES) {
    const mine = here.fees.get(code);
    const theirs = there.fees.get(code);
    const ucr = office.ucrFees.get(code);
    if (mine === undefined && theirs === undefined) continue;
    const gap = mine !== undefined && theirs !== undefined ? theirs - mine : null;
    rows.push({
      code,
      label: CODE_LABELS[code] || code,
      weight: BASKET[code],
      mine: mine ?? null,
      theirs: theirs ?? null,
      ucr: ucr ?? null,
      gap,
      gapPct: gap !== null && mine ? gap / mine : null,
      minePctUcr: mine !== undefined && ucr ? mine / ucr : null,
      theirsPctUcr: theirs !== undefined && ucr ? theirs / ucr : null,
      weightedGap: gap !== null ? BASKET[code] * gap : 0,
    });
  }
  const ranked = [...rows].sort((a, b) => b.weightedGap - a.weightedGap);
  const totalWeightedGap = rows.reduce((n, r) => n + r.weightedGap, 0);

  // ── CSV ──
  const csv = [
    [
      'proc_code', 'description', 'basket_weight',
      `${office.officeKey}_connection_2024_fee`,
      `${thereOffice.officeKey}_connection_2024_fee`,
      `${office.officeKey}_ucr_fee`,
      'gap_dollars', 'gap_pct_of_current',
      `${office.officeKey}_pct_of_ucr`, `${thereOffice.officeKey}_pct_of_ucr`,
      'weighted_gap',
    ],
  ];
  for (const r of ranked) {
    csv.push([
      r.code, r.label, r.weight,
      r.mine === null ? '' : r.mine.toFixed(2),
      r.theirs === null ? '' : r.theirs.toFixed(2),
      r.ucr === null ? '' : r.ucr.toFixed(2),
      r.gap === null ? '' : r.gap.toFixed(2),
      r.gapPct === null ? '' : (r.gapPct * 100).toFixed(1),
      r.minePctUcr === null ? '' : (r.minePctUcr * 100).toFixed(1),
      r.theirsPctUcr === null ? '' : (r.theirsPctUcr * 100).toFixed(1),
      r.weightedGap.toFixed(2),
    ]);
  }
  fs.writeFileSync(path.join(outDir, 'connection-comparison.csv'), toCsv(csv), 'utf8');

  // ── Markdown ──
  const behind = ranked.filter((r) => r.gap !== null && r.gap > 0);
  const ahead = ranked.filter((r) => r.gap !== null && r.gap < 0);

  /** @type {string[]} */
  const m = [];
  m.push(`# Connection Dental 2024 — ${office.officeName} vs ${thereOffice.officeName}`);
  m.push('');
  m.push(`_Generated ${todayStamp()} · every fee read from Open Dental · read-only_`);
  m.push('');
  m.push('## What to say');
  m.push('');
  m.push(
    `**Both practices are under common ownership and both participate in Connection Dental. ` +
      `The two locations are on different 2024 schedules.** The ask is not a rate increase — it is ` +
      `**extension of the schedule already negotiated for the ${thereOffice.officeName} location to ` +
      `the ${office.officeName} TIN**, effective as soon as the network can load it.`
  );
  m.push('');
  m.push(
    `On the ${behind.length} basket codes where ${thereOffice.officeName} is paid more, the gap is ` +
      `**${money(behind.reduce((n, r) => n + r.gap, 0))} across one of each**. Weighted by how often a ` +
      `general practice does each code, the shortfall is **${money(totalWeightedGap)} per basket ` +
      `cycle** (see the note on what that means at the bottom).`
  );
  m.push('');
  m.push(
    `| | ${md(office.officeName)} | ${md(thereOffice.officeName)} |\n` +
      `|---|---|---|\n` +
      `| Schedule | ${md(here.description)} (\`${here.feeSchedNum}\`) | ${md(there.description)} (\`${there.feeSchedNum}\`) |\n` +
      `| Live plans on it | ${here.planCount} | ${there.planCount} |\n` +
      `| Basket codes priced | ${CODES.filter((c) => here.fees.has(c)).length}/${CODES.length} | ${CODES.filter((c) => there.fees.has(c)).length}/${CODES.length} |`
  );
  m.push('');
  if (note) m.push(`_Schedule selection (${office.officeKey}): ${note}._`);
  if (thereNote) m.push(`_Schedule selection (${thereOffice.officeKey}): ${thereNote}._`);
  m.push('');

  m.push('## The codes, biggest money first');
  m.push('');
  m.push(
    `Ranked by basket weight × dollar gap, so the codes worth the most to fix are at the top. ` +
      `"% of UCR" is each rate measured against ${office.officeName}'s own full fee ` +
      `(\`${office.ucrNum}\` ${md(office.ucrSchedule ? office.ucrSchedule.description : '')}).`
  );
  m.push('');
  m.push(
    `| Code | Procedure | Wt | ${md(office.officeName)} | ${md(thereOffice.officeName)} | Gap | ${md(office.officeName)} % UCR | ${md(thereOffice.officeName)} % UCR |`
  );
  m.push('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const r of ranked) {
    const gapCell =
      r.gap === null ? '—' : r.gap > 0 ? `**+${money(r.gap).slice(1)}**` : money(r.gap);
    m.push(
      `| \`${r.code}\` | ${md(r.label)} | ${r.weight} | ${money(r.mine)} | ${money(r.theirs)} | ` +
        `${gapCell} | ${pct(r.minePctUcr)} | ${pct(r.theirsPctUcr)} |`
    );
  }
  m.push('');
  if (ahead.length) {
    m.push(
      `> Note for honesty in the conversation: on ${ahead.length} code(s) ` +
        `(${ahead.map((r) => `\`${r.code}\``).join(', ')}) ${office.officeName} is already paid MORE ` +
        `than ${thereOffice.officeName}. Ask for the better of the two per code, and expect the ` +
        `network to propose a single schedule rather than a cherry-pick.`
    );
    m.push('');
  }
  m.push('---');
  m.push('');
  m.push(
    `**"Per basket cycle" means** one of each basket code in general-practice proportion ` +
      `(${Object.values(BASKET).reduce((a, b) => a + b, 0)} procedures). It is a comparison unit, ` +
      `**not a forecast** — the weights are a standard GP mix, not this practice's measured volumes. ` +
      `Real volumes come from the production report.`
  );
  m.push('');
  fs.writeFileSync(path.join(outDir, 'connection-comparison.md'), `${m.join('\n')}\n`, 'utf8');

  return { totalWeightedGap, behindCount: behind.length, aheadCount: ahead.length };
}

/** One carrier ask sheet. */
function writeCarrierSheet(dir, office, view) {
  const { spec, matched, planCount, schedules, dominant } = view;
  const rows = dominant ? askRows(dominant.fees, office.ucrFees) : [];
  const recovery = estimatedRecovery(rows);

  /** @type {string[]} */
  const m = [];
  m.push(`# ${spec.label} — fee ask sheet`);
  m.push('');
  m.push(`_${office.officeName} · generated ${todayStamp()} · every fee read from Open Dental_`);
  m.push('');

  if (!matched.length) {
    m.push(`**No carrier record at this practice matches "${spec.listed}".** Nothing to negotiate here — check the spelling in Open Dental's carrier list.`);
    m.push('');
    fs.writeFileSync(path.join(dir, `${slug(spec.label)}.md`), `${m.join('\n')}\n`, 'utf8');
    return { view, rows, recovery: 0, leased: false, skipped: 'NO_CARRIER_RECORD' };
  }
  if (planCount === 0) {
    m.push(`**${matched.length} carrier record(s) exist but carry no active plans.** Nothing to negotiate until there is volume.`);
    m.push('');
    m.push(`Records: ${matched.map((c) => `\`${c.carrierName.trim()}\``).join(', ')}`);
    m.push('');
    fs.writeFileSync(path.join(dir, `${slug(spec.label)}.md`), `${m.join('\n')}\n`, 'utf8');
    return { view, rows, recovery: 0, leased: false, skipped: 'NO_PLANS' };
  }

  const leased = Boolean(dominant && dominant.leased);
  const foreignPayer = dominant ? foreignPayerInScheduleName(spec, dominant.description) : null;
  if (leased) {
    m.push(LEASED_BANNER);
    m.push('');
  } else if (foreignPayer) {
    m.push(
      `> ⚠️ **Check who owns this schedule before you call.**  \n` +
        `> ${spec.label}'s plans ride a schedule named **"${md(dominant.description)}"** — after ` +
        `**${foreignPayer}**, a different payer. That usually means ${spec.label} is renting ` +
        `${foreignPayer}'s network and did not set these rates itself. **Ask ${spec.label} which ` +
        `network adjudicates your claims and who owns the fee schedule**, then take the ask to ` +
        `whoever that is. The rates below are still what you are being paid.`
    );
    m.push('');
  }

  m.push('## Where they sit today');
  m.push('');
  m.push(`**${planCount} active plan(s)** across ${matched.length} carrier record(s) in Open Dental.`);
  m.push('');
  m.push('| Fee schedule | Plans | Basket codes priced | |');
  m.push('|---|---:|---:|---|');
  for (const s of schedules) {
    const tags = [];
    if (s.isUcr) tags.push('**your full fee**');
    if (s.leased) tags.push('leased network');
    if (s.isHidden) tags.push('hidden');
    if (dominant && s.feeSchedNum === dominant.feeSchedNum) tags.push('◀ this sheet');
    m.push(
      `| ${md(s.description)}${s.feeSchedNum === 0 ? '' : ` (\`${s.feeSchedNum}\`)`} | ${s.plans} | ` +
        `${s.feeSchedNum === 0 ? '—' : `${s.pricedBasketCodes}/${CODES.length}`} | ${tags.join(', ')} |`
    );
  }
  m.push('');

  if (!dominant) {
    m.push(
      '**No schedule to build an ask against.** Every schedule these plans ride is either your own ' +
        'full fee, has no fee schedule attached, or prices none of the basket. Nothing to propose — ' +
        'check the plan setup in Open Dental first.'
    );
    m.push('');
    fs.writeFileSync(path.join(dir, `${slug(spec.label)}.md`), `${m.join('\n')}\n`, 'utf8');
    return { view, rows, recovery: 0, leased, skipped: 'NO_NEGOTIABLE_SCHEDULE' };
  }

  const covered = rows.length;
  const avgNow =
    covered > 0
      ? rows.reduce((n, r) => n + r.weight * r.current, 0) /
        rows.reduce((n, r) => n + r.weight * r.ucr, 0)
      : null;

  m.push('## The ask');
  m.push('');
  m.push(
    `Schedule in play: **${md(dominant.description)}** (\`${dominant.feeSchedNum}\`), carrying ` +
      `**${dominant.plans}** of their ${planCount} plans. Today it pays **${pct(avgNow)}** of your ` +
      `full fee across ${covered} basket codes.`
  );
  m.push('');
  m.push(
    `**Open at your full fee on every code below.** That is the standard way to open a fee review; ` +
      `settling typically lands between **70% and 85%** of full fee. Opening at the number you want ` +
      `to land on leaves nowhere to move.`
  );
  m.push('');
  m.push('| Code | Procedure | Wt | Their rate now | % of your fee | **Ask** | Gain per proc |');
  m.push('|---|---|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    m.push(
      `| \`${r.code}\` | ${md(r.label)} | ${r.weight} | ${money(r.current)} | ${pct(r.currentPctOfUcr)} | ` +
        `**${money(r.proposed)}** | +${money(r.gap).slice(1)} |`
    );
  }
  m.push('');
  m.push(
    `**ESTIMATED recovery if they came all the way to full fee: ${money(recovery)} per basket cycle** ` +
      `(${Object.values(BASKET).reduce((a, b) => a + b, 0)} procedures in general-practice proportion). ` +
      `At a realistic 80% landing, roughly ${money(recovery * 0.8)}. ` +
      `**This is an estimate from standard weights, not this practice's volumes** — see \`priority.md\`.`
  );
  m.push('');
  m.push('## On the call');
  m.push('');
  m.push('- Ask for the **fee schedule review process and the form**, not a verbal rate.');
  m.push('- Ask **when the schedule was last updated** and **when it next opens for review**.');
  m.push('- Get a **name, direct number and reference number** before hanging up.');
  m.push('- Anything agreed verbally means nothing until it arrives **in writing with an effective date**.');
  if (leased) {
    m.push('- This one is network-set: ask **which network** loads the rate and **who owns the contract**.');
  }
  m.push('');

  fs.writeFileSync(path.join(dir, `${slug(spec.label)}.md`), `${m.join('\n')}\n`, 'utf8');
  return { view, rows, recovery, leased, foreignPayer, skipped: null };
}

/**
 * priority.md — where to spend the effort.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE RANKING IS NOT Σ(weight × gap) ALONE
 * ─────────────────────────────────────────────────────────────────────────────
 * That sum is a property of the SCHEDULE, not of the carrier. Every carrier
 * riding Connection Dental 2024 gets the identical figure, so ranking on it
 * alone put GEHA (4 active plans) level with Humana (65) and above Guardian
 * (70) — a priority list that sends the office manager to the smallest book
 * first is worse than no priority list.
 *
 * So the ORDER is `Σ(weight × gap) × active plans`: the size of the per-procedure
 * gap times how much of that carrier the practice actually sees. Active plan
 * count is the only volume signal available without patient-scoped reads.
 *
 * It is shown as a RELATIVE INDEX (top = 100), not as dollars. Both factors are
 * proxies, and multiplying two proxies and printing the result with a dollar
 * sign would be false precision — an office manager would reasonably read
 * "$421,000" as a forecast. The per-cycle dollar gap keeps its own column,
 * because that one IS real money per procedure and came from the API.
 */
function writePriority(outDir, office, sheets, connection) {
  const actionable = sheets.filter((s) => !s.skipped);
  for (const s of actionable) {
    s.priorityRaw = s.recovery * s.view.planCount;
  }
  const topRaw = actionable.reduce((n, s) => Math.max(n, s.priorityRaw), 0);
  for (const s of actionable) {
    s.priorityIndex = topRaw > 0 ? (s.priorityRaw / topRaw) * 100 : 0;
  }
  const scored = [...actionable].sort((a, b) => b.priorityRaw - a.priorityRaw);
  const skipped = sheets.filter((s) => s.skipped);
  const basketSize = Object.values(BASKET).reduce((a, b) => a + b, 0);
  const networkSet = scored.filter((s) => s.leased);

  /** @type {string[]} */
  const m = [];
  m.push(`# Negotiation priority — ${office.officeName}`);
  m.push('');
  m.push(`_Generated ${todayStamp()} · read-only · every fee read from Open Dental_`);
  m.push('');
  m.push('> ## ⚠️ These numbers are an ESTIMATE');
  m.push('> ');
  m.push('> **Gap per basket cycle** is real money per procedure — every fee was read from Open');
  m.push('> Dental — but it is scaled by a **standard general-practice procedure mix**, not this');
  m.push("> practice's measured volumes. No procedure history was read to build this packet.");
  m.push('> ');
  m.push('> **Priority** multiplies that gap by the carrier\'s active plan count, because the gap');
  m.push('> alone is a property of the SCHEDULE — every carrier on the same schedule scores the');
  m.push('> same, which would rank a 4-plan carrier level with a 65-plan one. It is shown as a');
  m.push('> **relative index (top = 100), not dollars**: both factors are proxies, and printing a');
  m.push('> dollar total would read as a forecast when it is not one.');
  m.push('> ');
  m.push('> **A real annual dollar figure needs the production report.** Use this to decide who to');
  m.push('> call first, then re-run against actual procedure counts.');
  m.push('');
  m.push(`Full fee (UCR) used throughout: \`${office.ucrNum}\` **${md(office.ucrSchedule ? office.ucrSchedule.description : '')}** — ${office.ucrBasis}.`);
  m.push('');

  m.push('## Ranked');
  m.push('');
  m.push('| # | Carrier | Active plans | Schedule they ride | Pays now | Gap per basket cycle | **Priority** | |');
  m.push('|---:|---|---:|---|---:|---:|---:|---|');
  scored.forEach((s, i) => {
    const d = s.view.dominant;
    const avgNow =
      s.rows.length > 0
        ? s.rows.reduce((n, r) => n + r.weight * r.current, 0) /
          s.rows.reduce((n, r) => n + r.weight * r.ucr, 0)
        : null;
    m.push(
      `| ${i + 1} | **${md(s.view.spec.label)}** | ${s.view.planCount} | ${md(d ? d.description : '—')} | ` +
        `${pct(avgNow)} | ${money(s.recovery)} | **${s.priorityIndex.toFixed(0)}** | ` +
        `${s.leased ? '🔗 network-set' : s.foreignPayer ? `⚠️ check network (schedule named after ${md(s.foreignPayer)})` : 'direct'} |`
    );
  });
  m.push('');
  m.push(
    `_"Per basket cycle" = one of each basket code in GP proportion (${basketSize} procedures). ` +
      `Carriers on the same fee schedule share a per-cycle gap — that is why the ranking is the gap ` +
      `**times active plans**, not the gap alone._`
  );
  m.push('');

  // Almost everything is usually network-set, and that changes the strategy from
  // "call eight carriers" to "have two or three network conversations".
  if (networkSet.length) {
    /** @type {Map<string, Array<object>>} */
    const byNetwork = new Map();
    for (const s of networkSet) {
      const key = s.view.dominant ? s.view.dominant.description : '(unknown)';
      if (!byNetwork.has(key)) byNetwork.set(key, []);
      byNetwork.get(key).push(s);
    }
    m.push('## The shortcut: most of these are the same conversation');
    m.push('');
    m.push(
      `${networkSet.length} of the ${scored.length} carriers above do not set their own rates — they ` +
        `ride a leased network schedule. **One conversation per network moves every carrier on it at ` +
        `once**, which is far less work than eight separate fee reviews.`
    );
    m.push('');
    m.push('| Network schedule | Carriers on it | Their plans |');
    m.push('|---|---|---:|');
    for (const [name, group] of [...byNetwork.entries()].sort(
      (a, b) =>
        b[1].reduce((n, s) => n + s.view.planCount, 0) -
        a[1].reduce((n, s) => n + s.view.planCount, 0)
    )) {
      m.push(
        `| ${md(name)} | ${group.map((s) => md(s.view.spec.label)).join(', ')} | ` +
          `${group.reduce((n, s) => n + s.view.planCount, 0)} |`
      );
    }
    m.push('');
  }

  if (skipped.length) {
    m.push('## Not actionable');
    m.push('');
    for (const s of skipped) {
      const why =
        s.skipped === 'NO_CARRIER_RECORD'
          ? 'no carrier record at this practice'
          : s.skipped === 'NO_PLANS'
            ? `${s.view.matched.length} carrier record(s) but no active plans`
            : 'plans ride only your own full fee, an unattached schedule, or one with no basket fees';
      m.push(`- **${md(s.view.spec.label)}** — ${why}.`);
    }
    m.push('');
  }

  m.push('## Do these in order');
  m.push('');
  const networkSheets = networkSet;
  if (connection) {
    m.push(
      `1. **Connection Dental first.** ${connection.behindCount} basket codes pay less here than at the ` +
        `sister practice, worth **${money(connection.totalWeightedGap)} per basket cycle**. It is the ` +
        `single largest item and the easiest ask to justify — same ownership, schedule already agreed ` +
        `at the other location. See \`connection-comparison.md\` and \`letters/connection-dental-extension.md\`.`
    );
  } else {
    m.push(
      `1. **Leased networks first**${networkSheets.length ? ` (${networkSheets.map((s) => md(s.view.spec.label)).join(', ')})` : ''}. ` +
        `One network conversation moves every carrier riding that schedule at once.`
    );
  }
  m.push(
    `2. **Then the direct carriers, top of the table down.** One at a time — each needs its own form, ` +
      `and chasing six at once means chasing none of them.`
  );
  m.push(
    `3. **Delta Dental and Blue Cross Blue Shield are NOT on this list.** They are the two biggest ` +
      `books at both practices, but neither is a fee-schedule negotiation: Delta is a participation-tier ` +
      `decision (Premier vs PPO vs out of network) and BCBS is a network-participation question. Both ` +
      `need a separate participation analysis with real volumes before anything is decided.`
  );
  m.push('');
  m.push(
    `4. **Re-run this packet after the production report exists**, so the ranking uses real procedure ` +
      `counts instead of standard weights.`
  );
  m.push('');
  fs.writeFileSync(path.join(outDir, 'priority.md'), `${m.join('\n')}\n`, 'utf8');
  return scored;
}

/**
 * The three letter templates.
 *
 * Placeholders only — no TIN, no NPI, no effective date, and no assertion about
 * what any contract says. A template that guessed at contract terms would be
 * worse than no template: it would be sent.
 */
function writeLetters(dir) {
  const common =
    '<!--\n' +
    'MERGE FIELDS — replace every {PLACEHOLDER} before sending.\n' +
    '  {CARRIER}         payer or network name\n' +
    '  {OFFICE}          practice name as it appears on the contract\n' +
    '  {TIN}             practice tax ID\n' +
    '  {NPI}             group NPI\n' +
    '  {EFFECTIVE_DATE}  date you are requesting the new schedule take effect\n' +
    '  {FEE_TABLE}       paste the table from the matching ask sheet\n' +
    '  {CONTACT_NAME} / {CONTACT_TITLE} / {CONTACT_PHONE} / {CONTACT_EMAIL} / {DATE}\n' +
    'Nothing in this template asserts a contract term. Do not add one you have not verified.\n' +
    '-->\n';

  fs.writeFileSync(
    path.join(dir, 'direct-carrier-fee-review.md'),
    `${common}
# Fee schedule review request — {CARRIER}

{DATE}

{CARRIER}
Provider Relations / Network Management

**Re: Request for fee schedule review**
**Practice:** {OFFICE}
**TIN:** {TIN}  **Group NPI:** {NPI}

To whom it may concern,

{OFFICE} is a participating provider with {CARRIER}. We are requesting a review of our
current fee schedule and are asking that it be updated effective {EFFECTIVE_DATE}.

Our costs of delivering care — staffing, laboratory, materials and supplies — have risen
materially since our schedule was last set. We are asking that our reimbursement be
brought in line with our current full fee for the procedures below, which represent the
majority of the care we deliver.

{FEE_TABLE}

Please send us:

1. The current fee schedule on file for {TIN}, with the date it took effect.
2. Your fee schedule review process and any form you require.
3. The date our schedule next opens for review, if it is not open now.

We value our participation with {CARRIER} and the patients we see under your plans, and we
would like to keep that relationship on a footing that is sustainable for both of us.

Please confirm receipt and let us know the expected timeline for a response.

Sincerely,

{CONTACT_NAME}
{CONTACT_TITLE}, {OFFICE}
{CONTACT_PHONE} · {CONTACT_EMAIL}
`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(dir, 'connection-dental-extension.md'),
    `${common}
# Schedule extension request — {CARRIER}

<!-- Additional placeholders for this letter:
  {SISTER_OFFICE}       the affiliated location already on the better schedule
  {SISTER_TIN}          that location's TIN
-->

{DATE}

{CARRIER}
Network Management

**Re: Request to extend an existing negotiated schedule to an affiliated location**
**Requesting practice:** {OFFICE}
**TIN:** {TIN}  **Group NPI:** {NPI}
**Affiliated practice already contracted:** {SISTER_OFFICE}, TIN {SISTER_TIN}

To whom it may concern,

{OFFICE} and {SISTER_OFFICE} are under common ownership. Both locations participate with
{CARRIER}, and both are currently loaded on a 2024 schedule — but the two locations are on
**different schedules**, with {SISTER_OFFICE} reimbursed at materially higher rates for the
same procedures.

We are not asking for a rate increase. We are asking that the schedule already negotiated
and in force for {SISTER_OFFICE} be **extended to {OFFICE} under TIN {TIN}**, effective
{EFFECTIVE_DATE}.

The table below compares the two locations' current rates on the procedures that make up
the majority of our care:

{FEE_TABLE}

Both locations operate under the same ownership, the same clinical protocols and the same
standard of care. We see no basis for the two being reimbursed differently, and aligning
them should be an administrative change rather than a negotiation.

Please confirm:

1. Whether the {SISTER_OFFICE} schedule can be extended to {TIN}.
2. What documentation you need from us to do so.
3. The earliest effective date you can load it.

If extension is not possible, please tell us what does govern the difference between the
two locations so we can address it directly.

Sincerely,

{CONTACT_NAME}
{CONTACT_TITLE}, {OFFICE}
{CONTACT_PHONE} · {CONTACT_EMAIL}
`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(dir, 'followup-30-day-escalation.md'),
    `${common}
# Follow-up — no response at 30 days

<!-- Additional placeholders:
  {ORIGINAL_DATE}   date of the original request
  {REFERENCE}       reference or ticket number, if one was given
-->

{DATE}

{CARRIER}
Provider Relations / Network Management

**Re: Second request — fee schedule review for {OFFICE}, TIN {TIN}**
**Original request dated:** {ORIGINAL_DATE}
**Reference:** {REFERENCE}

To whom it may concern,

On {ORIGINAL_DATE} we submitted a written request for a fee schedule review for {OFFICE}
(TIN {TIN}, NPI {NPI}). We have not received a substantive response.

We are following up to ask for:

1. Confirmation that our request was received and is in process.
2. The name and direct contact details of the person handling it.
3. A date by which we can expect a decision.

If this request has been declined, we ask for that in writing, together with the reason and
the date our schedule next opens for review.

We would prefer to resolve this in the ordinary course. Absent a response within 14 days of
this letter, we will need to evaluate our continued participation, and we would rather have
the conversation than reach that point without one.

A copy of our original request and the supporting fee comparison is enclosed.

Sincerely,

{CONTACT_NAME}
{CONTACT_TITLE}, {OFFICE}
{CONTACT_PHONE} · {CONTACT_EMAIL}
`,
    'utf8'
  );
}

/** README.md — the process, in office-manager language. */
function writeReadme(outDir, office, sheets, connection, scored) {
  const basketSize = Object.values(BASKET).reduce((a, b) => a + b, 0);
  /** @type {string[]} */
  const m = [];
  m.push(`# Fee negotiation packet — ${office.officeName}`);
  m.push('');
  m.push(`_Generated ${todayStamp()}. Every dollar in this packet was read directly from Open Dental._`);
  m.push('');
  m.push('## What this is');
  m.push('');
  m.push(
    'A set of sheets for asking payers for better rates. Each one shows what a payer pays you ' +
      'today, what your own full fee is, and what to ask for — with the procedures worth the most ' +
      'money at the top.'
  );
  m.push('');
  m.push("## What's in here");
  m.push('');
  m.push('| File | What it is |');
  m.push('|---|---|');
  m.push('| `priority.md` | **Start here.** Which carriers are worth your time, in order. |');
  if (connection) {
    m.push('| `connection-comparison.md` | The Connection Dental sheet — our rates vs the sister practice. Read this on the call. |');
    m.push('| `connection-comparison.csv` | Same numbers, for a spreadsheet. |');
  }
  m.push('| `carrier-asks/` | One sheet per carrier. Print the one you are calling about. |');
  m.push('| `letters/` | Three letter templates. Fill in the blanks before sending. |');
  m.push('');

  m.push('## The order to do this in');
  m.push('');
  if (connection) {
    m.push(
      '**1. Connection Dental first.** It is the biggest single item and the easiest to justify: ' +
        'both practices have the same owner, and the other location is already on a better schedule ' +
        'for the same network. You are not asking for a raise — you are asking them to put both ' +
        'locations on the same deal. Use `connection-comparison.md` and ' +
        '`letters/connection-dental-extension.md`.'
    );
  } else {
    m.push(
      '**1. Leased networks first.** Where a carrier rides a rented network schedule, one ' +
        'conversation with the network moves every carrier on it at once.'
    );
  }
  m.push('');
  m.push(
    '**2. Then the direct carriers,** working down `priority.md`. Do them **one at a time**. Each ' +
      'one needs its own form and its own follow-up, and six half-finished requests get you nothing.'
  );
  m.push('');
  m.push(
    '**3. Delta Dental and Blue Cross Blue Shield are deliberately not in this packet.** They are ' +
      'your two biggest books, but neither is a "please pay us more" conversation. Delta is a ' +
      'decision about which tier you participate in (Premier, PPO, or out of network) and BCBS is a ' +
      'question about whether to stay in the network at all. Both need real procedure volumes and a ' +
      'separate participation analysis. Do not phone them with these sheets.'
  );
  m.push('');

  m.push('## Two things to know before you call');
  m.push('');
  m.push(
    '**"Network-set" carriers.** Some carriers do not set their own rates — they rent a network ' +
      '(Connection Dental, Zelis, DNoA, Careington, Dentemax) and use that network\'s schedule. ' +
      'Those sheets carry a warning banner at the top. Phoning the carrier about the rate will not ' +
      'work; you have to go to the network. The sheet is still useful — it shows you what the ' +
      'network schedule is costing you.'
  );
  m.push('');
  m.push(
    '**Ask for your full fee.** Every sheet proposes your own full fee for every code. That is ' +
      'deliberate and it is how this is normally done — you open at full fee and settle somewhere ' +
      'around 70–85% of it. If you open at the number you would be happy with, you have nowhere to go.'
  );
  m.push('');

  m.push('## What the numbers mean');
  m.push('');
  m.push(
    `- **Full fee / UCR** — your own fee schedule, \`${office.ucrNum}\` ` +
      `**${md(office.ucrSchedule ? office.ucrSchedule.description : '')}**. Everything is measured against it.`
  );
  m.push(
    '- **Wt (weight)** — roughly how often a general practice does that procedure relative to the ' +
      'others. Used to sort the big-money codes to the top.'
  );
  m.push(
    `- **Per basket cycle** — one of each basket code in general-practice proportion ` +
      `(${basketSize} procedures). It is a way to compare carriers on the same footing.`
  );
  m.push('');
  m.push(
    '> ⚠️ **The recovery figures are estimates.** They use a standard general-practice procedure ' +
      'mix, not your actual volumes — no patient or procedure history was read to build this packet. ' +
      'Use them to decide **who to call first**, not to forecast income. Once the production report ' +
      'is available, this can be re-run against real counts.'
  );
  m.push('');

  m.push('## Every call, every time');
  m.push('');
  m.push('1. Ask for the **fee schedule review process and the form**. Do not accept a verbal rate.');
  m.push('2. Ask **when the schedule was last updated** and **when it next opens for review**.');
  m.push('3. Get a **name, a direct number, and a reference number** before you hang up.');
  m.push('4. Send the letter the same day, even if the call went well.');
  m.push('5. Diary **30 days**. No substantive answer by then → `letters/followup-30-day-escalation.md`.');
  m.push('6. Nothing is real until it arrives **in writing with an effective date**.');
  m.push('');
  m.push('---');
  m.push('');
  m.push(
    '_Read-only: building this packet made no change to Open Dental. It contains no patient ' +
      'information — only fee schedules, procedure codes, carriers and plan counts._'
  );
  m.push('');
  fs.writeFileSync(path.join(outDir, 'README.md'), `${m.join('\n')}\n`, 'utf8');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] ?? '';
  }
  const usage =
    'usage: node scripts/fee-negotiation-packet.js --office roland|valley [--ucr <FeeSchedNum>]';
  const office = String(out.office || '').trim();
  if (office !== 'roland' && office !== 'valley') throw new Error(usage);
  const ucr = out.ucr ? Number(out.ucr) : null;
  if (ucr !== null && !Number.isFinite(ucr)) throw new Error('--ucr must be a FeeSchedNum');
  return { office, ucr };
}

/** The office whose Connection Dental schedule is the comparison target. */
const SISTER_OFFICE = Object.freeze({ roland: 'valley', valley: null });

async function main() {
  const { office: officeKey, ucr: ucrOverride } = parseArgs(process.argv.slice(2));

  await require('../config/secrets').loadSecrets();

  console.log(`\n=== FEE NEGOTIATION PACKET — ${officeKey} — READ-ONLY ===\n`);
  const office = await loadOffice(officeKey, ucrOverride);
  console.log(
    `\n  UCR -> ${office.ucrNum} "${office.ucrSchedule ? office.ucrSchedule.description : '?'}" (${office.ucrBasis})\n`
  );

  const outDir = path.join(
    __dirname, '..', '..', 'docs', 'reports',
    `negotiation-packet-${officeKey}-${todayStamp()}`
  );
  fs.mkdirSync(path.join(outDir, 'carrier-asks'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'letters'), { recursive: true });

  // ── Connection Dental comparison (needs the sister practice) ───────────────
  let connection = null;
  let sisterRequests = 0;
  let sisterSeconds = 0;
  const sisterKey = SISTER_OFFICE[officeKey];
  if (sisterKey) {
    const here = findConnectionSchedule(office);
    if (!here.schedule) {
      console.log(`  connection comparison SKIPPED: ${here.note}`);
    } else {
      console.log(`  connection: ${officeKey} -> ${here.schedule.feeSchedNum} "${here.schedule.description}"`);
      // A SECOND office, opened through the same asserted seam. Its CodeNum map
      // is resolved from its OWN database — see lib/odFeeBasket.fetchBasketCodeNums.
      const sister = await loadSisterConnection(sisterKey);
      sisterRequests = sister.requests;
      sisterSeconds = sister.seconds;
      if (!sister.schedule) {
        console.log(`  connection comparison SKIPPED: ${sister.note} (${sisterKey})`);
      } else {
        const hereFees = office.fees.get(here.schedule.feeSchedNum) || new Map();
        connection = writeConnectionComparison(outDir, {
          office,
          here: { ...here.schedule, fees: hereFees, planCount: here.schedule.planCount },
          there: sister.schedule,
          thereOffice: { officeKey: sisterKey, officeName: sister.officeName },
          note: here.note,
          thereNote: sister.note,
        });
        console.log(
          `  connection comparison: ${connection.behindCount} codes behind, ` +
            `${money(connection.totalWeightedGap)} per basket cycle`
        );
      }
    }
  }

  // ── Carrier ask sheets ────────────────────────────────────────────────────
  const sheets = DIRECT_CARRIERS.map((spec) =>
    writeCarrierSheet(path.join(outDir, 'carrier-asks'), office, carrierView(spec, office))
  );

  const scored = writePriority(outDir, office, sheets, connection);
  writeLetters(path.join(outDir, 'letters'));
  writeReadme(outDir, office, sheets, connection, scored);

  const totalRequests = office.reader.requests + sisterRequests;
  const totalSeconds = office.reader.elapsedSeconds() + sisterSeconds;
  console.log(`\n  wrote ${path.relative(path.join(__dirname, '..', '..'), outDir)}/`);
  console.log(`  ${sheets.filter((s) => !s.skipped).length}/${sheets.length} carrier sheets actionable`);
  console.log(
    `\n  ${totalRequests} requests in ${totalSeconds.toFixed(1)}s` +
      `${sisterRequests ? `  (${office.reader.requests} ${officeKey} + ${sisterRequests} ${sisterKey})` : ''}\n`
  );
}

/**
 * Read ONLY what the comparison needs from the sister practice: its own basket
 * CodeNum map, and its Connection Dental 2024 schedule's fees.
 *
 * Deliberately narrow. The sister office's carriers, plans and other schedules
 * are none of this packet's business, and not reading them keeps the
 * cross-office footprint to the one table that needs it.
 *
 * @param {string} sisterKey
 */
async function loadSisterConnection(sisterKey) {
  const { reader, officeName } = openOffice(sisterKey);

  process.stdout.write(`  [${sisterKey}] /feescheds ... `);
  const schedules = await fetchFeeSchedules(reader);
  console.log(`${schedules.length}`);

  process.stdout.write(`  [${sisterKey}] /insplans ... `);
  const plans = await fetchInsPlans(reader);
  console.log(`${plans.length}`);

  /** @type {Map<number, number>} */
  const planCounts = new Map();
  for (const p of plans) {
    if (p.isHidden) continue;
    planCounts.set(p.feeSched, (planCounts.get(p.feeSched) || 0) + 1);
  }

  const found = findConnectionSchedule({ schedules, planCounts });
  if (!found.schedule) {
    return { schedule: null, note: found.note, officeName, requests: reader.requests, seconds: reader.elapsedSeconds() };
  }

  process.stdout.write(`  [${sisterKey}] /procedurecodes ... `);
  const { codeNumByProcCode } = await fetchBasketCodeNums(reader);
  console.log(`${codeNumByProcCode.size}/${CODES.length} basket codes`);

  process.stdout.write(`  [${sisterKey}] /fees?FeeSched=${found.schedule.feeSchedNum} ... `);
  const { fees } = await fetchScheduleBasketFees(
    reader,
    found.schedule.feeSchedNum,
    codeNumByProcCode
  );
  console.log(`${fees.size} basket fees`);

  return {
    schedule: { ...found.schedule, fees },
    note: found.note,
    officeName,
    requests: reader.requests,
    seconds: reader.elapsedSeconds(),
  };
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`\nFAILED: ${err && err.code ? `[${err.code}] ` : ''}${err && err.message ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
