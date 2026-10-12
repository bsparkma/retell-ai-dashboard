#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Karen eval set — Stage 1 inventory (READ-ONLY).
 *
 * Lists the after-hours agent's (Karen's) calls over the last N days and writes a
 * PHI-free inventory to tools/karen-eval/out/ (gitignored):
 *
 *   call_id, office, did_office, start (ISO), duration_s, disconnection_reason, label
 *
 * Nothing else about a call is written anywhere. Transcripts are held in memory only
 * long enough to be labelled and are never written to disk or printed.
 *
 * Data paths, and why each is the one it is:
 *   - Call list: POST /v3/list-calls. The legacy /v2/list-calls was removed 2026-06-15.
 *     v3 rows carry no transcript, so each call is hydrated via GET /v2/get-call/{id}
 *     (the only get-call path that answers; /v3/get-call 404s).
 *   - Office: backend/config/officeAgents.js — the same server-side derivation the app
 *     uses. For a Retell call that is agent → office (AGENT_OFFICE). The called DID is
 *     ALSO looked up in MANGO_LINE_OFFICE and reported separately as `did_office`, so a
 *     DID that isn't in the line map shows up as 'unmapped' instead of being guessed.
 *   - Labels: Azure OpenAI ONLY (Microsoft BAA). No other AI provider sees transcript
 *     text. The model is constrained to a closed label set by a JSON schema, and a reply
 *     outside that set is recorded as a failure — never coerced to 'other'.
 *   - Secrets: Retell key read from Key Vault in-process (never written, never printed).
 *     Azure OpenAI is called with an Entra token from the signed-in az CLI identity — no
 *     key at all. Nothing reads .env.
 *
 * It does NOT touch Open Dental, the call store, normalizeCall, ingestion, or Azure
 * Speech (so the transcription budget breaker is untouched).
 *
 * Usage (from repo root, after `cd backend && npm ci`):
 *   node tools/karen-eval/inventory.js [--days 60] [--no-label] [--limit-calls N]
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

// Resolve SDKs from backend/node_modules so this tool adds no dependencies of its own.
const backendRequire = createRequire(path.join(__dirname, '..', '..', 'backend', 'package.json'));
/** @type {typeof import('@azure/identity')} */
const identity = backendRequire('@azure/identity');
/** @type {typeof import('@azure/keyvault-secrets')} */
const keyvault = backendRequire('@azure/keyvault-secrets');
// The app's own office derivation. Typed here (rather than inferred) so this tool's
// strict typecheck doesn't pull the untyped-strict backend file into its program.
/**
 * @type {{
 *   MANGO_LINE_OFFICE: Record<string, string>,
 *   normalizeE164: (n: string | undefined) => string | null,
 *   getOfficeForCall: (call: { source: string, handler_id: string }) => string,
 * }}
 */
const officeAgents = backendRequire('./config/officeAgents');

// ── Config (all non-secret) ───────────────────────────────────────────────────────

const KAREN_AGENT_ID = 'agent_d1f762efc57db01475ad0579e8';
const AZURE_SUBSCRIPTION = 'Azure subscription 1';
const RETELL_KEY_VAULT = 'kv-carein-core';
const RETELL_KEY_SECRET = 'retell-api-key';
const RETELL_BASE = 'https://api.retellai.com';
// Production calls are labelled by the PRODUCTION Azure OpenAI resource.
const OAI_ENDPOINT = 'https://oai-carein-prod.openai.azure.com';
const OAI_DEPLOYMENT = 'gpt-5.4-mini';
const OAI_API_VERSION = '2024-10-21';
const OAI_SCOPE = 'https://cognitiveservices.azure.com/.default';
const REPORT_TZ = 'America/Chicago';

/** Closed label set. Order is the display order of the summary table. */
const LABELS = /** @type {const} */ ([
  'new-patient',
  'existing-appointment',
  'emergency/red-flag',
  'billing/insurance',
  'wrong-number/spam',
  'transfer-request',
  'other',
]);
/** @typedef {typeof LABELS[number]} Label */

