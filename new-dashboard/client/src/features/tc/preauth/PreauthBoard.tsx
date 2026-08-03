/**
 * Pre-auth kanban board — 7 status columns (PREAUTH_BOARD_STATUSES order).
 *
 * Presentational: the page owns data + dialogs. Cards move via an explicit
 * "Move to…" menu (no drag-and-drop — the server stamps submittedDate /
 * decisionDate on transition, so every move is a confirmed API call).
 */
import type { z } from "zod";
import type { PreauthType, TcPreauthCase } from "@shared/tc/contract";
import { PREAUTH_BOARD_STATUSES, PREAUTH_STATUSES, type PreauthStatusId } from "../status";
import { PreauthStatusBadge } from "../components/TcShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowRightLeft,
  Building2,
  CalendarClock,
  Hash,
  MoreHorizontal,
  Pencil,
  Stethoscope,
  Trash2,
} from "lucide-react";

type PreauthTypeId = z.infer<typeof PreauthType>;

export const PREAUTH_TYPE_LABELS: Record<PreauthTypeId, string> = {
  treatment: "Treatment",
  perio: "Perio",
  manual: "Manual",
};

const TYPE_BADGE: Record<PreauthTypeId, string> = {
  treatment: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
  perio: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  manual: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
};

function formatDate(value: string): string {
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function PreauthCard({
  preauth,
  onTransition,
  onEdit,
  onDelete,
}: {
  preauth: TcPreauthCase;
  onTransition: (preauth: TcPreauthCase, status: PreauthStatusId) => void;
  onEdit: (preauth: TcPreauthCase) => void;
  onDelete: (preauth: TcPreauthCase) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-sm space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">{preauth.patientName}</p>
          <p className="text-xs text-muted-foreground truncate flex items-center gap-1 mt-0.5">
            <Building2 className="w-3 h-3 shrink-0" />
            {preauth.insuranceCarrier || "No carrier"}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label="Card actions">
              <MoreHorizontal className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onEdit(preauth)}>
              <Pencil className="w-3.5 h-3.5" /> Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onDelete(preauth)}
              className="text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge variant="outline" className={`border-transparent ${TYPE_BADGE[preauth.preauthType]}`}>
          {PREAUTH_TYPE_LABELS[preauth.preauthType]}
        </Badge>
        {preauth.referenceNumber && (
          <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground font-mono">
            <Hash className="w-3 h-3" />
            {preauth.referenceNumber}
          </span>
        )}
      </div>

      <div className="text-xs text-muted-foreground space-y-0.5">
        <p className="flex items-center gap-1 truncate">
          <Stethoscope className="w-3 h-3 shrink-0" />
          {preauth.doctorName || "No doctor"}
        </p>
        <p className="flex items-center gap-1">
          <CalendarClock className="w-3 h-3 shrink-0" />
          Created {formatDate(preauth.createdAt)}
        </p>
        {preauth.submittedDate && <p className="pl-4">Submitted {formatDate(preauth.submittedDate)}</p>}
        {preauth.decisionDate && <p className="pl-4">Decision {formatDate(preauth.decisionDate)}</p>}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="w-full h-7 text-xs">
            <ArrowRightLeft className="w-3 h-3" /> Move to…
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuLabel className="text-xs">Move to</DropdownMenuLabel>
          {PREAUTH_BOARD_STATUSES.filter((s) => s !== preauth.status).map((s) => (
            <DropdownMenuItem key={s} onClick={() => onTransition(preauth, s)}>
              {PREAUTH_STATUSES[s].label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function PreauthBoard({
  cases,
  onTransition,
  onEdit,
  onDelete,
}: {
  cases: TcPreauthCase[];
  onTransition: (preauth: TcPreauthCase, status: PreauthStatusId) => void;
  onEdit: (preauth: TcPreauthCase) => void;
  onDelete: (preauth: TcPreauthCase) => void;
}) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-4">
      {PREAUTH_BOARD_STATUSES.map((status) => {
        const column = cases.filter((c) => c.status === status);
        return (
          <div key={status} className="flex flex-col w-64 shrink-0 rounded-xl bg-muted/40 border border-border/60">
            <div className="flex items-center justify-between px-3 py-2.5">
              <PreauthStatusBadge status={status} />
              <span className="text-xs font-medium text-muted-foreground tabular-nums">{column.length}</span>
            </div>
            <div className="flex flex-col gap-2 px-2 pb-2 min-h-[80px]">
              {column.length === 0 ? (
                <p className="text-xs text-muted-foreground/70 text-center py-6">No cases</p>
              ) : (
                column.map((c) => (
                  <PreauthCard
                    key={c.preauthId}
                    preauth={c}
                    onTransition={onTransition}
                    onEdit={onEdit}
                    onDelete={onDelete}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
