/**
 * Admin — Office status, integrations, and system settings
 * Pulls real data from backend /api/admin/* endpoints
 */
import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Building2, Users, Settings, CheckCircle2, AlertCircle,
  Globe, Key, Bell, ChevronRight, RefreshCw, Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types for backend responses
// ---------------------------------------------------------------------------

interface ServiceStatus {
  status: string;
  connected_clients?: number;
  active_calls?: number;
  webhook_configured?: boolean;
  last_sync?: string;
  next_sync?: string;
  scheduler_running?: boolean;
  connection_type?: string;
  provider?: string;
  stats?: Record<string, unknown>;
}

interface HealthData {
  status: string;
  timestamp: string;
  services: Record<string, ServiceStatus>;
}

interface ConfigData {
  mango?: { enabled?: boolean; sync_interval?: string; [k: string]: unknown };
  openDental?: { enabled?: boolean; connection_type?: string; api_url_configured?: boolean; [k: string]: unknown };
  transcription?: { enabled?: boolean; provider?: string; [k: string]: unknown };
  analysis?: { enabled?: boolean; provider?: string; [k: string]: unknown };
  [k: string]: unknown;
}

interface CostsData {
  transcription?: { provider?: string; total_minutes?: number; total_transcriptions?: number; estimated_cost?: number; rate?: string };
  analysis?: { provider?: string; total_analyses?: number; total_tokens?: number; estimated_cost?: number; rate?: string };
  total_estimated?: number;
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

type AdminTab = "offices" | "users" | "integrations" | "settings";

export default function Admin() {
  const [activeTab, setActiveTab] = useState<AdminTab>("integrations");
  const [health, setHealth] = useState<HealthData | null>(null);
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [costs, setCosts] = useState<CostsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testingService, setTestingService] = useState<string | null>(null);
  const [syncingMango, setSyncingMango] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [healthRes, configRes, costsRes] = await Promise.allSettled([
        api.getAdminHealth(),
        api.getAdminConfig(),
        api.getAdminCosts(),
      ]);

      if (healthRes.status === "fulfilled") {
        setHealth(healthRes.value as HealthData);
      }
      if (configRes.status === "fulfilled") {
        setConfig((configRes.value as { config: ConfigData }).config ?? null);
      }
      if (costsRes.status === "fulfilled") {
        setCosts((costsRes.value as { costs: CostsData }).costs ?? null);
      }

