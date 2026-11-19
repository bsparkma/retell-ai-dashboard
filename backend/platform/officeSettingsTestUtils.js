'use strict';

/**
 * TESTS ONLY. An in-memory control plane that speaks exactly the statements
 * platform/registry.js issues for platform_setting and office_setting, with
 * real BEGIN / COMMIT / ROLLBACK (a snapshot restored on rollback) and the
 * office_setting foreign key. Installed with registry.setPoolForTests().
 *
 * It refuses any statement it does not recognise, so a new statement in the
 * registry cannot pass a test by being silently ignored. The real-Postgres
 * proof of the same statements is scripts/office-settings-verify-queries.js.
 */

const TENANT_ID = '00000000-0000-4000-8000-0000000000c1';

/**
 * Whether a suite has installed an in-memory control plane on the REAL
 * registry (registry.setPoolForTests(fake)). While one is installed, the
 * office_setting mirror below steps aside and the real registry reads that
 * fake's office_setting table: those suites test the table itself.
 */
const realRegistry = require('./registry');
let testPoolInstalled = false;
const realSetPoolForTests = realRegistry.setPoolForTests;
realRegistry.setPoolForTests = (fake) => {
  testPoolInstalled = Boolean(fake);
  return realSetPoolForTests(fake);
};

/** @param {unknown} v */
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

class FakeControlPlane {
  /**
   * @param {{ tenants?: Array<{ tenant_id: string, slug: string }>,
   *           offices?: Array<{ tenant_id: string, office_key: string }> }} [seed]
   */
  constructor(seed = {}) {
    this.tenants = seed.tenants || [{ tenant_id: TENANT_ID, slug: 'carein' }];
    this.offices = seed.offices || [
      { tenant_id: TENANT_ID, office_key: 'roland' },
      { tenant_id: TENANT_ID, office_key: 'valley' },
    ];
    /** @type {Map<string, { key: string, value: unknown, updated_at: Date, updated_by: string|null }>} */
    this.platform = new Map();
    /** @type {Map<string, { tenant_id: string, office_key: string, setting_key: string, value: unknown, updated_at: Date, updated_by: string|null }>} */
    this.officeSetting = new Map();
    /** Force failures: set a flag to make that statement throw. */
    this.fail = { platformUpsert: false, officeUpsert: false, officeReadbackTamper: null, listOfficeSettings: false };
    /** @type {string[]} */
    this.log = [];
    /** @type {null | { platform: string, officeSetting: string }} */
    this.snapshot = null;
    this.clock = Date.parse('2026-11-12T15:00:00Z');
  }

  now() {
    this.clock += 1000;
    return new Date(this.clock);
  }

  /** Seed a platform_setting row directly (a runbook write). */
  seedPlatform(key, value, updatedBy = null) {
    this.platform.set(key, { key, value: clone(value), updated_at: this.now(), updated_by: updatedBy });
  }

  /** Seed an office_setting row directly. */
  seedOffice(officeKey, settingKey, value, tenantId = TENANT_ID) {
    this.officeSetting.set(`${tenantId}|${officeKey}|${settingKey}`, {
      tenant_id: tenantId,
      office_key: officeKey,
      setting_key: settingKey,
      value: clone(value),
      updated_at: this.now(),
      updated_by: null,
    });
  }

