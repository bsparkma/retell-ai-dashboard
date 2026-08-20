/**
 * Pre-auth kanban board — 7 status columns (PREAUTH_BOARD_STATUSES order).
 *
 * Presentational: the page owns data + dialogs. A card moves either by drag
 * or by the "Move to…" menu, and BOTH run the same thing — the server stamps
 * submittedDate / decisionDate on transition, so every move is a confirmed
 * API call. There is no optimistic move: a dragged card is released back into
 * its ORIGINAL column, dimmed and undraggable, until the API resolves; the
 * board only re-renders from the row the server returned (the page's
 * replaceRow). On failure the page toasts and the card has never moved.
 *
 * The "Move to…" menu stays as the keyboard/touch fallback — drag is an
 * additional gesture, never the only one.
 *
 * Layout: each column's card list scrolls on its own under a viewport cap, so
 * the board's horizontal scrollbar stays on screen instead of being pushed
 * below the fold by the tallest column. dnd-kit auto-scrolls both the column
 * (vertical) and the board (horizontal) when a drag nears an edge.
 */
import { useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { z } from "zod";
import type { PreauthType, TcPreauthCase } from "@shared/tc/contract";
import { PREAUTH_BOARD_STATUSES, PREAUTH_STATUSES, type PreauthStatusId } from "../status";
import { PreauthStatusBadge } from "../components/TcShell";
import { preauthColumnDroppableId, resolvePreauthDrop } from "./preauthDnd";
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
import { cn } from "@/lib/utils";
import {
  ArrowRightLeft,
  Building2,
  CalendarClock,
  Hash,
  Loader2,
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

/**
 * Vertical chrome above and below a column's card list: the app top bar, the
 * page padding + page header, the column header, and the board's own
 * horizontal scrollbar. Capping here is what keeps that scrollbar on screen.
 */
const COLUMN_LIST_MAX_H = "max-h-[calc(100vh-270px)]";

function formatDate(value: string): string {
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ── Card ────────────────────────────────────────────────────────────────────

/** The card's visuals, shared by the live card and the drag overlay. */
function PreauthCardBody({
  preauth,
  pending,
  onTransition,
  onEdit,
  onDelete,
}: {
  preauth: TcPreauthCase;
  pending: boolean;
  onTransition: (preauth: TcPreauthCase, status: PreauthStatusId) => void;
  onEdit: (preauth: TcPreauthCase) => void;
  onDelete: (preauth: TcPreauthCase) => void;
}) {
  // Menus sit inside a card that is both draggable and click-to-open, so they
  // have to own their own events: no drag start, no card click.
  const swallow = {
    onPointerDown: (e: ReactPointerEvent) => e.stopPropagation(),
    onClick: (e: ReactMouseEvent) => e.stopPropagation(),
  };
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">{preauth.patientName}</p>
          <p className="text-xs text-muted-foreground truncate flex items-center gap-1 mt-0.5">
            <Building2 className="w-3 h-3 shrink-0" />
            {preauth.insuranceCarrier || "No carrier"}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {pending && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                aria-label={`Actions for ${preauth.patientName}`}
                {...swallow}
              >
                <MoreHorizontal className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" {...swallow}>
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
          <Button
            variant="outline"
            size="sm"
            className="w-full h-7 text-xs"
            disabled={pending}
            {...swallow}
          >
            <ArrowRightLeft className="w-3 h-3" /> Move to…
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44" {...swallow}>
          <DropdownMenuLabel className="text-xs">Move to</DropdownMenuLabel>
          {PREAUTH_BOARD_STATUSES.filter((s) => s !== preauth.status).map((s) => (
            <DropdownMenuItem key={s} onClick={() => onTransition(preauth, s)}>
              {PREAUTH_STATUSES[s].label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function PreauthCard({
  preauth,
  pending,
  onTransition,
  onEdit,
  onDelete,
}: {
  preauth: TcPreauthCase;
  /** A transition for this card is in flight: dimmed, and drag is disabled. */
  pending: boolean;
  onTransition: (preauth: TcPreauthCase, status: PreauthStatusId) => void;
  onEdit: (preauth: TcPreauthCase) => void;
  onDelete: (preauth: TcPreauthCase) => void;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: preauth.preauthId,
    disabled: pending,
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      // Deliberately no transform: the card never leaves its own column while
      // the move is unconfirmed — the DragOverlay follows the cursor instead.
      onClick={() => onEdit(preauth)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEdit(preauth);
        }
      }}
      aria-label={`${preauth.patientName}, ${PREAUTH_STATUSES[preauth.status].label}. Open to edit, or drag to another column.`}
      className={cn(
        "rounded-lg border border-border bg-card p-3 shadow-sm space-y-2 text-left shrink-0",
        "cursor-grab active:cursor-grabbing hover:shadow-md transition-shadow",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isDragging && "opacity-40",
        pending && "opacity-50 cursor-progress",
      )}
    >
      <PreauthCardBody
        preauth={preauth}
        pending={pending}
        onTransition={onTransition}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </div>
  );
}

// ── Column ──────────────────────────────────────────────────────────────────

function PreauthColumn({
  status,
  cases,
  pendingIds,
  onTransition,
  onEdit,
  onDelete,
}: {
  status: PreauthStatusId;
  cases: TcPreauthCase[];
  pendingIds: string[];
  onTransition: (preauth: TcPreauthCase, status: PreauthStatusId) => void;
  onEdit: (preauth: TcPreauthCase) => void;
  onDelete: (preauth: TcPreauthCase) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: preauthColumnDroppableId(status) });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex flex-col w-64 shrink-0 rounded-xl bg-muted/40 border border-border/60 transition-colors",
        isOver && "bg-muted/80 border-primary/60 ring-2 ring-primary/30",
      )}
    >
      <div className="flex items-center justify-between px-3 py-2.5 shrink-0">
        <PreauthStatusBadge status={status} />
        <span className="text-xs font-medium text-muted-foreground tabular-nums">{cases.length}</span>
      </div>
      <div className={cn("flex flex-col gap-2 px-2 pb-2 overflow-y-auto min-h-[80px]", COLUMN_LIST_MAX_H)}>
        {cases.length === 0 ? (
          <p className="text-xs text-muted-foreground/70 text-center py-6">No cases</p>
        ) : (
          cases.map((c) => (
            <PreauthCard
              key={c.preauthId}
              preauth={c}
              pending={pendingIds.includes(c.preauthId)}
              onTransition={onTransition}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── Board ───────────────────────────────────────────────────────────────────

export function PreauthBoard({
  cases,
  onTransition,
  onEdit,
  onDelete,
}: {
  cases: TcPreauthCase[];
  /**
   * Runs the guarded transition. Resolves once the server has answered — the
   * board holds the card pending until then and never moves it itself.
   */
  onTransition: (preauth: TcPreauthCase, status: PreauthStatusId) => Promise<void>;
  onEdit: (preauth: TcPreauthCase) => void;
  onDelete: (preauth: TcPreauthCase) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<string[]>([]);

  // A plain click must reach the card (click-to-edit); only a real drag of
  // ~8px takes the gesture over.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const activeCard = activeId === null ? null : cases.find((c) => c.preauthId === activeId) ?? null;

  const runTransition = async (preauth: TcPreauthCase, status: PreauthStatusId) => {
    if (pendingIds.includes(preauth.preauthId)) return;
    setPendingIds((prev) => [...prev, preauth.preauthId]);
    try {
      await onTransition(preauth, status);
    } finally {
      setPendingIds((prev) => prev.filter((id) => id !== preauth.preauthId));
    }
  };

  const handleDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const dragged = cases.find((c) => c.preauthId === String(event.active.id));
    const action = resolvePreauthDrop(dragged?.status, event.over?.id);
    if (action.kind === "transition" && dragged) void runTransition(dragged, action.status);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      // Always: the columns scroll under the drag, so a rect measured once at
      // drag start would resolve the drop against a stale position.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="flex gap-3 overflow-x-auto pb-4 items-start">
        {PREAUTH_BOARD_STATUSES.map((status) => (
          <PreauthColumn
            key={status}
            status={status}
            cases={cases.filter((c) => c.status === status)}
            pendingIds={pendingIds}
            onTransition={(p, s) => void runTransition(p, s)}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeCard && (
          <div className="w-60 rounded-lg border border-primary/50 bg-card p-3 shadow-xl space-y-2 cursor-grabbing pointer-events-none">
            <PreauthCardBody
              preauth={activeCard}
              pending={false}
              onTransition={() => undefined}
              onEdit={() => undefined}
              onDelete={() => undefined}
            />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
