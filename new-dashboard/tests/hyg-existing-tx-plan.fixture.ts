/**
 * A SYNTHETIC 30-item existing-treatment plan, for the compact-round tests and
 * the report's screenshots. No patient, no fees — ProcNums from 7001.
 *
 * 18 recent items on 12 teeth (a crown / build-up / post on #30, quadrant SRP,
 * a whole-mouth guard), 2 on Watch, 3 answered (two urgent on #30, one declined
 * that is older than 24 months and so stays in view), 3 already scheduled, and
 * 8 planned more than 24 months before the 2026-09-08 visit.
 */
import type { ExistingTxDisposition, ExistingTxItem } from "@shared/hyg/existingTx";

function item(procNum: number, over: Partial<ExistingTxItem> = {}): ExistingTxItem {
  return {
    procNum,
    code: "D2391",
    description: "Resin-based composite - one surface, posterior",
    tooth: "30",
    surface: "O",
    dateTp: "2026-05-01",
    priorityName: null,
    watch: false,
    scheduled: false,
    disposition: null,
    lastDiscussed: null,
    ...over,
  };
}

function answered(over: Partial<ExistingTxDisposition>): ExistingTxDisposition {
  return {
    clinical: null,
    patient: "not_discussed",
    waitTimeframe: null,
    note: null,
    updatedBy: "hygienist@carein.ai",
    updatedAt: "2026-09-08T13:05:00.000Z",
    ...over,
  };
}

export function thirtyItemPlan(): ExistingTxItem[] {
  const out: ExistingTxItem[] = [];
  let n = 7001;
  const add = (over: Partial<ExistingTxItem>) => out.push(item(n++, over));
  add({ tooth: "30", code: "D2740", description: "Crown - porcelain/ceramic", surface: "", dateTp: "2026-06-20", disposition: answered({ clinical: "worse_urgent", patient: "wants_to_wait", waitTimeframe: "3_months" }) });
  add({ tooth: "30", code: "D2950", description: "Core buildup, including any pins", surface: "", dateTp: "2026-06-20", disposition: answered({ clinical: "worse_urgent", patient: "wants_to_wait", waitTimeframe: "3_months" }) });
  add({ tooth: "30", code: "D2954", description: "Prefabricated post and core", surface: "", dateTp: "2026-06-20" });
  add({ tooth: "3", code: "D2391", surface: "O", dateTp: "2026-02-11" });
  add({ tooth: "14", code: "D2392", description: "Resin-based composite - two surfaces, posterior", surface: "MO", dateTp: "2025-11-03" });
  add({ tooth: "19", code: "D3330", description: "Endodontic therapy, molar tooth", surface: "", dateTp: "2025-09-14" });
  add({ tooth: "19", code: "D2740", description: "Crown - porcelain/ceramic", surface: "", dateTp: "2025-09-14" });
  add({ tooth: "8", code: "D2330", description: "Resin-based composite - one surface, anterior", surface: "M", dateTp: "2026-01-20" });
  add({ tooth: "9", code: "D2330", description: "Resin-based composite - one surface, anterior", surface: "D", dateTp: "2026-01-20" });
  add({ tooth: "2", code: "D2393", description: "Resin-based composite - three surfaces, posterior", surface: "MOD", dateTp: "2025-04-02" });
  add({ tooth: "31", code: "D2391", surface: "O", dateTp: "2025-12-01", watch: true, priorityName: "Watch" });
  add({ tooth: "18", code: "D2391", surface: "O", dateTp: "2026-03-09", watch: true, priorityName: "Watch" });
  add({ tooth: "", code: "D4341", description: "Periodontal scaling and root planing - four or more teeth per quadrant", surface: "UR", dateTp: "2026-04-18" });
  add({ tooth: "", code: "D4341", description: "Periodontal scaling and root planing - four or more teeth per quadrant", surface: "UL", dateTp: "2026-04-18" });
  add({ tooth: "", code: "D9944", description: "Occlusal guard - hard appliance, full arch", surface: "", dateTp: "2025-10-10" });
  add({ tooth: "12", code: "D2391", surface: "O", dateTp: "2025-07-07" });
  add({ tooth: "13", code: "D2391", surface: "O", dateTp: "2025-07-07" });
  add({ tooth: "20", code: "D2391", surface: "O", dateTp: "2026-08-01" });
  // Already scheduled.
  add({ tooth: "15", code: "D2740", description: "Crown - porcelain/ceramic", surface: "", dateTp: "2026-05-05", scheduled: true });
  add({ tooth: "15", code: "D2950", description: "Core buildup, including any pins", surface: "", dateTp: "2026-05-05", scheduled: true });
  add({ tooth: "4", code: "D2391", surface: "O", dateTp: "2026-05-05", scheduled: true });
  // Older than 24 months; one of them answered, so it stays in view.
  add({ tooth: "29", code: "D2391", surface: "O", dateTp: "2023-03-01" });
  add({ tooth: "28", code: "D2391", surface: "O", dateTp: "2022-11-15" });
  add({ tooth: "21", code: "D2391", surface: "O", dateTp: "2021-06-30" });
  add({ tooth: "5", code: "D2391", surface: "O", dateTp: "2023-08-08" });
  add({ tooth: "6", code: "D2330", description: "Resin-based composite - one surface, anterior", surface: "F", dateTp: "2020-02-02" });
  add({ tooth: "7", code: "D2330", description: "Resin-based composite - one surface, anterior", surface: "F", dateTp: "2020-02-02" });
  add({ tooth: "10", code: "D2330", description: "Resin-based composite - one surface, anterior", surface: "F", dateTp: "2023-01-01" });
  add({ tooth: "11", code: "D2330", description: "Resin-based composite - one surface, anterior", surface: "F", dateTp: "2022-04-04" });
  add({ tooth: "3", code: "D1354", description: "Interim caries arresting medicament", surface: "", dateTp: "2022-02-02", disposition: answered({ patient: "declined" }) });
  return out;
}
