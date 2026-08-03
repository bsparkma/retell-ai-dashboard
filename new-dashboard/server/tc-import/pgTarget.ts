/**
 * TC legacy importer — Postgres implementation of ImportTarget.
 *
 * One pg Client (single connection — the whole run is one transaction).
 * Connection string comes from the environment (Key Vault → session env),
 * never from code. All statements are parameterized; identifiers come only
 * from the typed row objects (compile-time constants), never from data.
 */
import pg from "pg";
import type {
  TcCaseRows,
  TcCommunicationRow,
  TcEmailTemplateRow,
  TcGalleryRow,
  TcLegacyUserMapRow,
  TcLibraryConfigRow,
  TcPreauthRow,
  TcSmileSimulationRow,
} from "@shared/tc/rows";
import type { ImportTarget } from "./target";
import type { ExistingState } from "./types";

/** Columns whose values are objects/arrays destined for jsonb — stringified
 *  explicitly so node-pg does not misformat JS arrays as PG arrays. */
const JSONB_COLUMNS = new Set(["legacy_snapshot", "blocks", "value", "detail"]);

export class PgImportTarget implements ImportTarget {
  private client: pg.Client;

  constructor(connectionString: string) {
    this.client = new pg.Client({ connectionString });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  private async insert(table: string, rowObj: object): Promise<void> {
    const row = rowObj as Record<string, unknown>;
    const cols = Object.keys(row);
    const params: unknown[] = [];
    const placeholders = cols.map((col, i) => {
      let v = row[col];
      if (JSONB_COLUMNS.has(col) && v !== null && v !== undefined) {
        v = JSON.stringify(v);
      }
      params.push(v);
      return JSONB_COLUMNS.has(col) ? `$${i + 1}::jsonb` : `$${i + 1}`;
    });
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`;
    await this.client.query(sql, params);
  }

  async fetchExistingState(): Promise<ExistingState> {
    const idMap = async (table: string, pk: string): Promise<Map<string, string>> => {
      const res = await this.client.query(
        `SELECT legacy_id, ${pk} FROM ${table} WHERE legacy_id IS NOT NULL`,
      );
      return new Map(res.rows.map((r) => [String(r.legacy_id), String(r[pk])]));
    };
    const lib = await this.client.query("SELECT office_id, section FROM tc_library_config");
    const users = await this.client.query("SELECT legacy_user_id FROM tc_legacy_user_map");
    return {
      cases: await idMap("tc_cases", "case_id"),
      preauths: await idMap("tc_preauth_cases", "preauth_id"),
      templates: await idMap("tc_email_templates", "template_id"),
      communications: await idMap("tc_communications", "comm_id"),
      gallery: await idMap("tc_gallery_cases", "gallery_id"),
      simulations: await idMap("tc_smile_simulations", "sim_id"),
      librarySections: new Set(lib.rows.map((r) => `${r.office_id}:${r.section}`)),
      userMapIds: new Set(users.rows.map((r) => String(r.legacy_user_id))),
    };
  }

  async begin(): Promise<void> {
    await this.client.query("BEGIN");
  }
  async commit(): Promise<void> {
    await this.client.query("COMMIT");
  }
  async rollback(): Promise<void> {
    await this.client.query("ROLLBACK");
  }

  async insertCaseAggregate(rows: TcCaseRows, legacySnapshot: unknown): Promise<void> {
    await this.insert("tc_cases", { ...rows.caseRow, legacy_snapshot: legacySnapshot });
    for (const p of rows.phaseRows) await this.insert("tc_case_phases", p);
    for (const it of rows.itemRows) await this.insert("tc_case_items", it);
    for (const o of rows.objectionRows) await this.insert("tc_case_objections", o);
    for (const f of rows.followupRows) await this.insert("tc_followups", f);
    for (const e of rows.eventRows) await this.insert("tc_case_events", e);
    if (rows.hygieneIntakeRow) await this.insert("tc_hygiene_intakes", rows.hygieneIntakeRow);
  }

  async insertPreauth(row: TcPreauthRow): Promise<void> {
    await this.insert("tc_preauth_cases", row);
  }
  async insertTemplate(row: TcEmailTemplateRow): Promise<void> {
    await this.insert("tc_email_templates", row);
  }
  async insertCommunication(row: TcCommunicationRow): Promise<void> {
    await this.insert("tc_communications", row);
  }
  async insertGallery(row: TcGalleryRow): Promise<void> {
    await this.insert("tc_gallery_cases", row);
  }
  async insertSimulation(row: TcSmileSimulationRow): Promise<void> {
    await this.insert("tc_smile_simulations", row);
  }
  async insertLibrarySection(row: TcLibraryConfigRow): Promise<void> {
    await this.insert("tc_library_config", { ...row });
  }
  async insertUserMapEntry(row: TcLegacyUserMapRow): Promise<void> {
    await this.insert("tc_legacy_user_map", row);
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}
