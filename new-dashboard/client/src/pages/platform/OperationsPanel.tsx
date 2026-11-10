/**
 * Developer Console → Operations (SC-1).
 *
 * The voice pipeline's operational widgets: service health and connection
 * tests, the Mango sync (run / history / scheduler start-stop), the
 * configuration readout, usage and costs, the processing queues, and recent
 * sync errors. They used to be the /admin page's tabs. SC-1 moved them here
 * because /admin is now the PRACTICE's settings, and these are platform
 * operations for Beau and future developers.
 *
 * MOVED, NOT REWRITTEN. The widgets are Admin.tsx's, unchanged, and they call
 * the same /api/admin/* endpoints, which SC-1 did not touch. The call store's
 * prune and purge were already on this console (the Call store tab) and stay
 * there.
 */
import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Building2, AlertCircle, ChevronRight, ChevronDown, RefreshCw, Loader2,
  Play, Square,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type {
  AdminHealthData, AdminConfigData, AdminCostsData,
  AdminServiceStatus, SyncHistoryEntry, AdminQueuesData, AdminErrorEntry,
  MangoTranscriptionCosts,
} from "@/lib/api";
import { formatResetTime } from "@/lib/transcribe";

/** Office keys shown first in the on-demand breakdown; anything else follows. */
const OFFICE_ORDER = ["roland", "valley", "unknown"];

/**
 * (M4) Mango transcription usage. Transcription is now a human decision per call, so the
 * question this answers is "what did we choose to spend today, and where is the ceiling" —
 * today's audio minutes against the daily breaker, who ran what, and the month to date.
 */