// Calls shorter than this are counted but never offered as candidates: a hang-up in
// the greeting has nothing to test against.
const CANDIDATE_MIN_SECONDS = 20;
const CANDIDATES_PER_TYPE_MIN = 3;
const CANDIDATES_PER_TYPE_MAX = 4;
const CANDIDATES_TOTAL_TARGET = 25;
// Transcript characters sent for labelling. The call type is settled early in a call.
const TRANSCRIPT_CHAR_CAP = 12000;
const CONCURRENCY = 4;

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * The ONLY fields this tool records about a call.
 * @typedef {Object} InventoryRow
 * @property {string} call_id
 * @property {string} office          officeAgents.getOfficeForCall (agent → office)
 * @property {string} did_office      MANGO_LINE_OFFICE lookup of the called DID, or 'unmapped'
 * @property {string} start           ISO 8601, UTC
 * @property {number} duration_s
 * @property {string} disconnection_reason
 * @property {Label | null} label
 * @property {'labelled' | 'no_transcript' | 'label_failed' | 'skipped'} label_status
 */

/**
 * The subset of a v3 list-calls item this tool reads.
 * @typedef {Object} ListedCall
 * @property {string} call_id
 * @property {string} agent_id
 * @property {string} call_type
 * @property {string | undefined} direction
 * @property {string | undefined} to_number
 * @property {number | undefined} start_timestamp
 * @property {number | undefined} end_timestamp
 * @property {number | undefined} duration_ms
 * @property {string | undefined} disconnection_reason
 */

// ── Small helpers ───────────────────────────────────────────────────────────────

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v @returns {string | undefined} */
const str = (v) => (typeof v === 'string' && v !== '' ? v : undefined);
/** @param {unknown} v @returns {number | undefined} */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @param {string} name */
  const value = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const days = Number(value('--days') ?? 60);
  const limitCalls = value('--limit-calls');
  if (!Number.isInteger(days) || days <= 0) throw new Error('--days must be a positive integer');
  return {
    days,
    label: !argv.includes('--no-label'),
    limitCalls: limitCalls === undefined ? Infinity : Number(limitCalls),
  };
}

/**
 * fetch with retry on 429/5xx. Error messages carry status and path only — never a
 * response body, which for get-call would be a transcript.
 * @param {string} url
 * @param {RequestInit} init
 * @param {string} what  label for errors (no PHI)
 * @returns {Promise<unknown>}
 */
async function fetchJson(url, init, what) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 5) {
      throw new Error(`${what} failed: HTTP ${res.status}`);
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
  }
}

/**
 * Run `fn` over `items` with bounded concurrency, preserving order.
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapPool(items, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

// ── Azure auth + secrets ────────────────────────────────────────────────────────

/**
 * az CLI credential pinned to the CareIN SUBSCRIPTION. Not `tenantId`: this machine's
 * CLI holds more than one signed-in account, and `--tenant` picks the wrong one
 * (AADSTS50020), while `--subscription` selects the account that owns it. Without
 * either, the default subscription is the wrong tenant (AKV10032 "Invalid issuer").
 */
function careinCredential() {
  const cli = new identity.AzureCliCredential({ subscription: AZURE_SUBSCRIPTION });
  // Key Vault's challenge auth passes the vault's tenantId per request, and az refuses
  // `--subscription` with `--tenant` together. The subscription already pins the tenant.
  /** @type {import('@azure/identity').TokenCredential} */
  const credential = {
    getToken: (scopes, options) => cli.getToken(scopes, { ...options, tenantId: undefined }),
  };
  return credential;
}

/** @param {import('@azure/identity').TokenCredential} credential */
async function readRetellKey(credential) {
  const client = new keyvault.SecretClient(`https://${RETELL_KEY_VAULT}.vault.azure.net`, credential);
  const secret = await client.getSecret(RETELL_KEY_SECRET);
  if (!secret.value) throw new Error(`Key Vault secret ${RETELL_KEY_VAULT}/${RETELL_KEY_SECRET} is empty`);
  return secret.value;
}

