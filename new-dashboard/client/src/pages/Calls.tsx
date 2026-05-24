/**
 * Calls — Unified Call Log + Callbacks + CareIN Log (tabbed view)
 * Tab 1: Call log (Retell + Mango Voice) with search, filters, transcript preview
 * Tab 2: Callback queue with priority, status tracking, attempt logging
 * Tab 3: CareIN ingested calls — office, tag, commlog status, quality score
 */
import { useState, useEffect } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Search, Bot, Users, Phone, PhoneOff, PhoneMissed,
  Download, RefreshCw, Mic, FileText, AlertTriangle,
  Volume2, Clock, CheckCircle2, User, Plus
} from "lucide-react";
import { api, careInApi, type UnifiedCall, type CallbackDisplay, type CareInCall } from "@/lib/api";
import { formatDuration, formatTimeAgo } from "@/lib/utils";
import { toast } from "sonner";

type CallSource = "all" | "retell" | "mango";
type CallStatus = "all" | "completed" | "transferred" | "voicemail" | "missed";
type CallbackStatusFilter = "all" | "pending" | "in-progress" | "completed";
type Priority = "all" | "high" | "medium" | "low";
type ActiveTab = "calls" | "callbacks" | "carein";

const statusConfig: Record<string, { label: string; icon: React.ElementType; style: React.CSSProperties }> = {
  completed: { label: "Completed", icon: Phone, style: { color: "oklch(0.55 0.18 155)", backgroundColor: "oklch(0.65 0.18 155 / 0.12)" } },
  transferred: { label: "Transferred", icon: PhoneOff, style: { color: "oklch(0.55 0.18 210)", backgroundColor: "oklch(0.55 0.18 210 / 0.12)" } },
  voicemail: { label: "Voicemail", icon: Mic, style: { color: "oklch(0.55 0.15 280)", backgroundColor: "oklch(0.55 0.15 280 / 0.12)" } },
  missed: { label: "Missed", icon: PhoneMissed, style: { color: "oklch(0.62 0.22 25)", backgroundColor: "oklch(0.62 0.22 25 / 0.12)" } },
};

const sentimentColors: Record<string, string> = {
  positive: "oklch(0.55 0.18 155)",
  neutral: "oklch(0.52 0.015 240)",
  negative: "oklch(0.62 0.22 25)",
};

const priorityConfig = {
  high: { label: "High", color: "oklch(0.62 0.22 25)", bg: "oklch(0.62 0.22 25 / 0.12)" },
  medium: { label: "Medium", color: "oklch(0.65 0.17 75)", bg: "oklch(0.78 0.17 75 / 0.12)" },
  low: { label: "Low", color: "oklch(0.52 0.015 240)", bg: "oklch(0.50 0.01 240 / 0.1)" },
};

const cbStatusConfig = {
  pending: { label: "Pending", color: "oklch(0.55 0.18 210)", bg: "oklch(0.55 0.18 210 / 0.1)" },
  "in-progress": { label: "In Progress", color: "oklch(0.65 0.17 75)", bg: "oklch(0.78 0.17 75 / 0.1)" },
  completed: { label: "Completed", color: "oklch(0.55 0.18 155)", bg: "oklch(0.65 0.18 155 / 0.1)" },
  failed: { label: "Failed", color: "oklch(0.52 0.015 240)", bg: "oklch(0.52 0.015 240 / 0.1)" },
};

function getTranscriptPreview(call: UnifiedCall): string | null {
  if (call.transcript_object && call.transcript_object.length > 0) {
    for (let i = call.transcript_object.length - 1; i >= 0; i--) {
      const u = call.transcript_object[i];
      if (u.role && u.role !== "agent" && u.role !== "assistant" && u.content) {
        return u.content;
      }
    }
    const last = call.transcript_object[call.transcript_object.length - 1];
    if (last?.content) return last.content;
  }
  if (typeof call.transcript === "string" && call.transcript.trim()) {
    const lines = call.transcript.trim().split("\n").filter(Boolean);
    return lines[lines.length - 1] ?? null;
  }
  return null;
}

