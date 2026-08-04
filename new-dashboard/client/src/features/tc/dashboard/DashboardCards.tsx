/**
 * Dashboard-local widgets for the TC Morning Command Screen.
 *
 * Each card renders REAL derived data (from derive.ts) or an explicitly
 * honest empty state. The legacy page's mock-driven widgets (MTD banner,
 * Top Objections counts, 7-month trend, TC Performance %) are replaced here
 * by pipeline-state cards labeled as such, or "not enough data yet" states.
 */
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  MessageSquareQuote,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCents } from "../money";
import { CaseStatusBadge } from "../components/TcShell";
import { OfficeBadge } from "../components/OfficeBadge";
import type { TcCaseSummary } from "../api";
import type { PipelineNowStats, TcRollup } from "./derive";

// ── Pipeline-now banner (replaces the fake "Your Week Stats" MTD banner) ────

export function PipelineNowBanner({ stats }: { stats: PipelineNowStats }) {
  const items: { label: string; value: string; accent?: boolean }[] = [
    {
      label: "Presented (now)",
      value: `${formatCents(stats.presentedValueCents)} · ${stats.presentedCount}`,
    },
    {
      label: "Accepted (now)",
      value: `${formatCents(stats.acceptedValueCents)} · ${stats.acceptedCount}`,
    },
    {
      label: "Open pipeline",
      value: `${formatCents(stats.openValueCents)} · ${stats.openCount}`,
      accent: true,
    },
  ];
  return (
    <div className="bg-card rounded-xl border border-border p-4 shadow-sm">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-4 sm:gap-6 flex-wrap">
          {items.map((item, i) => (
            <div key={item.label} className="flex items-center gap-4 sm:gap-6">
              {i > 0 && <div className="h-8 w-px bg-border" />}
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                  {item.label}
                </p>
                <p
                  className={`text-lg font-bold ${item.accent ? "text-primary" : "text-foreground"}`}
                  style={{ fontFamily: "Sora, sans-serif" }}
                >
                  {item.value}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-col items-start sm:items-end gap-1">
          <Button asChild variant="ghost" size="sm" className="text-xs gap-1">
            <Link href="/tc/reports">
              Full Report <ArrowRight className="w-3 h-3" />
            </Link>
          </Button>
          <p className="text-[10px] text-muted-foreground">
            Current pipeline state — month-to-date needs status history.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Health check bar ────────────────────────────────────────────────────────

export function HealthCheckBar({
  noNextStepCount,
  agingCount,
}: {
  noNextStepCount: number;
  agingCount: number;
}) {
  if (noNextStepCount === 0 && agingCount === 0) return null;
  return (
    <div className="flex items-center gap-3 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-900 rounded-lg px-4 py-2.5">
      <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
      <div className="flex items-center gap-3 text-xs flex-wrap">
        {noNextStepCount > 0 && (
          <span className="font-medium text-amber-800 dark:text-amber-300">
            {noNextStepCount} case{noNextStepCount === 1 ? "" : "s"} with no next step
          </span>
        )}
        {noNextStepCount > 0 && agingCount > 0 && (
          <span className="text-amber-400">·</span>
        )}
        {agingCount > 0 && (
          <span className="font-medium text-amber-800 dark:text-amber-300">
            {agingCount} case{agingCount === 1 ? "" : "s"} aging 30+ days
          </span>
        )}
      </div>
    </div>
  );
}

// ── Active cases (top 5 by value, real summaries) ───────────────────────────

function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function ActiveCasesCard({
  cases,
  showOfficeBadges = false,
}: {
  cases: TcCaseSummary[];
  /** All-offices view: tag each row with the office it came from. */
  showOfficeBadges?: boolean;
}) {
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm">
      <div className="flex items-center justify-between p-4 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
          Active Cases
        </h2>
        <Button asChild variant="ghost" size="sm" className="text-xs h-7 gap-1">
          <Link href="/tc/cases">
            All <ChevronRight className="w-3 h-3" />
          </Link>
        </Button>
      </div>
      {cases.length === 0 ? (
        <div className="px-4 py-6 text-center">
          <p className="text-xs text-muted-foreground">
            No cases in the decision stages yet.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border">
          {cases.map((c) => (
            <Link key={c.caseId} href={`/tc/cases/${c.caseId}`}>
              <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50 transition-colors cursor-pointer">
                <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold shrink-0">
                  {initialsOf(c.patientName)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-foreground truncate">{c.patientName}</div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {c.caseType || c.doctorName || c.category}
                  </div>
                </div>
                <div className="text-right shrink-0 space-y-0.5">
                  <div className="text-xs font-bold text-foreground">{formatCents(c.caseValueCents)}</div>
                  <div className="flex items-center justify-end gap-1">
                    {showOfficeBadges && <OfficeBadge officeId={c.officeId} />}
                    <CaseStatusBadge status={c.status} />
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Top Objections (honest deferral — summaries don't carry objections) ─────

export function ObjectionsCard() {
  return (
    <div className="bg-card rounded-xl border border-border p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-foreground mb-2" style={{ fontFamily: "Sora, sans-serif" }}>
        Top Objections
      </h2>
      <div className="flex flex-col items-start gap-2">
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <MessageSquareQuote className="w-4 h-4 shrink-0 mt-0.5" />
          <p>
            Objections are logged per case — objection intelligence lives in
            Reports, not on this screen.
          </p>
        </div>
        <Button asChild variant="ghost" size="sm" className="text-xs h-7 gap-1 -ml-2">
          <Link href="/tc/reports">
            Reports <ChevronRight className="w-3 h-3" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

// ── Trend chart placeholder (honest — no history endpoint yet) ──────────────

export function TrendCard() {
  return (
    <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
      <div>
        <h2 className="text-sm font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
          Treatment Acceptance Trend
        </h2>
        <p className="text-xs text-muted-foreground">Monthly diagnosed vs accepted</p>
      </div>
      <div className="flex flex-col items-center justify-center text-center py-10 gap-2">
        <TrendingUp className="w-8 h-8 text-muted-foreground/40" />
        <p className="text-sm font-medium text-foreground">Not enough history yet</p>
        <p className="text-xs text-muted-foreground max-w-sm">
          Trend charts unlock as cases accumulate status history. This card will
          plot real monthly diagnosed and accepted totals — never sample data.
        </p>
      </div>
    </div>
  );
}

// ── Per-TC pipeline (honest replacement for the fake "TC Performance MTD") ──

export function TcPipelineCard({ rollups }: { rollups: TcRollup[] }) {
  const maxOpenValue = rollups.reduce((max, r) => Math.max(max, r.openValueCents), 0);
  return (
    <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
            TC Pipeline — Current State
          </h2>
          <p className="text-xs text-muted-foreground">
            Open cases per coordinator right now — not a month-to-date score.
          </p>
        </div>
        <Button asChild variant="ghost" size="sm" className="text-xs h-7 gap-1">
          <Link href="/tc/reports">
            Full Report <ArrowRight className="w-3 h-3" />
          </Link>
        </Button>
      </div>
      {rollups.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-8 gap-1.5">
          <p className="text-sm font-medium text-foreground">No assigned coordinators yet</p>
          <p className="text-xs text-muted-foreground">
            Assign cases to a TC and their pipeline shows up here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {rollups.map((tc) => (
            <div key={tc.assignedTc} className="rounded-lg border border-border p-4">
              <div className="flex items-center justify-between mb-3 gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold shrink-0">
                    {initialsOf(tc.assignedTc)}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground truncate">{tc.assignedTc}</div>
                    <div className="text-xs text-muted-foreground">Treatment Coordinator</div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-lg font-bold text-primary" style={{ fontFamily: "Sora, sans-serif" }}>
                    {tc.openCount}
                  </div>
                  <div className="text-[10px] text-muted-foreground">open cases</div>
                </div>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: maxOpenValue > 0 ? `${(tc.openValueCents / maxOpenValue) * 100}%` : "0%",
                    background: "var(--chart-1)",
                  }}
                />
              </div>
              <div className="flex justify-between mt-2 text-xs text-muted-foreground">
                <span>Open: {formatCents(tc.openValueCents)}</span>
                <span>
                  Accepted now: {tc.acceptedNowCount} ({formatCents(tc.acceptedNowValueCents)})
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Empty follow-up queue ───────────────────────────────────────────────────

export function AllCaughtUpCard() {
  return (
    <div className="bg-card rounded-xl border border-border p-8 text-center">
      <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-emerald-500" />
      <p className="text-sm font-semibold text-foreground">All caught up!</p>
      <p className="text-xs text-muted-foreground mt-1">
        No follow-ups pending. Check the pipeline for new cases.
      </p>
    </div>
  );
}
