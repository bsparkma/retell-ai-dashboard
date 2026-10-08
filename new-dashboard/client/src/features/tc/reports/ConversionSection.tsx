/**
 * /tc/reports — "Conversion" (item 42). Driven ONLY by
 * GET /api/tc/reports/funnel: every figure on this section is a number the
 * server computed from recorded status transitions. This component formats;
 * it does no arithmetic on cases, and it never falls back to the case-summary
 * derivations the rest of the page uses.
 *
 * Honesty rules carried over from the page:
 *  - every rate tile carries the coverage caption (what window, since when);
 *  - a rate with no denominator renders "—", never 0%;
 *  - an office with no recorded history renders the server's coverage note;
 *  - a failed load says so — it never shows stale or estimated numbers.
 */
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { OfficeId } from "@shared/tc/contract";
import { Skeleton } from "@/components/ui/skeleton";
import { getConversionFunnel, tcErrorMessage } from "../api";
import { formatCents } from "../money";
import { CASE_STATUSES, LOST_REASON_LABELS } from "../status";
import {
  FUNNEL_PRESETS,
  coverageCaption,
  formatDays,
  formatPercent,
  presetFromDate,
  type FunnelPersonRow,
  type FunnelPresetId,
  type ServedFunnel,
} from "./funnel";

const SORA: CSSProperties = { fontFamily: "'Sora', sans-serif" };
const TOOLTIP_STYLE: CSSProperties = {
  fontSize: 12,
  borderRadius: 8,
  background: "var(--popover)",
  border: "1px solid var(--border)",
  color: "var(--popover-foreground)",
};

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; funnel: ServedFunnel };

