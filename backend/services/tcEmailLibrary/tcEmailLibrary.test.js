'use strict';

/**
 * The TC patient email library (EL-1), service level.
 *
 *   P  source.json is the handoff file byte for byte: its sha256 is pinned here,
 *      so a wording change is a PR that moves this pin
 *   G  the CommonJS compose port reproduces every golden case exactly
 *      (sha256 of JSON.stringify(output), email count, first/last id, ...)
 *   N  composeOne (the preview's narrowed compose) yields exactly the email the
 *      full compose yields, for every email in two answer sets
 *   C  the shared contract's key / option / procedure lists ARE the source's
 *   A  LIBRARY_CLINICALLY_APPROVED is false
 *   R  the library requires no messaging service, no channel adapter, no Open
 *      Dental client and no AI client
 *   V  answer validation: one refusal code per failure, normalization
 *   M  merge resolution leaves unset fields as {{tokens}} and lists them
 *   W  1.2.0 wording: no answer-owned {{token}}, no [[slot]], no stray brace,
 *      no review_referral email in any golden case; a set scheduling link is
 *      printed where the library says; the retired-key list is review_link only
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const library = require('./index');
const { compose } = require('./compose');
const contract = require('../../tc/contract.gen.cjs');

const SOURCE_SHA256 = 'f091ef388d9decc5561ec0fc7001a9bedb88aa2ce41fe1f56c8729dc1b663cd8';
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', 'golden.json'), 'utf8'));
/** A fresh, unfrozen parse: the golden test must not depend on the module's copy. */
const freshSource = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'source.json'), 'utf8'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('P: source.json is pinned by sha256', () => {
  assert.equal(sha(fs.readFileSync(path.join(__dirname, 'source.json'))), SOURCE_SHA256);
  assert.equal(library.SOURCE_SHA256, SOURCE_SHA256);
  assert.equal(golden.source_sha256, SOURCE_SHA256, 'the golden fixture was recorded against this source');
  assert.equal(library.LIBRARY_VERSION, golden.library_version);
});

test('G: every golden case reproduces exactly', () => {
  assert.ok(golden.cases.length >= 3);
  for (const c of golden.cases) {
    const out = compose(freshSource(), c.answers);
    assert.equal(sha(JSON.stringify(out)), c.output_sha256, `${c.name}: output hash`);
    assert.equal(out.length, c.email_count, `${c.name}: email count`);
    assert.equal(new Set(out.map((e) => e.procedure_id)).size, c.procedure_count, `${c.name}: procedures`);
    assert.equal(new Set(out.map((e) => e.stage)).size, c.stages, `${c.name}: stages`);
    const mergeFields = [...new Set(out.flatMap((e) => e.merge_fields))].sort();
    assert.deepEqual(mergeFields, c.merge_fields, `${c.name}: merge fields printed anywhere`);
  }
});

test('G: the module-loaded (frozen) source composes the same as a fresh parse', () => {
  for (const c of golden.cases) {
    assert.equal(sha(JSON.stringify(library.composeAll(c.answers))), c.output_sha256, c.name);
  }
});

test('N: composeOne equals the full compose for every email', () => {
  for (const c of [golden.cases[0], golden.cases[golden.cases.length - 1]]) {
    const full = compose(freshSource(), c.answers);
    for (const e of full) {
      const one = library.composeOne({ procedureId: e.procedure_id, stage: e.stage, variant: e.variant }, c.answers);
      assert.deepEqual(one, e, `${c.name}: ${e.id}`);
    }
  }
});

test('N: composeOne refuses by name', () => {
  const codeOf = (pick, answers = {}) => {
    try {
      library.composeOne(pick, answers);
    } catch (err) {
      return [err.code, err.status];
    }
    return null;
  };
  assert.deepEqual(codeOf({ procedureId: 'nope', stage: 'tp_recap', variant: 'A' }), ['EMAIL_LIBRARY_UNKNOWN_PROCEDURE', 400]);
  assert.deepEqual(codeOf({ procedureId: 'crown', stage: 'nope', variant: 'A' }), ['EMAIL_LIBRARY_UNKNOWN_STAGE', 400]);
  assert.deepEqual(codeOf({ procedureId: 'crown', stage: 'tp_recap', variant: 'Z' }), ['EMAIL_LIBRARY_UNKNOWN_VARIANT', 400]);
  assert.deepEqual(codeOf({ procedureId: 'braces', stage: 'tp_recap', variant: 'A' }, { services_off: ['braces'] }), [
    'EMAIL_LIBRARY_SERVICE_OFF',
    409,
  ]);
  assert.deepEqual(
    codeOf({ procedureId: 'crown', stage: 'benefits_deadline', variant: 'A' }, { insurance_mode: 'no_insurance' }),
    ['EMAIL_LIBRARY_STAGE_NOT_USED', 409]
  );
});