// ── Retell ──────────────────────────────────────────────────────────────────────

/** @param {unknown} raw @returns {ListedCall | null} */
function toListedCall(raw) {
  if (!isRecord(raw)) return null;
  const callId = str(raw.call_id);
  const agentId = str(raw.agent_id);
  if (!callId || !agentId) return null;
  return {
    call_id: callId,
    agent_id: agentId,
    call_type: str(raw.call_type) ?? 'unknown',
    direction: str(raw.direction),
    to_number: str(raw.to_number),
    start_timestamp: num(raw.start_timestamp),
    end_timestamp: num(raw.end_timestamp),
    duration_ms: num(raw.duration_ms),
    disconnection_reason: str(raw.disconnection_reason),
  };
}

/**
 * Every Karen call that started in [sinceMs, now], via POST /v3/list-calls.
 * @param {string} apiKey
 * @param {number} sinceMs
 */
async function listKarenCalls(apiKey, sinceMs) {
  /** @type {ListedCall[]} */
  const calls = [];
  /** @type {string | null} */
  let paginationKey = null;
  for (let page = 0; page < 50; page++) {
    /** @type {Record<string, unknown>} */
    const body = {
      filter_criteria: {
        agent: [{ agent_id: KAREN_AGENT_ID }],
        start_timestamp: { type: 'range', op: 'bt', value: [sinceMs, Date.now()] },
      },
      sort_order: 'descending',
      limit: 1000,
    };
    // skip and pagination_key are mutually exclusive in v3; this never sends skip.
    if (paginationKey) body.pagination_key = paginationKey;
    const res = await fetchJson(
      `${RETELL_BASE}/v3/list-calls`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      'Retell POST /v3/list-calls'
    );
    if (!isRecord(res) || !Array.isArray(res.items)) {
      throw new Error('Retell POST /v3/list-calls returned an unexpected shape (expected { items: [...] })');
    }
    for (const item of res.items) {
      const call = toListedCall(item);
      if (call) calls.push(call);
    }
    paginationKey = str(res.pagination_key) ?? null;
    if (!res.has_more || !paginationKey) return calls;
  }
  throw new Error('Retell list-calls exceeded 50 pages — refusing to report a partial inventory');
}

/**
 * Transcript text for one call via GET /v2/get-call/{id}. Returned to the caller and
 * nowhere else — this function neither logs nor stores it.
 * @param {string} apiKey
 * @param {string} callId
 * @returns {Promise<string>}
 */
