// Office ↔ agent configuration (REAL mapping — not demo config).
//
// Every inbound call is routed to exactly one office by looking up the Retell
// agent that handled it. On stored unified calls the agent id lives in
// `handler_id` (a.k.a. `agent_id` on some raw shapes), so we key on both.
//
// Current reality is single-office: everything belongs to **Roland**. Valley
// Fort Smith is defined but has NO agents mapped yet — it must render as an
// empty worklist, NOT a copy of Roland's calls. When Valley goes live, adding it is
// literally ONE line: map its agent id to 'valley' in AGENT_OFFICE below.
//
// Agent ids below were discovered from the live call store (data/unified_calls.json,
// 1,333 calls) on 2026-07-20. Any agent id NOT listed here — and any call with no
// agent id at all — falls back to FALLBACK_OFFICE (Roland) and is logged once as a
// warning, so a genuinely new/Valley agent surfacing gets noticed.

/**
 * @typedef {Object} OfficeConfig
 *
 * Deliberately carries NO `odConnected` flag. It used to, and
 * backend/routes/tc/od.js was its last reader: TC reached Open Dental through the
 * single process-wide client, so it needed a switch it could hold OFF for valley
 * while the voice module's own switch (odOffices.OFFICE_OD_SETTINGS[].odEnabled)
 * was ON. TC now resolves its client PER OFFICE through config/odOffices like
 * everything else, so the second flag gated nothing — and a boolean claiming
 * valley is "not OD connected" while valley reads its own Open Dental every day is
 * worse than no boolean at all. Ask `odOffices.isOdReady(officeKey)`, or
 * `odOffices.describeOffice(officeKey)` for the UI shape: both report intent AND
 * credentials, per office.
 *
 * @property {string}  officeId     stable id used in the office_id query param
 * @property {string}  officeName   display name for the office selector
 */

// Internal office KEYS (roland / valley / unknown) are FROZEN identifiers used in
// the office_id query param, the line map, and stored calls — never rename them.
// Display LABELS (officeName) are separate and may change freely. Note: internal
// key 'valley' IS the Fort Smith "Riley" office (historical name); the key stays
// frozen even though the office is branded/known as Riley.
/** @type {Record<string, OfficeConfig>} */
const OFFICES = {
  roland: { officeId: 'roland', officeName: 'Roland' },
  valley: { officeId: 'valley', officeName: 'Valley Fort Smith' },
  // Bucket for Mango calls whose called line isn't in MANGO_LINE_OFFICE yet. These
  // still ingest and stay triageable; the UI surfaces the raw line so an admin can
  // see which number to add. It has no OFFICE_OD_SETTINGS entry, so odOffices
  // refuses it with OFFICE_UNKNOWN — there is no OD path of any kind.
  unknown: { officeId: 'unknown', officeName: 'Unmapped' },
};

// The office any unmapped Retell agent (or a call with no agent id) belongs to today.
// NOTE: this is the RETELL fallback only. Unmapped Mango LINES go to UNMAPPED_OFFICE
// ('unknown'), NOT here — an unknown DID must never be silently attributed to Roland.
const FALLBACK_OFFICE = 'roland';

// Where an unmapped Mango line lands. Honest 'unknown' instead of a silent Roland.
const UNMAPPED_OFFICE = 'unknown';

/**
 * Retell agent_id → officeId. Add a Valley agent later = ONE entry here.
 * Comment on each line is the agent's display name at discovery time.
 * @type {Record<string, string>}
 */