test('C: the contract key and option lists are the source questions, minus the office fields', () => {
  const src = freshSource();
  const stored = src.questions.filter((q) => !contract.EMAIL_LIBRARY_NEVER_STORED.includes(q.id));
  assert.deepEqual([...contract.EMAIL_LIBRARY_NEVER_STORED].sort(), ['office_name', 'office_phone']);
  for (const id of contract.EMAIL_LIBRARY_NEVER_STORED) assert.ok(src.questions.some((q) => q.id === id), `${id} is a source question`);
  assert.deepEqual([...contract.EMAIL_LIBRARY_ANSWER_KEYS].sort(), stored.map((q) => q.id).sort());

  const byType = (t) => stored.filter((q) => q.type === t);
  assert.deepEqual([...contract.EMAIL_LIBRARY_YESNO_KEYS].sort(), byType('yesno').map((q) => q.id).sort());
  for (const q of byType('select')) {
    assert.deepEqual(contract.EMAIL_LIBRARY_SELECT_OPTIONS[q.id], q.options.map((o) => o.value), q.id);
  }
  assert.equal(Object.keys(contract.EMAIL_LIBRARY_SELECT_OPTIONS).length, byType('select').length);
  for (const q of byType('multi')) {
    assert.deepEqual(contract.EMAIL_LIBRARY_MULTI_OPTIONS[q.id], q.options.map((o) => o.value), q.id);
  }
  assert.equal(Object.keys(contract.EMAIL_LIBRARY_MULTI_OPTIONS).length, byType('multi').length);
  assert.deepEqual(byType('procedures').map((q) => q.id), ['services_off']);
  assert.deepEqual([...contract.EMAIL_LIBRARY_PROCEDURE_IDS], src.procedure_blocks.map((p) => p.id));

  // Every text-typed question is exactly one of: free text, a link, cancel_hours.
  const textish = [
    ...Object.keys(contract.EMAIL_LIBRARY_TEXT_MAX),
    ...contract.EMAIL_LIBRARY_LINK_KEYS,
    contract.EMAIL_LIBRARY_CANCEL_HOURS.key,
  ].sort();
  assert.deepEqual(textish, byType('text').map((q) => q.id).sort());
  assert.deepEqual(Object.keys(src.variants).sort(), [...contract.EMAIL_LIBRARY_VARIANTS]);

  // The answer-owned merge settings are real merge fields and real questions.
  const mergeNames = src.merge_fields.map((m) => m.name);
  for (const f of contract.EMAIL_LIBRARY_MERGE_SETTINGS) {
    assert.ok(mergeNames.includes(f), `${f} is a merge field`);
    assert.ok(contract.EMAIL_LIBRARY_ANSWER_KEYS.includes(f), `${f} is an answer`);
  }
});

test('C: every saved-answers default composes (the source defaults validate)', () => {
  const src = freshSource();
  for (const q of src.questions) {
    if (q.default == null || contract.EMAIL_LIBRARY_NEVER_STORED.includes(q.id)) continue;
    const v = contract.validateEmailLibraryAnswers({ [q.id]: q.default });
    assert.equal(v.ok, true, `${q.id}'s default '${q.default}' validates`);
  }
});

test('A: the library is not clinically approved', () => {
  assert.equal(library.LIBRARY_CLINICALLY_APPROVED, false);
  const cat = library.catalog('roland', {});
  assert.equal(cat.clinicallyApproved, false);
  assert.equal(contract.EmailLibraryCatalogResponse.safeParse(cat).success, true, 'the catalog matches its contract');
});

