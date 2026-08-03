/**
 * TC legacy importer — planning stage.
 *
 * Pure: takes the loaded legacy data + what already exists in the target and
 * produces an ImportPlan (rows to insert, blobs to upload, full
 * reconciliation). ALL legacy→contract mapping is delegated to
 * shared/tc/legacy.ts — a record that won't map is a mapper gap or a
 * data-quality row, never something this file papers over.
 *
 * Idempotency: records whose legacy id already exists in the target are
 * SKIPPED (reason "already imported") — re-running the importer converges to
 * the same end-state and never duplicates.
 */
import { randomUUID } from "node:crypto";
import {
  legacyCaseToTc,
  legacyCommunicationToTc,
  legacyGalleryToTc,
  legacyLibraryToSections,
  legacyPreauthToTc,
  legacySimulationToTc,
  legacyTemplateToTc,
  legacyUserToMapEntry,
} from "@shared/tc/legacy";
import {
  caseToRows,
  communicationToRow,
  galleryToRow,
  preauthToRow,
  simulationToRow,
  templateToRow,
  userMapEntryToRow,
} from "@shared/tc/rows";
import type { OfficeId } from "@shared/tc/contract";
import { contentTypeForExt, normalizeImageRef, type LegacyDataDir } from "./loadLegacy";
import {
  emptyExistingState,
  type DataQualityNote,
  type EntityRecon,
  type ErrorRecord,
  type ExistingState,
  type ImportPlan,
  type PlanOptions,
  type PlannedUpload,
  type SkippedRecord,
} from "./types";

export interface PlanDeps {
  /** Build a tenant-safe blob key for an entity + extension. */
  makeBlobKey(entity: "gallery" | "smile-sim" | "email", ext: string): string;
  /** Injectable for deterministic tests; defaults to crypto.randomUUID. */
  newId?: () => string;
}

const OFFICES: OfficeId[] = ["roland", "valley"];

