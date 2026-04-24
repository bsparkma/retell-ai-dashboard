/**
 * Dashboard — CareIn Home Page
 * Command center overview: stats, today's schedule, callbacks queue, recent calls
 */
import { useState, useEffect } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  PhoneCall, Clock, TrendingUp, CalendarDays,
  ArrowRight, CheckCircle2, Bot,
  PhoneIncoming, BarChart3, RefreshCw
} from "lucide-react";
import { api, type UnifiedCall, type CallbackDisplay } from "@/lib/api";
import { formatDuration, formatTimeAgo } from "@/lib/utils";
import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip } from "recharts";
import { toast } from "sonner";

type AppointmentDisplay = { id: string; patientName: string; time: string; type: string; provider: string; status: "confirmed" | "unconfirmed" };
type HourlyDataPoint = { hour: string; calls: number };

export default function Dashboard() {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [callbacks, setCallbacks] = useState<CallbackDisplay[]>([]);
  const [recentCalls, setRecentCalls] = useState<UnifiedCall[]>([]);
  const [todayAppointments, setTodayAppointments] = useState<AppointmentDisplay[]>([]);
  const [loading, setLoading] = useState(true);
  const [hourlyData, setHourlyData] = useState<HourlyDataPoint[]>([]);
  const [todayKpis, setTodayKpis] = useState<{
    totalCalls: number;
    aiHandled: number;
    aiHandledPct: number;
    avgDurationSec: number;
  } | null>(null);
  const [analyticsError, setAnalyticsError] = useState(false);

  const pendingCallbacks = callbacks.filter(c => c.status === "pending");
  const confirmedApts = todayAppointments.filter(a => a.status === "confirmed");
  const unconfirmedApts = todayAppointments.filter(a => a.status === "unconfirmed");

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setAnalyticsError(false);
    setLoading(true);
    const today = new Date().toISOString().split("T")[0];
    Promise.all([
      api.getCallbacks().then(setCallbacks).catch(() => setCallbacks([])),
      api.getUnifiedCalls({ limit: 10 }).then(({ calls }) => setRecentCalls(calls)).catch(() => setRecentCalls([])),
      api.getAnalyticsSummary({ days: 1 }).then((res) => {
        const filtered = res.hourlyVolume.filter((h) => {
          const match = h.hour.match(/^(\d+)(AM|PM)$/);
          if (!match) return false;
          let hr = parseInt(match[1]);
          if (match[2] === "PM" && hr !== 12) hr += 12;
          if (match[2] === "AM" && hr === 12) hr = 0;
          return hr >= 8 && hr <= 17;
        });
        setHourlyData(filtered.length > 0 ? filtered : []);
        setTodayKpis({
          totalCalls: res.kpis.totalCalls,
          aiHandled: res.kpis.aiHandled,
          aiHandledPct: res.kpis.aiHandledPct,
          avgDurationSec: res.kpis.avgDurationSec,
        });
      }).catch(() => { setHourlyData([]); setAnalyticsError(true); }),
      api.getOpenDentalCalendar({ date: today }).then(({ appointments }) => {
        if (Array.isArray(appointments) && appointments.length > 0) {
          const mapped = (appointments as Array<Record<string, unknown>>).map((a, i) => ({
            id: (a.id as string) ?? `apt-${i}`,
            patientName: (a.patientName ?? a.patient ?? "Patient") as string,
            time: (a.time ?? "09:00") as string,
            type: (a.type ?? "Appointment") as string,
            provider: (a.providerName ?? a.provider ?? "—") as string,
            status: (a.status === "confirmed" || a.status === "scheduled" ? "confirmed" : "unconfirmed") as "confirmed" | "unconfirmed",
          }));
          setTodayAppointments(mapped);
        } else setTodayAppointments([]);
      }).catch(() => setTodayAppointments([])),
    ]).finally(() => setLoading(false));
  }, [lastRefresh]);

  const hour = currentTime.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const stats = [
    {
      label: "Today's Calls",
      value: analyticsError && !todayKpis ? "—" : (todayKpis?.totalCalls ?? recentCalls.length),
      sub: loading ? "Loading..." : analyticsError && !todayKpis ? "Unavailable" : todayKpis ? `${todayKpis.aiHandled} AI handled` : `${recentCalls.filter(c => c.source === "retell").length} AI handled`,
      icon: PhoneCall,
      color: "teal",
    },
    {
      label: "AI Handled",
      value: analyticsError && !todayKpis ? "—" : (todayKpis ? `${todayKpis.aiHandledPct}%` : "—"),
      sub: analyticsError && !todayKpis ? "Unavailable" : (todayKpis ? `${todayKpis.aiHandled} of ${todayKpis.totalCalls}` : "No data"),
      icon: Bot,
      color: "green",
    },
    {
      label: "Pending Callbacks",
      value: pendingCallbacks.length,
      sub: `${pendingCallbacks.filter(c => c.priority === "high").length} high priority`,
      icon: PhoneIncoming,
      color: "amber",
      urgent: pendingCallbacks.filter(c => c.priority === "high").length > 0,
    },
    {
      label: "Today's Appointments",
      value: todayAppointments.length,
      sub: `${unconfirmedApts.length} unconfirmed`,
      icon: CalendarDays,
      color: "purple",
    },
    {
      label: "Avg Call Duration",
      value: analyticsError && !todayKpis ? "—" : (todayKpis ? formatDuration(todayKpis.avgDurationSec) : "—"),
      sub: analyticsError && !todayKpis ? "Unavailable" : "Today",
      icon: Clock,
      color: "slate",
    },
  ];

  const colorMap: Record<string, { bg: string; icon: string; text: string }> = {
    teal: { bg: "oklch(0.55 0.18 210 / 0.1)", icon: "oklch(0.55 0.18 210)", text: "oklch(0.40 0.18 210)" },
    green: { bg: "oklch(0.65 0.18 155 / 0.1)", icon: "oklch(0.55 0.18 155)", text: "oklch(0.40 0.18 155)" },
    amber: { bg: "oklch(0.78 0.17 75 / 0.1)", icon: "oklch(0.65 0.17 75)", text: "oklch(0.50 0.17 75)" },
    purple: { bg: "oklch(0.60 0.15 280 / 0.1)", icon: "oklch(0.55 0.15 280)", text: "oklch(0.40 0.15 280)" },
    slate: { bg: "oklch(0.50 0.01 240 / 0.1)", icon: "oklch(0.50 0.01 240)", text: "oklch(0.40 0.01 240)" },
  };

  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
            {greeting}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {currentTime.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            {" · "}
            {currentTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { setLastRefresh(new Date()); toast.success("Refreshing..."); }}
          disabled={loading}
        >
          <RefreshCw size={14} className="mr-1.5" />
          Refresh
        </Button>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        {stats.map((stat) => {
          const colors = colorMap[stat.color];
          const Icon = stat.icon;
          return (
            <Card key={stat.label} className={`relative overflow-hidden ${stat.urgent ? "ring-2 ring-destructive/30" : ""}`}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between mb-3">
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center"
                    style={{ backgroundColor: colors.bg }}
                  >
                    <Icon size={16} style={{ color: colors.icon }} />
                  </div>
                  {stat.urgent && (
                    <span className="w-2 h-2 rounded-full bg-destructive" />
                  )}
                </div>
                <div className="text-2xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
                  {stat.value}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">{stat.label}</div>
                <div className="text-xs mt-1" style={{ color: colors.text }}>{stat.sub}</div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Main content grid */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Left: Call volume chart */}
        <div className="xl:col-span-2 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">Today's Call Volume</CardTitle>
                <Link href="/analytics">
                  <Button variant="ghost" size="sm" className="text-xs gap-1">
                    Analytics <ArrowRight size={12} />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={hourlyData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                  <defs>
                    <linearGradient id="callGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="oklch(0.55 0.18 210)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="oklch(0.55 0.18 210)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="hour" tick={{ fontSize: 11, fill: "oklch(0.52 0.015 240)" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "oklch(0.52 0.015 240)" }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: "white", border: "1px solid oklch(0.90 0.006 85)", borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ fontWeight: 600 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="calls"
                    stroke="oklch(0.55 0.18 210)"
                    strokeWidth={2}
                    fill="url(#callGrad)"
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Recent calls */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">Recent Calls</CardTitle>
                <Link href="/calls">
                  <Button variant="ghost" size="sm" className="text-xs gap-1">
                    All Calls <ArrowRight size={12} />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {recentCalls.slice(0, 5).map((call) => (
                <Link key={call.id} href={`/calls/${call.id}`}>
                  <div className="flex items-center gap-3 py-1.5 hover:bg-muted/40 rounded-md px-1 transition-colors cursor-pointer">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                      call.source === "retell" ? "bg-primary/10" : "bg-amber-500/10"
                    }`}>
                      {call.source === "retell" ? (
                        <Bot size={12} className="text-primary" />
                      ) : (
                        <TrendingUp size={12} className="text-amber-600" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground truncate">{call.patientName}</div>
                      <div className="text-xs text-muted-foreground">{call.intent}</div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-xs font-mono text-muted-foreground">{formatDuration(call.duration)}</div>
                      <div className="text-xs text-muted-foreground">{formatTimeAgo(call.date)}</div>
                    </div>
                  </div>
                </Link>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Right: Today's schedule + Callbacks */}
        <div className="space-y-6">
          {/* Today's schedule */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">Today's Schedule</CardTitle>
                <Link href="/scheduling">
                  <Button variant="ghost" size="sm" className="text-xs gap-1">
                    Scheduling <ArrowRight size={12} />
                  </Button>
                </Link>
              </div>
              <div className="flex gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <CheckCircle2 size={11} className="text-green-500" /> {confirmedApts.length} confirmed
                </span>
                <span className="flex items-center gap-1">
                  <Clock size={11} className="text-amber-500" /> {unconfirmedApts.length} unconfirmed
                </span>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {todayAppointments.slice(0, 6).map((apt) => (
                <div key={apt.id} className="flex items-center gap-3 py-1.5">
                  <div className="text-xs font-mono text-muted-foreground w-10 flex-shrink-0">{apt.time}</div>
                  <div
                    className="w-1.5 h-8 rounded-full flex-shrink-0"
                    style={{
                      backgroundColor: apt.status === "confirmed"
                        ? "oklch(0.65 0.18 155)"
                        : "oklch(0.78 0.17 75)",
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground truncate">{apt.patientName}</div>
                    <div className="text-xs text-muted-foreground truncate">{apt.type} · {apt.provider}</div>
                  </div>
                </div>
              ))}
              {todayAppointments.length > 6 && (
                <Link href="/scheduling">
                  <div className="text-xs text-primary text-center pt-1 hover:underline cursor-pointer">
                    +{todayAppointments.length - 6} more appointments
                  </div>
                </Link>
              )}
            </CardContent>
          </Card>

          {/* Callbacks queue */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  Callbacks
                  {pendingCallbacks.length > 0 && (
                    <Badge variant="destructive" className="text-xs">{pendingCallbacks.length}</Badge>
                  )}
                </CardTitle>
                <Link href="/callbacks">
                  <Button variant="ghost" size="sm" className="text-xs gap-1">
                    View All <ArrowRight size={12} />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {callbacks.filter(c => c.status !== "completed").slice(0, 4).map((cb) => (
                <div key={cb.id} className="flex items-start gap-3 p-2.5 rounded-lg bg-muted/30 border border-border">
                  <div
                    className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0"
                    style={{
                      backgroundColor: cb.priority === "high"
                        ? "oklch(0.62 0.22 25)"
                        : cb.priority === "medium"
                        ? "oklch(0.78 0.17 75)"
                        : "oklch(0.52 0.015 240)",
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">{cb.patientName}</div>
                    <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{cb.reason}</div>
                    <div className="text-xs font-mono text-muted-foreground mt-0.5">{cb.phone}</div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