test('R: the library requires no messaging, channel adapter, Open Dental or AI module', () => {
  // A fresh process, so this suite's own requires cannot hide or add anything.
  const script = `
    require(${JSON.stringify(path.join(__dirname, 'index.js'))});
    require(${JSON.stringify(path.join(__dirname, 'profileStore.js'))});
    process.stdout.write(JSON.stringify(Object.keys(require.cache)));
  `;
  const loaded = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })).map((p) =>
    p.split(path.sep).join('/')
  );
  const backend = path.join(__dirname, '..', '..').split(path.sep).join('/');
  const ours = loaded.filter((p) => p.startsWith(backend) && !p.includes('/node_modules/')).map((p) => p.slice(backend.length + 1));
  assert.deepEqual(
    ours.sort(),
    ['services/tcEmailLibrary/compose.js', 'services/tcEmailLibrary/index.js', 'services/tcEmailLibrary/profileStore.js', 'tc/contract.gen.cjs'].sort(),
    'the library loads only itself and the shared contract'
  );
  const forbidden = [/\/services\/messaging\//, /\/services\/tcNurture\//, /adapters/i, /openDental|odOffices|opendental/i, /\/openai\//, /twilio/i, /\/acs/i];
  for (const p of loaded) for (const rx of forbidden) assert.ok(!rx.test(p), `${p} must not be loaded (${rx})`);
});

test('R: the route touches no messaging service, tcNurture service or Open Dental client directly', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'tc', 'emailLibrary.js'), 'utf8');
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  for (const r of requires) {
    assert.ok(!/services\/messaging|services\/tcNurture|openDental|odOffices|openai|adapters/i.test(r), `routes/tc/emailLibrary.js requires ${r}`);
  }
  // No statement touches the message table (prose may mention it).
  const touchesMessages = /\b(FROM|INTO|UPDATE|JOIN)\s+tc_messages\b/i;
  for (const file of [src, ...['index.js', 'profileStore.js', 'compose.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8'))]) {
    assert.ok(!touchesMessages.test(file), 'no SQL against tc_messages');
  }
});

test('V: one refusal code per failure', () => {
  const v = contract.validateEmailLibraryAnswers;
  const C = contract.EMAIL_LIBRARY_ANSWER_CODES;
  const cases = [
    [null, C.NOT_AN_OBJECT, null],
    [['x'], C.NOT_AN_OBJECT, null],
    [{ office_name: 'Sample Dental' }, C.OFFICE_FIELD, 'office_name'],
    [{ office_phone: '(555) 555-0100' }, C.OFFICE_FIELD, 'office_phone'],
    [{ bogus: true }, C.UNKNOWN_KEY, 'bogus'],
    [{ cbct: 'yes' }, C.NOT_BOOLEAN, 'cbct'],
    [{ insurance_mode: 'sometimes' }, C.BAD_OPTION, 'insurance_mode'],
    [{ sedation: 'nitrous' }, C.BAD_OPTION, 'sedation'],
    [{ sedation: ['nitrous', 'hypnosis'] }, C.BAD_OPTION, 'sedation'],
    [{ services_off: ['braces', 'teleportation'] }, C.BAD_PROCEDURE, 'services_off'],
    [{ doctor_name: 42 }, C.TEXT_NOT_STRING, 'doctor_name'],
    [{ doctor_name: 'x'.repeat(121) }, C.TEXT_TOO_LONG, 'doctor_name'],
    [{ amenities: 'x'.repeat(201) }, C.TEXT_TOO_LONG, 'amenities'],
    [{ doctor_name: 'Dr. {first_name}' }, C.TEXT_FORBIDDEN_CHARACTER, 'doctor_name'],
    [{ membership_name: '[[WHAT]]' }, C.TEXT_FORBIDDEN_CHARACTER, 'membership_name'],
    [{ aligner_brand: '<b>Sample</b>' }, C.TEXT_FORBIDDEN_CHARACTER, 'aligner_brand'],
    [{ amenities: 'blankets\nheadphones' }, C.TEXT_FORBIDDEN_CHARACTER, 'amenities'],
    [{ same_day_length: 'two\thours' }, C.TEXT_FORBIDDEN_CHARACTER, 'same_day_length'],
    [{ financing_partners: `Sample${String.fromCharCode(0x2028)}Co` }, C.TEXT_FORBIDDEN_CHARACTER, 'financing_partners'],
    [{ cancel_hours: '0' }, C.CANCEL_HOURS, 'cancel_hours'],
    [{ cancel_hours: '169' }, C.CANCEL_HOURS, 'cancel_hours'],
    [{ cancel_hours: '24.5' }, C.CANCEL_HOURS, 'cancel_hours'],
    [{ cancel_hours: '048' }, C.CANCEL_HOURS, 'cancel_hours'],
    [{ cancel_hours: 24 }, C.TEXT_NOT_STRING, 'cancel_hours'],
    [{ schedule_link: 'http://book.example.test' }, C.LINK, 'schedule_link'],
    [{ schedule_link: 'book.example.test' }, C.LINK, 'schedule_link'],
    [{ schedule_link: 'https://book.example.test/a b' }, C.LINK, 'schedule_link'],
    [{ schedule_link: `https://r.example.test/${'x'.repeat(300)}` }, C.LINK, 'schedule_link'],
    [{ schedule_link: 'javascript:alert(1)' }, C.LINK, 'schedule_link'],
    // Retired in 1.2.0: not a question any more, so an unknown key.
    [{ review_link: 'https://review.example.test' }, C.UNKNOWN_KEY, 'review_link'],
  ];
  for (const [input, code, key] of cases) {
    const r = v(input);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.equal(r.code, code, JSON.stringify(input));
    assert.equal(r.key, key, JSON.stringify(input));
  }
  // Every code is reachable.
  const seen = new Set(cases.map((c) => c[1]));
  for (const code of Object.values(C)) assert.ok(seen.has(code), `${code} is exercised`);
});