function MangoTranscriptionCard({ data }: { data: MangoTranscriptionCosts }) {
  const { daily_budget: budget, on_demand_today: today, on_demand_month: month } = data;
  const capped = budget.budget_minutes > 0;
  const pct = capped ? Math.min(100, (budget.used_minutes / budget.budget_minutes) * 100) : 0;
  // Colour the bar by pressure, not decoration: amber past 75%, red when it's spent.
  const barColor = pct >= 100 ? "oklch(0.62 0.22 25)" : pct >= 75 ? "oklch(0.72 0.16 70)" : "var(--primary)";

  const offices = Object.entries(today.by_office).sort(
    (a, b) => (OFFICE_ORDER.indexOf(a[0]) + 1 || 99) - (OFFICE_ORDER.indexOf(b[0]) + 1 || 99)
  );

  return (
    <div className="p-3 rounded-lg bg-muted/40 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-foreground">Mango transcription (on demand)</div>
        <Badge variant={data.auto_transcribe ? "destructive" : "secondary"} className="text-[10px]">
          {data.auto_transcribe ? "Auto: ON" : "Auto: OFF"}
        </Badge>
      </div>

      {/* Today vs the daily breaker */}
      <div>
        <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
          <span>Today&apos;s audio minutes</span>
          <span className="font-mono text-foreground">
            {budget.used_minutes.toFixed(1)} / {capped ? `${budget.budget_minutes}` : "∞"} min
          </span>
        </div>
        {capped && (
          <div className="h-2 bg-border rounded-full overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: barColor }} />
          </div>
        )}
        <div className="text-[11px] text-muted-foreground mt-1">
          {capped && pct >= 100
            ? `Budget spent — resets at ${formatResetTime(budget.resets_at)}.`
            : `Resets at ${formatResetTime(budget.resets_at)} (${budget.timezone}).`}
          {!budget.persisted && " · Not persisted — resets on restart."}
        </div>
      </div>

      {/* Who transcribed what today */}
      <div>
        <div className="text-xs text-muted-foreground mb-1">
          Transcriptions today: <span className="text-foreground font-medium">{today.completed}</span>
          {today.total > today.completed && (
            <span className="text-muted-foreground"> ({today.total} attempts)</span>
          )}
        </div>
        {offices.length === 0 ? (
          <div className="text-[11px] text-muted-foreground">Nobody has transcribed a call today.</div>
        ) : (
          <div className="space-y-0.5">
            {offices.map(([office, counts]) => (
              <div key={office} className="flex items-center justify-between text-[11px]">
                <span className="capitalize text-foreground">{office}</span>
                <span className="text-muted-foreground font-mono">
                  {counts.completed} done · {counts.minutes.toFixed(1)} min
                  {counts.budget_exhausted > 0 && ` · ${counts.budget_exhausted} over budget`}
                  {counts.error > 0 && ` · ${counts.error} failed`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Month to date, at list rates */}
      <div className="pt-2 border-t border-border/60 text-[11px] text-muted-foreground space-y-0.5">
        <div className="flex items-center justify-between">
          <span>{month.month_key} on demand</span>
          <span className="font-mono text-foreground">
            {month.transcriptions} calls · {month.minutes.toFixed(1)} min
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span>Estimated spend (Speech + summaries)</span>
          <span className="font-mono text-foreground">${month.estimated_cost.toFixed(2)}</span>
        </div>
        <div className="text-muted-foreground/80">{data.rates.speech}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Integration display config: maps backend service keys to UI
// ---------------------------------------------------------------------------

const INTEGRATION_DEFS: Array<{
  serviceKey: string;
  testKey: string;
  name: string;
  desc: string;
  icon: string;
  canSync?: boolean;
}> = [
  { serviceKey: "retell", testKey: "retell", name: "Retell AI", desc: "Voice AI platform for inbound call handling", icon: "bot" },
  { serviceKey: "openDental", testKey: "opendental", name: "Open Dental", desc: "Practice management and scheduling", icon: "tooth" },
  { serviceKey: "mango", testKey: "mango", name: "Mango Voice", desc: "VoIP phone system and call routing", icon: "phone", canSync: true },
  { serviceKey: "transcription", testKey: "deepgram", name: "Deepgram", desc: "Speech-to-text transcription service", icon: "mic" },
  { serviceKey: "callAnalyzer", testKey: "openai", name: "OpenAI", desc: "Call analysis and summarization", icon: "brain" },
];

function getIconEmoji(icon: string) {
  const map: Record<string, string> = { bot: "\u{1F916}", tooth: "\u{1F9B7}", phone: "\u{1F4DE}", mic: "\u{1F399}\uFE0F", brain: "\u{1F9E0}" };
  return map[icon] ?? "\u{2699}\uFE0F";
}

function formatTimestamp(ts?: string | null): string {
  if (!ts) return "Never";
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    const now = Date.now();
    const diffMs = now - d.getTime();
    if (diffMs < 60_000) return "Just now";
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} min ago`;
    if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
    return d.toLocaleDateString();
  } catch {
    return ts;
  }
}

export default function OperationsPanel() {
  const [health, setHealth] = useState<AdminHealthData | null>(null);
  const [config, setConfig] = useState<AdminConfigData | null>(null);
  const [costs, setCosts] = useState<AdminCostsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testingService, setTestingService] = useState<string | null>(null);
  const [syncingMango, setSyncingMango] = useState(false);

  const [syncHistory, setSyncHistory] = useState<SyncHistoryEntry[]>([]);
  const [queues, setQueues] = useState<AdminQueuesData | null>(null);
  const [adminErrors, setAdminErrors] = useState<AdminErrorEntry[]>([]);
  const [startingScheduler, setStartingScheduler] = useState(false);
  const [stoppingScheduler, setStoppingScheduler] = useState(false);
  const [syncHistoryOpen, setSyncHistoryOpen] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [healthRes, configRes, costsRes, historyRes, queuesRes, errorsRes] =
        await Promise.allSettled([
          api.getAdminHealth(),
          api.getAdminConfig(),
          api.getAdminCosts(),
          api.getAdminSyncHistory(),
          api.getAdminQueues(),
          api.getAdminErrors(),
        ]);

      if (healthRes.status === "fulfilled") setHealth(healthRes.value);
      if (configRes.status === "fulfilled") setConfig(configRes.value.config ?? null);
      if (costsRes.status === "fulfilled") setCosts(costsRes.value.costs ?? null);
      if (historyRes.status === "fulfilled") setSyncHistory(historyRes.value.history ?? []);
      if (queuesRes.status === "fulfilled") setQueues(queuesRes.value.queues ?? null);
      if (errorsRes.status === "fulfilled") setAdminErrors(errorsRes.value.errors ?? []);

      if (
        healthRes.status === "rejected" &&
        configRes.status === "rejected" &&
        costsRes.status === "rejected"
      ) {
        setError("Unable to reach admin API. Is the backend running?");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load admin data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleTestConnection = async (serviceKey: string, testKey: string) => {
    setTestingService(serviceKey);
    try {
      const res = await api.testConnection(testKey);
      if (res.success) {
        toast.success(res.message || `${testKey} connection successful`);
      } else {
        toast.error(res.message || `${testKey} connection failed`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to test ${testKey}`);
    } finally {
      setTestingService(null);
    }
  };

  const handleMangoSync = async () => {
    setSyncingMango(true);
    try {
      const res = await api.triggerMangoSync();
      if (res.success) {
        toast.success(res.message || "Mango sync triggered");
        setTimeout(() => fetchData(), 2000);
      } else {
        toast.error(res.message || "Sync failed");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to trigger sync");
    } finally {
      setSyncingMango(false);
    }
  };

  const handleStartScheduler = async () => {
    setStartingScheduler(true);
    try {
      const res = await api.startMangoScheduler();
      if (res.success) { toast.success(res.message || "Scheduler started"); fetchData(); }
      else toast.error(res.message || "Failed to start scheduler");
    } catch { toast.error("Failed to start scheduler"); }
    finally { setStartingScheduler(false); }
  };

  const handleStopScheduler = async () => {
    setStoppingScheduler(true);
    try {
      const res = await api.stopMangoScheduler();
      if (res.success) { toast.success(res.message || "Scheduler stopped"); fetchData(); }
      else toast.error(res.message || "Failed to stop scheduler");
    } catch { toast.error("Failed to stop scheduler"); }
    finally { setStoppingScheduler(false); }
  };

  const services = health?.services ?? {};

  return (
    <div className="space-y-8" data-testid="platform-operations">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">Operations</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Service health, the Mango sync, configuration, costs, queues and recent errors
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={fetchData}
          disabled={loading}
          data-testid="operations-refresh"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg text-sm" style={{ backgroundColor: "oklch(0.65 0.20 25 / 0.12)", color: "oklch(0.45 0.20 25)" }}>
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {loading && !health && !config && (
        <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">Loading operations data...</span>
        </div>
      )}

      {!loading && (
        <>
          {/* Service status (was /admin's Office tab) */}
          <section className="space-y-4" data-testid="operations-status">
            <div className="text-sm text-muted-foreground">Practice locations — system-level status shared across offices</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl">
            {([
              { name: "Valley Family Dental", location: "Fort Smith, AR" },
              { name: "Roland Family Dental", location: "Roland, OK" },
            ] as const).map((office) => (
              <Card key={office.name} className="hover:shadow-md transition-shadow">
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-4">
                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                      <Building2 size={18} className="text-primary" />
                    </div>
                    <span
                      className="text-xs px-2 py-0.5 rounded-full font-medium"
                      style={
                        health?.status === "healthy"
                          ? { backgroundColor: "oklch(0.65 0.18 155 / 0.15)", color: "oklch(0.45 0.18 155)" }
                          : { backgroundColor: "oklch(0.78 0.17 75 / 0.15)", color: "oklch(0.50 0.17 75)" }
                      }
                    >
                      {health?.status === "healthy" ? "Active" : health?.status ?? "Unknown"}
                    </span>
                  </div>

                  <div className="font-semibold text-foreground">{office.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{office.location}</div>

                  {/* Service chips */}
                  <div className="flex items-center gap-2 mt-4 flex-wrap">
                    {Object.entries(services).map(([key, svc]) => {
                      const s = svc as AdminServiceStatus;
                      const connected = s.status === "connected" || s.status === "active" || s.status === "healthy" || s.status === "configured" || s.status === "available";
                      return (
                        <span
                          key={key}
                          className="text-xs px-1.5 py-0.5 rounded"
                          style={
                            connected
                              ? { backgroundColor: "oklch(0.65 0.18 155 / 0.12)", color: "oklch(0.45 0.18 155)" }
                              : { backgroundColor: "oklch(0.50 0.01 240 / 0.1)", color: "var(--muted-foreground)" }
                          }
                        >
                          {key}
                        </span>
                      );
                    })}
                  </div>

                  {/* Cost summary */}
                  {costs?.total_estimated !== undefined && (
                    <div className="mt-4 pt-4 border-t border-border">
                      <div className="text-xs text-muted-foreground">Estimated Cost (system-wide)</div>
                      <div className="text-lg font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                        ${costs.total_estimated.toFixed(2)}
                      </div>
                    </div>
                  )}

                  {health?.mangoSync && (
                    <div className={`text-xs mt-2 flex items-center gap-1.5 ${
                      health.mangoSync.lastErrorAt && (!health.mangoSync.lastSuccess || new Date(health.mangoSync.lastErrorAt) > new Date(health.mangoSync.lastSuccess))
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }`}>
                      {health.mangoSync.lastErrorAt && (!health.mangoSync.lastSuccess || new Date(health.mangoSync.lastErrorAt) > new Date(health.mangoSync.lastSuccess))
                        ? `⚠ Mango sync failed: ${health.mangoSync.lastErrorMessage ?? "unknown error"}`
                        : health.mangoSync.lastSuccess
                          ? `Mango sync: last OK ${new Date(health.mangoSync.lastSuccess).toLocaleTimeString()}`
                          : "Mango sync: not yet run"
                      }
                    </div>
                  )}

                  {health?.timestamp && (
                    <div className="text-xs text-muted-foreground mt-3">
                      Last checked: {formatTimestamp(health.timestamp)}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
          </section>

          {/* Integrations: health, connection tests, Mango sync controls and history (was /admin's Integrations tab) */}
          <section className="space-y-4" data-testid="operations-integrations">
          <p className="text-sm text-muted-foreground">
            Live integration status from the backend. Click Test to verify connectivity.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {INTEGRATION_DEFS.map((intg) => {
              const svc = services[intg.serviceKey] as AdminServiceStatus | undefined;
              const connected = svc
                ? svc.status === "connected" || svc.status === "active" || svc.status === "healthy" || svc.status === "configured" || svc.status === "available"
                : false;
              const statusLabel = svc?.status ?? "unknown";
              const lastSync = svc?.last_sync;

              return (
                <Card key={intg.serviceKey}>
                  <CardContent className="p-5">
                    <div className="flex items-start gap-4">
                      <span className="text-2xl flex-shrink-0">{getIconEmoji(intg.icon)}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm text-foreground">{intg.name}</span>
                          <span
                            className="text-xs px-1.5 py-0.5 rounded-full font-medium"
                            style={
                              connected
                                ? { backgroundColor: "oklch(0.65 0.18 155 / 0.15)", color: "oklch(0.45 0.18 155)" }
                                : { backgroundColor: "oklch(0.50 0.01 240 / 0.1)", color: "var(--muted-foreground)" }
                            }
                          >
                            {statusLabel}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{intg.desc}</p>
                        {lastSync && (
                          <p className="text-xs text-muted-foreground mt-1">Last sync: {formatTimestamp(lastSync)}</p>
                        )}
                        {intg.serviceKey === "mango" && svc?.scheduler_running !== undefined && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Scheduler: {svc.scheduler_running ? "Running" : "Stopped"}
                            {svc.next_sync ? ` | Next: ${formatTimestamp(svc.next_sync)}` : ""}
                          </p>
                        )}
                        {intg.serviceKey === "retell" && svc?.webhook_configured !== undefined && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Webhook: {svc.webhook_configured ? "Configured" : "Not configured"}
                          </p>
                        )}
                        {intg.serviceKey === "socketIO" && svc?.connected_clients !== undefined && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Clients: {svc.connected_clients} | Active calls: {svc.active_calls ?? 0}
                          </p>
                        )}
                        {(intg.serviceKey === "transcription" || intg.serviceKey === "callAnalyzer") && svc?.provider && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Provider: {svc.provider}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {intg.canSync && connected && (
                          <>
                            {svc?.scheduler_running ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs text-destructive border-destructive/30 hover:bg-destructive/10"
                                disabled={stoppingScheduler}
                                onClick={handleStopScheduler}
                              >
                                {stoppingScheduler ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
                                <span className="ml-1">Stop</span>
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                disabled={startingScheduler}
                                onClick={handleStartScheduler}
                              >
                                {startingScheduler ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                                <span className="ml-1">Start</span>
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs"
                              disabled={syncingMango}
                              onClick={handleMangoSync}
                            >
                              {syncingMango ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                            </Button>
                          </>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={testingService === intg.serviceKey}
                          onClick={() => handleTestConnection(intg.serviceKey, intg.testKey)}
                        >
                          {testingService === intg.serviceKey ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            "Test"
                          )}
                        </Button>
                      </div>
                    </div>

                    {/* Sync history disclosure for Mango */}
                    {intg.serviceKey === "mango" && connected && (
                      <div className="mt-3 pt-3 border-t border-border">
                        <button
                          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                          onClick={() => setSyncHistoryOpen(!syncHistoryOpen)}
                        >
                          {syncHistoryOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          Sync history ({syncHistory.length})
                        </button>
                        {syncHistoryOpen && (
                          <div className="mt-2 space-y-1.5">
                            {syncHistory.length === 0 ? (
                              <p className="text-xs text-muted-foreground pl-5">No sync history yet</p>
                            ) : (
                              syncHistory.slice(0, 5).map((entry, i) => {
                                const hasErrors = (entry.errors?.length ?? 0) > 0;
                                return (
                                  <div key={entry.id || i} className="flex items-center justify-between text-xs pl-5">
                                    <span className="text-muted-foreground">{formatTimestamp(entry.started_at)}</span>
                                    <div className="flex items-center gap-2">
                                      <span className="text-muted-foreground">{entry.calls_processed ?? 0} calls</span>
                                      {hasErrors ? (
                                        <span className="text-xs px-1.5 py-0.5 rounded-full font-medium" style={{ backgroundColor: "oklch(0.65 0.20 25 / 0.12)", color: "oklch(0.45 0.20 25)" }}>
                                          {entry.errors!.length} errors
                                        </span>
                                      ) : (
                                        <span className="text-xs px-1.5 py-0.5 rounded-full font-medium" style={{ backgroundColor: "oklch(0.65 0.18 155 / 0.12)", color: "oklch(0.45 0.18 155)" }}>
                                          OK
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
          </section>

          {/* Configuration, usage and costs, queues, errors (was /admin's Settings tab) */}
          <section className="space-y-6 max-w-2xl" data-testid="operations-config">
          {/* Open Dental Config */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">Open Dental Connection</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {[
                {
                  label: "Connection Type",
                  value: config?.openDental?.connection_type ?? "Not configured",
                },
                {
                  label: "API URL Configured",
                  value: config?.openDental?.api_url_configured ? "Yes" : "No",
                },
                {
                  label: "Enabled",
                  value: config?.openDental?.enabled ? "Yes" : "No",
                },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-foreground">{label}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{String(value)}</div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Mango Config */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">Mango Voice Sync</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {[
                {
                  label: "Enabled",
                  value: config?.mango?.enabled ? "Yes" : "No",
                },
                {
                  label: "Sync Interval",
                  value: config?.mango?.sync_interval ?? "Not configured",
                },
                {
                  label: "Scheduler Status",
                  value: (services.mango as AdminServiceStatus | undefined)?.scheduler_running ? "Running" : "Stopped",
                },
                {
                  label: "Last Sync",
                  value: formatTimestamp((services.mango as AdminServiceStatus | undefined)?.last_sync),
                },
                {
                  label: "Next Sync",
                  value: formatTimestamp((services.mango as AdminServiceStatus | undefined)?.next_sync),
                },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-foreground">{label}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{String(value)}</div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* AI Services Config */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">AI Services</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {[
                {
                  label: "Transcription Provider",
                  value: config?.transcription?.provider ?? (services.transcription as AdminServiceStatus | undefined)?.provider ?? "Not configured",
                },
                {
                  label: "Transcription Configured",
                  value: config?.transcription?.configured ? "Yes" : "No",
                },
                {
                  label: "Analysis Provider",
                  value: config?.analysis?.provider ?? (services.callAnalyzer as AdminServiceStatus | undefined)?.provider ?? "Not configured",
                },
                {
                  label: "Analysis Configured",
                  value: config?.analysis?.configured ? "Yes" : "No",
                },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-foreground">{label}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{String(value)}</div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Costs */}
          {costs && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">Usage & Costs</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {costs.mango_transcription && (
                  <MangoTranscriptionCard data={costs.mango_transcription} />
                )}
                {costs.transcription && (
                  <div className="p-3 rounded-lg bg-muted/40">
                    <div className="text-sm font-medium text-foreground">Transcription ({costs.transcription.provider})</div>
                    <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                      <div>Total transcriptions: {costs.transcription.total_transcriptions}</div>
                      <div>Total minutes: {costs.transcription.total_minutes.toFixed(1)}</div>
                      <div>Rate: {costs.transcription.rate}</div>
                      <div>Estimated cost: ${costs.transcription.estimated_cost.toFixed(4)}</div>
                    </div>
                  </div>
                )}
                {costs.analysis && (
                  <div className="p-3 rounded-lg bg-muted/40">
                    <div className="text-sm font-medium text-foreground">Analysis ({costs.analysis.provider})</div>
                    <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                      <div>Total analyses: {costs.analysis.total_analyses}</div>
                      <div>Total tokens: {costs.analysis.total_tokens.toLocaleString()}</div>
                      <div>Rate: {costs.analysis.rate}</div>
                      <div>Estimated cost: ${costs.analysis.estimated_cost.toFixed(4)}</div>
                    </div>
                  </div>
                )}
                {costs.total_estimated !== undefined && (
                  <div className="flex items-center justify-between pt-2 border-t border-border">
                    <span className="text-sm font-medium text-foreground">Total Estimated</span>
                    <span className="text-lg font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                      ${costs.total_estimated.toFixed(2)}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Processing Queues */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">Processing Queues</CardTitle>
            </CardHeader>
            <CardContent>
              {queues ? (
                <div className="space-y-3">
                  {([
                    { label: "Transcription", q: queues.transcription },
                    { label: "Call Analysis", q: queues.analysis },
                    { label: "Open Dental Sync", q: queues.open_dental_sync },
                  ] as const).map(({ label, q }) => (
                    <div key={label} className="flex items-center justify-between">
                      <span className="text-sm text-foreground">{label}</span>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {q.pending > 0 && <span className="text-amber-600">{q.pending} pending</span>}
                        {q.processing > 0 && <span className="text-blue-600">{q.processing} processing</span>}
                        <span>{q.completed_today} today</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Queue data unavailable</p>
              )}
            </CardContent>
          </Card>

          {/* Recent Errors */}
          {adminErrors.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <AlertCircle size={14} className="text-destructive" />
                  Recent Sync Errors
                  <span className="ml-auto text-xs font-normal text-muted-foreground">{adminErrors.length} total</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {adminErrors.slice(0, 10).map((e, i) => (
                    <div key={i} className="text-xs p-2 rounded bg-destructive/5 border border-destructive/10">
                      <div className="text-muted-foreground mb-0.5">{formatTimestamp(e.timestamp)}</div>
                      <div className="text-foreground font-medium truncate">{e.error}</div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
          </section>
        </>
      )}
    </div>
  );
}