const AGENT_OFFICE = {
  agent_3a7042b50e7c4775cd350f02b4: 'roland', // Phone attendant
  agent_d1f762efc57db01475ad0579e8: 'roland', // After Hours Demo (revised 4.29.26) / (copy)
  agent_063d7e3077f6dc708c54a19d20: 'roland', // After Hours Demo
  agent_89e8a68788e925aa506475393e: 'roland', // Charlie Jo (copy)
  agent_3007741dd93381f51675417edb: 'roland', // Charlie Jo
  agent_fab86b38f60a3561b16831bea8: 'roland', // Valley Family Dental by Ameer — see NOTE below
  agent_4a553eece68d214e364e85d4d4: 'roland', // Single-Prompt Agent
  agent_ace28f92effcafe7254c004713: 'roland', // Multi-State Agent
  agent_8494abf7556bfd9a4cf231a1a1: 'roland', // IV Outbound Agent (Bridge-it)
  // NOTE: "Valley Family Dental by Ameer" is a Valley-branded test agent but is
  // mapped to Roland for now per the single-office reality. When Valley's OD
  // connection lands (per-location slice), change its mapping to 'valley'.
};

// ── Mango (staff) line → office ──────────────────────────────────────────────
// Mango staff calls carry NO Retell agent id, so they can't be attributed by
// AGENT_OFFICE. Instead they're attributed by the office phone LINE that was
// called — the Mango `called_number` (DID), later also `pbx_uuid`. Keyed on the
// E.164-normalized number so formatting differences ((479) 555-0000 vs
// +14795550000) don't matter.
//
// Real office DIDs supplied by Beau. Keys are E.164-normalized. This is the single
// source of truth for line→office attribution — structured as DATA (an E.164→officeId
// table) precisely so a future office-management admin UI can edit the SAME object.
// Valley/Riley is OD-connected in its own right (odOffices.OFFICE_OD_SETTINGS.valley),
// so a line mapped here both attributes the call and gives it a chart path.
// Any called_number NOT here → UNMAPPED_OFFICE ('unknown') + warn-once (never Roland).
/** @type {Record<string, string>} E.164 DID → officeId (frozen internal key) */
const MANGO_LINE_OFFICE = {
  // Roland Family Dental
  '+19189134595': 'roland', // 918-913-4595
  '+19185036262': 'roland', // 918-503-6262 (main line)
  '+19183930353': 'roland', // 918-393-0353
  // Valley Family Dental — the Fort Smith "Riley" office (internal key 'valley' frozen)
  '+14797854390': 'valley', // 479-785-4390
  '+14793166111': 'valley', // 479-316-6111
  '+14797851419': 'valley', // 479-785-1419
  '+14792263500': 'valley', // 479-226-3500
  '+14797633344': 'valley', // 479-763-3344
};

/**
 * Normalize a phone number to canonical E.164 (+1XXXXXXXXXX for NANP). Best-effort:
 * 10 digits → +1XXXXXXXXXX; 11 digits starting with 1 → +1XXXXXXXXXX; already-+ →
 * digits re-wrapped. Returns null when there aren't enough digits to be a real line.
 * @param {string|number|null|undefined} number
 * @returns {string|null}
 */
const normalizeE164 = (number) => {
  if (number == null) return null;
  const digits = String(number).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 11) return `+${digits}`; // already includes a country code
  return null; // too short to be a usable line
};

// Remember which unmapped agent ids / Mango lines we've already warned about, so the
// fallback warning fires once per id per process instead of on every call.
const warnedUnmappedAgents = new Set();
const warnedUnmappedLines = new Set();

/**
 * Read the handling agent id off a call, tolerating both stored (`handler_id`)
 * and raw (`agent_id`) shapes.
 * @param {{ handler_id?: string, agent_id?: string|number }} call
 * @returns {string|null}
 */
const getAgentId = (call) => {
  const raw = call && (call.handler_id ?? call.agent_id);
  return raw != null && raw !== '' ? String(raw) : null;
};

/**
 * Resolve the office a call belongs to.
 *   - Mango (staff) calls: attributed by the office LINE that was called
 *     (E.164-normalized `called_number` → MANGO_LINE_OFFICE). Unmapped line →
 *     fallback office + warn once.
 *   - Retell (AI) calls: attributed by the handling agent (AGENT_OFFICE).
 *     Unmapped agent / agent-less → fallback office + warn once.
 * @param {{ source?: string, called_number?: string, handler_id?: string, agent_id?: string|number }} call
 * @returns {string} officeId
 */
