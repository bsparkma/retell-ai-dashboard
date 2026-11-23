'use strict';

/**
 * compose(source, answers) — the TC patient email library's ONE composer (EL-1).
 *
 * A CommonJS port of the handoff compose.js (pm-prompts/email-library), and
 * BEHAVIOR-IDENTICAL to it: every function body below is the handoff's, line for
 * line. Only the wrapper changed (a UMD IIFE became module.exports). The proof is
 * the golden test: for every case in __fixtures__/golden.json,
 * sha256(JSON.stringify(compose(source, answers))) must equal the recorded hash.
 * If you change a character here, that test tells you whether the output moved.
 *
 * What it does: for each procedure block not switched off by `services_off`, and
 * each stage frame that block does not skip, fill the frame's `[[TOKENS]]` from
 * the block (after the office's rules rewrite it) and the office's globals. The
 * result keeps the `{{merge_fields}}` (first_name, office_name, ...) UNRESOLVED;
 * resolving them is the caller's job (routes/tc/emailLibrary.js preview).
 *
 * Pure: no I/O, no clock, no randomness, no patient data. Never mutates
 * `source` (blockFor deep-copies each block before rewriting it).
 */

function listPhrase(items) {
  if (items.length < 2) return items.join("");
  if (items.length === 2) return items[0] + " and " + items[1];
  return items.slice(0, -1).join(", ") + ", and " + items[items.length - 1];
}
function answerOf(src, ans, key) {
  const q = src.questions.find(x => x.id === key);
  let v = ans[key];
  if (v === undefined || v === null || v === "") v = q && q.default != null ? q.default : (q && (q.type === "multi" || q.type === "procedures") ? [] : "");
  return v;
}
function test(src, ans, cond) {
  if (!cond) return true;
  const neg = cond[0] === "!";
  const c = neg ? cond.slice(1) : cond;
  const [key, want] = c.split("=");
  const v = answerOf(src, ans, key);
  let ok;
  if (want !== undefined) ok = v === want;
  else if (Array.isArray(v)) ok = v.length > 0;
  else ok = v === true || (typeof v === "string" && v.trim() !== "" && v !== "no");
  return neg ? !ok : ok;
}
function interp(src, ans, text) {
  return text.replace(/\{(\w+)\}/g, (m, key) => {
    const q = src.questions.find(x => x.id === key);
    if (!q) return m;
    const v = answerOf(src, ans, key);
    if (Array.isArray(v)) return listPhrase(q.options.filter(o => v.includes(o.value)).map(o => o.phrase || o.label));
    return String(v).trim();
  });
}
function blockFor(src, ans, proc) {
  const b = JSON.parse(JSON.stringify(proc));
  for (const r of src.rules) {
    if (!r.procedures.includes(b.id) || !test(src, ans, r.when)) continue;
    const ip = t => (Array.isArray(t) ? t.map(ip) : interp(src, ans, t));
    const val = ip(r.text);
    if (r.mode === "replace") b[r.field] = val;
    else if (Array.isArray(b[r.field])) b[r.field] = b[r.field].concat(val);
    else b[r.field] = b[r.field] + " " + val;
  }
  return b;
}
function globalsFor(src, ans) {
  const g = {};
  for (const [name, def] of Object.entries(src.globals))
    g[name] = def.parts.filter(p => test(src, ans, p.when)).map(p => interp(src, ans, p.text)).join(def.join);
  return g;
}
const bul = items => items.map(i => "- " + i).join("\n");
function fill(text, b, g) {
  const parent = b.audience === "parent";
  const t = Object.assign({
    YOURS: b.yours, THE: b.the, WHAT: b.what, BENEFIT: b.benefit, WAIT: b.wait, VISIT: b.visit,
    COMFORT: b.comfort, PREP: bul(b.prep), AFTERCARE: bul(b.aftercare), NORMAL: b.normal, OUTCOME: b.outcome,
    WHOSE: parent ? "your child's" : "your", WHOM: parent ? "your child" : "you",
    HOW_FEELING: parent ? "How is your child doing?" : "How are you feeling?",
  }, g);
  if (parent) for (const k of Object.keys(g)) if (k.endsWith("_KIDS")) t[k.slice(0, -5)] = g[k];
  b.faq.forEach((qa, i) => { t["Q" + (i + 1)] = qa[0]; t["A" + (i + 1)] = qa[1]; });
  let out = text;
  for (let pass = 0; pass < 2; pass++) out = out.replace(/\[\[(\w+)\]\]/g, (m, k) => (k in t ? t[k] : m));
  return out.replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function compose(src, ans) {
  ans = ans || {};
  const g = globalsFor(src, ans);
  const stagesOff = new Set();
  for (const r of src.stage_rules) if (test(src, ans, r.when)) r.stages_off.forEach(s => stagesOff.add(s));
  const off = new Set(answerOf(src, ans, "services_off"));
  const stage = Object.fromEntries(src.stages.map(s => [s.id, s]));
  const out = [];
  for (const proc of src.procedure_blocks) {
    if (off.has(proc.id)) continue;
    const b = blockFor(src, ans, proc);
    for (const f of src.frames) {
      if (b.skip.includes(f.stage) || stagesOff.has(f.stage)) continue;
      const body = fill(f.body, b, g) + "\n\n{{sender_name}}\n{{office_name}}\n{{office_phone}}";
      const subject = fill(f.subject, b, g), preheader = fill(f.preheader, b, g);
      out.push({
        id: b.id + "." + f.stage + "." + f.variant, procedure_id: b.id, procedure_name: b.name,
        category: b.category, audience: b.audience, stage: f.stage, stage_label: stage[f.stage].label,
        phase: stage[f.stage].phase, variant: f.variant, tone: src.variants[f.variant],
        subject, preheader, body_text: body,
        merge_fields: [...new Set((subject + preheader + body).match(/\{\{\w+\}\}/g) || [])].map(m => m.slice(2, -2)).sort(),
        suggested_asset: b.asset, word_count: body.split(/\s+/).length,
      });
    }
  }
  return out;
}

module.exports = { compose };
