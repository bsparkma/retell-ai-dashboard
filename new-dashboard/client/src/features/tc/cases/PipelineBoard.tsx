/**
 * Pipeline kanban board — BOARD_STATUSES columns in order plus the legacy
 * ghost Nurture column at the far right. Header aggregates (count + value)
 * are computed from the loaded cases; the legacy mock PIPELINE_STATS is dead.
 *
 * Moves go through the "Move to…" dropdown on each card OR by dragging the
 * card into another column — both run the same guarded transition. Choosing
 * (or dropping on) Lost opens a dialog collecting the required lost reason
 * (validateTransition mirrors the backend guard) before the parent POSTs.
 *
 * No optimistic moves: a dropped card stays in its original column, dimmed
 * and undraggable, until onTransition resolves; the board only changes when
 * the parent merges the row the server returned. A failed move never looks
 * like it happened.
 *
 * There is no Lost column — every lost case ever would pile up in it — so the
 * lost drop target is a strip that exists only while a drag is in progress.
 */
import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Loader2, XCircle } from "lucide-react";
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
import { CaseCard, CaseCardBody } from "./CaseCard";
import { caseColumnDroppableId, LOST_DROPPABLE_ID, resolvePipelineDrop } from "./pipelineDnd";

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
  /** All-offices view: cards carry an office badge. */
  showOfficeBadges?: boolean;
}

export function PipelineBoard({
  cases,
  onOpen,
  onTransition,
  showOfficeBadges = false,
}: PipelineBoardProps) {
  const [lostTarget, setLostTarget] = useState<TcCaseSummary | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<string[]>([]);

  // A plain click must still open the case; only a real ~8px drag takes the
  // gesture over.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const byStatus = useMemo(() => {
    const map = new Map<CaseStatusId, TcCaseSummary[]>();
    for (const row of cases) {
      const list = map.get(row.status);
      if (list) list.push(row);
      else map.set(row.status, [row]);
    }
    return map;
  }, [cases]);

  /** Holds the card visibly pending for the life of the request. */
  const runTransition = async (
    caseId: string,
    status: CaseStatusId,
    lostReason: LostReasonId | null,
    note?: string,
  ): Promise<boolean> => {
    setPendingIds((prev) => (prev.includes(caseId) ? prev : [...prev, caseId]));
    try {
      return await onTransition(caseId, status, lostReason, note);
    } finally {
      setPendingIds((prev) => prev.filter((id) => id !== caseId));
    }
  };

  const handleMove = (row: TcCaseSummary, status: CaseStatusId) => {
    if (status === "lost") {
      setLostTarget(row);
      return;
    }
    void runTransition(row.caseId, status, null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const dragged = cases.find((c) => c.caseId === String(event.active.id));
    if (!dragged) return;
    const action = resolvePipelineDrop(dragged.status, event.over?.id);
    // Lost is never a bare drop: it opens the same reason dialog the menu does.
    if (action.kind === "lost") setLostTarget(dragged);
    else if (action.kind === "transition") void runTransition(dragged.caseId, action.status, null);
  };

  const activeCard = activeId === null ? null : cases.find((c) => c.caseId === activeId) ?? null;
  const nurtureCases = byStatus.get("nurture") ?? [];

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        // Always: the columns scroll under the drag and the lost strip mounts
        // mid-drag, so rects measured once at drag start would be stale.
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={(event: DragStartEvent) => setActiveId(String(event.active.id))}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="overflow-x-auto pb-2">
          <div className="flex gap-4 items-start" style={{ minWidth: "max-content" }}>
            {BOARD_STATUSES.map((status) => (
              <BoardColumn
                key={status}
                status={status}
                cases={byStatus.get(status) ?? []}
                pendingIds={pendingIds}
                onOpen={onOpen}
                onMove={handleMove}
                showOfficeBadges={showOfficeBadges}
              />
            ))}
            {/* Ghost Nurture column (legacy behavior) — visually muted, still moveable. */}
            <BoardColumn
              status="nurture"
              cases={nurtureCases}
              pendingIds={pendingIds}
              onOpen={onOpen}
              onMove={handleMove}
              showOfficeBadges={showOfficeBadges}
              ghost
            />
            {activeCard && <LostDropZone />}
          </div>
        </div>

        <DragOverlay dropAnimation={null}>
          {activeCard && (
            <div className="w-[266px] bg-card rounded-xl border border-primary/50 p-3 shadow-xl cursor-grabbing pointer-events-none">
              <CaseCardBody
                caseRow={activeCard}
                onMove={() => undefined}
                showOfficeBadge={showOfficeBadges}
              />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      <MarkLostDialog
        target={lostTarget}
        onClose={() => setLostTarget(null)}
        onConfirm={async (reason, note) => {
          if (!lostTarget) return false;
          return runTransition(lostTarget.caseId, "lost", reason, note);
        }}
      />
    </>
  );
}

// ── Column ──────────────────────────────────────────────────────────────────

function BoardColumn({
  status,
  cases,
  pendingIds,
  onOpen,
  onMove,
  showOfficeBadges = false,
  ghost = false,
}: {
  status: CaseStatusId;
  cases: TcCaseSummary[];
  pendingIds: string[];
  onOpen: (caseId: string) => void;
  onMove: (row: TcCaseSummary, status: CaseStatusId) => void;
  showOfficeBadges?: boolean;
  ghost?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: caseColumnDroppableId(status) });
  const totalCents = cases.reduce((sum, c) => sum + c.caseValueCents, 0);
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "w-[270px] shrink-0 flex flex-col rounded-xl transition-colors",
        ghost && "opacity-60 border-2 border-dashed border-border p-2",
        isOver && "bg-muted/60 ring-2 ring-primary/30 opacity-100",
      )}
    >
      <div className="flex items-baseline gap-2 mb-1 shrink-0 px-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {CASE_STATUSES[status].label}
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
            pending={pendingIds.includes(row.caseId)}
            showOfficeBadge={showOfficeBadges}
            onOpen={() => onOpen(row.caseId)}
            onMove={(next) => onMove(row, next)}
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

// ── Lost drop target ────────────────────────────────────────────────────────

/**
 * Drop-only "mark lost" strip, present ONLY while a drag is in progress. A
 * drop here can never be the whole decision: the backend refuses a lost move
 * with no reason, so this opens the very same MarkLostDialog the "Move to…"
 * menu opens.
 */
function LostDropZone() {
  const { setNodeRef, isOver } = useDroppable({ id: LOST_DROPPABLE_ID });
  return (
    <div
      ref={setNodeRef}
      aria-label="Drop here to mark the case lost"
      className={cn(
        "w-[200px] shrink-0 self-stretch min-h-[160px] rounded-xl border-2 border-dashed",
        "flex flex-col items-center justify-center gap-2 px-3 text-center transition-colors",
        isOver
          ? "border-red-500 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-300"
          : "border-border text-muted-foreground",
      )}
    >
      <XCircle className="w-5 h-5" />
      <span className="text-xs font-medium">Drop here to mark lost</span>
      <span className="text-[11px] opacity-80">Asks for a reason first</span>
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