async function fetchTranscript(apiKey, callId) {
  const res = await fetchJson(
    `${RETELL_BASE}/v2/get-call/${encodeURIComponent(callId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    `Retell GET /v2/get-call/${callId}`
  );
  return isRecord(res) ? (str(res.transcript) ?? '') : '';
}

// ── Azure OpenAI labelling ──────────────────────────────────────────────────────

const LABEL_SYSTEM_PROMPT = [
  'You classify transcripts of calls answered by an AFTER-HOURS AI receptionist ("Agent")',
  'for a dental practice. Choose the ONE label that best describes why the caller called:',
  '',
  '- new-patient: caller is not yet a patient and wants to become one / book a first visit.',
  '- existing-appointment: an existing patient about an appointment — schedule, reschedule,',
  '  cancel, confirm, or check a time.',
  '- emergency/red-flag: pain, swelling, bleeding, trauma, broken tooth, infection, or any',
  '  urgent clinical concern.',
  '- billing/insurance: bills, balances, payments, insurance coverage or in-network questions.',
  '- wrong-number/spam: wrong number, robocall, sales/solicitor, silence, or no real request.',
  '- transfer-request: the main ask is to reach a live person / the doctor / the office.',
  '- other: anything else (hours, location, vendors/labs, records, general questions).',
  '',
  'If several apply, pick the caller\'s primary reason; an urgent clinical concern wins.',
  'Reply ONLY with the JSON object required by the schema. Do not quote the transcript.',
].join('\n');

const LABEL_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'call_label',
    strict: true,
    schema: {
      type: 'object',
      properties: { label: { type: 'string', enum: [...LABELS] } },
      required: ['label'],
      additionalProperties: false,
    },
  },
};

/** @param {unknown} v @returns {v is Label} */
const isLabel = (v) => typeof v === 'string' && /** @type {readonly string[]} */ (LABELS).includes(v);

/**
 * @param {import('@azure/identity').TokenCredential} credential
 * @param {string} transcript
 * @returns {Promise<Label>}
 */
async function labelTranscript(credential, transcript) {
  const token = await credential.getToken(OAI_SCOPE);
  if (!token) throw new Error('No Entra token for Azure OpenAI');
  const res = await fetchJson(
    `${OAI_ENDPOINT}/openai/deployments/${OAI_DEPLOYMENT}/chat/completions?api-version=${OAI_API_VERSION}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: LABEL_SYSTEM_PROMPT },
          { role: 'user', content: transcript.slice(0, TRANSCRIPT_CHAR_CAP) },
        ],
        response_format: LABEL_RESPONSE_FORMAT,
        // gpt-5.4-mini: max_completion_tokens (not max_tokens), default temperature.
        // Reasoning tokens count against this, hence the headroom over a one-word answer.
        max_completion_tokens: 2000,
      }),
    },
    'Azure OpenAI chat/completions'
  );
  const content =
    isRecord(res) && Array.isArray(res.choices) && isRecord(res.choices[0]) && isRecord(res.choices[0].message)
      ? res.choices[0].message.content
      : undefined;
  if (typeof content !== 'string') throw new Error('Azure OpenAI returned no message content');
  /** @type {unknown} */
  const parsed = JSON.parse(content);
  const label = isRecord(parsed) ? parsed.label : undefined;
  if (!isLabel(label)) throw new Error('Azure OpenAI returned a label outside the closed set');
  return label;
}

/** Fail fast (before any transcript is fetched) if Azure OpenAI won't accept us. */
/** @param {import('@azure/identity').TokenCredential} credential */
async function preflightAzureOpenAI(credential) {
  try {
    await labelTranscript(credential, 'Agent: Hello, this is the office.\nUser: Sorry, wrong number.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Azure OpenAI preflight failed (${msg}). The signed-in az identity likely lacks ` +
        `"Cognitive Services OpenAI User" on ${OAI_ENDPOINT}. Re-run with --no-label to ` +
        'inventory without labels.'
    );
  }
}

// ── Candidate selection ─────────────────────────────────────────────────────────

/**
 * Pick up to `quota` calls with the widest spread of outcome and length: each pick
 * prefers a disconnection_reason not yet picked, then the duration farthest (in log
 * space) from those already picked. Seeded with the median-length call. Deterministic.
 * @param {InventoryRow[]} rows
 * @param {number} quota
 */
