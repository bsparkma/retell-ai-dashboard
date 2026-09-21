/**
 * The perio send's confirmation (item 12) — exactly what will be written, and how.
 *
 * THE PREVIEW IS THE WRITE. The lines listed are the SERVER's staged preview, and
 * the confirm carries their fingerprint. The exam date and the provider are shown
 * because the preview does not carry them; they go back with the confirm so the
 * server can refuse if either changed.
 *
 * "How it goes in" is `planPerioSend` — the SAME function the server plans the send
 * with — so an arch this dialog says goes as one request is the arch the server
 * sends as one request, and the reason an arch goes row by row (a reading of 10 or
 * more, a gap, a flag with no depth) is stated before anything is written.
 */
import { AlertTriangle, Loader2, Send } from "lucide-react";

import { type StagedWrite } from "@shared/hyg/contract";
import { countPerioChart, type PerioChart } from "@shared/hyg/perio";
import {
  estimatePerioSendRequests,
  perioChangeLine,
  planPerioSend,
  type PerioSiteChange,
} from "@shared/hyg/perioSend";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const TAP = "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors";

/**
 * The provider an exam is filed under: the hygienist, else the provider. The
 * SAME rule the server applies (services/hyg/perioSend.js provNumFor); both
 * confirms — the chart page's and the visit Send's — carry this number, and the
 * server refuses if its own differs.
 */
export function perioProvNumOf(appointment: { provHyg: number | null; provNum: number | null }): number | null {
  if (appointment.provHyg !== null && appointment.provHyg > 0) return appointment.provHyg;
  if (appointment.provNum !== null && appointment.provNum > 0) return appointment.provNum;
  return null;
}

/** "about 20 seconds" — an estimate at one request a second, and worded as one. */
export function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "a moment";
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}

export function PerioSendConfirm({
  open,
  write,
  chart,
  patientName,
  examDate,
  providerLabel,
  busy,
  replacesExamNum = null,
  changes = [],
  onCancel,
  onConfirm,
}: {
  open: boolean;
  write: StagedWrite;
  chart: PerioChart;
  patientName: string;
  examDate: string;
  providerLabel: string;
  busy: boolean;
  /** Item 13: the exam this correction replaces, or null on a first send. */
  replacesExamNum?: number | null;
  /** Every site this correction changes, old → new. */
  changes?: PerioSiteChange[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const counts = countPerioChart(chart);
  const plan = planPerioSend(chart);
  const strings = Object.keys(plan.strings).length;
  const seconds = estimatePerioSendRequests({ examCreated: false, rowsRemaining: plan.rows.length });
  const shape =
    plan.rows.length === 0
      ? `One request: the exam and ${strings} ${strings === 1 ? "arch" : "arches"} together`
      : `The exam${strings > 0 ? ` with ${strings} ${strings === 1 ? "arch" : "arches"}` : ""}, then ${plan.rows.length} ${plan.rows.length === 1 ? "row" : "rows"} one at a time`;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-testid="hyg-perio-confirm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-4 w-4" />
            {replacesExamNum === null
              ? "Write this perio chart to Open Dental?"
              : `Correct exam ${replacesExamNum} in Open Dental?`}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3" data-testid="hyg-perio-confirm-body">
              <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Patient</dt>
                <dd className="font-medium text-foreground">{patientName}</dd>
                <dt className="text-muted-foreground">Exam date</dt>
                <dd className="font-medium text-foreground" data-testid="hyg-perio-confirm-date">{examDate}</dd>
                <dt className="text-muted-foreground">Provider</dt>
                <dd className="font-medium text-foreground" data-testid="hyg-perio-confirm-provider">{providerLabel}</dd>
                <dt className="text-muted-foreground">Sites</dt>
                <dd className="text-foreground" data-testid="hyg-perio-confirm-sites">
                  {counts.sitesCharted} of {counts.sitesExpected} charted
                  {counts.teethSkipped.length > 0
                    ? `, ${counts.teethSkipped.map((t) => "#" + t).join(", ")} skipped`
                    : ""}
                </dd>
                <dt className="text-muted-foreground">Open Dental</dt>
                <dd className="text-foreground" data-testid="hyg-perio-confirm-shape">
                  {shape}, then every site read back — about {formatRemaining(seconds)}
                </dd>
              </dl>

              {/*
                ITEM 13: A HYGIENIST CONFIRMING A CORRECTION SEES THE CORRECTION.
                Every changed site, old → new — not a summary, and not a count.
              */}
              {replacesExamNum !== null ? (
                <div className="rounded-lg border border-primary/50" data-testid="hyg-perio-confirm-changes">
                  <p className="border-b border-border px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    What changes ({changes.length} {changes.length === 1 ? "site" : "sites"})
                  </p>
                  <ul className="max-h-40 space-y-0.5 overflow-y-auto p-2 text-sm tabular-nums">
                    {changes.map((change, i) => (
                      <li key={i} className="text-foreground">
                        {perioChangeLine(change)}
                      </li>
                    ))}
                    {changes.length === 0 ? (
                      <li className="text-muted-foreground">Nothing is different from the exam in Open Dental.</li>
                    ) : null}
                  </ul>
                </div>
              ) : null}

              <div className="rounded-lg border border-border" data-testid="hyg-perio-confirm-arches">
                <p className="border-b border-border px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  How it goes in
                </p>
                <ul className="divide-y divide-border text-sm">
                  {plan.arches.map((arch) => (
                    <li
                      key={arch.field}
                      className="flex flex-wrap items-baseline justify-between gap-x-3 px-2 py-1.5"
                      data-testid={`hyg-perio-confirm-arch-${arch.field}`}
                    >
                      <span className="font-medium text-foreground">{arch.label}</span>
                      <span
                        className={cn(
                          "text-xs",
                          arch.path === "per_row" ? "text-amber-800 dark:text-amber-300" : "text-muted-foreground",
                        )}
                      >
                        {arch.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-sm text-amber-800 dark:text-amber-300">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                {replacesExamNum === null ? (
                  <>
                    If any site does not read back exactly as charted, the chart is NOT marked written, the
                    screen names the sites, and you can delete the exam. If anything on this chart changes
                    before you confirm, nothing is sent.
                  </>
                ) : (
                  <>
                    The corrected exam is written FIRST and every site of it read back. Exam{" "}
                    {replacesExamNum} is deleted only after that succeeds — if anything fails, nothing is
                    deleted and the patient keeps the exam they have. The two exist together for a moment,
                    on the same date.
                  </>
                )}
              </p>

              <ul
                className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-border p-2 text-xs"
                data-testid="hyg-perio-confirm-preview"
              >
                {write.preview.map((line, i) => (
                  <li key={i} className={cn(line.startsWith("  ") && "pl-3")}>
                    {line.trim()}
                  </li>
                ))}
              </ul>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button type="button" onClick={onCancel} disabled={busy} className={cn(TAP, "border-transparent text-muted-foreground")}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            data-testid="hyg-perio-confirm-accept"
            className={cn(TAP, "border-primary bg-primary text-primary-foreground")}
          >
            {busy ? <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" /> : null}
            {replacesExamNum === null ? "Write to Open Dental" : "Send correction"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
