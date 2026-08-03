/**
 * Follow-up queue — the "what's due" daily worklist.
 *
 * Fetches /tc/followups/due (defaults to today's horizon, includes overdue),
 * filters by kind / assignee / horizon date, and groups rows into Overdue →
 * Due today → Upcoming (the last only appears when the horizon is moved into
 * the future, since the server only returns future rows then). Takes `office`
 * and an optional `today` as props so tests stay deterministic and free of
 * context providers.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarCheck2, CalendarDays, Inbox, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OfficeId } from "@shared/tc/contract";
import { followupsDue, tcErrorMessage, type TcDueFollowup } from "../api";
import { todayIsoDate, getDaysOverdue } from "../lib/followups";
import { FollowupActionCard } from "./FollowupActionCard";

type KindFilter = "all" | TcDueFollowup["kind"];

const KIND_FILTERS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "followup", label: "Follow-ups" },
  { value: "nurture", label: "Nurture" },
];

const URGENCY_ORDER: Record<TcDueFollowup["caseUrgency"], number> = {
  high: 0,
  medium: 1,
  low: 2,
  elective: 3,
};

function byDueDateThenUrgency(a: TcDueFollowup, b: TcDueFollowup): number {
  return (
    a.dueDate.localeCompare(b.dueDate) ||
    URGENCY_ORDER[a.caseUrgency] - URGENCY_ORDER[b.caseUrgency]
  );
}

export interface FollowupQueueProps {
  office: OfficeId;
  /** YYYY-MM-DD "today" override for deterministic tests. */
  today?: string;
}

export function FollowupQueue({ office, today }: FollowupQueueProps) {
  const todayIso = today ?? todayIsoDate();

  const [rows, setRows] = useState<TcDueFollowup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>("all");
  const [assignee, setAssignee] = useState("");
  const [horizon, setHorizon] = useState(todayIso);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const due = await followupsDue(office, {
        date: horizon,
        ...(kind !== "all" ? { kind } : {}),
      });
      setRows(due);
    } catch (e) {
      setRows([]);
      setError(tcErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [office, horizon, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const removeRow = useCallback((followupId: string) => {
    setRows((prev) => prev.filter((f) => f.followupId !== followupId));
  }, []);

  const replaceRow = useCallback((updated: TcDueFollowup) => {
    setRows((prev) => prev.map((f) => (f.followupId === updated.followupId ? updated : f)));
  }, []);

  const groups = useMemo(() => {
    const needle = assignee.trim().toLowerCase();
    const visible = needle
      ? rows.filter((f) => f.assignedTc.toLowerCase().includes(needle))
      : rows;
    const overdue: TcDueFollowup[] = [];
    const dueToday: TcDueFollowup[] = [];
    const upcoming: TcDueFollowup[] = [];
    for (const f of visible) {
      const days = getDaysOverdue(f.dueDate, todayIso);
      if (days > 0) overdue.push(f);
      else if (days === 0) dueToday.push(f);
      else upcoming.push(f);
    }
    overdue.sort(byDueDateThenUrgency);
    dueToday.sort(byDueDateThenUrgency);
    upcoming.sort(byDueDateThenUrgency);
    return { overdue, dueToday, upcoming };
  }, [rows, assignee, todayIso]);

  const total = groups.overdue.length + groups.dueToday.length + groups.upcoming.length;

  const renderGroup = (
    label: string,
    Icon: typeof AlertTriangle,
    iconClass: string,
    items: TcDueFollowup[],
  ) => {
    if (items.length === 0) return null;
    return (
      <section aria-label={label}>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground mb-2">
          <Icon className={`w-4 h-4 ${iconClass}`} />
          {label}
          <span className="text-xs font-medium text-muted-foreground bg-muted rounded-full px-2 py-0.5">
            {items.length}
          </span>
        </h2>
        <div className="space-y-3">
          {items.map((f) => (
            <FollowupActionCard
              key={f.followupId}
              office={office}
              followup={f}
              today={todayIso}
              onCompleted={removeRow}
              onSkipped={removeRow}
              onRescheduled={replaceRow}
            />
          ))}
        </div>
      </section>
    );
  };

  return (
    <div className="space-y-5">
      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center rounded-lg border border-border p-0.5 gap-0.5">
          {KIND_FILTERS.map((k) => (
            <Button
              key={k.value}
              size="sm"
              variant={kind === k.value ? "secondary" : "ghost"}
              className="h-7 px-2.5 text-xs"
              aria-pressed={kind === k.value}
              onClick={() => setKind(k.value)}
            >
              {k.label}
            </Button>
          ))}
        </div>
        <Input
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          placeholder="Filter by assignee…"
          aria-label="Filter by assignee"
          className="h-8 w-44 text-sm"
        />
        <Input
          type="date"
          value={horizon}
          onChange={(e) => {
            if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) setHorizon(e.target.value);
          }}
          aria-label="Queue horizon date"
          className="h-8 w-40 text-sm"
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 text-xs"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-3 text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : total === 0 && !error ? (
        <div className="flex flex-col items-center justify-center text-center py-16 gap-2 text-muted-foreground">
          <Inbox className="w-8 h-8 opacity-40" />
          <p className="text-sm font-medium text-foreground">Queue clear</p>
          <p className="text-xs">Nothing due through {horizon}. Nice work.</p>
        </div>
      ) : (
        <>
          {renderGroup("Overdue", AlertTriangle, "text-red-600 dark:text-red-400", groups.overdue)}
          {renderGroup("Due today", CalendarCheck2, "text-blue-600 dark:text-blue-400", groups.dueToday)}
          {renderGroup("Upcoming", CalendarDays, "text-muted-foreground", groups.upcoming)}
        </>
      )}
    </div>
  );
}
