/**
 * TC legacy importer — execution stage.
 *
 * Mechanically applies an ImportPlan: upload the planned blobs, then insert
 * every planned row inside ONE transaction (FK parents before children).
 * Any insert failure rolls the whole run back — a partial import never
 * commits. Blobs uploaded before a rollback are orphans under uuid keys;
 * they are reported, harmless, and cleaned up by re-provisioning or soft
 * delete expiry.
 */
import * as fs from "node:fs";
import type { ImportPlan, PlannedUpload } from "./types";
import type { BlobSink, ImportTarget } from "./target";

export interface ExecuteResult {
  uploadedBlobs: { count: number; bytes: number };
  insertedRows: Record<string, number>;
}

export async function executePlan(
  plan: ImportPlan,
  target: ImportTarget,
  blobs: BlobSink,
): Promise<ExecuteResult> {
  const pendingUploads: PlannedUpload[] = [
    ...plan.gallery.flatMap((g) => g.uploads),
    ...plan.simulations.flatMap((s) => s.uploads),
  ];

  let uploadedBytes = 0;
  for (const u of pendingUploads) {
    const data = fs.readFileSync(u.sourcePath);
    await blobs.upload(u.blobKey, data, u.contentType);
    uploadedBytes += data.length;
  }

  const inserted: Record<string, number> = {
    tc_cases: 0,
    tc_preauth_cases: 0,
    tc_email_templates: 0,
    tc_gallery_cases: 0,
    tc_smile_simulations: 0,
    tc_communications: 0,
    tc_library_config: 0,
    tc_legacy_user_map: 0,
  };

  await target.begin();
  try {
    for (const c of plan.cases) {
      await target.insertCaseAggregate(c.rows, c.legacySnapshot);
      inserted.tc_cases += 1;
    }
    for (const row of plan.preauths) {
      await target.insertPreauth(row);
      inserted.tc_preauth_cases += 1;
    }
    for (const row of plan.templates) {
      await target.insertTemplate(row);
      inserted.tc_email_templates += 1;
    }
    for (const g of plan.gallery) {
      await target.insertGallery(g.row);
      inserted.tc_gallery_cases += 1;
    }
    for (const s of plan.simulations) {
      await target.insertSimulation(s.row);
      inserted.tc_smile_simulations += 1;
    }
    for (const row of plan.communications) {
      await target.insertCommunication(row);
      inserted.tc_communications += 1;
    }
    for (const row of plan.librarySections) {
      await target.insertLibrarySection(row);
      inserted.tc_library_config += 1;
    }
    for (const row of plan.userMap) {
      await target.insertUserMapEntry(row);
      inserted.tc_legacy_user_map += 1;
    }
    await target.commit();
  } catch (err) {
    await target.rollback();
    throw err;
  }

  return {
    uploadedBlobs: { count: pendingUploads.length, bytes: uploadedBytes },
    insertedRows: inserted,
  };
}
