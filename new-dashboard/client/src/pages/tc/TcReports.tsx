/**
 * /tc/reports — Reports & Analytics, ported from DentaFlow with REAL DATA ONLY.
 *
 * The legacy page rendered mock PIPELINE_STATS above its "LIVE DATA SECTIONS"
 * comment (KPIs, monthly bars, treatment types, TC/provider tiles, objection
 * tiles). Here EVERY section derives from listCases()/listFollowups() via the
 * pure functions in features/tc/reports/derive.ts, or renders an honest
 * "not enough data yet" card. Layout order matches the legacy page; the mock
 * numbers never return.
 *
 * Data: exactly two requests — listCases(office) + listFollowups(office,
 * { status: "completed" }). No per-case fetches (objections therefore render
 * an honest card, not an aggregation).
 */
import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import type { CSSProperties, ReactNode } from "react";
import type { OfficeId } from "@shared/tc/contract";
import { Skeleton } from "@/components/ui/skeleton";
import { listCases, listFollowups, tcErrorMessage } from "@/features/tc/api";
import type { TcCaseSummary, TcQueueFollowup } from "@/features/tc/api";
import { formatCents } from "@/features/tc/money";
import {
  deriveChannelResponse,
  deriveKpis,
  deriveMonthlySeries,
  derivePipelineForecast,
  deriveProviderPerformance,
  deriveReferralSources,
  deriveTcPerformance,
  deriveTreatmentTypes,
  deriveWinLoss,
} from "@/features/tc/reports/derive";
import type { PersonRow } from "@/features/tc/reports/derive";
import { TcOfficeGate, TcPageHeader, useTcOffice } from "@/features/tc/components/TcShell";

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

const TOOLTIP_STYLE: CSSProperties = {
  fontSize: 12,
  borderRadius: 8,
  background: "var(--popover)",
  border: "1px solid var(--border)",
  color: "var(--popover-foreground)",
};

const SORA: CSSProperties = { fontFamily: "'Sora', sans-serif" };

export default function TcReports() {
  const office = useTcOffice();
  if (!office) return <div className="p-6"><TcOfficeGate /></div>;
  // Inner component keyed by office so hooks reset cleanly on office change.
  return <ReportsInner key={office} office={office} />;
}

