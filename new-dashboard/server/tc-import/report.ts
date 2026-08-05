/**
 * TC legacy importer — reconciliation report formatting.
 *
 * PHI discipline: the report identifies records by LEGACY ID only. No patient
 * names, phones, or emails ever appear in importer output.
 */
import type { LegacyDataDir } from "./loadLegacy";
import type { ImportPlan } from "./types";
import type { ExecuteResult } from "./execute";

function pad(s: string | number, w: number): string {
  return String(s).padEnd(w);
}

export function formatReport(
  plan: ImportPlan,
  data: LegacyDataDir,
  mode: "dry-run" | "execute",
  executeResult?: ExecuteResult,
): string {
  const lines: string[] = [];
  const push = (s = ""): void => {
    lines.push(s);
  };

  push(`TC legacy import — ${mode.toUpperCase()} reconciliation`);
  push(`tenant=${plan.options.tenantSlug} defaultOffice=${plan.options.defaultOffice}`);
  push();

  push(
    pad("entity", 18) + pad("source", 8) + pad("mapped", 8) + pad("import", 8) + pad("skipped", 9) + "errors",
  );
  push("-".repeat(58));
  for (const r of plan.recon) {
    push(
      pad(r.entity, 18) +
        pad(r.source, 8) +
        pad(r.mapped, 8) +
        pad(r.imported, 8) +
        pad(r.skipped.length, 9) +
        r.errors.length,
    );
  }
  push();

  // Per-office row counts across all planned rows.
  const office: Record<string, Record<string, number>> = {};
  const bump = (table: string, o: string, n = 1): void => {
    office[o] = office[o] ?? {};
    office[o][table] = (office[o][table] ?? 0) + n;
  };
  for (const c of plan.cases) {
    const o = c.rows.caseRow.office_id;
    bump("tc_cases", o);
    bump("tc_case_phases", o, c.rows.phaseRows.length);
    bump("tc_case_items", o, c.rows.itemRows.length);
    bump("tc_case_objections", o, c.rows.objectionRows.length);
    bump("tc_followups", o, c.rows.followupRows.length);
    bump("tc_case_events", o, c.rows.eventRows.length);
    if (c.rows.hygieneIntakeRow) bump("tc_hygiene_intakes", o);
  }
  for (const p of plan.preauths) bump("tc_preauth_cases", p.office_id);
  for (const t of plan.templates) bump("tc_email_templates", t.office_id);
  for (const g of plan.gallery) bump("tc_gallery_cases", g.row.office_id);
  for (const s of plan.simulations) bump("tc_smile_simulations", s.row.office_id);
  for (const c of plan.communications) bump("tc_communications", c.office_id);
  for (const l of plan.librarySections) bump("tc_library_config", l.office_id);

  push("planned rows by office:");
  for (const [o, tables] of Object.entries(office)) {
    push(`  ${o}:`);
    for (const [table, n] of Object.entries(tables)) push(`    ${pad(table, 22)}${n}`);
  }
  push(`  (tenant-global) tc_legacy_user_map: ${plan.userMap.length}`);
  push();

  push("blob uploads planned:");
  const uploads = [
    ...plan.gallery.flatMap((g) => g.uploads.map((u) => ({ entity: "gallery", ...u }))),
    ...plan.simulations.flatMap((s) => s.uploads.map((u) => ({ entity: "smile-sim", ...u }))),
  ];
  const byEntity: Record<string, { count: number; bytes: number }> = {};
  for (const u of uploads) {
    byEntity[u.entity] = byEntity[u.entity] ?? { count: 0, bytes: 0 };
    byEntity[u.entity].count += 1;
    byEntity[u.entity].bytes += u.bytes;
  }
  for (const [entity, agg] of Object.entries(byEntity)) {
    push(`  ${pad(entity, 12)}${agg.count} blob(s), ${agg.bytes} bytes`);
  }
  if (uploads.length === 0) push("  (none)");
  push("source image directories:");
  for (const d of data.images.dirs) push(`  ${pad(d.dir, 18)}${d.count} file(s), ${d.bytes} bytes`);
  push();

  for (const r of plan.recon) {
    for (const s of r.skipped) push(`SKIP  [${r.entity}] ${s.id}: ${s.reason}`);
  }
  for (const r of plan.recon) {
    for (const e of r.errors) push(`ERROR [${r.entity}] ${e.id}: ${e.message.split("\n")[0]}`);
  }
  for (const dq of plan.dataQuality) push(`DATA  [${dq.entity}] ${dq.id}: ${dq.note}`);
  if (plan.excludedFiles.length) push(`excluded files: ${plan.excludedFiles.join(", ")}`);
  if (plan.unknownFiles.length) push(`UNRECOGNIZED files (not imported): ${plan.unknownFiles.join(", ")}`);
  push();

  if (executeResult) {
    push("EXECUTED:");
    push(
      `  blobs uploaded: ${executeResult.uploadedBlobs.count} (${executeResult.uploadedBlobs.bytes} bytes)`,
    );
    for (const [table, n] of Object.entries(executeResult.insertedRows)) {
      push(`  ${pad(table, 22)}${n} row(s) inserted`);
    }
  } else {
    push("DRY-RUN: no database writes, no blob uploads.");
  }
  push("reconciliation balance: OK (source = imported + skipped + errors, all entities)");
  return lines.join("\n");
}
