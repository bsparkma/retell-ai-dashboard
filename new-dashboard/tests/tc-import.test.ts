/**
 * TC legacy importer (Slice 2) — unit tests over the synthetic fixture
 * directory in tests/fixtures/tc-import/legacy-data. NO real data here:
 * every name/phone/email in the fixtures is synthetic by construction.
 */
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLegacyDataDir } from "../server/tc-import/loadLegacy";
import { assertReconciliationBalance, buildImportPlan } from "../server/tc-import/plan";
import { executePlan } from "../server/tc-import/execute";
import type { BlobSink, ImportTarget } from "../server/tc-import/target";
import { emptyExistingState, type ExistingState, type PlanOptions } from "../server/tc-import/types";
import type {
  TcCaseRows,
  TcCommunicationRow,
  TcEmailTemplateRow,
  TcGalleryRow,
  TcLegacyUserMapRow,
  TcLibraryConfigRow,
  TcPreauthRow,
  TcSmileSimulationRow,
} from "../shared/tc/rows";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "tc-import",
  "legacy-data",
);

const OPTIONS: PlanOptions = {
  tenantSlug: "carein",
  defaultOffice: "roland",
  userEmailOverrides: { override: "override.user@example.com" },
};

let keyCounter = 0;
const makeBlobKey = (entity: string, ext: string): string =>
  `tenant/carein/tc/${entity}/test-${++keyCounter}.${ext}`;

function freshPlan(existing = emptyExistingState()) {
  const data = loadLegacyDataDir(FIXTURE_DIR);
  return { data, plan: buildImportPlan(data, OPTIONS, existing, { makeBlobKey }) };
}

describe("loadLegacyDataDir", () => {
  it("consumes the data files, excludes the PRD exclusions, flags strays", () => {
    const data = loadLegacyDataDir(FIXTURE_DIR);
    expect(data.cases).toHaveLength(3);
    expect(data.preauth).toHaveLength(2);
    expect(data.templates).toHaveLength(1);
    expect(data.communications).toHaveLength(2);
    expect(data.gallery).toHaveLength(1);
    expect(data.simulations).toHaveLength(1);
    expect(data.users).toHaveLength(3);
    expect(data.library).not.toBeNull();
    expect(data.excludedFiles.sort()).toEqual([
      "migrations.json",
      "practice.json",
      "templates.json.backup-sprint9-1234567890",
    ]);
    expect(data.unknownFiles).toEqual(["stray-notes.txt"]);
    expect(data.images.files.size).toBe(4);
    const galleryDir = data.images.dirs.find((d) => d.dir === "gallery-images");
    expect(galleryDir?.count).toBe(2);
  });
});