function ReportsInner({ office }: { office: OfficeId }) {
  const [cases, setCases] = useState<TcCaseSummary[]>([]);
  const [followups, setFollowups] = useState<TcQueueFollowup[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      listCases(office),
      listFollowups(office, { status: "completed" }),
    ])
      .then(([caseList, followupList]) => {
        if (cancelled) return;
        setCases(caseList);
        setFollowups(followupList);
      })
      .catch((err) => {
        if (cancelled) return;
        setCases([]);
        setFollowups([]);
        toast.error(tcErrorMessage(err));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [office]);

  // All-real derivations (pure functions over the fetched rows).
  const kpis = useMemo(() => deriveKpis(cases), [cases]);
  const monthly = useMemo(() => deriveMonthlySeries(cases), [cases]);
  const treatmentTypes = useMemo(() => deriveTreatmentTypes(cases), [cases]);
  const tcPerformance = useMemo(() => deriveTcPerformance(cases), [cases]);
  const providerPerformance = useMemo(() => deriveProviderPerformance(cases), [cases]);
  const forecast = useMemo(() => derivePipelineForecast(cases), [cases]);
  const winLoss = useMemo(() => deriveWinLoss(cases), [cases]);
  const referrals = useMemo(() => deriveReferralSources(cases), [cases]);
  const channelResponse = useMemo(() => deriveChannelResponse(followups), [followups]);

  // Recharts wants row objects in display units (whole dollars).
  const monthlyChartData = useMemo(
    () =>
      monthly.map((p) => ({
        label: p.label,
        diagnosed: Math.round(p.diagnosedCents / 100),
        accepted: Math.round(p.acceptedCents / 100),
      })),
    [monthly],
  );
  const forecastChartData = useMemo(
    () =>
      forecast.stages.map((s) => ({
        stage: s.label,
        count: s.count,
        value: Math.round(s.valueCents / 100),
      })),
    [forecast],
  );
  const forecastChips = useMemo(
    () => forecast.stages.filter((s) => s.count > 0).slice(0, 4),
    [forecast],
  );

  if (loading) return <ReportsSkeleton />;

  return (
    <div className="p-6 space-y-6">
      {/* 1. Header — subtitle states the REAL scope, not a fake date range. */}
      <TcPageHeader
        title="Reports & Analytics"
        subtitle={`Current pipeline · all ${kpis.totalCases} recorded case${kpis.totalCases === 1 ? "" : "s"}`}
      />

      {/* 2. KPI row — all-time pipeline rollups from case summaries. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi
          label="Total Diagnosed"
          value={formatCents(kpis.totalValueCents)}
          sub={`${kpis.totalCases} case${kpis.totalCases === 1 ? "" : "s"} · all-time pipeline`}
        />
        <Kpi
          label="Total Accepted"
          value={formatCents(kpis.acceptedValueCents)}
          sub={`${kpis.acceptedCases} won · ${kpis.acceptanceRatePct}% of all cases`}
        />
        <Kpi
          label="Unscheduled Tx"
          value={formatCents(kpis.unscheduledValueCents)}
          sub={`${kpis.unscheduledCases} accepted, not yet scheduled`}
        />
        <Kpi
          label="Avg Case Size"
          value={formatCents(kpis.avgCaseSizeCents)}
          sub="Mean of all recorded cases"
        />
      </div>

      {/* 3. Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 3a. Monthly — partial-real series, labeled exactly for what it is:
            diagnosed = case value by month recorded; accepted = value of that
            month's cases whose CURRENT status is won (no status history yet). */}
        <ReportCard
          title="Monthly Diagnosed vs. Accepted"
          subtitle="Case value by month recorded · accepted = current status of those cases"
        >
          {monthlyChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={monthlyChartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
                />
                <Tooltip
                  formatter={(v: number) => [formatCents(v * 100), ""]}
                  contentStyle={TOOLTIP_STYLE}
                />
                <Bar dataKey="diagnosed" fill="var(--chart-1)" radius={[4, 4, 0, 0]} name="Diagnosed" />
                <Bar dataKey="accepted" fill="var(--chart-2)" radius={[4, 4, 0, 0]} name="Accepted" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState
              title="No monthly data yet"
              body="This chart fills in as cases are recorded month over month."
            />
          )}
        </ReportCard>

        {/* 3b. Treatment types — real per-category diagnosed vs accepted value. */}
        <ReportCard
          title="Acceptance by Treatment Type"
          subtitle="Accepted value as a share of diagnosed value, per category"
        >
          {treatmentTypes.length > 0 ? (
            <div className="space-y-3">
              {treatmentTypes.map((item, i) => (
                <div key={item.category}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-medium">{item.label}</span>
                    <span className="text-muted-foreground">{item.acceptanceRatePct}%</span>
                  </div>
                  <ProgressBar
                    pct={item.acceptanceRatePct}
                    color={CHART_COLORS[i % CHART_COLORS.length]}
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
                    <span>Diagnosed: {formatCents(item.diagnosedCents)} ({item.diagnosedCases})</span>
                    <span>Accepted: {formatCents(item.acceptedCents)} ({item.acceptedCases})</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No cases yet"
              body="Treatment-type acceptance appears once cases are recorded."
            />
          )}
        </ReportCard>
      </div>

      {/* 4. TC + Provider performance — real rollups; no invented names. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ReportCard
          title="TC Performance"
          subtitle="Accepted value vs diagnosed value per assigned TC"
        >
          {tcPerformance.length > 0 ? (
            <PersonRollupList rows={tcPerformance} color="var(--chart-1)" />
          ) : (
            <EmptyState
              title="No cases yet"
              body="TC performance appears once cases are assigned."
            />
          )}
        </ReportCard>

        <ReportCard
          title="Provider Performance"
          subtitle="Accepted value vs diagnosed value per diagnosing doctor"
        >
          {providerPerformance.length > 0 ? (
            <PersonRollupList rows={providerPerformance} color="var(--chart-4)" />
          ) : (
            <EmptyState
              title="No cases yet"
              body="Provider performance appears once cases record a doctor."
            />
          )}
        </ReportCard>
      </div>

      {/* 5. Top Objections — honest card. Objections live on individual cases
          and aren't in list summaries; aggregating would mean fetching every
          case (N+1), so this section stays honest until a rollup endpoint
          exists. The legacy tiles here were mock data. */}
      <ReportCard title="Top Objections">
        <EmptyState
          title="Objection reporting isn't wired up yet"
          body="Objections are tracked per case (Case → Objections tab). A practice-wide rollup unlocks when the API can aggregate them — nothing is estimated here."
        />
      </ReportCard>

      {/* 6. Pipeline Revenue Forecast — real port of the legacy live section,
          using the platform's 9 board stages. */}
      <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold" style={SORA}>Pipeline Revenue Forecast</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Active cases · case value by stage</p>
          </div>
          <div className="text-right">
            <div className="text-lg font-bold" style={{ ...SORA, color: "var(--chart-1)" }}>
              {formatCents(forecast.totalCents)}
            </div>
            <div className="text-xs text-muted-foreground">total in pipeline</div>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={forecastChartData} margin={{ top: 0, right: 0, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="stage" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis
              tick={{ fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
            />
            <Tooltip
              formatter={(v: number, name: string) => [
                name === "value" ? formatCents(v * 100) : v,
                name === "value" ? "Value" : "Cases",
              ]}
              contentStyle={TOOLTIP_STYLE}
            />
            <Bar dataKey="value" fill="var(--chart-1)" radius={[4, 4, 0, 0]} name="value" />
          </BarChart>
        </ResponsiveContainer>
        <div className="grid grid-cols-4 gap-2 mt-4">
          {forecastChips.map((s) => (
            <div key={s.status} className="text-center p-2 rounded-lg bg-muted/40">
              <div className="text-sm font-bold" style={SORA}>{s.count}</div>
              <div className="text-[10px] text-muted-foreground">{s.label}</div>
              <div className="text-xs font-medium" style={{ color: "var(--chart-1)" }}>
                {formatCents(s.valueCents)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 7. Win/Loss + Referral Source — real ports of the legacy live sections. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ReportCard title="Win / Loss Analysis">
          <div className="flex items-center gap-6 mb-5">
            <div className="text-center">
              <div className="text-3xl font-bold" style={{ ...SORA, color: "var(--chart-5)" }}>
                {winLoss.won}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">Won</div>
            </div>
            <div className="h-12 w-px bg-border" />
            <div className="text-center">
              <div className="text-3xl font-bold text-destructive" style={SORA}>
                {winLoss.lost}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">Lost</div>
            </div>
            <div className="h-12 w-px bg-border" />
            <div className="text-center">
              <div className="text-3xl font-bold" style={SORA}>{winLoss.winRatePct}%</div>
              <div className="text-xs text-muted-foreground mt-0.5">Win rate</div>
            </div>
          </div>
          {winLoss.lostBreakdown.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Lost cases by reason</p>
              {winLoss.lostBreakdown.map((item) => (
                <div key={item.reason}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-medium">{item.label}</span>
                    <span className="text-muted-foreground">
                      {item.count} case{item.count !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <ProgressBar pct={item.pctOfLost} color="var(--destructive)" />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">No lost cases recorded yet.</p>
          )}
        </ReportCard>

        <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold" style={SORA}>Referral Source</h2>
            {referrals.notRecorded > 0 && (
              <span className="text-xs text-muted-foreground">
                {referrals.notRecorded} not recorded
              </span>
            )}
          </div>
          {referrals.known.length > 0 ? (
            <div className="space-y-3">
              {referrals.known.map((item, i) => (
                <div key={item.source}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-medium">{item.label}</span>
                    <span className="text-muted-foreground">
                      {item.count} · {item.pctOfAll}%
                    </span>
                  </div>
                  <ProgressBar pct={item.pctOfAll} color={CHART_COLORS[i % CHART_COLORS.length]} />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No referral data yet"
              body='Select "How did they hear about us?" when creating new cases to start tracking.'
            />
          )}
        </div>
      </div>

      {/* 8. Response Rate by Channel — real port; only completed follow-ups
          with an explicitly logged patient reply count (no assumed answers). */}
      <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold" style={SORA}>Response Rate by Channel</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Completed follow-ups with a logged patient reply
            </p>
          </div>
        </div>
        {channelResponse.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {channelResponse.map((item, i) => (
              <div key={item.channel} className="rounded-xl border border-border p-4 text-center">
                <div
                  className="text-3xl font-bold mb-1"
                  style={{ ...SORA, color: CHART_COLORS[i % CHART_COLORS.length] }}
                >
                  {item.ratePct}%
                </div>
                <div className="text-sm font-semibold">{item.label}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {item.responded} replied / {item.recorded} logged
                </div>
                <div className="mt-2">
                  <ProgressBar pct={item.ratePct} color={CHART_COLORS[i % CHART_COLORS.length]} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No response data yet"
            body='Log follow-up outcomes using the "Did patient reply?" toggle to populate this chart.'
          />
        )}
      </div>
    </div>
  );
}

// ── Presentational helpers ──────────────────────────────────────────────────

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="metric-card">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </div>
      <div className="text-2xl font-bold mt-1" style={SORA}>{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
    </div>
  );
}

function ReportCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
      <div className="mb-4">
        <h2 className="text-sm font-semibold" style={SORA}>{title}</h2>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function ProgressBar({ pct, color }: { pct: number; color: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="h-2 bg-muted rounded-full overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${clamped}%`, background: color }} />
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="py-8 text-center text-xs text-muted-foreground">
      <p className="font-medium mb-1">{title}</p>
      <p className="max-w-md mx-auto">{body}</p>
    </div>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((p) => (p[0] ?? "").toUpperCase())
    .join("");
}

function PersonRollupList({ rows, color }: { rows: PersonRow[]; color: string }) {
  return (
    <div className="space-y-4">
      {rows.map((row) => (
        <div key={row.name} className="rounded-lg border border-border p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2.5">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white"
                style={{ background: color }}
              >
                {initialsOf(row.name)}
              </div>
              <span className="text-sm font-semibold">{row.name}</span>
            </div>
            <span className="text-lg font-bold" style={{ ...SORA, color }}>
              {row.acceptanceRatePct}%
            </span>
          </div>
          <ProgressBar pct={row.acceptanceRatePct} color={color} />
          <div className="flex justify-between text-xs text-muted-foreground mt-1.5">
            <span>Diagnosed: {formatCents(row.diagnosedCents)} ({row.diagnosedCases})</span>
            <span>Accepted: {formatCents(row.acceptedCents)} ({row.acceptedCases})</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ReportsSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-72 mt-2" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
      <Skeleton className="h-72 w-full rounded-xl" />
    </div>
  );
}
