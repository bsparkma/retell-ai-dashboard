/**
 * Callbacks — Callback queue management
 * Priority queue, attempt tracking, due dates, and status management
 */
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Phone, Plus, Clock, AlertTriangle, CheckCircle2,
  User, Search, Filter, ArrowUpDown, Trash2, Edit3
} from "lucide-react";
import { api, type CallbackDisplay } from "@/lib/api";
import { formatTimeAgo } from "@/lib/utils";
import { toast } from "sonner";

type CallbackStatus = "all" | "pending" | "in-progress" | "completed";
type Priority = "all" | "high" | "medium" | "low";

const priorityConfig = {
  high: { label: "High", color: "oklch(0.62 0.22 25)", bg: "oklch(0.62 0.22 25 / 0.12)" },
  medium: { label: "Medium", color: "oklch(0.65 0.17 75)", bg: "oklch(0.78 0.17 75 / 0.12)" },
  low: { label: "Low", color: "oklch(0.52 0.015 240)", bg: "oklch(0.50 0.01 240 / 0.1)" },
};

const statusConfig = {
  pending: { label: "Pending", color: "oklch(0.55 0.18 210)", bg: "oklch(0.55 0.18 210 / 0.1)" },
  "in-progress": { label: "In Progress", color: "oklch(0.65 0.17 75)", bg: "oklch(0.78 0.17 75 / 0.1)" },
  completed: { label: "Completed", color: "oklch(0.55 0.18 155)", bg: "oklch(0.65 0.18 155 / 0.1)" },
};