const getOfficeForCall = (call) => {
  // A pruned record carries the office FROZEN at prune time. Re-deriving is not an
  // option: a stub has neither called_number nor handler_id, so every Mango stub
  // would fall to 'unknown' and every Retell stub to the Roland fallback — silently
  // reattributing pruned calls in the office-filtered views. Compared as a literal
  // rather than through services/callRetention.isStub because that module imports
  // THIS one, and a require cycle would be worse than one duplicated constant.
  if (call && call.record_kind === 'stub') {
    return call.office || UNMAPPED_OFFICE;
  }

  // The registry's lists when it is serving, else exactly the maps above (MT-1b).
  const { agentOffice, lineOffice } = servedMaps();

  // Mango staff calls have no Retell agent id — attribute by the called line.
  if (call && call.source === 'mango') {
    const line = normalizeE164(call.called_number);
    if (line && lineOffice[line]) {
      return lineOffice[line];
    }
    // Unmapped line → honest 'unknown' (NOT Roland). The call still ingests and is
    // triageable; the worklist surfaces the raw line so Beau can see which DID to add.
    const warnKey = line || '(no-line)';
    if (!warnedUnmappedLines.has(warnKey)) {
      warnedUnmappedLines.add(warnKey);
      console.warn(
        `[officeAgents] Unmapped Mango line '${warnKey}' — attributing to '${UNMAPPED_OFFICE}' ` +
        `(NOT Roland). Add its DID to MANGO_LINE_OFFICE to assign it to an office.`
      );
    }
    return UNMAPPED_OFFICE;
  }

  const agentId = getAgentId(call);
  if (agentId && agentOffice[agentId]) {
    return agentOffice[agentId];
  }
  if (agentId && !warnedUnmappedAgents.has(agentId)) {
    warnedUnmappedAgents.add(agentId);
    console.warn(
      `[officeAgents] Unmapped agent '${agentId}' — routing to fallback office ` +
      `'${FALLBACK_OFFICE}'. Add it to AGENT_OFFICE to assign it explicitly.`
    );
  }
  return FALLBACK_OFFICE;
};

/**
 * Get configuration for a specific office. Unknown/absent/"all"/"default"
 * office ids return null (caller treats null as "no office scoping").
 * @param {string} [officeId]
 * @returns {OfficeConfig|null}
 */
const getOfficeConfig = (officeId) => {
  if (!officeId || officeId === 'default' || officeId === 'all') return null;
  const code = OFFICES[officeId] || null;
  if (!code || !isRealOfficeKey(officeId)) return code;
  // MT-1b: the registry's display name when it is serving one. The SAME object
  // as today when the names agree, so nothing downstream can tell the difference.
  const name = officeNameFor(officeId);
  return name === code.officeName ? code : { officeId: code.officeId, officeName: name };
};

/**
 * Real offices for the worklist office selector, in display order. Excludes the
 * 'unknown' system bucket — unmapped-line calls surface in the "All calls" view
 * with an "Unmapped line" affordance rather than as a permanent empty office tab.
 *
 * MT-1b: names and order come from the registry when it is serving (sortOrder,
 * ties broken by code order); otherwise this is exactly the code list.
 * @returns {OfficeConfig[]}
 */
const getAllOfficeConfigs = () => {
  const real = Object.values(OFFICES).filter((o) => o.officeId !== UNMAPPED_OFFICE);
  if (!servedRegistry()) return real;
  return real
    .map((o, i) => ({ config: getOfficeConfig(o.officeId), order: sortOrderFor(o.officeId, i + 1), i }))
    .sort((a, b) => a.order - b.order || a.i - b.i)
    .map((x) => /** @type {OfficeConfig} */ (x.config));
};