describe("buildImportPlan (dry-run)", () => {
  const { plan } = freshPlan();
  const recon = Object.fromEntries(plan.recon.map((r) => [r.entity, r]));

  it("maps the mappable cases and reports the unmappable one as an error", () => {
    expect(recon.cases.source).toBe(3);
    expect(recon.cases.imported).toBe(2);
    expect(recon.cases.errors).toHaveLength(1);
    expect(recon.cases.errors[0].id).toBe("c_bad");
  });

  it("stamps offices: roland stays, riley → valley", () => {
    const offices = plan.cases.map((c) => c.rows.caseRow.office_id).sort();
    expect(offices).toEqual(["roland", "valley"]);
    const preauthOffices = plan.preauths.map((p) => p.office_id).sort();
    expect(preauthOffices).toEqual(["roland", "valley"]);
  });

  it("converts float dollars to integer cents", () => {
    const multi = plan.cases.find((c) => c.rows.caseRow.legacy_id === "c_multi");
    expect(multi?.rows.caseRow.case_value_cents).toBe(1234567);
    const crown = multi?.rows.itemRows.find((i) => i.legacy_item_id === "od_123");
    expect(crown?.fee_cents).toBe(123456);
    expect(crown?.insurance_est_cents).toBe(60010);
    expect(crown?.od_proc_num).toBe(123);
  });

  it("unifies the three follow-up systems and reports date drops", () => {
    const multi = plan.cases.find((c) => c.rows.caseRow.legacy_id === "c_multi");
    // followUps(1) + followUpSteps(2, 1 undated) + nurtureTouchpoints(1) → 3
    expect(multi?.rows.followupRows).toHaveLength(3);
    const kinds = multi!.rows.followupRows.map((f) => f.kind).sort();
    expect(kinds).toEqual(["followup", "followup", "nurture"]);
    const drop = plan.dataQuality.find(
      (d) => d.entity === "cases" && d.id === "c_multi" && d.note.includes("follow-up"),
    );
    expect(drop?.note).toContain("1 follow-up");
    // contactAttempts fold into events: 2 caseEvents + 1 attempt
    expect(multi?.rows.eventRows).toHaveLength(3);
    expect(multi?.rows.eventRows.filter((e) => e.type === "contact_attempt")).toHaveLength(1);
  });

  it("resolves communication links and nulls dangling ones with notes", () => {
    const ok = plan.communications.find((c) => c.legacy_id === "cm_ok");
    const multi = plan.cases.find((c) => c.rows.caseRow.legacy_id === "c_multi");
    expect(ok?.case_id).toBe(multi?.rows.caseRow.case_id);
    expect(ok?.template_id).toBe(plan.templates[0].template_id);
    const dangling = plan.communications.find((c) => c.legacy_id === "cm_dangling");
    expect(dangling?.case_id).toBeNull();
    expect(dangling?.template_id).toBeNull();
    expect(
      plan.dataQuality.filter((d) => d.entity === "communications" && d.id === "cm_dangling"),
    ).toHaveLength(2);
  });

  it("plans blob uploads for gallery + smile-sim and links the sim", () => {
    expect(plan.gallery[0].uploads).toHaveLength(2);
    expect(plan.simulations[0].uploads).toHaveLength(2);
    for (const u of [...plan.gallery[0].uploads, ...plan.simulations[0].uploads]) {
      expect(u.blobKey).toMatch(/^tenant\/carein\/tc\/(gallery|smile-sim)\/.+\.png$/);
      expect(u.bytes).toBeGreaterThan(0);
    }
    const sim = plan.simulations[0].row;
    expect(sim.gallery_id).toBe(plan.gallery[0].row.gallery_id);
    expect(sim.case_id).not.toBeNull();
  });

  it("seeds library sections to BOTH offices with money in cents", () => {
    const crown = plan.librarySections.filter((s) => s.section === "crown_pricing");
    expect(crown.map((c) => c.office_id).sort()).toEqual(["roland", "valley"]);
    expect((crown[0].value as { economyCents: number }).economyCents).toBe(89999);
    const providers = plan.librarySections.find(
      (s) => s.section === "financing_providers" && s.office_id === "roland",
    );
    expect((providers?.value as { minAmountCents: number }[])[0].minAmountCents).toBe(50050);
    const cadence = plan.librarySections.find(
      (s) => s.section === "cadence_config" && s.office_id === "roland",
    );
    expect(
      (cadence?.value as { thresholds: { standardMinCents: number } }).thresholds.standardMinCents,
    ).toBe(300000);
  });

  it("maps users with emails (source or --user-map), skips the rest, strips pinHash", () => {
    expect(recon.users.source).toBe(3);
    expect(plan.userMap.map((u) => u.legacy_user_id).sort()).toEqual(["override", "withemail"]);
    expect(recon.users.skipped).toHaveLength(1);
    expect(recon.users.skipped[0].id).toBe("noemail");
    expect(JSON.stringify(plan)).not.toContain("SECRETHASH");
  });

  it("balances every entity: source = imported + skipped + errors", () => {
    for (const r of plan.recon) {
      expect(r.source, r.entity).toBe(r.imported + r.skipped.length + r.errors.length);
    }
  });
});

describe("assertReconciliationBalance", () => {
  it("fails loudly when a record goes unaccounted", () => {
    expect(() =>
      assertReconciliationBalance([
        { entity: "cases", source: 5, mapped: 3, imported: 3, skipped: [], errors: [] },
      ]),
    ).toThrow(/RECONCILIATION DOES NOT BALANCE/);
  });
});

// ── Idempotency: run twice against an in-memory target ─────────────────────

class FakeTarget implements ImportTarget {
  cases = new Map<string, { rows: TcCaseRows; snapshot: unknown }>();
  preauths = new Map<string, TcPreauthRow>();
  templates = new Map<string, TcEmailTemplateRow>();
  communications = new Map<string, TcCommunicationRow>();
  gallery = new Map<string, TcGalleryRow>();
  simulations = new Map<string, TcSmileSimulationRow>();
  library = new Map<string, TcLibraryConfigRow>();
  users = new Map<string, TcLegacyUserMapRow>();
  inserts = 0;

