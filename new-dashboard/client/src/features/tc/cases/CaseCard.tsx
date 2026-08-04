/**
 * Pipeline board card — one case on the kanban. Click opens the case page;
 * the "Move to…" dropdown replaces the legacy drag-and-drop (no DnD in the
 * platform port — explicit moves through the guarded transition path).
 */
import { ArrowRightLeft, Clock, User } from "lucide-react";
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

/** Whole days the case has sat in its current status (statusChangedAt, falling back to createdAt). */
export function daysInStatus(row: TcCaseSummary): number {
  const ref = row.statusChangedAt ?? row.createdAt;
  const t = new Date(ref).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

export function CaseCard({
  caseRow,
  onOpen,
  onMove,
  muted = false,
}: {
  caseRow: TcCaseSummary;
  onOpen: () => void;
  /** Requested status move — the parent validates + transitions (lost opens the reason dialog). */
  onMove: (status: CaseStatusId) => void;
  /** Ghost styling for the Nurture column. */
  muted?: boolean;
}) {
  const days = daysInStatus(caseRow);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group bg-card rounded-xl border border-border p-3 hover:shadow-md transition-shadow cursor-pointer text-left",
        muted && "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground truncate">
            {caseRow.patientName}
          </div>
          {caseRow.caseType && (
            <div className="text-[11px] text-muted-foreground truncate">{caseRow.caseType}</div>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100"
              aria-label={`Move ${caseRow.patientName} to another status`}
              onClick={(e) => e.stopPropagation()}
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

      <div className="mt-2 text-sm font-bold text-foreground">
        {formatCents(caseRow.caseValueCents)}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <UrgencyBadge urgency={caseRow.urgency} />
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
    </div>
  );
}
