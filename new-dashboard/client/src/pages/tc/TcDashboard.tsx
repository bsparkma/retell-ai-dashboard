/**
 * /tc/dashboard — the TC Morning Command Screen (DentaFlow Dashboard port).
 *
 * REAL DATA ONLY: everything on this screen derives from listCases +
 * followupsDue + listFollowups for the selected office (see
 * features/tc/dashboard/derive.ts). Widgets the legacy page faked with
 * PIPELINE_STATS seed data render honest pipeline-state numbers or explicit
 * "not enough data yet" states instead. Deliberately omitted: CareIN handoffs
 * (cross-module integration, deferred) and Today's Consults (the platform
 * case model has no consult-date field).
 *
 * All-offices: there is no server-side all-offices query, so the three loads
 * fan out per office and the derived widgets run over the merged rows. Every
 * follow-up action writes back to the office that owns the row.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { AlertTriangle, ClipboardCopy, Loader2, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import {
  TcOfficeGate,
  TcPageHeader,
  TcPartialDataNotice,
} from "@/features/tc/components/TcShell";
import {
  fanOutOfficeValues,
  hardErrorMessage,
  partialNotice,
  tagOffice,
  useTcOfficeScope,
  type WithOffice,
} from "@/features/tc/officeScope";
import {
  followupsDue,
  listCases,
  listFollowups,
  type TcCaseSummary,
  type TcDueFollowup,
  type TcQueueFollowup,
} from "@/features/tc/api";
import { FollowupActionCard } from "@/features/tc/followups/FollowupActionCard";
import { todayIsoDate } from "@/features/tc/lib/followups";
import {
  addDaysIso,
  buildHuddleText,
  countActionsToday,
  findAgingCases,
  findCasesWithNoNextStep,
  firstNameOf,
  getGreeting,
  perTcRollup,
  pipelineNowStats,
  splitDueFollowups,
  topActiveCases,
} from "@/features/tc/dashboard/derive";
import { CareInHandoffsStrip } from "@/features/tc/handoffs/CareInHandoffsStrip";
import {
  ActiveCasesCard,
  AllCaughtUpCard,
  HealthCheckBar,
  ObjectionsCard,
  PipelineNowBanner,
  TcPipelineCard,
  TrendCard,
} from "@/features/tc/dashboard/DashboardCards";

/** Days ahead the "Coming Up" section looks (server returns due_date <= horizon). */
const UPCOMING_HORIZON_DAYS = 7;
/** Legacy layout showed at most 3 upcoming cards. */
const UPCOMING_LIMIT = 3;

