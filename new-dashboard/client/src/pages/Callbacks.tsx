import { useState, useEffect, useCallback } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  PhoneIncoming, RefreshCw, Loader2, Trash2, CheckCircle2,
  Phone, Clock, ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { api, type CallbackDisplay } from "@/lib/api";
import { formatTimeAgo } from "@/lib/utils";

const PRIORITY_ORDER: Record<string, number> = { emergency: 0, high: 1, medium: 2, low: 3 };
const PRIORITY_DOT: Record<string, string> = {
  emergency: "oklch(0.55 0.22 25)",
  high: "oklch(0.62 0.22 25)",
  medium: "oklch(0.78 0.17 75)",
  low: "oklch(0.52 0.015 240)",
};
const STATUS_BADGE: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; className: string }> = {
  pending: { variant: "outline", className: "border-amber-500/50 text-amber-700 bg-amber-500/10" },
  "in-progress": { variant: "outline", className: "border-blue-500/50 text-blue-700 bg-blue-500/10" },
  completed: { variant: "outline", className: "border-green-500/50 text-green-700 bg-green-500/10" },
  failed: { variant: "secondary", className: "text-muted-foreground" },
};

type StatusFilter = "all" | "pending" | "completed" | "failed";
type PriorityFilter = "all" | "emergency" | "high" | "medium" | "low";