  /** office_setting values for one key, as { office: value }. */
  officeValues(settingKey, tenantId = TENANT_ID) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const r of this.officeSetting.values()) {
      if (r.tenant_id === tenantId && r.setting_key === settingKey) out[r.office_key] = clone(r.value);
    }
    return out;
  }

  platformValue(key) {
    const r = this.platform.get(key);
    return r ? clone(r.value) : undefined;
  }

  /**
   * @param {string} text
   * @param {unknown[]} [params]
   * @returns {Promise<{ rows: Array<Record<string, unknown>>, rowCount: number }>}
   */
  async exec(text, params = []) {
    const sql = text.replace(/\s+/g, ' ').trim();
    this.log.push(sql);
    const ok = (rows) => ({ rows: clone(rows), rowCount: rows.length });

    if (sql === 'BEGIN') {
      this.snapshot = {
        platform: JSON.stringify([...this.platform]),
        officeSetting: JSON.stringify([...this.officeSetting]),
      };
      return ok([]);
    }
    if (sql === 'COMMIT') {
      this.snapshot = null;
      return ok([]);
    }
    if (sql === 'ROLLBACK') {
      if (this.snapshot) {
        const revive = (entries) =>
          new Map(JSON.parse(entries).map(([k, v]) => [k, { ...v, updated_at: new Date(v.updated_at) }]));
        this.platform = revive(this.snapshot.platform);
        this.officeSetting = revive(this.snapshot.officeSetting);
      }
      this.snapshot = null;
      return ok([]);
    }
    if (sql.startsWith('INSERT INTO platform_setting')) {
      if (this.fail.platformUpsert) throw new Error('forced platform_setting failure');
      const [key, json, by] = /** @type {[string, string, string|null]} */ (params);
      const row = { key, value: JSON.parse(json), updated_at: this.now(), updated_by: by };
      this.platform.set(key, row);
      return ok([row]);
    }
    if (sql.startsWith('SELECT key, value, updated_at, updated_by FROM platform_setting WHERE key = $1')) {
      const r = this.platform.get(/** @type {string} */ (params[0]));
      return ok(r ? [r] : []);
    }
    if (sql.startsWith('SELECT o.tenant_id, o.office_key FROM office o JOIN tenant t')) {
      const t = this.tenants.find((x) => x.slug === params[0]);
      return ok(t ? this.offices.filter((o) => o.tenant_id === t.tenant_id) : []);
    }
    // MT-2d single writer (registry.setOfficeSetting): one row, always re-stamped.
    if (
      sql.startsWith('INSERT INTO office_setting') &&
      sql.endsWith('RETURNING office_key, setting_key, value, updated_at, updated_by')
    ) {
      if (this.fail.officeUpsert) throw new Error('forced office_setting failure');
      const [tenantId, officeKey, settingKey, json, by] = /** @type {[string, string, string, string, string|null]} */ (params);
      if (!this.offices.some((o) => o.tenant_id === tenantId && o.office_key === officeKey)) {
        const err = /** @type {Error & { code?: string }} */ (new Error('office_setting_office_fkey'));
        err.code = '23503';
        throw err;
      }
      const row = {
        tenant_id: tenantId,
        office_key: officeKey,
        setting_key: settingKey,
        value: JSON.parse(json),
        updated_at: this.now(),
        updated_by: by,
      };
      this.officeSetting.set(`${tenantId}|${officeKey}|${settingKey}`, row);
      return ok([
        { office_key: row.office_key, setting_key: row.setting_key, value: row.value, updated_at: row.updated_at, updated_by: row.updated_by },
      ]);
    }
    if (sql.startsWith('SELECT office_key, value FROM office_setting WHERE tenant_id = $1 AND setting_key = $2')) {
      const [tenantId, settingKey] = /** @type {[string, string]} */ (params);
      let rows = [...this.officeSetting.values()]
        .filter((r) => r.tenant_id === tenantId && r.setting_key === settingKey)
        .map((r) => ({ office_key: r.office_key, value: r.value }));
      if (this.fail.officeReadbackTamper) rows = this.fail.officeReadbackTamper(clone(rows));
      return ok(rows);
    }
    if (sql.startsWith('SELECT s.office_key, s.setting_key, s.value, s.updated_at, s.updated_by FROM office_setting s')) {
      if (this.fail.listOfficeSettings) throw new Error('forced office_setting read failure');
      const t = this.tenants.find((x) => x.slug === params[0]);
      if (!t) return ok([]);
      return ok(
        [...this.officeSetting.values()]
          .filter((r) => r.tenant_id === t.tenant_id)
          .map((r) => ({
            office_key: r.office_key,
            setting_key: r.setting_key,
            value: r.value,
            updated_at: r.updated_at,
            updated_by: r.updated_by,
          }))
      );
    }
    throw new Error(`FakeControlPlane does not recognise: ${sql.slice(0, 120)}`);
  }

  /** A pg.Pool look-alike. */
  pool() {
    return /** @type {import('pg').Pool} */ (/** @type {unknown} */ ({
      query: (text, params) => this.exec(text, params),
      connect: async () => ({
        query: (text, params) => this.exec(text, params),
        release: () => {},
      }),
      end: async () => {},
      on: () => {},
    }));
  }
}