function formatDateLabel(now: Date): string {
  return now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function SectionHeading({
  label,
  count,
  dotClass,
  muted,
}: {
  label: string;
  count?: number;
  dotClass: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className={`w-2 h-2 rounded-full ${dotClass}`} />
      <h2
        className={`text-sm font-semibold ${muted ? "text-muted-foreground" : "text-foreground"}`}
        style={{ fontFamily: "Sora, sans-serif" }}
      >
        {label}
        {count !== undefined ? ` (${count})` : ""}
      </h2>
    </div>
  );
}

export default function TcDashboard() {
  const scope = useTcOfficeScope();
  const { offices, showOfficeBadges } = scope;
  const auth = useAuth();
  const userName = auth.status === "authenticated" ? auth.user.name : "";

  const todayIso = todayIsoDate();
  const now = new Date();

  const [cases, setCases] = useState<WithOffice<TcCaseSummary>[]>([]);
  const [dueRows, setDueRows] = useState<WithOffice<TcDueFollowup>[]>([]);
  const [pendingFollowups, setPendingFollowups] = useState<WithOffice<TcQueueFollowup>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (offices.length === 0) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    const result = await fanOutOfficeValues(offices, async (o) => {
      const [caseRows, due, pending] = await Promise.all([
        listCases(o),
        followupsDue(o, { date: addDaysIso(todayIsoDate(), UPCOMING_HORIZON_DAYS) }),
        listFollowups(o, { status: "pending" }),
      ]);
      return { caseRows, due, pending };
    });
    const mergedCases: WithOffice<TcCaseSummary>[] = [];
    const mergedDue: WithOffice<TcDueFollowup>[] = [];
    const mergedPending: WithOffice<TcQueueFollowup>[] = [];
    for (const { officeId, value } of result.values) {
      mergedCases.push(...tagOffice(value.caseRows, officeId));
      mergedDue.push(...tagOffice(value.due, officeId));
      mergedPending.push(...tagOffice(value.pending, officeId));
    }
    setCases(mergedCases);
    setDueRows(mergedDue);
    setPendingFollowups(mergedPending);
    setError(hardErrorMessage(result));
    setNotice(partialNotice(result));
    setLoading(false);
  }, [offices]);

  useEffect(() => {
    void load();
  }, [load]);

  // Queue mutations: keep both followup stores in sync so the health bar's
  // "no next step" count stays truthful after completing/skipping.
  const removeFollowup = useCallback((followupId: string) => {
    setDueRows((prev) => prev.filter((f) => f.followupId !== followupId));
    setPendingFollowups((prev) => prev.filter((f) => f.followupId !== followupId));
  }, []);

  const replaceFollowup = useCallback((updated: TcDueFollowup) => {
    setDueRows((prev) => prev.map((f) => (f.followupId === updated.followupId ? updated : f)));
    setPendingFollowups((prev) =>
      prev.map((f) => (f.followupId === updated.followupId ? { ...f, ...updated } : f)),
    );
  }, []);

  const derived = useMemo(() => {
    const split = splitDueFollowups(dueRows, todayIso);
    return {
      split,
      actionsToday: countActionsToday(split),
      stats: pipelineNowStats(cases),
      aging: findAgingCases(cases, todayIso),
      noNextStep: findCasesWithNoNextStep(cases, pendingFollowups),
      activeTop: topActiveCases(cases),
      rollups: perTcRollup(cases),
    };
  }, [cases, dueRows, pendingFollowups, todayIso]);

  const copyHuddle = useCallback(() => {
    const text = buildHuddleText({
      dateLabel: formatDateLabel(new Date()),
      tcName: userName,
      overdue: derived.split.overdue,
      dueToday: derived.split.dueToday,
      stats: derived.stats,
      agingCount: derived.aging.length,
      noNextStepCount: derived.noNextStep.length,
    });
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success("Morning huddle copied to clipboard"))
      .catch(() => toast.error("Could not copy — try again"));
  }, [derived, userName]);

  if (offices.length === 0) {
    return (
      <div className="p-6">
        <TcOfficeGate loading={scope.loading} />
      </div>
    );
  }

  const { split } = derived;
  const upcoming = split.upcoming.slice(0, UPCOMING_LIMIT);
  const queueEmpty =
    split.overdue.length === 0 && split.dueToday.length === 0 && upcoming.length === 0;

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6 max-w-7xl mx-auto">
      <TcPageHeader
        title={`${getGreeting(now.getHours())}, ${firstNameOf(userName)}`}
        subtitle={`${formatDateLabel(now)} · ${
          derived.actionsToday > 0
            ? `You have ${derived.actionsToday} action${derived.actionsToday === 1 ? "" : "s"} today`
            : "All caught up!"
        }`}
        actions={
          <>
            <Button variant="outline" size="sm" className="gap-2" onClick={copyHuddle} disabled={loading}>
              <ClipboardCopy className="w-4 h-4" />
              <span className="hidden sm:inline">Copy Huddle</span>
            </Button>
            <Button asChild size="sm" className="gap-2">
              <Link href="/tc">
                <Target className="w-4 h-4" />
                <span className="hidden sm:inline">Pipeline</span>
              </Link>
            </Button>
          </>
        }
      />

      <CareInHandoffsStrip />

      {notice && <TcPartialDataNotice message={notice} />}

      {error && (
        <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-3 text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : (
        <>
          <PipelineNowBanner stats={derived.stats} />

          <HealthCheckBar
            noNextStepCount={derived.noNextStep.length}
            agingCount={derived.aging.length}
          />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
            {/* Left 2/3: follow-up action cards */}
            <div className="lg:col-span-2 space-y-4 order-2 lg:order-1">
              {split.overdue.length > 0 && (
                <div>
                  <SectionHeading label="Overdue" count={split.overdue.length} dotClass="bg-red-500" />
                  <div className="space-y-2">
                    {split.overdue.map((f) => (
                      <FollowupActionCard
                        key={f.followupId}
                        office={f.officeId}
                        followup={f}
                        showOfficeBadge={showOfficeBadges}
                        today={todayIso}
                        onCompleted={removeFollowup}
                        onSkipped={removeFollowup}
                        onRescheduled={replaceFollowup}
                      />
                    ))}
                  </div>
                </div>
              )}

              {split.dueToday.length > 0 && (
                <div>
                  <SectionHeading
                    label="Today's Follow-Ups"
                    count={split.dueToday.length}
                    dotClass="bg-primary"
                  />
                  <div className="space-y-2">
                    {split.dueToday.map((f) => (
                      <FollowupActionCard
                        key={f.followupId}
                        office={f.officeId}
                        followup={f}
                        showOfficeBadge={showOfficeBadges}
                        today={todayIso}
                        onCompleted={removeFollowup}
                        onSkipped={removeFollowup}
                        onRescheduled={replaceFollowup}
                      />
                    ))}
                  </div>
                </div>
              )}

              {upcoming.length > 0 && (
                <div>
                  <SectionHeading label="Coming Up" dotClass="bg-muted-foreground/40" muted />
                  <div className="space-y-2">
                    {upcoming.map((f) => (
                      <FollowupActionCard
                        key={f.followupId}
                        office={f.officeId}
                        followup={f}
                        showOfficeBadge={showOfficeBadges}
                        today={todayIso}
                        onCompleted={removeFollowup}
                        onSkipped={removeFollowup}
                        onRescheduled={replaceFollowup}
                      />
                    ))}
                  </div>
                </div>
              )}

              {queueEmpty && <AllCaughtUpCard />}
            </div>

            {/* Right 1/3: active cases + objections deferral */}
            <div className="space-y-4 order-1 lg:order-2">
              <ActiveCasesCard cases={derived.activeTop} showOfficeBadges={showOfficeBadges} />
              <ObjectionsCard />
            </div>
          </div>

          <TrendCard />

          <TcPipelineCard rollups={derived.rollups} />
        </>
      )}
    </div>
  );
}
