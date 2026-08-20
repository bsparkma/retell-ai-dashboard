/**
 * Pipeline board card — one case on the kanban. Click opens the case page;
 * the card also drags between columns, and the "Move to…" dropdown stays on
 * as the keyboard/touch fallback. Both gestures run the SAME guarded
 * transition: a drag is never optimistic — the card holds its place, dimmed
 * via `pending`, until the server answers and the board re-renders from the
 * returned row.
 *
 * CaseCardBody is the visual, split out so the board's DragOverlay can render
 * an identical-looking card WITHOUT registering a second draggable under the
 * same caseId (which would overwrite the real card's node in dnd-kit's
 * registry and break the drop).
 */
import { useDraggable } from "@dnd-kit/core";
import { ArrowRightLeft, Clock, Loader2, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { TcCaseSummary } from "../api";
import { formatCents } from "../money";
import { ALL_CASE_STATUSES, caseStatusLabel } from "../status";
import type { CaseStatusId } from "../status";
import { UrgencyBadge } from "../components/TcShell";
import { OfficeBadge } from "../components/OfficeBadge";

/** Whole days the case has sat in its current status (statusChangedAt, falling back to createdAt). */
export function daysInStatus(row: TcCaseSummary): number {
  const ref = row.statusChangedAt ?? row.createdAt;
  const t = new Date(ref).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

export function CaseCardBody({
  caseRow,
  onMove,
  pending = false,
  showOfficeBadge = false,
}: {
  caseRow: TcCaseSummary;
  /** Requested status move — the parent validates + transitions (lost opens the reason dialog). */
  onMove: (status: CaseStatusId) => void;
  pending?: boolean;
  showOfficeBadge?: boolean;
}) {
  const days = daysInStatus(caseRow);
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground truncate">
            {caseRow.patientName}
          </div>
          {caseRow.caseType && (
            <div className="text-[11px] text-muted-foreground truncate">{caseRow.caseType}</div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {pending && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={pending}
                className="h-6 w-6 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100"
                aria-label={`Move ${caseRow.patientName} to another status`}
                // The card is draggable AND click-to-open: the menu owns both
                // of those events so neither fires behind it.
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <ArrowRightLeft className="w-3.5 h-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuLabel>Move to…</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {ALL_CASE_STATUSES.map((status) => (
                <DropdownMenuItem
                  key={status}
                  disabled={status === caseRow.status}
                  onSelect={() => onMove(status)}
                >
                  {caseStatusLabel(status)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mt-2 text-sm font-bold text-foreground">
        {formatCents(caseRow.caseValueCents)}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <UrgencyBadge urgency={caseRow.urgency} />
          {showOfficeBadge && <OfficeBadge officeId={caseRow.officeId} />}
        </div>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Clock className="w-3 h-3" />
          {days}d in stage
        </span>
      </div>

      {caseRow.assignedTc && (
        <div className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground truncate">
          <User className="w-3 h-3 shrink-0" />
          {caseRow.assignedTc}
        </div>
      )}
    </>
  );
}

export function CaseCard({
  caseRow,
  onOpen,
  onMove,
  pending = false,
  muted = false,
  showOfficeBadge = false,
}: {
  caseRow: TcCaseSummary;
  onOpen: () => void;
  /** Requested status move — the parent validates + transitions (lost opens the reason dialog). */
  onMove: (status: CaseStatusId) => void;
  /** A transition for this case is in flight: dimmed, and drag is disabled. */
  pending?: boolean;
  /** Ghost styling for the Nurture column. */
  muted?: boolean;
  /** All-offices view: show which office this case belongs to. */
  showOfficeBadge?: boolean;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: caseRow.caseId,
    disabled: pending,
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      // Deliberately no transform: the card never leaves its own column while
      // the move is unconfirmed — the board's DragOverlay follows the cursor.
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`${caseRow.patientName}, ${caseStatusLabel(caseRow.status)}. Open the case, or drag to another column.`}
      className={cn(
        "group bg-card rounded-xl border border-border p-3 hover:shadow-md transition-shadow text-left",
        "cursor-grab active:cursor-grabbing",
        muted && "opacity-70",
        isDragging && "opacity-40",
        pending && "opacity-50 cursor-progress",
      )}
    >
      <CaseCardBody
        caseRow={caseRow}
        onMove={onMove}
        pending={pending}
        showOfficeBadge={showOfficeBadge}
      />
    </div>
  );
}
