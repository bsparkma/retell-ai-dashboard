/**
 * Calls — Unified Call Log (Retell + Mango Voice)
 * Filterable, searchable call list with source labels, sentiment, and patient linking
 */
import { useState, useEffect } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Search, Filter, Bot, Users, Phone, PhoneOff, PhoneMissed,
  ChevronRight, Download, RefreshCw, Mic, FileText, AlertTriangle,
  Volume2
} from "lucide-react";
import { api, type UnifiedCall } from "@/lib/api";
import { formatDuration, formatTimeAgo } from "@/lib/utils";
import { toast } from "sonner";

type CallSource = "all" | "retell" | "mango";
type CallStatus = "all" | "completed" | "transferred" | "voicemail" | "missed";

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

function getTranscriptPreview(call: UnifiedCall): string | null {
  // Try transcript_object first — find last patient utterance
  if (call.transcript_object && call.transcript_object.length > 0) {
    for (let i = call.transcript_object.length - 1; i >= 0; i--) {
      const u = call.transcript_object[i];
      if (u.role && u.role !== "agent" && u.role !== "assistant" && u.content) {
        return u.content;
      }
    }
    // Fallback: last utterance of any role
    const last = call.transcript_object[call.transcript_object.length - 1];
    if (last?.content) return last.content;
  }
  // Try plain transcript string
  if (typeof call.transcript === "string" && call.transcript.trim()) {
    const lines = call.transcript.trim().split("\n").filter(Boolean);
    return lines[lines.length - 1] ?? null;
  }
  return null;
}

export default function Calls() {
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<CallSource>("all");
  const [status, setStatus] = useState<CallStatus>("all");
  const [calls, setCalls] = useState<UnifiedCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const loadCalls = () => {
    setLoading(true);
    api.getUnifiedCalls({ limit: 200, source: source === "all" ? undefined : source, search: search || undefined })
      .then(({ calls: list }) => setCalls(list))
      .catch(() => setCalls([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadCalls();
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await api.syncRetell({ limit: 50 });
      toast.success(res.message ?? "Sync complete");
      loadCalls();
    } catch {
      toast.error("Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const filtered = calls.filter((call) => {
    const matchSearch = !search ||
      call.patientName.toLowerCase().includes(search.toLowerCase()) ||
      call.fromNumber.includes(search) ||
      call.intent?.toLowerCase().includes(search.toLowerCase());
    const matchSource = source === "all" || call.source === source;
    const matchStatus = status === "all" || call.status === status;
    return matchSearch && matchSource && matchStatus;
  });

  const stats = {
    total: calls.length,
    retell: calls.filter(c => c.source === "retell").length,
    mango: calls.filter(c => c.source === "mango").length,
    avgDuration: calls.length ? Math.round(calls.reduce((a, c) => a + c.duration, 0) / calls.length) : 0,
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
            Call Log
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Unified view of all Retell AI and Mango Voice calls
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
            <RefreshCw size={14} className={`mr-1.5 ${syncing ? "animate-spin" : ""}`} /> {syncing ? "Syncing…" : "Sync"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => toast.info("Exporting call log...")}>
            <Download size={14} className="mr-1.5" /> Export
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total Calls", value: stats.total, sub: "All time" },
          { label: "AI Handled", value: stats.retell, sub: "Retell AI", color: "oklch(0.55 0.18 210)" },
          { label: "Staff Calls", value: stats.mango, sub: "Mango Voice", color: "oklch(0.65 0.17 75)" },
          { label: "Avg Duration", value: formatDuration(stats.avgDuration), sub: "Per call" },
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

            {/* Source filter */}
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

            {/* Status filter */}
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
              {filtered.length} calls
            </CardTitle>
            <span className="text-xs text-muted-foreground">Click a row to view details</span>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* Table header */}
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
            <div className="text-center py-12 text-muted-foreground text-sm">Loading calls…</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Search size={32} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">No calls found. Sync Retell or check your backend.</p>
            </div>
          ) : filtered.map((call) => {
            const sc = statusConfig[call.status] || statusConfig.completed;
            const StatusIcon = sc.icon;
            return (
              <Link key={call.id} href={`/calls/${call.id}`}>
                <div className="grid grid-cols-12 gap-3 px-4 py-3 border-b border-border/50 hover:bg-muted/30 transition-colors cursor-pointer items-center">
                  {/* Patient */}
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

                  {/* Source */}
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

                  {/* Intent */}
                  <div className="col-span-2 text-sm text-muted-foreground truncate">
                    {call.intent || "—"}
                  </div>

                  {/* Status */}
                  <div className="col-span-2">
                    <span
                      className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full"
                      style={sc.style}
                    >
                      <StatusIcon size={10} />
                      {sc.label}
                    </span>
                  </div>

                  {/* Duration */}
                  <div className="col-span-1 text-sm font-mono text-muted-foreground flex items-center gap-1">
                    {formatDuration(call.duration)}
                    {call.hasRecording && <span title="Has recording"><Volume2 size={11} className="text-primary/60 flex-shrink-0" /></span>}
                    {call.hasTranscript && <span title="Has transcript"><FileText size={11} className="text-primary/60 flex-shrink-0" /></span>}
                  </div>

                  {/* Sentiment */}
                  <div className="col-span-1">
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: sentimentColors[call.sentiment] || sentimentColors.neutral }}
                      title={call.sentiment}
                    />
                  </div>

                  {/* Time */}
                  <div className="col-span-1 text-xs text-muted-foreground">
                    {formatTimeAgo(call.date)}
                  </div>
                </div>
              </Link>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
