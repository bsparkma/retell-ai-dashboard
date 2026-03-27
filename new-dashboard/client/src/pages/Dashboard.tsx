/**
 * Dashboard — CareIn Home Page
 * Command center overview: live stats, active calls, today's schedule, callbacks queue
 */
import { useState, useEffect } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  PhoneCall, PhoneOff, Clock, TrendingUp, Users, CalendarDays,
  ArrowRight, AlertTriangle, CheckCircle2, Bot, Mic,
  PhoneIncoming, BarChart3, RefreshCw, UserPlus
} from "lucide-react";
import { useLiveCalls } from "@/contexts/SocketContext";
import { api, type UnifiedCall, type CallbackDisplay } from "@/lib/api";
import { formatDuration, formatTimeAgo } from "@/lib/utils";
import NewPatientIntake from "@/components/NewPatientIntake";
import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip } from "recharts";
import { toast } from "sonner";

type AppointmentDisplay = { id: string; patientName: string; time: string; type: string; provider: string; status: "confirmed" | "unconfirmed" };
type HourlyDataPoint = { hour: string; calls: number };

export default function Dashboard() {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [callbacks, setCallbacks] = useState<CallbackDisplay[]>([]);
  const [recentCalls, setRecentCalls] = useState<UnifiedCall[]>([]);
  const [todayAppointments, setTodayAppointments] = useState<AppointmentDisplay[]>([]);
  const [loading, setLoading] = useState(true);
  const [hourlyData, setHourlyData] = useState<HourlyDataPoint[]>([]);

  const liveCalls = useLiveCalls();
  const emergencyCalls = liveCalls.filter(c => c.isEmergency);
  const pendingCallbacks = callbacks.filter(c => c.status === "pending");
  const confirmedApts = todayAppointments.filter(a => a.status === "confirmed");
  const unconfirmedApts = todayAppointments.filter(a => a.status === "unconfirmed");

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setLoading(true);
    const today = new Date().toISOString().split("T")[0];
    Promise.all([
      api.getCallbacks().then(setCallbacks).catch(() => setCallbacks([])),
      api.getUnifiedCalls({ limit: 10 }).then(({ calls }) => setRecentCalls(calls)).catch(() => setRecentCalls([])),
      api.getAnalyticsSummary({ days: 1 }).then((res) => {
        // Filter to business hours (7AM-7PM)
        const filtered = res.hourlyVolume.filter((h) => {
          const match = h.hour.match(/^(\d+)(AM|PM)$/);
          if (!match) return false;
          let hr = parseInt(match[1]);
          if (match[2] === "PM" && hr !== 12) hr += 12;
          if (match[2] === "AM" && hr === 12) hr = 0;
          return hr >= 8 && hr <= 17;
        });
        setHourlyData(filtered.length > 0 ? filtered : []);
      }).catch(() => setHourlyData([])),
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

  const stats = [
    {
      label: "Active Calls",
      value: liveCalls.length,
      sub: `${emergencyCalls.length} emergency`,
      icon: PhoneCall,
      color: "teal",
      urgent: emergencyCalls.length > 0,
    },
    {
      label: "Recent Calls",
      value: recentCalls.length,
      sub: loading ? "Loading…" : `${recentCalls.filter(c => c.source === "retell").length} AI`,
      icon: TrendingUp,
      color: "blue",
    },
    {
      label: "AI Handled",
      value: recentCalls.length ? `${Math.round((recentCalls.filter(c => c.source === "retell").length / recentCalls.length) * 100)}%` : "—",
      sub: recentCalls.length ? `${recentCalls.filter(c => c.source === "retell").length} of ${recentCalls.length}` : "No data",
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
      value: recentCalls.length ? formatDuration(Math.round(recentCalls.reduce((a, c) => a + c.duration, 0) / recentCalls.length)) : "—",
      sub: loading ? "Loading…" : "From API",
      icon: Clock,
      color: "slate",
    },
  ];

  const colorMap: Record<string, { bg: string; icon: string; text: string }> = {
    teal: { bg: "oklch(0.55 0.18 210 / 0.1)", icon: "oklch(0.55 0.18 210)", text: "oklch(0.40 0.18 210)" },
    blue: { bg: "oklch(0.55 0.18 250 / 0.1)", icon: "oklch(0.55 0.18 250)", text: "oklch(0.40 0.18 250)" },
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
            Good morning, Downtown Dental
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {currentTime.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            {" · "}
            {currentTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {emergencyCalls.length > 0 && (
            <Link href="/live">
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg emergency-flash border border-destructive/30 cursor-pointer">
                <AlertTriangle size={14} className="text-destructive" />
                <span className="text-sm font-semibold text-destructive">{emergencyCalls.length} Emergency</span>
              </div>
            </Link>
          )}
          <Button
            size="sm"
            onClick={() => setIntakeOpen(true)}
            className="gap-1.5"
          >
            <UserPlus size={14} />
            New Patient
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setLastRefresh(new Date()); toast.success("Refreshing…"); }}
            disabled={loading}
          >
            <RefreshCw size={14} className="mr-1.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
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
        {/* Left: Live calls + Call volume */}
        <div className="xl:col-span-2 space-y-6">
          {/* Live calls */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <span className="live-dot" />
                  Live Calls
                  <Badge variant="secondary" className="text-xs">{liveCalls.length} active</Badge>
                </CardTitle>
                <Link href="/live">
                  <Button variant="ghost" size="sm" className="text-xs gap-1">
                    Full Monitor <ArrowRight size={12} />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {liveCalls.map((call) => (
                <div
                  key={call.id}
                  className={`flex items-start gap-3 p-3 rounded-lg border transition-all ${
                    call.isEmergency
                      ? "emergency-flash border-destructive/30"
                      : "bg-muted/30 border-border hover:bg-muted/60"
                  }`}
                >
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                    call.source === "retell" ? "bg-primary/10" : "bg-amber-500/10"
                  }`}>
                    {call.source === "retell" ? (
                      <Bot size={14} className="text-primary" />
                    ) : (
                      <Users size={14} className="text-amber-600" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-foreground">{call.patientName}</span>
                      {call.isEmergency && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-bold bg-destructive/15 text-destructive">
                          <AlertTriangle size={10} /> EMERGENCY
                        </span>
                      )}
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        call.source === "retell"
                          ? "bg-primary/10 text-primary"
                          : "bg-amber-500/10 text-amber-700"
                      }`}>
                        {call.source === "retell" ? "AI · Rover" : "Staff"}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 font-mono">{call.fromNumber}</div>
                    {call.intent && (
                      <div className="text-xs text-muted-foreground mt-0.5">{call.intent}</div>
                    )}
                    {call.transcript && call.transcript.length > 0 && (
                      <div className="text-xs text-muted-foreground mt-1.5 italic line-clamp-1">
                        "{call.transcript[call.transcript.length - 1].text}"
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    <div className="flex items-center gap-1">
                      {[1,2,3,4,5].map((i) => (
                        <div
                          key={i}
                          className="waveform-bar w-1"
                          style={{
                            height: `${8 + Math.random() * 12}px`,
                            animationDelay: `${i * 0.15}s`,
                          }}
                        />
                      ))}
                    </div>
                    <span className="text-xs font-mono text-muted-foreground">
                      {formatDuration(call.duration)}
                    </span>
                  </div>
                </div>
              ))}
              {liveCalls.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  <PhoneOff size={32} className="mx-auto mb-2 opacity-30" />
                  <p className="text-sm">No active calls</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Call volume chart */}
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
              <ResponsiveContainer width="100%" height={160}>
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
        </div>

        {/* Right: Today's schedule + Callbacks */}
        <div className="space-y-6">
          {/* Today's schedule */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">Today's Schedule</CardTitle>
                <Link href="/calendar">
                  <Button variant="ghost" size="sm" className="text-xs gap-1">
                    Calendar <ArrowRight size={12} />
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
                  {apt.status === "unconfirmed" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs h-6 px-2 flex-shrink-0"
                      onClick={() => toast.info("Confirmation call feature coming soon")}
                    >
                      Confirm
                    </Button>
                  )}
                </div>
              ))}
              {todayAppointments.length > 6 && (
                <Link href="/calendar">
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
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs h-6 px-2 flex-shrink-0"
                    onClick={() => toast.info("Initiating callback...")}
                  >
                    Call
                  </Button>
                </div>
              ))}
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
                        <Users size={12} className="text-amber-600" />
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
      </div>
      <NewPatientIntake open={intakeOpen} onClose={() => setIntakeOpen(false)} />
    </div>
  );
}
