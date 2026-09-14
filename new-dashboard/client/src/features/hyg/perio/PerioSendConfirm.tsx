/**
 * The perio send's confirmation (H4 slice 11) — exactly what will be written.
 *
 * THE PREVIEW IS THE WRITE. The lines listed are the SERVER's staged preview,
 * and the confirm carries their fingerprint. The exam date and the provider are
 * shown here because the preview does not carry them, and they go back with the
 * confirm so the server can refuse if either changed.
 *
 * The counts (sites, flags, rows, time) are computed from the chart on screen
 * with the same shared function the server plans the queue with. They describe;
 * the fingerprint gates.
 */
import { AlertTriangle, Loader2, Send } from "lucide-react";

import { type StagedWrite } from "@shared/hyg/contract";
import {
  countPerioChart,
  estimatePerioSendRequests,
  perioMeasureRows,
  type PerioChart,
} from "@shared/hyg/perio";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatRemaining } from "./PerioSendPanel";

const TAP = "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors";

export function PerioSendConfirm({
  open,
  write,
  chart,
  patientName,
  examDate,
  providerLabel,
  busy,
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
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const counts = countPerioChart(chart);
  const rows = perioMeasureRows(chart).length;
  const seconds = estimatePerioSendRequests({ examConfirmed: false, rowsRemaining: rows });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl" data-testid="hyg-perio-confirm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-4 w-4" />
            Write this perio chart to Open Dental?
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
                <dt className="text-muted-foreground">Flags</dt>
                <dd className="text-foreground" data-testid="hyg-perio-confirm-flags">
                  bleeding {counts.bleeding} · suppuration {counts.suppuration} · plaque {counts.plaque} · calculus {counts.calculus}
                </dd>
                <dt className="text-muted-foreground">Open Dental</dt>
                <dd className="text-foreground" data-testid="hyg-perio-confirm-rows">
                  1 exam and {rows} measurement rows, each read back — about {formatRemaining(seconds)}
                </dd>
              </dl>

              <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-sm text-amber-800 dark:text-amber-300">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                A probing row cannot be deleted from Open Dental once it is written. Check the readings
                below. If anything on this chart changes before you confirm, nothing is sent.
              </p>

              <ul className="max-h-60 space-y-0.5 overflow-y-auto rounded-lg border border-border p-2 text-xs" data-testid="hyg-perio-confirm-preview">
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
            Write {rows} rows to Open Dental
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