  async fetchExistingState(): Promise<ExistingState> {
    const idMap = <T>(m: Map<string, T>, pk: (v: T) => string): Map<string, string> =>
      new Map([...m.entries()].map(([legacyId, v]) => [legacyId, pk(v)]));
    return {
      cases: idMap(this.cases, (v) => v.rows.caseRow.case_id),
      preauths: idMap(this.preauths, (v) => v.preauth_id),
      templates: idMap(this.templates, (v) => v.template_id),
      communications: idMap(this.communications, (v) => v.comm_id),
      gallery: idMap(this.gallery, (v) => v.gallery_id),
      simulations: idMap(this.simulations, (v) => v.sim_id),
      librarySections: new Set(this.library.keys()),
      userMapIds: new Set(this.users.keys()),
    };
  }
  async begin(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
  async insertCaseAggregate(rows: TcCaseRows, snapshot: unknown): Promise<void> {
    if (this.cases.has(rows.caseRow.legacy_id ?? "")) throw new Error("duplicate case");
    this.cases.set(rows.caseRow.legacy_id ?? "", { rows, snapshot });
    this.inserts += 1;
  }
  async insertPreauth(row: TcPreauthRow): Promise<void> {
    if (this.preauths.has(row.legacy_id ?? "")) throw new Error("duplicate preauth");
    this.preauths.set(row.legacy_id ?? "", row);
    this.inserts += 1;
  }
  async insertTemplate(row: TcEmailTemplateRow): Promise<void> {
    if (this.templates.has(row.legacy_id ?? "")) throw new Error("duplicate template");
    this.templates.set(row.legacy_id ?? "", row);
    this.inserts += 1;
  }
  async insertCommunication(row: TcCommunicationRow): Promise<void> {
    if (this.communications.has(row.legacy_id ?? "")) throw new Error("duplicate comm");
    this.communications.set(row.legacy_id ?? "", row);
    this.inserts += 1;
  }
  async insertGallery(row: TcGalleryRow): Promise<void> {
    if (this.gallery.has(row.legacy_id ?? "")) throw new Error("duplicate gallery");
    this.gallery.set(row.legacy_id ?? "", row);
    this.inserts += 1;
  }
  async insertSimulation(row: TcSmileSimulationRow): Promise<void> {
    if (this.simulations.has(row.legacy_id ?? "")) throw new Error("duplicate sim");
    this.simulations.set(row.legacy_id ?? "", row);
    this.inserts += 1;
  }
  async insertLibrarySection(row: TcLibraryConfigRow): Promise<void> {
    const key = `${row.office_id}:${row.section}`;
    if (this.library.has(key)) throw new Error("duplicate library section");
    this.library.set(key, row);
    this.inserts += 1;
  }
  async insertUserMapEntry(row: TcLegacyUserMapRow): Promise<void> {
    if (this.users.has(row.legacy_user_id)) throw new Error("duplicate user");
    this.users.set(row.legacy_user_id, row);
    this.inserts += 1;
  }
  async close(): Promise<void> {}
}

class FakeSink implements BlobSink {
  uploads: string[] = [];
  async upload(key: string): Promise<void> {
    this.uploads.push(key);
  }
}

describe("idempotency (execute twice)", () => {
  it("second run plans zero inserts and zero uploads; end-state identical", async () => {
    const target = new FakeTarget();
    const sink = new FakeSink();

    const first = freshPlan(await target.fetchExistingState());
    const firstResult = await executePlan(first.plan, target, sink);
    expect(firstResult.insertedRows.tc_cases).toBe(2);
    expect(firstResult.uploadedBlobs.count).toBe(4);
    const snapshotAfterFirst = JSON.stringify([...target.cases.keys()].sort()) +
      JSON.stringify([...target.library.keys()].sort()) +
      String(target.inserts);

    const second = freshPlan(await target.fetchExistingState());
    for (const r of second.plan.recon) {
      expect(r.imported, `${r.entity} should plan no new imports`).toBe(0);
    }
    const secondResult = await executePlan(second.plan, target, sink);
    expect(Object.values(secondResult.insertedRows).reduce((a, b) => a + b, 0)).toBe(0);
    expect(secondResult.uploadedBlobs.count).toBe(0);

    const snapshotAfterSecond = JSON.stringify([...target.cases.keys()].sort()) +
      JSON.stringify([...target.library.keys()].sort()) +
      String(target.inserts);
    expect(snapshotAfterSecond).toBe(snapshotAfterFirst);
    // every source record on run 2 is accounted for as skipped or error
    for (const r of second.plan.recon) {
      expect(r.source).toBe(r.skipped.length + r.errors.length);
    }
  });
});