function pickVaried(rows, quota) {
  const pool = rows
    .filter((r) => r.duration_s >= CANDIDATE_MIN_SECONDS)
    .sort((a, b) => a.duration_s - b.duration_s || a.call_id.localeCompare(b.call_id));
  if (pool.length <= quota) return pool;
  /** @type {InventoryRow[]} */
  const picked = [pool[Math.floor(pool.length / 2)]];
  /** @param {InventoryRow} r */
  const logLen = (r) => Math.log(r.duration_s);
  while (picked.length < quota) {
    const reasons = new Set(picked.map((p) => p.disconnection_reason));
    let best = /** @type {InventoryRow | null} */ (null);
    let bestScore = -Infinity;
    for (const r of pool) {
      if (picked.includes(r)) continue;
      const spread = Math.min(...picked.map((p) => Math.abs(logLen(p) - logLen(r))));
      const score = (reasons.has(r.disconnection_reason) ? 0 : 100) + spread;
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    if (!best) break;
    picked.push(best);
  }
  return picked.sort((a, b) => a.duration_s - b.duration_s);
}

/**
 * Per-label quotas: everyone gets CANDIDATES_PER_TYPE_MIN, then the most common labels
 * get one more each until the total target is reached.
 * @param {Map<Label, InventoryRow[]>} byLabel
 */
function candidateQuotas(byLabel) {
  /** @type {Map<Label, number>} */
  const quotas = new Map();
  for (const label of LABELS) quotas.set(label, CANDIDATES_PER_TYPE_MIN);
  let total = LABELS.length * CANDIDATES_PER_TYPE_MIN;
  const byCount = [...LABELS].sort((a, b) => (byLabel.get(b)?.length ?? 0) - (byLabel.get(a)?.length ?? 0));
  for (const label of byCount) {
    if (total >= CANDIDATES_TOTAL_TARGET) break;
    quotas.set(label, CANDIDATES_PER_TYPE_MAX);
    total++;
  }
  return quotas;
}

// ── Report ──────────────────────────────────────────────────────────────────────

/** @param {InventoryRow} r */
const localStart = (r) =>
  new Date(r.start).toLocaleString('en-US', { timeZone: REPORT_TZ, dateStyle: 'short', timeStyle: 'short' });

/**
 * @param {InventoryRow[]} rows
 * @param {{ days: number, since: string, excluded: Record<string, number>, labelled: boolean }} meta
 */
function renderSummary(rows, meta) {
  const offices = [...new Set(rows.map((r) => r.office))].sort();
  const columns = [...LABELS, '(unlabelled)'];
  /** @param {InventoryRow} r */
  const col = (r) => r.label ?? '(unlabelled)';

  const lines = [];
  lines.push(`# Karen eval set — Stage 1 inventory`, '');
  lines.push(`Agent \`${KAREN_AGENT_ID}\`, inbound phone calls since ${meta.since} (${meta.days} days).`);
  lines.push(`Generated ${new Date().toISOString()}. Call ids and labels only — no transcript text.`, '');

  lines.push('## Counts per type per office', '');
  lines.push(`| office | ${columns.join(' | ')} | total |`);
  lines.push(`| --- | ${columns.map(() => '---:').join(' | ')} | ---: |`);
  for (const office of [...offices, 'ALL']) {
    const inOffice = office === 'ALL' ? rows : rows.filter((r) => r.office === office);
    const cells = columns.map((c) => String(inOffice.filter((r) => col(r) === c).length));
    lines.push(`| ${office} | ${cells.join(' | ')} | ${inOffice.length} |`);
  }
  lines.push('');

  const didOffices = [...new Set(rows.map((r) => r.did_office))].sort();
  lines.push(`Office via the agent map (\`getOfficeForCall\`): ${offices.join(', ') || '—'}. ` +
    `Office via the DID line map (\`MANGO_LINE_OFFICE\`): ${didOffices.join(', ') || '—'}.`, '');

  const statuses = rows.reduce((/** @type {Record<string, number>} */ acc, r) => {
    acc[r.label_status] = (acc[r.label_status] ?? 0) + 1;
    return acc;
  }, {});
  lines.push(`Label status: ${Object.entries(statuses).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
  const excluded = Object.entries(meta.excluded).filter(([, v]) => v > 0);
  if (excluded.length) lines.push(`Excluded before counting: ${excluded.map(([k, v]) => `${k} ${v}`).join(', ')}.`);
  lines.push('');

  if (meta.labelled) {
    /** @type {Map<Label, InventoryRow[]>} */
    const byLabel = new Map();
    for (const label of LABELS) byLabel.set(label, rows.filter((r) => r.label === label));
    const quotas = candidateQuotas(byLabel);
    lines.push(`## Candidates (≥${CANDIDATE_MIN_SECONDS}s, varied by outcome and length)`, '');
    lines.push('| type | call_id | office | start (CT) | duration | disconnection_reason |');
    lines.push('| --- | --- | --- | --- | ---: | --- |');
    let total = 0;
    for (const label of LABELS) {
      const picks = pickVaried(byLabel.get(label) ?? [], quotas.get(label) ?? CANDIDATES_PER_TYPE_MIN);
      if (picks.length === 0) lines.push(`| ${label} | _none ≥${CANDIDATE_MIN_SECONDS}s_ | | | | |`);
      for (const r of picks) {
        lines.push(`| ${label} | \`${r.call_id}\` | ${r.office} | ${localStart(r)} | ${r.duration_s}s | ${r.disconnection_reason} |`);
        total++;
      }
    }
    lines.push('', `${total} candidates.`);
  }
  return lines.join('\n') + '\n';
}

/** @param {InventoryRow[]} rows */
function renderCsv(rows) {
  const header = ['call_id', 'office', 'did_office', 'start', 'duration_s', 'disconnection_reason', 'label', 'label_status'];
  /** @param {unknown} v */
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.join(','), ...rows.map((r) => header.map((h) => cell(r[/** @type {keyof InventoryRow} */ (h)])).join(','))].join('\n') + '\n';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const since = Date.now() - args.days * 24 * 60 * 60 * 1000;

  const credential = careinCredential();
  if (args.label) await preflightAzureOpenAI(credential);
  const retellKey = await readRetellKey(credential);

  const listed = await listKarenCalls(retellKey, since);
  /** @type {Record<string, number>} */
  const excluded = { 'web/test calls': 0, outbound: 0, 'other agent (filter leak)': 0, 'outside window': 0 };
  const calls = listed.filter((c) => {
    if (c.agent_id !== KAREN_AGENT_ID) return (excluded['other agent (filter leak)']++, false);
    if (c.call_type !== 'phone_call') return (excluded['web/test calls']++, false);
    if (c.direction !== 'inbound') return (excluded.outbound++, false);
    if (c.start_timestamp === undefined || c.start_timestamp < since) return (excluded['outside window']++, false);
    return true;
  }).slice(0, args.limitCalls);
  console.log(`Listed ${listed.length} Karen calls; ${calls.length} inbound phone calls in window.`);

  let done = 0;
  const rows = await mapPool(calls, async (c) => {
    const lineOffice = officeAgents.MANGO_LINE_OFFICE[officeAgents.normalizeE164(c.to_number) ?? ''];
    const durationMs = c.duration_ms ?? (c.end_timestamp && c.start_timestamp ? c.end_timestamp - c.start_timestamp : 0);
    /** @type {InventoryRow} */
    const row = {
      call_id: c.call_id,
      office: officeAgents.getOfficeForCall({ source: 'retell', handler_id: c.agent_id }),
      did_office: lineOffice ?? 'unmapped',
      start: new Date(c.start_timestamp ?? 0).toISOString(),
      duration_s: Math.round(durationMs / 1000),
      disconnection_reason: c.disconnection_reason ?? 'unknown',
      label: null,
      label_status: 'skipped',
    };
    if (args.label) {
      try {
        const transcript = await fetchTranscript(retellKey, c.call_id);
        if (transcript.trim() === '') {
          row.label_status = 'no_transcript';
        } else {
          row.label = await labelTranscript(credential, transcript);
          row.label_status = 'labelled';
        }
      } catch (err) {
        row.label_status = 'label_failed';
        console.warn(`  ${c.call_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (++done % 25 === 0) console.log(`  ${done}/${calls.length}`);
    return row;
  });

  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const summary = renderSummary(rows, {
    days: args.days,
    since: new Date(since).toISOString().slice(0, 10),
    excluded,
    labelled: args.label,
  });
  fs.writeFileSync(path.join(outDir, `inventory-${stamp}.json`), JSON.stringify(rows, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, `inventory-${stamp}.csv`), renderCsv(rows));
  fs.writeFileSync(path.join(outDir, `summary-${stamp}.md`), summary);
  console.log('\n' + summary);
  console.log(`Wrote ${path.relative(process.cwd(), outDir)}/{inventory,summary}-${stamp}.*`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`inventory failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}

module.exports = { pickVaried, candidateQuotas, toListedCall, LABELS };