export function ConversionSection({
  office,
  defaultPreset = "90d",
}: {
  office: OfficeId;
  defaultPreset?: FunnelPresetId;
}) {
  const [preset, setPreset] = useState<FunnelPresetId>(defaultPreset);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    const days = FUNNEL_PRESETS.find((p) => p.id === preset)?.days ?? 90;
    getConversionFunnel(office, { from: presetFromDate(days) })
      .then((funnel) => {
        if (!cancelled) setState({ kind: "ready", funnel });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: "error", message: tcErrorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [office, preset]);

  return (
    <section className="bg-card rounded-xl border border-border p-5 shadow-sm space-y-5" aria-label="Conversion">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold" style={SORA}>Conversion</h2>
          <p className="text-xs text-muted-foreground mt-0.5" data-testid="funnel-coverage">
            {state.kind === "ready"
              ? coverageCaption(state.funnel)
              : "Computed by the server from recorded status changes"}
          </p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Window">
          {FUNNEL_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPreset(p.id)}
              aria-pressed={preset === p.id}
              className={`text-xs px-2.5 py-1 rounded-md border ${
                preset === p.id
                  ? "bg-foreground text-background border-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {state.kind === "loading" && <ConversionSkeleton />}
      {state.kind === "error" && (
        <div className="py-6 text-center text-xs text-muted-foreground" role="alert">
          <p className="font-medium mb-1">Couldn&apos;t load the conversion funnel</p>
          <p>{state.message} Nothing is estimated in its place.</p>
        </div>
      )}
      {state.kind === "ready" && <ConversionBody funnel={state.funnel} />}
    </section>
  );
}

function ConversionBody({ funnel }: { funnel: ServedFunnel }) {
  if (funnel.coverageStartsAt === null) {
    return (
      <div className="py-6 text-center text-xs text-muted-foreground" data-testid="funnel-no-history">
        <p className="font-medium mb-1">No conversion history yet</p>
        <p className="max-w-md mx-auto">{funnel.coverageNote}</p>
      </div>
    );
  }

  const a = funnel.acceptance;
  const wl = funnel.winLoss;
  const maxEntered = Math.max(1, ...funnel.stages.map((s) => s.entered));
  const trend = funnel.acceptedByWeek.map((w) => ({
    week: w.weekStart.slice(5),
    value: Math.round(w.wonValueCents / 100),
    cases: w.wonCases,
  }));

  return (
    <div className="space-y-6">
      {funnel.coverageNote && (
        <p className="text-xs rounded-md bg-muted/50 px-3 py-2 text-muted-foreground" data-testid="funnel-coverage-note">
          {funnel.coverageNote}
        </p>
      )}

      {/* Rate tiles — each one says what it is a share OF. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <RateTile
          label="Acceptance rate"
          value={formatPercent(a.acceptanceRatePercent)}
          sub={`${a.acceptedCases} of ${a.presentedCases} presented accepted`}
          testId="tile-acceptance"
        />
        <RateTile
          label="Value accepted"
          value={formatPercent(a.valueAcceptanceRatePercent)}
          sub={`${formatCents(a.acceptedValueCents)} of ${formatCents(a.presentedValueCents)} presented`}
          testId="tile-value"
        />
        <RateTile
          label="Won in window"
          value={formatCents(wl.wonValueCents)}
          sub={`${wl.wonCases} case${wl.wonCases === 1 ? "" : "s"} · win rate ${formatPercent(wl.winRatePercent)} vs ${wl.lostCases} lost`}
          testId="tile-won"
        />
        <RateTile
          label="Nurture reactivations"
          value={String(funnel.nurtureReactivations.cases)}
          sub={`${formatCents(funnel.nurtureReactivations.valueCents)} won back from nurture`}
          testId="tile-nurture"
        />
      </div>
      <p className="text-[11px] text-muted-foreground -mt-3">
        Rates follow the cases first presented in this window. A reopened case counts once. Value is
        each case&apos;s current value.
      </p>

      {/* Funnel bars — stage entries in the window, board order. */}
      <div>
        <h3 className="text-xs font-semibold mb-2">Stage by stage</h3>
        <div className="space-y-1.5" data-testid="funnel-bars">
          {funnel.stages.map((s) => (
            <div key={s.status} className="grid grid-cols-[9rem_1fr_11rem] items-center gap-3 text-xs">
              <span className="font-medium truncate">{CASE_STATUSES[s.status].label}</span>
              <div className="h-3 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${(s.entered / maxEntered) * 100}%`, background: "var(--chart-1)" }}
                />
              </div>
              <span className="text-muted-foreground text-right tabular-nums">
                {s.entered} entered · {formatPercent(s.conversionPercent)} moved on
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Time in stage. */}
      <div className="overflow-x-auto">
        <h3 className="text-xs font-semibold mb-2">Time in stage</h3>
        <table className="w-full text-xs" data-testid="time-in-stage">
          <thead>
            <tr className="text-muted-foreground text-left border-b border-border">
              <th className="py-1.5 pr-3 font-medium">Stage</th>
              <th className="py-1.5 pr-3 font-medium text-right">Entered</th>
              <th className="py-1.5 pr-3 font-medium text-right">Moved on</th>
              <th className="py-1.5 pr-3 font-medium text-right">Lost after</th>
              <th className="py-1.5 pr-3 font-medium text-right">Median</th>
              <th className="py-1.5 pr-3 font-medium text-right">90th pct</th>
              <th className="py-1.5 font-medium text-right">Stays timed / still open</th>
            </tr>
          </thead>
          <tbody>
            {funnel.stages.map((s) => (
              <tr key={s.status} className="border-b border-border/60">
                <td className="py-1.5 pr-3">{CASE_STATUSES[s.status].label}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{s.entered}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {s.progressed} ({formatPercent(s.conversionPercent)})
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{s.lostAfter}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{formatDays(s.medianDays)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{formatDays(s.p90Days)}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {s.completedStays} / {s.openStays}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[11px] text-muted-foreground mt-1">
          Only stays that ended inside the window are timed; stays still open are counted, not guessed.
        </p>
      </div>

      {/* Accepted value by week. */}
      <div>
        <h3 className="text-xs font-semibold mb-2">Accepted value by week</h3>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={trend} margin={{ top: 0, right: 0, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="week" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis
              tick={{ fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
            />
            <Tooltip
              formatter={(v: number) => [formatCents(v * 100), "Accepted"]}
              labelFormatter={(l: string) => `Week of ${l}`}
              contentStyle={TOOLTIP_STYLE}
            />
            <Bar dataKey="value" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
        <p className="text-[11px] text-muted-foreground mt-1">
          Weeks start Monday ({funnel.timeZone}). A case is credited once, in the week it was first accepted.
        </p>
      </div>

      {/* People + lost reasons. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <PersonTable title="By assigned TC" rows={funnel.byAssignedTc} blank="Unassigned" />
        <PersonTable title="By doctor" rows={funnel.byDoctor} blank="Not recorded" />
        <div>
          <h3 className="text-xs font-semibold mb-2">Lost, by reason</h3>
          {wl.byLostReason.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No cases lost in this window.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {wl.byLostReason.map((r) => (
                <li key={r.reason ?? "none"} className="flex justify-between">
                  <span>{r.reason ? LOST_REASON_LABELS[r.reason] : "No longer lost (reason not kept)"}</span>
                  <span className="tabular-nums text-muted-foreground">{r.lostCases}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function RateTile({ label, value, sub, testId }: { label: string; value: string; sub: string; testId: string }) {
  return (
    <div className="metric-card" data-testid={testId}>
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold mt-1" style={SORA}>{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
    </div>
  );
}

function PersonTable({ title, rows, blank }: { title: string; rows: FunnelPersonRow[]; blank: string }) {
  return (
    <div>
      <h3 className="text-xs font-semibold mb-2">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No cases presented in this window.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {rows.map((r) => (
            <li key={r.name || blank} className="flex justify-between gap-2">
              <span className="truncate">{r.name || blank}</span>
              <span className="tabular-nums text-muted-foreground whitespace-nowrap">
                {r.acceptedCases}/{r.presentedCases} · {formatPercent(r.acceptanceRatePercent)} ·{" "}
                {formatCents(r.acceptedValueCents)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConversionSkeleton() {
  return (
    <div className="space-y-4" data-testid="funnel-loading">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}