/** Tolerant peek at a raw record's legacy id, for reporting only. */
function peekId(raw: unknown): string {
  if (raw && typeof raw === "object" && "id" in raw && typeof (raw as { id: unknown }).id === "string") {
    return (raw as { id: string }).id;
  }
  return "(no id)";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function buildImportPlan(
  data: LegacyDataDir,
  options: PlanOptions,
  existing: ExistingState = emptyExistingState(),
  deps?: PlanDeps,
): ImportPlan {
  const newId = deps?.newId ?? (() => randomUUID());
  const makeBlobKey =
    deps?.makeBlobKey ??
    ((): string => {
      throw new Error("makeBlobKey dependency is required when image entities are present");
    });

  const recon: EntityRecon[] = [];
  const dataQuality: DataQualityNote[] = [];

  const plan: ImportPlan = {
    options,
    cases: [],
    preauths: [],
    templates: [],
    communications: [],
    gallery: [],
    simulations: [],
    librarySections: [],
    userMap: [],
    recon,
    dataQuality,
    excludedFiles: data.excludedFiles,
    unknownFiles: data.unknownFiles,
  };

  // ── Cases ────────────────────────────────────────────────────────────────
  const caseIdByLegacy = new Map(existing.cases);
  const caseOfficeByLegacy = new Map<string, OfficeId>();
  {
    const skipped: SkippedRecord[] = [];
    const errors: ErrorRecord[] = [];
    for (const raw of data.cases) {
      const legacyId = peekId(raw);
      if (existing.cases.has(legacyId)) {
        skipped.push({ id: legacyId, reason: "already imported" });
        continue;
      }
      try {
        const tcCase = legacyCaseToTc(raw, newId);
        const rows = caseToRows(tcCase, newId);
        plan.cases.push({ rows, legacySnapshot: raw });
        caseIdByLegacy.set(legacyId, tcCase.caseId);
        caseOfficeByLegacy.set(legacyId, tcCase.officeId);

        // The mappers drop queue/timeline items with unparseable dates —
        // count and surface every drop (importer contract from Slice 1).
        const r = raw as Record<string, unknown>;
        const len = (k: string) => (Array.isArray(r[k]) ? (r[k] as unknown[]).length : 0);
        const followupSource = len("followUps") + len("followUpSteps") + len("nurtureTouchpoints");
        const eventSource = len("caseEvents") + len("contactAttempts");
        if (followupSource > tcCase.followups.length) {
          dataQuality.push({
            entity: "cases",
            id: legacyId,
            note: `${followupSource - tcCase.followups.length} follow-up/nurture item(s) dropped (no parseable dueDate)`,
          });
        }
        if (eventSource > tcCase.events.length) {
          dataQuality.push({
            entity: "cases",
            id: legacyId,
            note: `${eventSource - tcCase.events.length} timeline event(s) dropped (no parseable timestamp)`,
          });
        }
      } catch (err) {
        errors.push({ id: legacyId, message: errMessage(err) });
      }
    }
    recon.push({
      entity: "cases",
      source: data.cases.length,
      mapped: plan.cases.length,
      imported: plan.cases.length,
      skipped,
      errors,
    });
  }

  // ── Pre-auth ─────────────────────────────────────────────────────────────
  {
    const skipped: SkippedRecord[] = [];
    const errors: ErrorRecord[] = [];
    for (const raw of data.preauth) {
      const legacyId = peekId(raw);
      if (existing.preauths.has(legacyId)) {
        skipped.push({ id: legacyId, reason: "already imported" });
        continue;
      }
      try {
        plan.preauths.push(preauthToRow(legacyPreauthToTc(raw, newId)));
      } catch (err) {
        errors.push({ id: legacyId, message: errMessage(err) });
      }
    }
    recon.push({
      entity: "preauth",
      source: data.preauth.length,
      mapped: plan.preauths.length,
      imported: plan.preauths.length,
      skipped,
      errors,
    });
  }

  // ── Email templates ──────────────────────────────────────────────────────
  const templateIdByLegacy = new Map(existing.templates);
  {
    const skipped: SkippedRecord[] = [];
    const errors: ErrorRecord[] = [];
    for (const raw of data.templates) {
      const legacyId = peekId(raw);
      if (existing.templates.has(legacyId)) {
        skipped.push({ id: legacyId, reason: "already imported" });
        continue;
      }
      try {
        const tpl = legacyTemplateToTc(raw, newId, options.defaultOffice);
        plan.templates.push(templateToRow(tpl));
        templateIdByLegacy.set(legacyId, tpl.templateId);
      } catch (err) {
        errors.push({ id: legacyId, message: errMessage(err) });
      }
    }
    recon.push({
      entity: "templates",
      source: data.templates.length,
      mapped: plan.templates.length,
      imported: plan.templates.length,
      skipped,
      errors,
    });
  }

  // ── Gallery (blob-bearing) ───────────────────────────────────────────────
  const galleryIdByLegacy = new Map(existing.gallery);
  {
    const skipped: SkippedRecord[] = [];
    const errors: ErrorRecord[] = [];
    for (const raw of data.gallery) {
      const legacyId = peekId(raw);
      if (existing.gallery.has(legacyId)) {
        skipped.push({ id: legacyId, reason: "already imported (blob keys retained)" });
        continue;
      }
      try {
        const uploads: PlannedUpload[] = [];
        const keyFor = (refRaw: unknown, which: string): string => {
          const ref = normalizeImageRef(String(refRaw ?? ""));
          const file = data.images.files.get(ref);
          if (!file) throw new Error(`${which} image file not found in data dir: ${ref}`);
          const ext = ref.slice(ref.lastIndexOf(".") + 1).toLowerCase();
          const blobKey = makeBlobKey("gallery", ext);
          uploads.push({
            blobKey,
            sourcePath: file.absPath,
            contentType: contentTypeForExt(ext),
            bytes: file.bytes,
            ownerId: legacyId,
          });
          return blobKey;
        };
        const r = raw as Record<string, unknown>;
        const before = keyFor(r.beforeImage, "before");
        const after = keyFor(r.afterImage, "after");
        const g = legacyGalleryToTc(raw, newId, options.defaultOffice, { before, after });
        plan.gallery.push({ row: galleryToRow(g), uploads });
        galleryIdByLegacy.set(legacyId, g.galleryId);
      } catch (err) {
        errors.push({ id: legacyId, message: errMessage(err) });
      }
    }
    recon.push({
      entity: "gallery",
      source: data.gallery.length,
      mapped: plan.gallery.length,
      imported: plan.gallery.length,
      skipped,
      errors,
    });
  }

  // ── Smile simulations (blob-bearing) ─────────────────────────────────────
  {
    const skipped: SkippedRecord[] = [];
    const errors: ErrorRecord[] = [];
    for (const raw of data.simulations) {
      const legacyId = peekId(raw);
      if (existing.simulations.has(legacyId)) {
        skipped.push({ id: legacyId, reason: "already imported (blob keys retained)" });
        continue;
      }
      try {
        const r = raw as Record<string, unknown>;
        const uploads: PlannedUpload[] = [];
        const keyFor = (refRaw: unknown, which: string): string => {
          const ref = normalizeImageRef(String(refRaw ?? ""));
          const file = data.images.files.get(ref);
          if (!file) throw new Error(`${which} image file not found in data dir: ${ref}`);
          const ext = ref.slice(ref.lastIndexOf(".") + 1).toLowerCase();
          const blobKey = makeBlobKey("smile-sim", ext);
          uploads.push({
            blobKey,
            sourcePath: file.absPath,
            contentType: contentTypeForExt(ext),
            bytes: file.bytes,
            ownerId: legacyId,
          });
          return blobKey;
        };
        const original = keyFor(r.originalImage, "original");
        const result = keyFor(r.simulationImage, "simulation");

        const legacyCaseId = typeof r.caseId === "string" ? r.caseId : null;
        const caseId = legacyCaseId ? (caseIdByLegacy.get(legacyCaseId) ?? null) : null;
        if (legacyCaseId && !caseId) {
          dataQuality.push({
            entity: "simulations",
            id: legacyId,
            note: `caseId '${legacyCaseId}' not found among imported cases — link set to null`,
          });
        }
        const legacyGalleryId = typeof r.galleryCaseId === "string" ? r.galleryCaseId : null;
        const galleryId = legacyGalleryId ? (galleryIdByLegacy.get(legacyGalleryId) ?? null) : null;
        if (legacyGalleryId && !galleryId) {
          dataQuality.push({
            entity: "simulations",
            id: legacyId,
            note: `galleryCaseId '${legacyGalleryId}' not found among imported gallery cases — link set to null`,
          });
        }
        const office = legacyCaseId
          ? (caseOfficeByLegacy.get(legacyCaseId) ?? options.defaultOffice)
          : options.defaultOffice;

        const sim = legacySimulationToTc(raw, newId, office, { original, result }, { caseId, galleryId });
        plan.simulations.push({ row: simulationToRow(sim), uploads });
      } catch (err) {
        errors.push({ id: legacyId, message: errMessage(err) });
      }
    }
    recon.push({
      entity: "simulations",
      source: data.simulations.length,
      mapped: plan.simulations.length,
      imported: plan.simulations.length,
      skipped,
      errors,
    });
  }

  // ── Communications ───────────────────────────────────────────────────────
  {
    const skipped: SkippedRecord[] = [];
    const errors: ErrorRecord[] = [];
    for (const raw of data.communications) {
      const legacyId = peekId(raw);
      if (existing.communications.has(legacyId)) {
        skipped.push({ id: legacyId, reason: "already imported" });
        continue;
      }
      try {
        const r = raw as Record<string, unknown>;
        const legacyCaseId = typeof r.caseId === "string" ? r.caseId : null;
        const caseId = legacyCaseId ? (caseIdByLegacy.get(legacyCaseId) ?? null) : null;
        if (legacyCaseId && !caseId) {
          dataQuality.push({
            entity: "communications",
            id: legacyId,
            note: `caseId '${legacyCaseId}' not found among imported cases — link set to null`,
          });
        }
        const legacyTemplateId = typeof r.templateId === "string" ? r.templateId : null;
        const templateId = legacyTemplateId ? (templateIdByLegacy.get(legacyTemplateId) ?? null) : null;
        if (legacyTemplateId && !templateId) {
          dataQuality.push({
            entity: "communications",
            id: legacyId,
            note: `templateId '${legacyTemplateId}' not found among imported templates — link set to null`,
          });
        }
        const office = legacyCaseId
          ? (caseOfficeByLegacy.get(legacyCaseId) ?? options.defaultOffice)
          : options.defaultOffice;
        const comm = legacyCommunicationToTc(raw, newId, office, { caseId, templateId });
        plan.communications.push(communicationToRow(comm));
      } catch (err) {
        errors.push({ id: legacyId, message: errMessage(err) });
      }
    }
    recon.push({
      entity: "communications",
      source: data.communications.length,
      mapped: plan.communications.length,
      imported: plan.communications.length,
      skipped,
      errors,
    });
  }

  // ── Library config (seeded to BOTH offices — legacy config was shared) ──
  {
    const skipped: SkippedRecord[] = [];
    const errors: ErrorRecord[] = [];
    let sourceSections = 0;
    let importedSections = 0;
    if (data.library != null) {
      const { sections, errors: sectionErrors } = legacyLibraryToSections(data.library);
      sourceSections = sections.length + sectionErrors.length;
      for (const e of sectionErrors) errors.push({ id: e.section, message: e.message });
      for (const s of sections) {
        const missingOffices = OFFICES.filter((o) => !existing.librarySections.has(`${o}:${s.section}`));
        if (missingOffices.length === 0) {
          skipped.push({ id: s.section, reason: "already imported (both offices)" });
          continue;
        }
        for (const office of missingOffices) {
          plan.librarySections.push({ office_id: office, section: s.section, value: s.value });
        }
        importedSections += 1;
      }
      dataQuality.push({
        entity: "library",
        id: "financing_settings",
        note: "not in source (legacy kept it in per-browser localStorage) — Slice 3 seeds server defaults",
      });
    }
    recon.push({
      entity: "library_sections",
      source: sourceSections,
      mapped: importedSections,
      imported: importedSections,
      skipped,
      errors,
    });
  }

  // ── Legacy user map ──────────────────────────────────────────────────────
  {
    const skipped: SkippedRecord[] = [];
    const errors: ErrorRecord[] = [];
    for (const raw of data.users) {
      const legacyId = peekId(raw);
      if (existing.userMapIds.has(legacyId)) {
        skipped.push({ id: legacyId, reason: "already imported" });
        continue;
      }
      try {
        const entry = legacyUserToMapEntry(raw, options.userEmailOverrides[legacyId]);
        if (!entry) {
          skipped.push({
            id: legacyId,
            reason: "no platform email available — provide one via --user-map",
          });
          continue;
        }
        plan.userMap.push(userMapEntryToRow(entry));
      } catch (err) {
        errors.push({ id: legacyId, message: errMessage(err) });
      }
    }
    recon.push({
      entity: "users",
      source: data.users.length,
      mapped: plan.userMap.length,
      imported: plan.userMap.length,
      skipped,
      errors,
    });
  }

  assertReconciliationBalance(recon);
  return plan;
}

/**
 * The loud failure the reconciliation contract demands: every source record
 * must be accounted for — source === imported + skipped + errors, per entity.
 */
export function assertReconciliationBalance(recon: EntityRecon[]): void {
  const broken = recon.filter(
    (r) => r.source !== r.imported + r.skipped.length + r.errors.length,
  );
  if (broken.length > 0) {
    const detail = broken
      .map(
        (r) =>
          `${r.entity}: source=${r.source} != imported=${r.imported} + skipped=${r.skipped.length} + errors=${r.errors.length}`,
      )
      .join("; ");
    throw new Error(`RECONCILIATION DOES NOT BALANCE — ${detail}`);
  }
}