/**
 * Whether an agent is allowed for an office. Empty/"all"/"default" → allowed.
 * @param {string|number} agentId
 * @param {string} [officeId]
 * @returns {boolean}
 */
const isAgentAllowedForOffice = (agentId, officeId) => {
  if (!officeId || officeId === 'default' || officeId === 'all') return true;
  const id = agentId != null ? String(agentId) : null;
  if (!id) return officeId === FALLBACK_OFFICE; // agent-less → fallback office only
  return (servedMaps().agentOffice[id] || FALLBACK_OFFICE) === officeId;
};

/**
 * Filter an agents list down to a single office.
 * @param {Array<{agent_id?: string, id?: string}>} agents
 * @param {string} [officeId]
 */
const filterAgentsForOffice = (agents, officeId) => {
  if (!officeId || officeId === 'default' || officeId === 'all') return agents;
  return agents.filter((agent) =>
    isAgentAllowedForOffice(agent.agent_id ?? agent.id, officeId)
  );
};

/**
 * Filter a calls list down to a single office by resolving each call's agent.
 * Empty/"all"/"default" → returns all calls unchanged. An office with no mapped
 * agents (e.g. Valley today) correctly returns [].
 * @param {Array<{handler_id?: string, agent_id?: string|number}>} calls
 * @param {string} [officeId]
 */
const filterCallsForOffice = (calls, officeId) => {
  if (!officeId || officeId === 'default' || officeId === 'all') return calls;
  return calls.filter((call) => getOfficeForCall(call) === officeId);
};

// ── Serving from the office registry (MT-1b) ─────────────────────────────────
// The control-plane `office` table (platform/officeRegistry.js) now ANSWERS for
// the fields this module owns, with the maps above as the fallback:
//
//   field            served from (first that applies)
//   ---------------  -------------------------------------------------------
//   office KEYS      code only. roland / valley / unknown stay FROZEN; a
//                    registry row for any other key is ignored (parity warns).
//   'unknown'        code only. Never read from the registry.
//   displayName      registry (non-blank string) > code
//   sortOrder        registry (integer) > code position
//   retellAgentIds   registry > code, per office; an agent id two offices
//                    claim is refused and falls back to its CODE mapping
//   mangoDids        registry (every entry a usable E.164 line) > code, per
//                    office; a line two offices claim falls back the same way
//
// There is no env layer for any of these today, so there is no env precedence
// to keep. "registry" means officeRegistry.servedOffices(): the last read
// succeeded, is under 15 minutes old, and the office's row is 'active'. In any
// other state every getter above answers from the maps in this file, exactly as
// before MT-1b. Nothing here reads the database: servedOffices() is synchronous
// over the cache, and the refresh stays on its background timer (server.js).
//
// Required here, below the maps, and officeRegistry reads these maps lazily, so
// there is no load-order cycle.
const officeRegistry = require('../platform/officeRegistry');

/** A key this module defines as a real office (never 'unknown', never a prototype name). @param {unknown} k */
function isRealOfficeKey(k) {
  return typeof k === 'string' && k !== UNMAPPED_OFFICE && Object.prototype.hasOwnProperty.call(OFFICES, k);
}

/** The registry's active rows by key while it is serving, else null. Never throws. */
function servedRegistry() {
  return officeRegistry.servedOffices().byKey;
}

/**
 * The registry row serving one real office right now, or null (serve the code).
 * The only way odOffices reaches the registry, so both modules agree on WHEN.
 * @param {string} officeKey
 * @returns {import('../platform/officeRegistry').RegistryOffice|null}
 */
function servedRegistryOffice(officeKey) {
  if (!isRealOfficeKey(officeKey)) return null;
  const byKey = servedRegistry();
  return (byKey && byKey.get(officeKey)) || null;
}