export default function Callbacks() {
  const [callbacks, setCallbacks] = useState<CallbackDisplay[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<CallbackStatus>("all");
  const [priorityFilter, setPriorityFilter] = useState<Priority>("all");
  const [loading, setLoading] = useState(true);

  const loadCallbacks = () => {
    setLoading(true);
    api.getCallbacks()
      .then(setCallbacks)
      .catch(() => setCallbacks([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadCallbacks(); }, []);

  const filtered = callbacks.filter((cb) => {
    const matchSearch = !search ||
      cb.patientName.toLowerCase().includes(search.toLowerCase()) ||
      cb.phone.includes(search) ||
      cb.reason.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === "all" || cb.status === statusFilter;
    const matchPriority = priorityFilter === "all" || cb.priority === priorityFilter;
    return matchSearch && matchStatus && matchPriority;
  });

  const stats = {
    pending: callbacks.filter(c => c.status === "pending").length,
    inProgress: callbacks.filter(c => c.status === "in-progress").length,
    completed: callbacks.filter(c => c.status === "completed").length,
    highPriority: callbacks.filter(c => c.priority === "high" && c.status !== "completed").length,
  };

  const markComplete = async (id: string) => {
    try {
      await api.updateCallback(id, { status: "completed" });
      setCallbacks(prev => prev.map(c => c.id === id ? { ...c, status: "completed" as const } : c));
      toast.success("Callback marked as completed");
    } catch {
      toast.error("Failed to update");
    }
  };

  const logAttempt = async (id: string) => {
    try {
      await api.logCallbackAttempt(id);
      setCallbacks(prev => prev.map(c => c.id === id ? { ...c, attempts: c.attempts + 1, lastAttempt: new Date().toISOString() } : c));
      toast.info("Attempt logged");
    } catch {
      toast.error("Failed to log attempt");
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
            Callbacks
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Follow-up queue for patients requiring a callback
          </p>
        </div>
        <Button className="gap-1.5" onClick={() => toast.info("New callback form coming soon")}>
          <Plus size={14} /> Add Callback
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Pending", value: stats.pending, color: "oklch(0.55 0.18 210)", urgent: false },
          { label: "In Progress", value: stats.inProgress, color: "oklch(0.65 0.17 75)", urgent: false },
          { label: "Completed Today", value: stats.completed, color: "oklch(0.55 0.18 155)", urgent: false },
          { label: "High Priority", value: stats.highPriority, color: "oklch(0.62 0.22 25)", urgent: stats.highPriority > 0 },
        ].map((s) => (
          <Card key={s.label} className={s.urgent ? "ring-2 ring-destructive/30" : ""}>
            <CardContent className="p-4">
              <div className="text-2xl font-bold" style={{ fontFamily: "Outfit, sans-serif", color: s.color }}>
                {s.value}
              </div>
              <div className="text-sm text-muted-foreground mt-0.5">{s.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-3">
            <div className="relative flex-1 min-w-48">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search patient, phone, reason..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 h-9 text-sm"
              />
            </div>

            <div className="flex items-center gap-1 bg-muted rounded-md p-1">
              {(["all", "pending", "in-progress", "completed"] as CallbackStatus[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className="px-3 py-1 rounded text-xs font-medium transition-all capitalize"
                  style={{
                    backgroundColor: statusFilter === s ? "white" : "transparent",
                    color: statusFilter === s ? "oklch(0.18 0.02 240)" : "oklch(0.52 0.015 240)",
                    boxShadow: statusFilter === s ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
                  }}
                >
                  {s === "all" ? "All" : s}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1 bg-muted rounded-md p-1">
              {(["all", "high", "medium", "low"] as Priority[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPriorityFilter(p)}
                  className="px-3 py-1 rounded text-xs font-medium transition-all capitalize"
                  style={{
                    backgroundColor: priorityFilter === p ? "white" : "transparent",
                    color: priorityFilter === p ? "oklch(0.18 0.02 240)" : "oklch(0.52 0.015 240)",
                    boxShadow: priorityFilter === p ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
                  }}
                >
                  {p === "all" ? "All Priority" : p}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Callback list */}
      <div className="space-y-3">
        {loading ? (
          <div className="text-center py-12 text-muted-foreground text-sm">Loading callbacks…</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Phone size={32} className="mx-auto mb-2 opacity-30" />
            <p className="text-sm">No callbacks. Add from call details or your backend.</p>
          </div>
        ) : filtered.map((cb) => {
          const pc = priorityConfig[cb.priority];
          const sc = statusConfig[cb.status];
          const isOverdue = cb.status !== "completed" && new Date(cb.dueDate) < new Date();

          return (
            <Card key={cb.id} className={`${isOverdue ? "ring-2 ring-destructive/20" : ""}`}>
              <CardContent className="p-4">
                <div className="flex items-start gap-4">
                  {/* Priority indicator */}
                  <div
                    className="w-1 self-stretch rounded-full flex-shrink-0"
                    style={{ backgroundColor: pc.color, minHeight: 48 }}
                  />

                  {/* Patient info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm text-foreground">{cb.patientName}</span>
                          <span
                            className="text-xs px-1.5 py-0.5 rounded-full font-medium"
                            style={{ backgroundColor: pc.bg, color: pc.color }}
                          >
                            {pc.label}
                          </span>
                          <span
                            className="text-xs px-1.5 py-0.5 rounded-full font-medium"
                            style={{ backgroundColor: sc.bg, color: sc.color }}
                          >
                            {sc.label}
                          </span>
                          {isOverdue && (
                            <span className="text-xs px-1.5 py-0.5 rounded-full font-medium bg-destructive/12 text-destructive">
                              Overdue
                            </span>
                          )}
                        </div>
                        <div className="text-xs font-mono text-muted-foreground mt-0.5">{cb.phone}</div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Button
                          size="sm"
                          className="gap-1.5 text-xs h-8"
                          onClick={() => { logAttempt(cb.id); toast.info(`Calling ${cb.patientName}...`); }}
                          disabled={cb.status === "completed"}
                        >
                          <Phone size={12} /> Call
                        </Button>
                        {cb.status !== "completed" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5 text-xs h-8"
                            onClick={() => markComplete(cb.id)}
                          >
                            <CheckCircle2 size={12} /> Done
                          </Button>
                        )}
                      </div>
                    </div>

                    <p className="text-sm text-foreground mt-2">{cb.reason}</p>

                    {cb.notes && (
                      <p className="text-xs text-muted-foreground mt-1 italic">{cb.notes}</p>
                    )}

                    <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground flex-wrap">
                      <span className="flex items-center gap-1">
                        <Clock size={11} />
                        Due: {new Date(cb.dueDate).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <span>Attempts: {cb.attempts}</span>
                      {cb.lastAttempt && (
                        <span>Last: {formatTimeAgo(cb.lastAttempt)}</span>
                      )}
                      {cb.assignedTo && (
                        <span className="flex items-center gap-1">
                          <User size={11} /> {cb.assignedTo}
                        </span>
                      )}
                    </div>
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
