/**
 * Pipeline kanban board — BOARD_STATUSES columns in order plus the legacy
 * ghost Nurture column at the far right. Header aggregates (count + value)
 * are computed from the loaded cases; the legacy mock PIPELINE_STATS is dead.
 *
 * Moves go through the "Move to…" dropdown on each card. Choosing Lost opens
 * a dialog collecting the required lost reason (validateTransition mirrors
 * the backend guard) before the parent POSTs the transition.
 */
import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { TcCaseSummary } from "../api";
import { formatCents } from "../money";
import { BOARD_STATUSES, CASE_STATUSES, LOST_REASON_LABELS } from "../status";
import type { CaseStatusId, LostReasonId } from "../status";
import { CaseCard } from "./CaseCard";

const LOST_REASON_IDS = Object.keys(LOST_REASON_LABELS) as LostReasonId[];

export interface PipelineBoardProps {
  cases: TcCaseSummary[];
  onOpen: (caseId: string) => void;
  /**
   * Performs the guarded transition; resolves true when the server persisted
   * the move (the parent merges the returned case and toasts). The lost
   * dialog stays open with values intact when this resolves false.
   */
  onTransition: (
    caseId: string,
    status: CaseStatusId,
    lostReason: LostReasonId | null,
    note?: string,
  ) => Promise<boolean>;
}

export function PipelineBoard({ cases, onOpen, onTransition }: PipelineBoardProps) {
  const [lostTarget, setLostTarget] = useState<TcCaseSummary | null>(null);

  const byStatus = useMemo(() => {
    const map = new Map<CaseStatusId, TcCaseSummary[]>();
    for (const row of cases) {
      const list = map.get(row.status);
      if (list) list.push(row);
      else map.set(row.status, [row]);
    }
    return map;
  }, [cases]);

  const handleMove = (row: TcCaseSummary, status: CaseStatusId) => {
    if (status === "lost") {
      setLostTarget(row);
      return;
    }
    void onTransition(row.caseId, status, null);
  };

  const nurtureCases = byStatus.get("nurture") ?? [];

  return (
    <>
      <div className="overflow-x-auto pb-2">
        <div className="flex gap-4 items-start" style={{ minWidth: "max-content" }}>
          {BOARD_STATUSES.map((status) => {
            const columnCases = byStatus.get(status) ?? [];
            return (
              <BoardColumn
                key={status}
                title={CASE_STATUSES[status].label}
                cases={columnCases}
                onOpen={onOpen}
                onMove={handleMove}
              />
            );
          })}
          {/* Ghost Nurture column (legacy behavior) — visually muted, still moveable. */}
          <BoardColumn
            title={CASE_STATUSES.nurture.label}
            cases={nurtureCases}
            onOpen={onOpen}
            onMove={handleMove}
            ghost
          />
        </div>
      </div>

      <MarkLostDialog
        target={lostTarget}
        onClose={() => setLostTarget(null)}
        onConfirm={async (reason, note) => {
          if (!lostTarget) return false;
          return onTransition(lostTarget.caseId, "lost", reason, note);
        }}
      />
    </>
  );
}

// ── Column ──────────────────────────────────────────────────────────────────

function BoardColumn({
  title,
  cases,
  onOpen,
  onMove,
  ghost = false,
}: {
  title: string;
  cases: TcCaseSummary[];
  onOpen: (caseId: string) => void;
  onMove: (row: TcCaseSummary, status: CaseStatusId) => void;
  ghost?: boolean;
}) {
  const totalCents = cases.reduce((sum, c) => sum + c.caseValueCents, 0);
  return (
    <div
      className={cn(
        "w-[270px] shrink-0 flex flex-col rounded-xl",
        ghost && "opacity-60 border-2 border-dashed border-border p-2",
      )}
    >
      <div className="flex items-baseline gap-2 mb-1 shrink-0 px-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        <span className="text-xs text-muted-foreground">{cases.length}</span>
        <span className="ml-auto text-xs font-medium text-muted-foreground">
          {formatCents(totalCents)}
        </span>
      </div>
      <div className="space-y-3 overflow-y-auto flex-1 pr-1 pt-2 max-h-[calc(100vh-340px)] min-h-[120px]">
        {cases.map((row) => (
          <CaseCard
            key={row.caseId}
            caseRow={row}
            muted={ghost}
            onOpen={() => onOpen(row.caseId)}
            onMove={(status) => onMove(row, status)}
          />
        ))}
        {cases.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            No cases
          </div>
        )}
      </div>
    </div>
  );
}

// ── Mark-lost dialog ────────────────────────────────────────────────────────

function MarkLostDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: TcCaseSummary | null;
  onClose: () => void;
  /** Resolves true when the transition persisted — only then does the dialog close. */
  onConfirm: (reason: LostReasonId, note?: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState<LostReasonId | "">("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setReason("");
    setNote("");
    setSubmitting(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    if (!reason || submitting) return;
    setSubmitting(true);
    const ok = await onConfirm(reason, note.trim() === "" ? undefined : note.trim());
    setSubmitting(false);
    // On failure the parent has toasted — keep the dialog open with values intact.
    if (ok) close();
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open && !submitting) close(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark case lost</DialogTitle>
          <DialogDescription>
            {target
              ? `Why was ${target.patientName}'s case lost? A reason is required.`
              : "A lost reason is required."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tc-lost-reason">Lost reason</Label>
            <Select
              value={reason}
              onValueChange={(v) => setReason(v as LostReasonId)}
            >
              <SelectTrigger id="tc-lost-reason" className="w-full">
                <SelectValue placeholder="Select a reason…" />
              </SelectTrigger>
              <SelectContent>
                {LOST_REASON_IDS.map((id) => (
                  <SelectItem key={id} value={id}>
                    {LOST_REASON_LABELS[id]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tc-lost-note">Note (optional)</Label>
            <Textarea
              id="tc-lost-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything worth remembering about this outcome…"
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!reason || submitting}>
            {submitting && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
            Mark Lost
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