export default function Calls() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("calls");

  // Call log state
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<CallSource>("all");
  const [status, setStatus] = useState<CallStatus>("all");
  const [calls, setCalls] = useState<UnifiedCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  // Callback state
  const [callbacks, setCallbacks] = useState<CallbackDisplay[]>([]);
  const [cbSearch, setCbSearch] = useState("");
  const [cbStatus, setCbStatus] = useState<CallbackStatusFilter>("all");
  const [cbPriority, setCbPriority] = useState<Priority>("all");
  const [cbLoading, setCbLoading] = useState(true);

  // CareIN log state
  const [careInCalls, setCareInCalls] = useState<CareInCall[]>([]);
  const [careInTotal, setCareInTotal] = useState(0);
  const [careInOffices, setCareInOffices] = useState<string[]>([]);
  const [careInTags, setCareInTags] = useState<string[]>([]);
  const [careInLoading, setCareInLoading] = useState(false);
  const [careInError, setCareInError] = useState<string | null>(null);
  const [careInSearch, setCareInSearch] = useState("");
  const [careInOfficeFilter, setCareInOfficeFilter] = useState("all");
  const [careInTagFilter, setCareInTagFilter] = useState("all");
  const [careInCommlogFilter, setCareInCommlogFilter] = useState("all");

  const loadCalls = () => {
    setLoading(true);
    api.getUnifiedCalls({ limit: 1000, source: source === "all" ? undefined : source, search: search || undefined })
      .then(({ calls: list }) => setCalls(list))
      .catch(() => setCalls([]))
      .finally(() => setLoading(false));
  };

  const loadCareInCalls = () => {
    setCareInLoading(true);
    setCareInError(null);
    careInApi.getCalls({ limit: 200 })
      .then(({ calls: list, total, offices, tags }) => {
        setCareInCalls(list);
        setCareInTotal(total);
        setCareInOffices(offices);
        setCareInTags(tags);
      })
      .catch((err: unknown) => {
        setCareInCalls([]);
        setCareInError(err instanceof Error ? err.message : "Failed to load CareIN calls");
      })
      .finally(() => setCareInLoading(false));
  };

  const loadCallbacks = () => {
    setCbLoading(true);
    api.getCallbacks()
      .then(setCallbacks)
      .catch(() => setCallbacks([]))
      .finally(() => setCbLoading(false));
  };

  useEffect(() => { loadCalls(); }, []);
  useEffect(() => { loadCallbacks(); }, []);
  // Load CareIN calls on first tab switch
  useEffect(() => {
    if (activeTab === "carein" && careInCalls.length === 0 && !careInLoading && !careInError) {
      loadCareInCalls();
    }
  }, [activeTab]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await api.syncRetell({ limit: 1000 });
      toast.success(res.message ?? "Sync complete");
      loadCalls();
    } catch {
      toast.error("Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const filteredCalls = calls.filter((call) => {
    const matchSearch = !search ||
      call.patientName.toLowerCase().includes(search.toLowerCase()) ||
      call.fromNumber.includes(search) ||
      call.intent?.toLowerCase().includes(search.toLowerCase());
    const matchSource = source === "all" || call.source === source;
    const matchStatus = status === "all" || call.status === status;
    return matchSearch && matchSource && matchStatus;
  });

  const filteredCallbacks = callbacks.filter((cb) => {
    const matchSearch = !cbSearch ||
      cb.patientName.toLowerCase().includes(cbSearch.toLowerCase()) ||
      cb.phone.includes(cbSearch) ||
      cb.reason.toLowerCase().includes(cbSearch.toLowerCase());
    const matchStatus = cbStatus === "all" || cb.status === cbStatus;
    const matchPriority = cbPriority === "all" || cb.priority === cbPriority;
    return matchSearch && matchStatus && matchPriority;
  });

  const callStats = {
    total: calls.length,
    retell: calls.filter(c => c.source === "retell").length,
    mango: calls.filter(c => c.source === "mango").length,
    avgDuration: calls.length ? Math.round(calls.reduce((a, c) => a + c.duration, 0) / calls.length) : 0,
  };

  const cbStats = {
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
            Calls
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Call log and callback queue
          </p>
        </div>
        <div className="flex items-center gap-2">
          {activeTab === "calls" && (
            <>
              <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
                <RefreshCw size={14} className={`mr-1.5 ${syncing ? "animate-spin" : ""}`} /> {syncing ? "Syncing..." : "Sync"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => toast.info("Exporting call log...")}>
                <Download size={14} className="mr-1.5" /> Export
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-muted rounded-lg p-1 w-fit">
        {([
          { key: "calls" as const, label: "Call Log", count: calls.length },
          { key: "callbacks" as const, label: "Callbacks", count: cbStats.pending },
          { key: "carein" as const, label: "CareIN Log", count: careInTotal },
        ]).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className="px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-2"
            style={{
              backgroundColor: activeTab === tab.key ? "white" : "transparent",
              color: activeTab === tab.key ? "oklch(0.18 0.02 240)" : "oklch(0.52 0.015 240)",
              boxShadow: activeTab === tab.key ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
            }}
          >
            {tab.label}
            {tab.key === "callbacks" && tab.count > 0 && (
              <Badge variant="destructive" className="text-xs px-1.5 py-0">{tab.count}</Badge>
            )}
            {tab.key === "carein" && tab.count > 0 && (
              <Badge className="text-xs px-1.5 py-0 bg-primary/15 text-primary border-0">{tab.count}</Badge>
            )}
          </button>
        ))}
      </div>

      {/* CALL LOG TAB */}
      {activeTab === "calls" && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Total Calls", value: callStats.total, sub: "All time" },
              { label: "AI Handled", value: callStats.retell, sub: "Retell AI", color: "oklch(0.55 0.18 210)" },
              { label: "Staff Calls", value: callStats.mango, sub: "Mango Voice", color: "oklch(0.65 0.17 75)" },
              { label: "Avg Duration", value: formatDuration(callStats.avgDuration), sub: "Per call" },
            ].map((s) => (
              <Card key={s.label}>
                <CardContent className="p-4">
                  <div className="text-2xl font-bold" style={{ fontFamily: "Outfit, sans-serif", color: s.color || "inherit" }}>
                    {s.value}
                  </div>
                  <div className="text-sm font-medium text-foreground mt-0.5">{s.label}</div>
                  <div className="text-xs text-muted-foreground">{s.sub}</div>
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
                    placeholder="Search patient, number, intent..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-9 h-9 text-sm"
                  />
                </div>

                <div className="flex items-center gap-1 bg-muted rounded-md p-1">
                  {(["all", "retell", "mango"] as CallSource[]).map((s) => (
                    <button
                      key={s}
                      onClick={() => setSource(s)}
                      className="px-3 py-1 rounded text-xs font-medium transition-all"
                      style={{
                        backgroundColor: source === s ? "white" : "transparent",
                        color: source === s ? "oklch(0.18 0.02 240)" : "oklch(0.52 0.015 240)",
                        boxShadow: source === s ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
                      }}
                    >
                      {s === "all" ? "All Sources" : s === "retell" ? "AI (Retell)" : "Staff (Mango)"}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1 bg-muted rounded-md p-1">
                  {(["all", "completed", "transferred", "voicemail"] as CallStatus[]).map((s) => (
                    <button
                      key={s}
                      onClick={() => setStatus(s)}
                      className="px-3 py-1 rounded text-xs font-medium transition-all capitalize"
                      style={{
                        backgroundColor: status === s ? "white" : "transparent",
                        color: status === s ? "oklch(0.18 0.02 240)" : "oklch(0.52 0.015 240)",
                        boxShadow: status === s ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
                      }}
                    >
                      {s === "all" ? "All Status" : s}
                    </button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Call list */}
          <Card>
            <CardHeader className="pb-3 border-b">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">
                  {filteredCalls.length} calls
                </CardTitle>
                <span className="text-xs text-muted-foreground">Click a row to view details</span>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="grid grid-cols-12 gap-3 px-4 py-2.5 border-b bg-muted/30 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                <div className="col-span-3">Patient / Number</div>
                <div className="col-span-2">Source</div>
                <div className="col-span-2">Intent</div>
                <div className="col-span-2">Status</div>
                <div className="col-span-1">Duration</div>
                <div className="col-span-1">Sentiment</div>
                <div className="col-span-1">Time</div>
              </div>

              {loading ? (
                <div className="text-center py-12 text-muted-foreground text-sm">Loading calls...</div>
              ) : filteredCalls.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Search size={32} className="mx-auto mb-2 opacity-30" />
                  <p className="text-sm">No calls found. Sync Retell or check your backend.</p>
                </div>
              ) : filteredCalls.map((call) => {
                const sc = statusConfig[call.status] || statusConfig.completed;
                const StatusIcon = sc.icon;
                return (
                  <Link key={call.id} href={`/calls/${call.id}`}>
                    <div className="grid grid-cols-12 gap-3 px-4 py-3 border-b border-border/50 hover:bg-muted/30 transition-colors cursor-pointer items-center">
                      <div className="col-span-3 flex items-center gap-2.5 min-w-0">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                          call.source === "retell" ? "bg-primary/10" : "bg-amber-500/10"
                        }`}>
                          {call.source === "retell" ? (
                            <Bot size={13} className="text-primary" />
                          ) : (
                            <Users size={13} className="text-amber-600" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground truncate flex items-center gap-1">
                            {call.patientName}
                            {call.isEmergency && <AlertTriangle size={11} className="text-destructive flex-shrink-0" />}
                          </div>
                          <div className="text-xs font-mono text-muted-foreground">{call.fromNumber}</div>
                          {(() => {
                            const preview = getTranscriptPreview(call);
                            return preview ? (
                              <div className="text-xs italic text-muted-foreground/70 line-clamp-1 mt-0.5">
                                {preview}
                              </div>
                            ) : null;
                          })()}
                        </div>
                      </div>

                      <div className="col-span-2">
                        <span
                          className="text-xs font-medium px-2 py-0.5 rounded-full"
                          style={call.source === "retell"
                            ? { backgroundColor: "oklch(0.55 0.18 210 / 0.12)", color: "oklch(0.40 0.18 210)" }
                            : { backgroundColor: "oklch(0.78 0.17 75 / 0.12)", color: "oklch(0.50 0.17 75)" }
                          }
                        >
                          {call.source === "retell" ? "AI · Rover" : "Staff · Mango"}
                        </span>
                      </div>

                      <div className="col-span-2 text-sm text-muted-foreground truncate">
                        {call.intent || "—"}
                      </div>

                      <div className="col-span-2">
                        <span
                          className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full"
                          style={sc.style}
                        >
                          <StatusIcon size={10} />
                          {sc.label}
                        </span>
                      </div>

                      <div className="col-span-1 text-sm font-mono text-muted-foreground flex items-center gap-1">
                        {formatDuration(call.duration)}
                        {call.hasRecording && <span title="Has recording"><Volume2 size={11} className="text-primary/60 flex-shrink-0" /></span>}
                        {call.hasTranscript && <span title="Has transcript"><FileText size={11} className="text-primary/60 flex-shrink-0" /></span>}
                      </div>

                      <div className="col-span-1">
                        <div
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: sentimentColors[call.sentiment] || sentimentColors.neutral }}
                          title={call.sentiment}
                        />
                      </div>

                      <div className="col-span-1 text-xs text-muted-foreground">
                        {formatTimeAgo(call.date)}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </CardContent>
          </Card>
        </>
      )}

      {/* CALLBACKS TAB */}
      {activeTab === "callbacks" && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Pending", value: cbStats.pending, color: "oklch(0.55 0.18 210)", urgent: false },
              { label: "In Progress", value: cbStats.inProgress, color: "oklch(0.65 0.17 75)", urgent: false },
              { label: "Completed Today", value: cbStats.completed, color: "oklch(0.55 0.18 155)", urgent: false },
              { label: "High Priority", value: cbStats.highPriority, color: "oklch(0.62 0.22 25)", urgent: cbStats.highPriority > 0 },
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
                    value={cbSearch}
                    onChange={(e) => setCbSearch(e.target.value)}
                    className="pl-9 h-9 text-sm"
                  />
                </div>

                <div className="flex items-center gap-1 bg-muted rounded-md p-1">
                  {(["all", "pending", "in-progress", "completed"] as CallbackStatusFilter[]).map((s) => (
                    <button
                      key={s}
                      onClick={() => setCbStatus(s)}
                      className="px-3 py-1 rounded text-xs font-medium transition-all capitalize"
                      style={{
                        backgroundColor: cbStatus === s ? "white" : "transparent",
                        color: cbStatus === s ? "oklch(0.18 0.02 240)" : "oklch(0.52 0.015 240)",
                        boxShadow: cbStatus === s ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
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
                      onClick={() => setCbPriority(p)}
                      className="px-3 py-1 rounded text-xs font-medium transition-all capitalize"
                      style={{
                        backgroundColor: cbPriority === p ? "white" : "transparent",
                        color: cbPriority === p ? "oklch(0.18 0.02 240)" : "oklch(0.52 0.015 240)",
                        boxShadow: cbPriority === p ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
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
            {cbLoading ? (
              <div className="text-center py-12 text-muted-foreground text-sm">Loading callbacks...</div>
            ) : filteredCallbacks.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Phone size={32} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">No callbacks found.</p>
              </div>
            ) : filteredCallbacks.map((cb) => {
              const pc = priorityConfig[cb.priority];
              const sc = cbStatusConfig[cb.status];
              const isOverdue = cb.status !== "completed" && new Date(cb.dueDate) < new Date();

              return (
                <Card key={cb.id} className={`${isOverdue ? "ring-2 ring-destructive/20" : ""}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-4">
                      <div
                        className="w-1 self-stretch rounded-full flex-shrink-0"
                        style={{ backgroundColor: pc.color, minHeight: 48 }}
                      />

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
        </>
      )}

      {/* CAREIN LOG TAB */}
      {activeTab === "carein" && (
        <CareInLogTab
          calls={careInCalls}
          total={careInTotal}
          offices={careInOffices}
          tags={careInTags}
          loading={careInLoading}
          error={careInError}
          search={careInSearch}
          officeFilter={careInOfficeFilter}
          tagFilter={careInTagFilter}
          commlogFilter={careInCommlogFilter}
          onSearch={setCareInSearch}
          onOffice={setCareInOfficeFilter}
          onTag={setCareInTagFilter}
          onCommlog={setCareInCommlogFilter}
          onRefresh={loadCareInCalls}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CareIN Log sub-component
// ---------------------------------------------------------------------------

const COMMLOG_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  written:  { label: "Written",  color: "oklch(0.55 0.18 155)", bg: "oklch(0.65 0.18 155 / 0.12)" },
  pending:  { label: "Pending",  color: "oklch(0.55 0.15 280)", bg: "oklch(0.55 0.15 280 / 0.12)" },
  failed:   { label: "Failed",   color: "oklch(0.62 0.22 25)",  bg: "oklch(0.62 0.22 25  / 0.12)" },
};

const TAG_LABELS: Record<string, string> = {
  appointment_scheduled:   "Scheduled",
  appointment_cancelled:   "Cancelled",
  appointment_rescheduled: "Rescheduled",
  new_patient_inquiry:     "New Patient",
  billing_inquiry:         "Billing",
  insurance_inquiry:       "Insurance",
  emergency:               "Emergency",
  voicemail:               "Voicemail",
  transferred:             "Transferred",
  completed:               "Completed",
  unresolved:              "Unresolved",
};

interface CareInLogTabProps {
  calls: CareInCall[];
  total: number;
  offices: string[];
  tags: string[];
  loading: boolean;
  error: string | null;
  search: string;
  officeFilter: string;
  tagFilter: string;
  commlogFilter: string;
  onSearch: (v: string) => void;
  onOffice: (v: string) => void;
  onTag: (v: string) => void;
  onCommlog: (v: string) => void;
  onRefresh: () => void;
}

function CareInLogTab({
  calls, total, offices, tags, loading, error,
  search, officeFilter, tagFilter, commlogFilter,
  onSearch, onOffice, onTag, onCommlog, onRefresh,
}: CareInLogTabProps) {

  // Client-side filter on top of fetched data
  const filtered = calls.filter((c) => {
    if (officeFilter !== "all" && c.office !== officeFilter) return false;
    if (tagFilter !== "all" && c.tag !== tagFilter) return false;
    if (commlogFilter !== "all" && c.commlogStatus !== commlogFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = [c.callerName, c.callerNumber, c.office, c.tag, c.summary, c.routedTo].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const commlogCounts = {
    written: calls.filter((c) => c.commlogStatus === "written").length,
    pending: calls.filter((c) => c.commlogStatus === "pending").length,
    failed:  calls.filter((c) => c.commlogStatus === "failed").length,
  };

  return (
    <>
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total Calls", value: total, sub: "Ingested" },
          { label: "Commlog Written", value: commlogCounts.written, sub: "Open Dental", color: COMMLOG_STYLES.written.color },
          { label: "Commlog Pending", value: commlogCounts.pending, sub: "Awaiting write", color: COMMLOG_STYLES.pending.color },
          { label: "Commlog Failed",  value: commlogCounts.failed,  sub: "Write errors", color: commlogCounts.failed > 0 ? COMMLOG_STYLES.failed.color : undefined },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="p-4">
              <div className="text-2xl font-bold" style={{ fontFamily: "Outfit, sans-serif", color: s.color }}>
                {s.value}
              </div>
              <div className="text-sm font-medium text-foreground mt-0.5">{s.label}</div>
              <div className="text-xs text-muted-foreground">{s.sub}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-48">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                aria-label="Search CareIN calls"
                placeholder="Search name, number, office, tag…"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                className="pl-9 h-9 text-sm w-full border border-input bg-background rounded-md px-3 focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            {/* Office filter */}
            {offices.length > 0 && (
              <div className="flex items-center gap-1 bg-muted rounded-md p-1 flex-wrap">
                {["all", ...offices].map((o) => (
                  <button
                    key={o}
                    aria-pressed={officeFilter === o}
                    onClick={() => onOffice(o)}
                    className="px-3 py-1 rounded text-xs font-medium transition-all"
                    style={{
                      backgroundColor: officeFilter === o ? "white" : "transparent",
                      color: officeFilter === o ? "oklch(0.18 0.02 240)" : "oklch(0.52 0.015 240)",
                      boxShadow: officeFilter === o ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
                    }}
                  >
                    {o === "all" ? "All Offices" : o}
                  </button>
                ))}
              </div>
            )}

            {/* Commlog status filter */}
            <div className="flex items-center gap-1 bg-muted rounded-md p-1">
              {(["all", "written", "pending", "failed"] as const).map((s) => (
                <button
                  key={s}
                  aria-pressed={commlogFilter === s}
                  onClick={() => onCommlog(s)}
                  className="px-3 py-1 rounded text-xs font-medium transition-all capitalize"
                  style={{
                    backgroundColor: commlogFilter === s ? "white" : "transparent",
                    color: commlogFilter === s ? "oklch(0.18 0.02 240)" : "oklch(0.52 0.015 240)",
                    boxShadow: commlogFilter === s ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
                  }}
                >
                  {s === "all" ? "All Commlog" : s}
                </button>
              ))}
            </div>

            {/* Tag filter */}
            {tags.length > 0 && (
              <select
                aria-label="Filter by tag"
                value={tagFilter}
                onChange={(e) => onTag(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="all">All Tags</option>
                {tags.map((t) => (
                  <option key={t} value={t}>{TAG_LABELS[t] ?? t}</option>
                ))}
              </select>
            )}

            <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading} aria-label="Refresh CareIN calls">
              <RefreshCw size={14} className={`mr-1.5 ${loading ? "animate-spin" : ""}`} />
              {loading ? "Loading…" : "Refresh"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Call list */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold">
              {filtered.length} of {total} calls
            </CardTitle>
            <span className="text-xs text-muted-foreground">Click a row for details</span>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* Column headers */}
          <div
            className="grid gap-3 px-4 py-2.5 border-b bg-muted/30 text-xs font-semibold text-muted-foreground uppercase tracking-wide"
            style={{ gridTemplateColumns: "2fr 1.5fr 1fr 1.5fr 1fr 1fr 0.8fr" }}
          >
            <div>Caller / Number</div>
            <div>Office</div>
            <div>Tag</div>
            <div>Routed To</div>
            <div>Sentiment</div>
            <div>Commlog</div>
            <div>Time</div>
          </div>

          {loading ? (
            <div role="status" className="text-center py-12 text-muted-foreground text-sm">
              Loading CareIN calls…
            </div>
          ) : error ? (
            <div role="alert" className="text-center py-12 space-y-2">
              <AlertTriangle size={32} className="mx-auto text-destructive/50" />
              <p className="text-sm text-destructive">{error}</p>
              <p className="text-xs text-muted-foreground">
                Make sure the CareIN server is running on port 3000.
              </p>
              <Button variant="outline" size="sm" onClick={onRefresh}>Retry</Button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Search size={32} className="mx-auto mb-2 opacity-30" aria-hidden />
              <p className="text-sm">No CareIN calls match the current filters.</p>
            </div>
          ) : (
            filtered.map((call) => {
              const cs = COMMLOG_STYLES[call.commlogStatus] ?? COMMLOG_STYLES.pending;
              const sentimentColor =
                call.sentiment === "positive" ? "oklch(0.55 0.18 155)"
                : call.sentiment === "negative" ? "oklch(0.62 0.22 25)"
                : "oklch(0.52 0.015 240)";

              return (
                <Link key={call.id} href={`/carein-calls/${call.id}`}>
                  <div
                    className="grid gap-3 px-4 py-3 border-b border-border/50 hover:bg-muted/30 transition-colors cursor-pointer items-center"
                    style={{ gridTemplateColumns: "2fr 1.5fr 1fr 1.5fr 1fr 1fr 0.8fr" }}
                    role="row"
                  >
                    {/* Caller */}
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate flex items-center gap-1">
                        {call.isEmergency && <AlertTriangle size={11} className="text-destructive flex-shrink-0" aria-label="Emergency" />}
                        {call.callerName}
                      </div>
                      <div className="text-xs font-mono text-muted-foreground">{call.callerNumber}</div>
                    </div>

                    {/* Office */}
                    <div className="text-sm text-muted-foreground truncate">{call.office}</div>

                    {/* Tag */}
                    <div>
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-primary/8 text-primary">
                        {TAG_LABELS[call.tag] ?? call.tag}
                      </span>
                    </div>

                    {/* Routed to */}
                    <div className="text-sm text-muted-foreground truncate">{call.routedTo}</div>

                    {/* Sentiment */}
                    <div className="flex items-center gap-1.5">
                      <div
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: sentimentColor }}
                        aria-label={`Sentiment: ${call.sentiment}`}
                      />
                      <span className="text-xs text-muted-foreground capitalize">{call.sentiment}</span>
                    </div>

                    {/* Commlog status */}
                    <div>
                      <span
                        className="text-xs font-medium px-2 py-0.5 rounded-full"
                        style={{ color: cs.color, backgroundColor: cs.bg }}
                        aria-label={`Commlog: ${cs.label}`}
                      >
                        {cs.label}
                      </span>
                    </div>

                    {/* Time */}
                    <div className="text-xs text-muted-foreground">
                      {formatTimeAgo(call.startedAt)}
                    </div>
                  </div>
                </Link>
              );
            })
          )}
        </CardContent>
      </Card>
    </>
  );
}
