/**
 * TC legacy importer — shared types (Slice 2).
 *
 * The importer is a one-shot CLI that moves the legacy TC-app JSON + images
 * into the tc_* tables and Azure Blob. All legacy→contract mapping lives in
 * shared/tc/legacy.ts; this package only orchestrates: load → plan → report,
 * and (with --execute) upload + insert.
 */
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

/** One skipped source record: identified by legacy id ONLY — never PHI. */
export interface SkippedRecord {
  id: string;
  reason: string;
}

/** One failed source record (would not map / missing referenced file). */
export interface ErrorRecord {
  id: string;
  message: string;
}

/**
 * Per-entity reconciliation. Balance invariant (enforced by
 * assertReconciliationBalance): source === imported + skipped + errors.
 */
export interface EntityRecon {
  entity: string;
  source: number;
  mapped: number;
  imported: number;
  skipped: SkippedRecord[];
  errors: ErrorRecord[];
}

/** A pending image upload (bytes read lazily from sourcePath at execute). */
export interface PlannedUpload {
  blobKey: string;
  sourcePath: string;
  contentType: string;
  bytes: number;
  /** legacy entity id this upload belongs to (for reporting) */
  ownerId: string;
}

/** Informational note (dangling reference, dropped item) — record still imports. */
export interface DataQualityNote {
  entity: string;
  id: string;
  note: string;
}

export interface ImportPlan {
  options: PlanOptions;
  cases: { rows: TcCaseRows; legacySnapshot: unknown }[];
  preauths: TcPreauthRow[];
  templates: TcEmailTemplateRow[];
  communications: TcCommunicationRow[];
  gallery: { row: TcGalleryRow; uploads: PlannedUpload[] }[];
  simulations: { row: TcSmileSimulationRow; uploads: PlannedUpload[] }[];
  librarySections: TcLibraryConfigRow[];
  userMap: TcLegacyUserMapRow[];
  recon: EntityRecon[];
  dataQuality: DataQualityNote[];
  excludedFiles: string[];
  unknownFiles: string[];
}

export interface PlanOptions {
  tenantSlug: string;
  defaultOffice: "roland" | "valley";
  /** legacy user id → platform email (from --user-map) */
  userEmailOverrides: Record<string, string>;
}

/**
 * What already exists in the target DB (empty in a pure dry-run). legacy id →
 * primary-key uuid, so cross-record links resolve to existing rows on re-run.
 */
export interface ExistingState {
  cases: Map<string, string>;
  preauths: Map<string, string>;
  templates: Map<string, string>;
  communications: Map<string, string>;
  gallery: Map<string, string>;
  simulations: Map<string, string>;
  /** `${office_id}:${section}` */
  librarySections: Set<string>;
  userMapIds: Set<string>;
}

export function emptyExistingState(): ExistingState {
  return {
    cases: new Map(),
    preauths: new Map(),
    templates: new Map(),
    communications: new Map(),
    gallery: new Map(),
    simulations: new Map(),
    librarySections: new Set(),
    userMapIds: new Set(),
  };
}