test('V: normalization drops unset answers, trims text and keeps the source option order', () => {
  const r = contract.validateEmailLibraryAnswers({
    sedation: ['iv', 'nitrous', 'iv'],
    schedule_perks: [],
    doctor_name: '  Dr. Sample  ',
    aligner_brand: '   ',
    laser: null,
    cbct: false,
    cancel_hours: ' 24 ',
    schedule_link: 'https://book.example.test/sample',
    services_off: ['braces', 'full_arch'],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.answers, {
    sedation: ['nitrous', 'iv'],
    doctor_name: 'Dr. Sample',
    cbct: false,
    cancel_hours: '24',
    schedule_link: 'https://book.example.test/sample',
    services_off: ['full_arch', 'braces'],
  });
  // Every golden answer set validates unchanged (modulo option order).
  for (const c of golden.cases) assert.equal(contract.validateEmailLibraryAnswers(c.answers).ok, true, c.name);
});

test('M: unresolved merge fields stay as tokens and are listed', () => {
  const r = library.resolveMergeFields(['Hi {{first_name}}', 'Book at {{schedule_link}} or call {{office_phone}}'], {
    first_name: 'Jordan',
    schedule_link: '   ',
    office_phone: null,
  });
  assert.deepEqual(r.texts, ['Hi Jordan', 'Book at {{schedule_link}} or call {{office_phone}}']);
  assert.deepEqual(r.unresolved, ['office_phone', 'schedule_link']);
});

test('M: missing lists only a setting an email still prints as a token; blankOptional lists the blank ones', () => {
  // 1.2.0 writes both settings into the text, so nothing is missing even blank.
  assert.deepEqual(library.missingSettings({}), []);
  assert.deepEqual(library.blankOptionalSettings({}), ['schedule_link', 'doctor_name']);
  assert.deepEqual(library.blankOptionalSettings({ doctor_name: 'Dr. Sample' }), ['schedule_link']);
  assert.deepEqual(library.blankOptionalSettings({ schedule_link: 'https://book.example.test', doctor_name: '  ' }), ['doctor_name']);
  const set = { schedule_link: 'https://book.example.test', doctor_name: 'Dr. Sample' };
  assert.deepEqual(library.missingSettings(set), []);
  assert.deepEqual(library.blankOptionalSettings(set), []);
});

/** Text outside every {{merge}} token. */
const outsideMerge = (text) => text.replace(/\{\{\w+\}\}/g, '');

test('W: no golden case prints an answer-owned token, a [[slot]], a stray brace or a review request', () => {
  for (const c of golden.cases) {
    const out = compose(freshSource(), c.answers);
    for (const e of out) {
      for (const [part, text] of [['subject', e.subject], ['preheader', e.preheader], ['body', e.body_text]]) {
        const where = `${c.name}: ${e.id} ${part}`;
        for (const token of ['{{schedule_link}}', '{{doctor_name}}', '{{review_link}}']) assert.ok(!text.includes(token), `${where} prints ${token}`);
        assert.ok(!text.includes('[['), `${where} has a [[ slot left`);
        assert.ok(!/[{}]/.test(outsideMerge(text)), `${where} has a brace outside a {{merge}} token`);
      }
      assert.notEqual(e.stage, 'review_referral', `${c.name}: ${e.id}`);
    }
  }
  const src = freshSource();
  assert.ok(!src.stages.some((s) => s.id === 'review_referral'));
  assert.ok(!src.questions.some((q) => q.id === 'review_link'));
  assert.ok(!src.merge_fields.some((m) => m.name === 'review_link'));
});

test('W: a set scheduling link is printed in tp_recap A, objection_time B and last_touch C', () => {
  const url = 'https://book.example.test/sample';
  for (const [stage, variant] of [['tp_recap', 'A'], ['objection_time', 'B'], ['last_touch', 'C']]) {
    const e = library.composeOne({ procedureId: 'crown', stage, variant }, { schedule_link: url });
    assert.ok(e.body_text.includes(url), `crown ${stage} ${variant} prints the link`);
    const blank = library.composeOne({ procedureId: 'crown', stage, variant }, {});
    assert.ok(!blank.body_text.includes('book.example.test'), `crown ${stage} ${variant} blank: no link`);
    assert.ok(!/book online/i.test(blank.body_text), `crown ${stage} ${variant} blank: no online-booking sentence`);
  }
});

test('W: the retired saved key list is review_link only, and none of it is an answer key', () => {
  assert.deepEqual([...contract.EMAIL_LIBRARY_RETIRED_SAVED_KEYS], ['review_link']);
  for (const k of contract.EMAIL_LIBRARY_RETIRED_SAVED_KEYS) assert.ok(!contract.EMAIL_LIBRARY_ANSWER_KEYS.includes(k), k);
  assert.deepEqual([...contract.EMAIL_LIBRARY_MERGE_SETTINGS], ['schedule_link', 'doctor_name']);
});

// ── EL-1c: library 1.3.0 (the doctor's clinical review) ─────────────────────

/** Every printed part of an email. */
const printed = (e) => `${e.subject}\n${e.preheader}\n${e.body_text}`;
const PARENT_PROCEDURES = ['sealants', 'pediatric_restorative', 'space_maintainer', 'frenectomy', 'early_ortho'];

test('EL-1c: the four 1.3.0 golden cases reproduce, with no slot, stray brace, review stage or review link', () => {
  assert.equal(golden.library_version, '1.3.0');
  assert.deepEqual(
    golden.cases.map((c) => [c.name, c.email_count]),
    [['blank', 1872], ['beau_offices', 1872], ['no_insurance_minimal', 1638], ['links_set', 1872]],
  );
  for (const c of golden.cases) {
    const out = compose(freshSource(), c.answers);
    assert.equal(sha(JSON.stringify(out)), c.output_sha256, `${c.name}: output hash`);
    assert.equal(out.length, c.email_count, `${c.name}: email count`);
    for (const e of out) {
      const text = printed(e);
      assert.ok(!text.includes('[['), `${c.name}: ${e.id} has a [[ slot left`);
      assert.ok(!/[{}]/.test(outsideMerge(text)), `${c.name}: ${e.id} has a brace outside a {{merge}} token`);
      assert.ok(!text.includes('{{review_link}}'), `${c.name}: ${e.id} prints {{review_link}}`);
      assert.notEqual(e.stage, 'review_referral', `${c.name}: ${e.id}`);
    }
  }
});

test('EL-1c: the source is 1.3.0 with 36 procedures, 18 stages, 54 frames, 27 questions and 36 rules', () => {
  const src = freshSource();
  assert.equal(src.version, '1.3.0');
  assert.equal(src.procedure_blocks.length, 36);
  assert.equal(src.stages.length, 18);
  assert.equal(src.frames.length, 54);
  assert.equal(src.questions.length, 27);
  assert.equal(src.rules.length, 36);
  for (const g of ['NEW_PT_WELCOME', 'WHITENING_TOUCHUP', 'RELAX_KIDS', 'COMFORT_LIST_KIDS']) assert.ok(g in src.globals, g);
  // 17 rules rewrite a block's FAQ, each with a list of [question, answer]
  // pairs: 11 for same_day_crowns / no_insurance, 3 for parent_in_room, 3 for
  // sleep_test. (The slice brief said 11; the source says 17.)
  const faqRules = src.rules.filter((r) => r.field === 'faq');
  assert.equal(faqRules.length, 17);
  for (const r of faqRules) assert.ok(r.text.every((p) => Array.isArray(p) && p.length === 2), JSON.stringify(r.when));
  assert.equal(faqRules.filter((r) => /^(parent_in_room|sleep_test)=/.test(r.when)).length, 6);
  const byId = Object.fromEntries(src.questions.map((q) => [q.id, q]));
  assert.equal(byId.surgical_guides.show_if, 'implant_surgery=in_house');
  assert.equal(byId.immediate_implants.show_if, 'implant_surgery=in_house');
});

test('EL-1c: a parent-audience email never offers adult sedation; an adult email does', () => {
  const out = compose(freshSource(), { sedation: ['nitrous', 'oral', 'iv'], sedation_kids: ['nitrous'] });
  const kids = out.filter((e) => PARENT_PROCEDURES.includes(e.procedure_id));
  assert.ok(kids.length > 0);
  assert.deepEqual([...new Set(kids.map((e) => e.audience))], ['parent']);
  for (const e of kids) {
    assert.ok(!/oral sedation/i.test(printed(e)), `${e.id} offers oral sedation`);
    assert.ok(!/IV sedation/i.test(printed(e)), `${e.id} offers IV sedation`);
  }
  const adult = out.filter((e) => e.audience !== 'parent' && /oral sedation/i.test(printed(e)) && /IV sedation/i.test(printed(e)));
  assert.ok(adult.length > 0, 'the adult wording still offers both');
});

test('EL-1c: with no insurance, no FAQ email talks about benefits or insurance maximums', () => {
  const phrase = /check your benefits|maximize your insurance/i;
  const faqs = (answers) => compose(freshSource(), answers).filter((e) => e.stage === 'faq');
  assert.ok(faqs({}).some((e) => phrase.test(printed(e))), 'control: the standard wording does say it');
  for (const e of faqs({ insurance_mode: 'no_insurance' })) assert.ok(!phrase.test(printed(e)), e.id);
});

test('EL-1c: parent_in_room and sleep_test rewrite the FAQ answers (array rule text)', () => {
  const peds = (a) => library.composeOne({ procedureId: 'pediatric_restorative', stage: 'faq', variant: 'B' }, a).body_text;
  assert.ok(peds({ parent_in_room: 'child_first' }).includes('come get you'));
  assert.ok(!peds({}).includes('come get you'), 'control: not without the answer');
  const sleep = (a) => library.composeOne({ procedureId: 'sleep_appliance', stage: 'faq', variant: 'B' }, a).body_text;
  assert.ok(sleep({ sleep_test: 'home_test' }).includes('home sleep test'));
});

test('EL-1c: the validator refuses a bad value for each new question class', () => {
  const C = contract.EMAIL_LIBRARY_ANSWER_CODES;
  const cases = [
    [{ parent_in_room: 'maybe' }, C.BAD_OPTION, 'parent_in_room'],
    [{ sleep_test: 'lab' }, C.BAD_OPTION, 'sleep_test'],
    [{ sedation_kids: ['spa'] }, C.BAD_OPTION, 'sedation_kids'],
    [{ new_patient_welcome: ['pony'] }, C.BAD_OPTION, 'new_patient_welcome'],
    [{ surgical_guides: 'yes' }, C.NOT_BOOLEAN, 'surgical_guides'],
    [{ immediate_implants: 1 }, C.NOT_BOOLEAN, 'immediate_implants'],
  ];
  for (const [answers, code, key] of cases) {
    const v = contract.validateEmailLibraryAnswers(answers);
    assert.equal(v.ok, false, JSON.stringify(answers));
    assert.equal(v.code, code, JSON.stringify(answers));
    assert.equal(v.key, key);
  }
  const ok = contract.validateEmailLibraryAnswers({
    surgical_guides: true,
    immediate_implants: false,
    new_patient_welcome: ['tour', 'xrays', 'tour'],
    sedation_kids: ['nitrous'],
    parent_in_room: 'child_first',
    sleep_test: 'home_test',
  });
  assert.equal(ok.ok, true);
  // A list keeps the source's option order with duplicates collapsed, as sedation does.
  assert.deepEqual(ok.answers.new_patient_welcome, ['xrays', 'tour']);
  for (const k of ['office_name', 'office_phone']) {
    assert.equal(contract.validateEmailLibraryAnswers({ [k]: 'x' }).code, C.OFFICE_FIELD, k);
  }
});