      // If all three failed, show error
      if (healthRes.status === "rejected" && configRes.status === "rejected" && costsRes.status === "rejected") {
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
        // Refresh data after sync
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

  const tabs = [
    { id: "offices", label: "Office", icon: Building2 },
    { id: "users", label: "Users & Roles", icon: Users },
    { id: "integrations", label: "Integrations", icon: Globe },
    { id: "settings", label: "Settings", icon: Settings },
  ] as const;

  const services = health?.services ?? {};

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
            Admin
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage office status, integrations, and system settings
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={fetchData}
          disabled={loading}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh
        </Button>
      </div>

      {/* Global error banner */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg text-sm" style={{ backgroundColor: "oklch(0.65 0.20 25 / 0.12)", color: "oklch(0.45 0.20 25)" }}>
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {/* Tab nav */}
      <div className="flex items-center gap-0 border-b overflow-x-auto">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-1.5 px-5 py-3 text-sm font-medium border-b-2 transition-all whitespace-nowrap ${
              activeTab === id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {/* Loading skeleton */}
      {loading && !health && !config && (
        <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">Loading admin data...</span>
        </div>
      )}

      {/* OFFICES TAB */}
      {activeTab === "offices" && !loading && (
        <div className="space-y-4">
          <div className="text-sm text-muted-foreground">Current practice</div>

          <Card className="hover:shadow-md transition-shadow max-w-xl">
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

              <div className="font-semibold text-foreground">CareIn Dashboard</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Connected via {String((config?.openDental as Record<string, unknown>)?.connection_type ?? "unknown")}
              </div>

              {/* Service status summary */}
              <div className="flex items-center gap-2 mt-4 flex-wrap">
                {Object.entries(services).map(([key, svc]) => {
                  const s = svc as ServiceStatus;
                  const connected = s.status === "connected" || s.status === "active" || s.status === "healthy";
                  return (
                    <span
                      key={key}
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={
                        connected
                          ? { backgroundColor: "oklch(0.65 0.18 155 / 0.12)", color: "oklch(0.45 0.18 155)" }
                          : { backgroundColor: "oklch(0.50 0.01 240 / 0.1)", color: "oklch(0.52 0.015 240)" }
                      }
                    >
                      {key}
                    </span>
                  );
                })}
              </div>

              {/* Costs summary */}
              {costs?.total_estimated !== undefined && (
                <div className="mt-4 pt-4 border-t border-border">
                  <div className="text-xs text-muted-foreground">Estimated Monthly Cost</div>
                  <div className="text-lg font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
                    ${typeof costs.total_estimated === "number" ? costs.total_estimated.toFixed(2) : costs.total_estimated}
                  </div>
                </div>
              )}

              {health?.timestamp && (
                <div className="text-xs text-muted-foreground mt-3">
                  Last checked: {formatTimestamp(health.timestamp)}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* USERS TAB */}
      {activeTab === "users" && (
        <div className="space-y-4">
          <Card className="max-w-2xl">
            <CardContent className="py-12 text-center">
              <Users size={32} className="mx-auto text-muted-foreground mb-3" />
              <div className="text-sm font-medium text-foreground">User Management Coming Soon</div>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                Role-based access control and user invitations will be available in a future update.
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* INTEGRATIONS TAB */}
      {activeTab === "integrations" && !loading && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Live integration status from the backend. Click Test to verify connectivity.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {INTEGRATION_DEFS.map((intg) => {
              const svc = services[intg.serviceKey] as ServiceStatus | undefined;
              const connected = svc
                ? svc.status === "connected" || svc.status === "active" || svc.status === "healthy"
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
                                : { backgroundColor: "oklch(0.50 0.01 240 / 0.1)", color: "oklch(0.52 0.015 240)" }
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
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={syncingMango}
                            onClick={handleMangoSync}
                          >
                            {syncingMango ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                          </Button>
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
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* SETTINGS TAB */}
      {activeTab === "settings" && !loading && (
        <div className="space-y-6 max-w-2xl">
          {/* Open Dental Config */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">Open Dental Connection</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {[
                {
                  label: "Connection Type",
                  value: (config?.openDental as Record<string, unknown>)?.connection_type ?? "Not configured",
                },
                {
                  label: "API URL Configured",
                  value: (config?.openDental as Record<string, unknown>)?.api_url_configured ? "Yes" : "No",
                },
                {
                  label: "Enabled",
                  value: (config?.openDental as Record<string, unknown>)?.enabled ? "Yes" : "No",
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
                  value: (services.mango as ServiceStatus)?.scheduler_running ? "Running" : "Stopped",
                },
                {
                  label: "Last Sync",
                  value: formatTimestamp((services.mango as ServiceStatus)?.last_sync),
                },
                {
                  label: "Next Sync",
                  value: formatTimestamp((services.mango as ServiceStatus)?.next_sync),
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

          {/* Transcription & Analysis Config */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">AI Services</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {[
                {
                  label: "Transcription Provider",
                  value: config?.transcription?.provider ?? (services.transcription as ServiceStatus)?.provider ?? "Not configured",
                },
                {
                  label: "Transcription Enabled",
                  value: config?.transcription?.enabled ? "Yes" : "No",
                },
                {
                  label: "Analysis Provider",
                  value: config?.analysis?.provider ?? (services.callAnalyzer as ServiceStatus)?.provider ?? "Not configured",
                },
                {
                  label: "Analysis Enabled",
                  value: config?.analysis?.enabled ? "Yes" : "No",
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
                {costs.transcription && (
                  <div className="p-3 rounded-lg bg-muted/40">
                    <div className="text-sm font-medium text-foreground">Transcription ({costs.transcription.provider})</div>
                    <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                      <div>Total transcriptions: {costs.transcription.total_transcriptions ?? "N/A"}</div>
                      <div>Total minutes: {costs.transcription.total_minutes?.toFixed(1) ?? "N/A"}</div>
                      <div>Rate: {costs.transcription.rate ?? "N/A"}</div>
                      <div>Estimated cost: ${costs.transcription.estimated_cost?.toFixed(4) ?? "N/A"}</div>
                    </div>
                  </div>
                )}
                {costs.analysis && (
                  <div className="p-3 rounded-lg bg-muted/40">
                    <div className="text-sm font-medium text-foreground">Analysis ({costs.analysis.provider})</div>
                    <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                      <div>Total analyses: {costs.analysis.total_analyses ?? "N/A"}</div>
                      <div>Total tokens: {costs.analysis.total_tokens?.toLocaleString() ?? "N/A"}</div>
                      <div>Rate: {costs.analysis.rate ?? "N/A"}</div>
                      <div>Estimated cost: ${costs.analysis.estimated_cost?.toFixed(4) ?? "N/A"}</div>
                    </div>
                  </div>
                )}
                {costs.total_estimated !== undefined && (
                  <div className="flex items-center justify-between pt-2 border-t border-border">
                    <span className="text-sm font-medium text-foreground">Total Estimated</span>
                    <span className="text-lg font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
                      ${typeof costs.total_estimated === "number" ? costs.total_estimated.toFixed(2) : costs.total_estimated}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Notifications — static for now */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Bell size={14} className="text-primary" /> Notifications
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {[
                { label: "Emergency call alerts", enabled: true },
                { label: "Missed call notifications", enabled: true },
                { label: "Daily call summary email", enabled: true },
                { label: "Agent error alerts", enabled: false },
              ].map(({ label, enabled }) => (
                <div key={label} className="flex items-center justify-between">
                  <span className="text-sm text-foreground">{label}</span>
                  <button
                    className="relative w-10 h-5 rounded-full transition-all"
                    style={{ backgroundColor: enabled ? "oklch(0.55 0.18 210)" : "oklch(0.70 0.01 240)" }}
                    onClick={() => toast.info("Notification settings saved")}
                  >
                    <span
                      className="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform"
                      style={{ transform: enabled ? "translateX(20px)" : "translateX(0)" }}
                    />
                  </button>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