/**
 * TESTS ONLY (MT-2b; MT-2d). Many suites drive a per-office switch by stubbing
 * `registry.getPlatformSetting` / `setPlatformSetting` — in those suites that
 * stub is simply the test's settings STORE, not the production table. Since
 * MT-2b the readers SERVE office_setting,
 * which they read through `registry.listOfficeSettings`. This installs a
 * `listOfficeSettings` that derives tenant 'carein's office_setting rows from
 * whatever the suite's getPlatformSetting stub answers AT READ TIME, through
 * the same officeSettingKeys.mirrorEntries the MT-2a dual-write mirrors with —
 * i.e. exactly what registry.setPlatformSetting would have stored. Any other
 * tenant holds no rows.
 *
 * FAILURES. office_setting is ONE read for all ten keys, while a suite's stub
 * answers key by key, and many stubs fall through to the real registry (which
 * throws with no control DB) for the keys they do not care about. So a key
 * whose stub throws is read as "no row for that key"; only when EVERY key
 * throws does this throw — the suite is simulating an unreachable control plane.
 *
 * WRITES (MT-2d). The readers' persist functions now call
 * `registry.setOfficeSetting(tenant, office, key, value, by)` — one office.
 * This also installs a `setOfficeSetting` that folds that one office's value
 * into the suite's stub store (its getPlatformSetting map, written back through
 * its setPlatformSetting stub), so the suite's store stays the one source of
 * its settings and its write counters still count one write per save. It only
 * stands in for office_setting inside such a suite; the production
 * single-writer path is pinned against the in-memory control plane in
 * officeSettingsSingleWriter.test.js.
 *
 * It changes no stubbed value. Returns a restore function.
 *
 * @param {{ getPlatformSetting: (key: string) => Promise<unknown>,
 *           setPlatformSetting: (key: string, value: unknown, by?: string|null) => Promise<unknown>,
 *           listOfficeSettings: unknown, setOfficeSetting: unknown }} registry
 * @param {{ tenantSlug?: string }} [opts]
 * @returns {() => void}
 */
function mirrorPlatformStubIntoOfficeSettings(registry, opts = {}) {
  const tenantSlug = opts.tenantSlug || 'carein';
  const { OFFICE_SETTING_KEYS, mirrorEntries } = require('./officeSettingKeys');
  const savedSet = /** @type {Function} */ (registry.setOfficeSetting);
  registry.setOfficeSetting = async (slug, officeKey, settingKey, value, updatedBy = null) => {
    // An in-memory control plane is installed: the REAL single writer runs.
    if (registry === realRegistry && testPoolInstalled) {
      return savedSet.call(registry, slug, officeKey, settingKey, value, updatedBy);
    }
    if (slug !== tenantSlug) throw new Error(`test store holds tenant '${tenantSlug}' only, not '${slug}'`);
    const current = /** @type {{ value?: unknown }|null} */ (await registry.getPlatformSetting(settingKey));
    const base =
      current && current.value && typeof current.value === 'object' && !Array.isArray(current.value)
        ? { .../** @type {Record<string, unknown>} */ (current.value) }
        : {};
    base[officeKey] = value;
    await registry.setPlatformSetting(settingKey, base, updatedBy);
    return { office_key: officeKey, setting_key: settingKey, value, updated_at: new Date(), updated_by: updatedBy };
  };
  const saved = registry.listOfficeSettings;
  registry.listOfficeSettings = async (slug) => {
    // An in-memory control plane is installed on the real registry: read ITS
    // office_setting table, not a derivation (see testPoolInstalled).
    if (registry === realRegistry && testPoolInstalled) return saved.call(registry, slug);
    if (slug !== tenantSlug) return [];
    /** @type {Array<{ office_key: string, setting_key: string, value: unknown, updated_at: Date|null, updated_by: string|null }>} */
    const rows = [];
    /** @type {unknown[]} */
    const errors = [];
    for (const key of OFFICE_SETTING_KEYS) {
      /** @type {{ value?: unknown, updated_at?: Date, updated_by?: string|null }|null} */
      let row;
      try {
        row = /** @type {typeof row} */ (await registry.getPlatformSetting(key));
      } catch (err) {
        errors.push(err);
        continue;
      }
      if (!row) continue;
      for (const e of mirrorEntries(key, row.value)) {
        rows.push({
          office_key: e.officeKey,
          setting_key: key,
          value: e.value,
          updated_at: row.updated_at || null,
          updated_by: row.updated_by || null,
        });
      }
    }
    if (errors.length === OFFICE_SETTING_KEYS.length) throw errors[0];
    return rows;
  };
  return () => {
    registry.listOfficeSettings = saved;
    registry.setOfficeSetting = savedSet;
  };
}

module.exports = { FakeControlPlane, TENANT_ID, mirrorPlatformStubIntoOfficeSettings };