export default function Callbacks() {
  const [callbacks, setCallbacks] = useState<CallbackDisplay[]>([]);
  const [stats, setStats] = useState<{ total: number; pending: number; overdue: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [cbRes, statsRes] = await Promise.allSettled([
        api.getCallbacks(),
        api.getCallbackStats(),
      ]);
      if (cbRes.status === "fulfilled") setCallbacks(cbRes.value);
      if (statsRes.status === "fulfilled") {
        const s = statsRes.value.stats;
        setStats(s ? { total: s.total ?? 0, pending: s.pending ?? 0, overdue: s.overdue ?? 0 } : null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const filtered = callbacks
    .filter((cb) => {
      if (statusFilter !== "all" && cb.status !== statusFilter) return false;
      if (priorityFilter !== "all" && cb.priority !== priorityFilter) return false;
      return true;
    })
    .sort((a, b) => {
      const terminal = (s: string) => s === "completed" || s === "failed";
      if (terminal(a.status) !== terminal(b.status)) return terminal(a.status) ? 1 : -1;
      const pa = PRIORITY_ORDER[a.priority] ?? 9;
      const pb = PRIORITY_ORDER[b.priority] ?? 9;
      if (pa !== pb) return pa - pb;
      return new Date(a.dueDate || 0).getTime() - new Date(b.dueDate || 0).getTime();
    });

  const handleComplete = async (id: string) => {
    setActionInFlight(id);
    try {
      await api.updateCallback(id, { status: "completed" });
      toast.success("Callback marked complete");
      fetchData();
    } catch { toast.error("Failed to update callback"); }
    finally { setActionInFlight(null); }
  };

  const handleLogAttempt = async (id: string) => {
    setActionInFlight(id + "-attempt");
    try {
      await api.logCallbackAttempt(id, { result: "no_answer" });
      toast.success("Attempt logged");
      fetchData();
    } catch { toast.error("Failed to log attempt"); }
    finally { setActionInFlight(null); }
  };

  const handleDelete = async (id: string) => {
    setActionInFlight(id + "-delete");
    try {
      await api.deleteCallback(id);
      toast.success("Callback removed");
      fetchData();
    } catch { toast.error("Failed to delete callback"); }
    finally { setActionInFlight(null); }
  };

  const isOverdue = (cb: CallbackDisplay) =>
    cb.status === "pending" && cb.dueDate && new Date(cb.dueDate) < new Date();

  const completedCount = (stats?.total ?? 0) - (stats?.pending ?? 0);

  const statusTabs: { key: StatusFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "pending", label: "Pending" },
    { key: "completed", label: "Completed" },
    { key: "failed", label: "Failed" },
  ];

  const priorityOptions: { key: PriorityFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "emergency", label: "Emergency" },
    { key: "high", label: "High" },
    { key: "medium", label: "Medium" },
    { key: "low", label: "Low" },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
            Callbacks
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Patient callback queue — track and manage follow-up calls
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => fetchData()} disabled={loading}>
          <RefreshCw size={14} className={`mr-1.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Stats bar */}
      <div className="flex flex-wrap gap-3">
        {[
          { label: "Total", value: stats?.total ?? 0, color: "oklch(0.52 0.015 240)" },
          { label: "Pending", value: stats?.pending ?? 0, color: (stats?.pending ?? 0) > 0 ? "oklch(0.65 0.17 75)" : "oklch(0.52 0.015 240)" },
          { label: "Overdue", value: stats?.overdue ?? 0, color: (stats?.overdue ?? 0) > 0 ? "oklch(0.55 0.22 25)" : "oklch(0.52 0.015 240)" },
          { label: "Completed", value: completedCount, color: "oklch(0.55 0.18 155)" },
        ].map((s) => (
          <Card key={s.label} className="flex-1 min-w-[120px]">
            <CardContent className="p-3 text-center">
              <div className="text-xl font-bold" style={{ fontFamily: "Outfit, sans-serif", color: s.color }}>
                {s.value}
              </div>
              <div className="text-xs text-muted-foreground">{s.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 bg-muted rounded-md p-1">
          {statusTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setStatusFilter(tab.key)}
              className="px-3 py-1 rounded text-xs font-medium transition-all"
              style={{
                backgroundColor: statusFilter === tab.key ? "white" : "transparent",
                color: statusFilter === tab.key ? "oklch(0.18 0.02 240)" : "oklch(0.52 0.015 240)",
                boxShadow: statusFilter === tab.key ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value as PriorityFilter)}
          className="text-xs rounded-md border border-border bg-background px-3 py-1.5 text-foreground"
        >
          {priorityOptions.map((opt) => (
            <option key={opt.key} value={opt.key}>{opt.key === "all" ? "All Priorities" : opt.label}</option>
          ))}
        </select>
      </div>

      {/* Loading */}
      {loading && callbacks.length === 0 && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="animate-spin text-muted-foreground" size={28} />
        </div>
      )}

      {/* Empty state */}
      {!loading && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <PhoneIncoming size={36} className="mb-3 opacity-40" />
          <div className="text-sm font-medium">
            {statusFilter === "all" ? "No callbacks" : `No ${statusFilter} callbacks`}
          </div>
          {(statusFilter === "pending" || statusFilter === "all") && (stats?.pending ?? 0) === 0 && (
            <div className="text-xs mt-1 opacity-70">All caught up.</div>
          )}
        </div>
      )}

      {/* Callback list */}
      <div className="space-y-3">
        {filtered.map((cb) => {
          const overdue = isOverdue(cb);
          const isTerminal = cb.status === "completed" || cb.status === "failed";
          const badge = STATUS_BADGE[cb.status] ?? STATUS_BADGE.pending;
          return (
            <Card key={cb.id} className={overdue ? "ring-1 ring-destructive/30" : ""}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  {/* Priority dot */}
                  <div
                    className="w-2.5 h-2.5 rounded-full mt-1.5 flex-shrink-0"
                    style={{ backgroundColor: PRIORITY_DOT[cb.priority] ?? PRIORITY_DOT.low }}
                  />

                  {/* Main content */}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-foreground">{cb.patientName}</span>
                      <Badge variant={badge.variant} className={`text-[10px] px-1.5 py-0 ${badge.className}`}>
                        {cb.status}
                      </Badge>
                    </div>

                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Phone size={11} />
                      <span className="font-mono">{cb.phone || "—"}</span>
                    </div>

                    {cb.reason && (
                      <div className="text-xs text-muted-foreground line-clamp-2">{cb.reason}</div>
                    )}

                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>attempts: {cb.attempts}</span>
                      <span>last attempt: {cb.lastAttempt ? formatTimeAgo(cb.lastAttempt) : "never"}</span>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 pt-1.5">
                      {!isTerminal && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-xs h-7 gap-1"
                            disabled={actionInFlight === cb.id}
                            onClick={() => handleComplete(cb.id)}
                          >
                            {actionInFlight === cb.id ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                            Mark Complete
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs h-7 gap-1"
                            disabled={actionInFlight === cb.id + "-attempt"}
                            onClick={() => handleLogAttempt(cb.id)}
                          >
                            {actionInFlight === cb.id + "-attempt" ? <Loader2 size={12} className="animate-spin" /> : <Clock size={12} />}
                            Log Attempt
                          </Button>
                          {cb.linkedCallId && (
                            <Link href={`/calls/${cb.linkedCallId}`}>
                              <Button variant="ghost" size="sm" className="text-xs h-7 gap-1">
                                View Call <ArrowRight size={12} />
                              </Button>
                            </Link>
                          )}
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7 px-2 text-muted-foreground hover:text-destructive"
                        disabled={actionInFlight === cb.id + "-delete"}
                        onClick={() => handleDelete(cb.id)}
                      >
                        {actionInFlight === cb.id + "-delete" ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                      </Button>
                    </div>
                  </div>

                  {/* Due date */}
                  <div className="text-right flex-shrink-0">
                    {cb.dueDate ? (
                      <div className={`text-xs font-medium ${overdue ? "text-destructive" : "text-muted-foreground"}`}>
                        {overdue ? "Overdue" : new Date(cb.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground">No due date</div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
