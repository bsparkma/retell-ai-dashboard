/**
 * TC legacy importer — target interfaces.
 *
 * `ImportTarget` is the narrow DB surface the executor writes through, and
 * `BlobSink` the storage surface. Real implementations: pgTarget.ts (node-pg
 * against the tenant DB) and the backend blobStore service. Tests use
 * in-memory fakes — the executor never knows the difference.
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
import type { ExistingState } from "./types";

export interface ImportTarget {
  /** legacy id → pk uuid maps / PK sets for everything already imported. */
  fetchExistingState(): Promise<ExistingState>;

  /** All inserts for one run happen inside a single transaction. */
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;

  insertCaseAggregate(rows: TcCaseRows, legacySnapshot: unknown): Promise<void>;
  insertPreauth(row: TcPreauthRow): Promise<void>;
  insertTemplate(row: TcEmailTemplateRow): Promise<void>;
  insertCommunication(row: TcCommunicationRow): Promise<void>;
  insertGallery(row: TcGalleryRow): Promise<void>;
  insertSimulation(row: TcSmileSimulationRow): Promise<void>;
  insertLibrarySection(row: TcLibraryConfigRow): Promise<void>;
  insertUserMapEntry(row: TcLegacyUserMapRow): Promise<void>;

  close(): Promise<void>;
}

export interface BlobSink {
  upload(key: string, data: Buffer, contentType: string): Promise<void>;
}
