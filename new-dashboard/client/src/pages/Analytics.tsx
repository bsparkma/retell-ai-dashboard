/**
 * Analytics — Call center performance analytics
 * Volume trends, intent breakdown, sentiment, hourly heatmap, AI vs staff
 */
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, ResponsiveContainer, Tooltip, Legend,
} from "recharts";
import { Download, TrendingUp, TrendingDown, Bot, Users, Phone, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";

const INTENT_COLORS = [
  "oklch(0.55 0.18 210)",
  "oklch(0.65 0.18 155)",
  "oklch(0.78 0.17 75)",
  "oklch(0.62 0.22 25)",
  "oklch(0.55 0.15 280)",
  "oklch(0.52 0.015 240)",
];

type DateRange = "7d" | "30d" | "90d";
const DAYS_MAP: Record<DateRange, number> = { "7d": 7, "30d": 30, "90d": 90 };

interface AnalyticsData {
  kpis: {
    totalCalls: number;
    aiHandled: number;
    staffHandled: number;
    aiHandledPct: number;
    avgDurationSec: number;
    emergencyCalls: number;
    missedCalls: number;
  };
  callVolume: Array<{ date: string; retell: number; mango: number }>;
  intentBreakdown: Array<{ name: string; value: number }>;
  sentimentTrend: Array<{ date: string; positive: number; neutral: number; negative: number }>;
  hourlyVolume: Array<{ hour: string; calls: number }>;
}

function formatDurationShort(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function parseHour24(label: string): number {
  const m = label.match(/^(\d+)(AM|PM)$/);
  if (!m) return -1;
  let h = parseInt(m[1]);
  if (m[2] === "PM" && h !== 12) h += 12;
  if (m[2] === "AM" && h === 12) h = 0;
  return h;
}

function downloadCSV(filename: string, rows: string[][]): void {
  const csv = rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Analytics() {
  const [dateRange, setDateRange] = useState<DateRange>("7d");
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = (range: DateRange) => {
    setLoading(true);
    setError(null);
    api
      .getAnalyticsSummary({ days: DAYS_MAP[range] })
      .then((res) => {
        setData({
          kpis: res.kpis,
          callVolume: res.callVolume,
          intentBreakdown: res.intentBreakdown,
          sentimentTrend: res.sentimentTrend,
          hourlyVolume: res.hourlyVolume,
        });
      })
      .catch((err) => {
        setError(err?.message ?? "Failed to load analytics");
        setData(null);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData(dateRange);
  }, [dateRange]);

  const kpis = data
    ? [
        { label: "Total Calls", value: String(data.kpis.totalCalls), icon: Phone },
        { label: "AI Handled", value: String(data.kpis.aiHandled), icon: Bot },
        { label: "Transfer Rate", value: data.kpis.totalCalls > 0 ? `${100 - data.kpis.aiHandledPct}%` : "—", icon: Users },
        { label: "Avg Duration", value: formatDurationShort(data.kpis.avgDurationSec), icon: TrendingUp },
        { label: "Emergency", value: String(data.kpis.emergencyCalls), icon: TrendingDown },
        { label: "Missed Calls", value: String(data.kpis.missedCalls), icon: TrendingDown },
      ]
    : [];

  const hourlyChartData = data
    ? data.hourlyVolume.filter((h) => {
        const h24 = parseHour24(h.hour);
        return h24 >= 7 && h24 <= 19;
      })
    : [];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
            Analytics
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Call center performance and AI agent metrics
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-muted rounded-md p-1">
            {(["7d", "30d", "90d"] as DateRange[]).map((r) => (
              <button
                key={r}
                onClick={() => setDateRange(r)}
                className="px-3 py-1 rounded text-xs font-medium transition-all"
                style={{
                  backgroundColor: dateRange === r ? "white" : "transparent",
                  color: dateRange === r ? "oklch(0.18 0.02 240)" : "oklch(0.52 0.015 240)",
                  boxShadow: dateRange === r ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
                }}
              >
                {r}
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchData(dateRange)}
            disabled={loading}
          >
            <RefreshCw size={14} className="mr-1.5" /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => {
            if (!data) { toast.warning("No data to export"); return; }
            const dateStr = new Date().toISOString().slice(0, 10);
            const volumeRows: string[][] = [
              ["Date", "AI (Retell)", "Staff (Mango)", "Total"],
              ...data.callVolume.map((r) => [r.date, String(r.retell), String(r.mango), String(r.retell + r.mango)]),
            ];
            downloadCSV(`carein-call-volume-${dateStr}.csv`, volumeRows);
            toast.success("Call volume exported");
          }}>
            <Download size={14} className="mr-1.5" /> Export
          </Button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-800">
          {error} — Ensure the backend is running.
        </div>
      )}

      {/* Loading state */}
      {loading && !data && (
        <div className="rounded-lg border border-border bg-muted/20 p-12 text-center text-muted-foreground">
          Loading analytics...
        </div>
      )}

      {/* KPI cards */}
      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
            {kpis.map((kpi) => (
              <Card key={kpi.label}>
                <CardContent className="p-4">
                  <div className="text-2xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
                    {kpi.value}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{kpi.label}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Charts row 1 */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            {/* Call volume */}
            <Card className="xl:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">Call Volume — AI vs Staff</CardTitle>
              </CardHeader>
              <CardContent>
                {data.callVolume.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={data.callVolume} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                      <XAxis dataKey="date" tick={{ fontSize: 11, fill: "oklch(0.52 0.015 240)" }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "oklch(0.52 0.015 240)" }} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={{ background: "white", border: "1px solid oklch(0.90 0.006 85)", borderRadius: 8, fontSize: 12 }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="retell" name="AI (Retell)" fill="oklch(0.55 0.18 210)" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="mango" name="Staff (Mango)" fill="oklch(0.78 0.17 75 / 0.7)" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-[220px] flex items-center justify-center text-muted-foreground text-sm">No call data yet</div>
                )}
              </CardContent>
            </Card>

            {/* Intent breakdown */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">Call Intent Breakdown</CardTitle>
              </CardHeader>
              <CardContent>
                {data.intentBreakdown.length > 0 ? (
                  <>
                    <ResponsiveContainer width="100%" height={160}>
                      <PieChart>
                        <Pie data={data.intentBreakdown} cx="50%" cy="50%" innerRadius={45} outerRadius={70} paddingAngle={2} dataKey="value">
                          {data.intentBreakdown.map((_, i) => (
                            <Cell key={i} fill={INTENT_COLORS[i % INTENT_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip contentStyle={{ background: "white", border: "1px solid oklch(0.90 0.006 85)", borderRadius: 8, fontSize: 12 }} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="space-y-1.5 mt-2">
                      {data.intentBreakdown.slice(0, 6).map((item, i) => (
                        <div key={item.name} className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-2">
                            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: INTENT_COLORS[i % INTENT_COLORS.length] }} />
                            <span className="text-muted-foreground">{item.name}</span>
                          </div>
                          <span className="font-medium">{item.value}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">No intent data</div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Charts row 2 */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {/* Sentiment trend */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">Sentiment Trend</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={data.sentimentTrend} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                    <defs>
                      <linearGradient id="posGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="oklch(0.65 0.18 155)" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="oklch(0.65 0.18 155)" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="negGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="oklch(0.62 0.22 25)" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="oklch(0.62 0.22 25)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: "oklch(0.52 0.015 240)" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: "oklch(0.52 0.015 240)" }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ background: "white", border: "1px solid oklch(0.90 0.006 85)", borderRadius: 8, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Area type="monotone" dataKey="positive" name="Positive" stroke="oklch(0.55 0.18 155)" fill="url(#posGrad)" strokeWidth={2} dot={false} />
                    <Area type="monotone" dataKey="neutral" name="Neutral" stroke="oklch(0.52 0.015 240)" fill="none" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
                    <Area type="monotone" dataKey="negative" name="Negative" stroke="oklch(0.62 0.22 25)" fill="url(#negGrad)" strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Hourly volume */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">Hourly Call Distribution</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={hourlyChartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                    <XAxis dataKey="hour" tick={{ fontSize: 11, fill: "oklch(0.52 0.015 240)" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: "oklch(0.52 0.015 240)" }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ background: "white", border: "1px solid oklch(0.90 0.006 85)", borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="calls" fill="oklch(0.55 0.18 210 / 0.7)" radius={[3, 3, 0, 0]}>
                      {hourlyChartData.map((entry, i) => (
                        <Cell key={i} fill={entry.calls > 5 ? "oklch(0.55 0.18 210)" : "oklch(0.55 0.18 210 / 0.5)"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          {/* AI performance summary */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Bot size={15} className="text-primary" /> AI Agent Performance
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                {[
                  {
                    label: "Calls Fully Handled by AI",
                    value: `${data.kpis.aiHandledPct}%`,
                    sub: `${data.kpis.aiHandled} of ${data.kpis.totalCalls} calls`,
                    color: "oklch(0.55 0.18 210)",
                  },
                  {
                    label: "Staff Handled",
                    value: String(data.kpis.staffHandled),
                    sub: `${data.kpis.totalCalls > 0 ? Math.round((data.kpis.staffHandled / data.kpis.totalCalls) * 100) : 0}% of total`,
                    color: "oklch(0.55 0.18 155)",
                  },
                  {
                    label: "Avg Call Duration",
                    value: formatDurationShort(data.kpis.avgDurationSec),
                    sub: `${data.kpis.totalCalls} calls analyzed`,
                    color: "oklch(0.55 0.15 280)",
                  },
                  {
                    label: "Emergency Calls",
                    value: String(data.kpis.emergencyCalls),
                    sub: `Last ${DAYS_MAP[dateRange]} days`,
                    color: "oklch(0.65 0.17 75)",
                  },
                ].map((m) => (
                  <div key={m.label} className="text-center p-4 rounded-xl bg-muted/30">
                    <div className="text-3xl font-bold" style={{ fontFamily: "Outfit, sans-serif", color: m.color }}>
                      {m.value}
                    </div>
                    <div className="text-sm font-medium text-foreground mt-1">{m.label}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{m.sub}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