/** @param {unknown} v */
function usableDisplayName(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * The display name served for a real office: the registry's when it is serving
 * a usable one, else the code label. Undefined for anything that is not one of
 * this module's offices ('unknown' answers from the code, like every other field).
 * @param {string} officeKey
 * @returns {string|undefined}
 */
function officeNameFor(officeKey) {
  if (!Object.prototype.hasOwnProperty.call(OFFICES, officeKey)) return undefined;
  const r = servedRegistryOffice(officeKey);
  return r && usableDisplayName(r.displayName) ? r.displayName : OFFICES[officeKey].officeName;
}

/** @param {string} officeKey @param {number} codePosition 1-based */
function sortOrderFor(officeKey, codePosition) {
  const r = servedRegistryOffice(officeKey);
  return r && Number.isInteger(r.sortOrder) ? r.sortOrder : codePosition;
}

/** @param {Record<string, string>} map @param {string} officeKey @returns {string[]} */
function codeIdsFor(map, officeKey) {
  return Object.keys(map).filter((id) => map[id] === officeKey);
}

/** A registry DID list, E.164-normalized, or null when ANY entry is unusable (serve the code list). */
function usableDids(/** @type {unknown} */ dids) {
  if (!Array.isArray(dids)) return null;
  const out = [];
  for (const d of dids) {
    const n = normalizeE164(/** @type {string} */ (d));
    if (!n) return null;
    out.push(n);
  }
  return out;
}

/** @param {unknown} ids @returns {string[]|null} */
function usableAgentIds(ids) {
  if (!Array.isArray(ids)) return null;
  return ids.every((id) => typeof id === 'string' && id.length > 0) ? /** @type {string[]} */ (ids) : null;
}

const warnedConflicts = new Set();

/**
 * Build id → office from per-office lists. An id claimed by MORE than one
 * office is a refusal, not a coin flip: it falls back to its code mapping (or
 * to no mapping at all), and is warned about once.
 * @param {Array<[string, string[]]>} lists  [officeKey, ids]
 * @param {Record<string, string>} codeMap
 * @param {string} what  for the log line
 * @returns {Record<string, string>}
 */
function buildIdMap(lists, codeMap, what) {
  /** @type {Map<string, Set<string>>} */
  const claims = new Map();
  for (const [officeKey, ids] of lists) {
    for (const id of ids) {
      if (!claims.has(id)) claims.set(id, new Set());
      /** @type {Set<string>} */ (claims.get(id)).add(officeKey);
    }
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [id, offices] of claims) {
    if (offices.size === 1) {
      out[id] = [...offices][0];
      continue;
    }
    const warnKey = `${what}:${id}`;
    if (!warnedConflicts.has(warnKey)) {
      warnedConflicts.add(warnKey);
      console.warn(
        `[officeAgents] office registry parity: ${what} '${id}' is claimed by ${[...offices].join(' and ')} — ` +
          `refusing the registry for it; serving its CODE mapping (${codeMap[id] || 'none'}).`
      );
    }
    if (Object.prototype.hasOwnProperty.call(codeMap, id)) out[id] = codeMap[id];
  }
  return out;
}

/** @type {{ source: Map<string, unknown>|null, agentOffice: Record<string, string>, lineOffice: Record<string, string> }} */
let derived = { source: null, agentOffice: AGENT_OFFICE, lineOffice: MANGO_LINE_OFFICE };

/**
 * The agent → office and line → office maps the attribution getters use.
 * Registry not serving: the code maps themselves (same objects, so a test that
 * edits them is honored live). Serving: rebuilt once per successful registry
 * read (memoized on its Map's identity), each office's list from its registry
 * row, or from the code when that office has no usable row.
 */
function servedMaps() {
  const byKey = servedRegistry();
  if (!byKey) return { agentOffice: AGENT_OFFICE, lineOffice: MANGO_LINE_OFFICE };
  if (derived.source !== byKey) {
    const realKeys = Object.keys(OFFICES).filter((k) => k !== UNMAPPED_OFFICE);
    const agentLists = realKeys.map((k) => {
      const r = byKey.get(k);
      const ids = r ? usableAgentIds(r.retellAgentIds) : null;
      return /** @type {[string, string[]]} */ ([k, ids || codeIdsFor(AGENT_OFFICE, k)]);
    });
    const lineLists = realKeys.map((k) => {
      const r = byKey.get(k);
      const dids = r ? usableDids(r.mangoDids) : null;
      return /** @type {[string, string[]]} */ ([k, dids || codeIdsFor(MANGO_LINE_OFFICE, k)]);
    });
    derived = {
      source: byKey,
      agentOffice: buildIdMap(agentLists, AGENT_OFFICE, 'Retell agent'),
      lineOffice: buildIdMap(lineLists, MANGO_LINE_OFFICE, 'Mango line'),
    };
  }
  return derived;
}

// ── Office registry parity tripwire (MT-1a, two-way since MT-1b) ─────────────
// On every successful registry read, compare the fields THIS module owns with
// the maps above, BOTH ways: an office in the code but not the registry, one in
// the registry but not the code, and every field that differs. One warning per
// divergent field per process, and each warning says which side is now SERVED.
// odOffices runs the same check over the Open Dental fields.

/**
 * Why a divergent field is served from the CODE, or null when the registry wins.
 * Mirrors the getters above; it decides nothing itself.
 * @param {import('../platform/officeRegistry').Divergence} d
 * @returns {string|null}
 */
function servedCodeReason(d) {
  if (d.field === 'row') {
    return d.registry === 'present'
      ? 'not a frozen office key; registry-only rows are ignored'
      : 'the office has no registry row';
  }
  const r = servedRegistryOffice(d.officeKey);
  if (!r) return 'the office has no active registry row';
  switch (d.field) {
    case 'displayName':
      return usableDisplayName(r.displayName) ? null : 'the registry value is blank';
    case 'sortOrder':
      return Number.isInteger(r.sortOrder) ? null : 'the registry value is not an integer';
    case 'retellAgentIds':
      return usableAgentIds(r.retellAgentIds) ? null : 'the registry list has an unusable id';
    case 'mangoDids':
      return usableDids(r.mangoDids) ? null : 'the registry list has an unusable line';
    default:
      return null;
  }
}

const registryParity = officeRegistry.createParityCheck({
  label: 'officeAgents',
  fields: ['row', 'displayName', 'sortOrder', 'retellAgentIds', 'mangoDids', 'status'],
  servedCode: servedCodeReason,
});
officeRegistry.onRefresh((offices, tenantSlug) => {
  if (tenantSlug === officeRegistry.CODE_MAP_TENANT_SLUG) registryParity.check(offices);
});

module.exports = {
  OFFICES,
  FALLBACK_OFFICE,
  UNMAPPED_OFFICE,
  AGENT_OFFICE,
  MANGO_LINE_OFFICE,
  normalizeE164,
  getAgentId,
  getOfficeForCall,
  getOfficeConfig,
  getAllOfficeConfigs,
  isAgentAllowedForOffice,
  filterAgentsForOffice,
  filterCallsForOffice,
  /** MT-1b: the display name served for an office (registry > code). */
  officeNameFor,
  /** MT-1b: the registry row serving a real office right now, or null. odOffices reads through this. */
  servedRegistryOffice,
  /** Parity tripwire (MT-1a). Logs only; returns the divergences it found. */
  checkRegistryParity: registryParity.check,
  /** TESTS ONLY: forget which divergences were already warned about. */
  resetRegistryParityForTests() {
    registryParity.resetForTests();
    warnedConflicts.clear();
    derived = { source: null, agentOffice: AGENT_OFFICE, lineOffice: MANGO_LINE_OFFICE };
  },
};
