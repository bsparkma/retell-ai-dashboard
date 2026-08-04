/**
 * Nurture campaign workspace — port of the legacy Nurture page onto the
 * platform TC module.
 *
 * Data: listCases(office, { status: 'nurture' }) for the roster and
 * listFollowups(office, { kind: 'nurture' }) for touchpoints — real
 * tc_followups rows joined client-side (no legacy touchpoint auto-generation;
 * the queue shows what exists). Queue actions reuse FollowupActionCard, whose
 * complete/skip/reschedule handlers hit the /api/tc followup endpoints with
 * the confirmed-save rule. Skip only marks the row skipped (server semantics)
 * — the legacy "next one scheduled" behaviour was NOT ported.
 *
 * Row actions: cadence overrides + unsubscribe via patchCase, financing
 * touchpoint via createFollowup, and exit-nurture via the guarded
 * transitionCase path back to 'considering' (the backend allows any
 * non-lost transition; lost is the only guarded target).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowUpRight,
  BellOff,
  DollarSign,
  Loader2,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OfficeId, TcCase } from "@shared/tc/contract";
import {
  createFollowup,
  listCases,
  listFollowups,
  patchCase,
  tcErrorMessage,
  transitionCase,
  type TcCaseSummary,
  type TcDueFollowup,
  type TcQueueFollowup,
} from "../api";
import { caseStatusLabel, validateTransition } from "../status";
import { TcPageHeader } from "../components/TcShell";
import { formatCents } from "../money";
import { todayIsoDate } from "../lib/followups";
import { FollowupActionCard } from "../followups/FollowupActionCard";
import { CadenceDialog } from "./CadenceDialog";
import {
  addDaysIso,
  buildFinancingTalkingPoint,
  formatCadence,
  getDaysEnrolled,
  getNurturePhase,
  nurtureTypeLabel,
} from "./nurtureUtils";

/** Where "back to the active pipeline" lands (any non-lost target is legal). */
const EXIT_NURTURE_STATUS = "considering" as const;

const PHASE_PILL: Record<1 | 2, string> = {
  1: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  2: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
};

export interface NurtureWorkspaceProps {
  office: OfficeId;
  /** YYYY-MM-DD "today" override for deterministic tests. */
  today?: string;
}

export function NurtureWorkspace({ office, today }: NurtureWorkspaceProps) {
  const todayIso = today ?? todayIsoDate();
  const weekOutIso = addDaysIso(todayIso, 7);

  const [cases, setCases] = useState<TcCaseSummary[]>([]);
  const [touchpoints, setTouchpoints] = useState<TcQueueFollowup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cadenceTargetId, setCadenceTargetId] = useState<string | null>(null);
  const [busyCaseId, setBusyCaseId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [caseList, followups] = await Promise.all([
        listCases(office, { status: "nurture" }),
        listFollowups(office, { kind: "nurture" }),
      ]);
      setCases(caseList);
      setTouchpoints(followups);
    } catch (e) {
      setCases([]);
      setTouchpoints([]);
      setError(tcErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [office]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Fold a returned full TcCase back into its summary row (scalars only). */
  const mergeCase = useCallback((updated: TcCase) => {
    setCases((prev) =>
      prev.map((row) => {
        if (row.caseId !== updated.caseId) return row;
        const {
          phases: _phases,
          objections: _objections,
          followups: _followups,
          events: _events,
          hygieneIntake: _hygieneIntake,
          ...scalars
        } = updated;
        return { ...row, ...scalars };
      }),
    );
  }, []);

  const caseById = useMemo(
    () => new Map(cases.map((c) => [c.caseId, c])),
    [cases],
  );

  // Pending touchpoints joined to a (subscribed) nurture case, as due-queue
  // rows so FollowupActionCard can render them. listFollowups returns bare
  // rows; the case context join happens here.
  const pendingItems = useMemo(() => {
    const items: TcDueFollowup[] = [];
    for (const t of touchpoints) {
      if (t.status !== "pending") continue;
      const c = caseById.get(t.caseId);
      if (!c || c.nurtureUnsubscribed) continue;
      items.push({
        ...t,
        patientName: c.patientName,
        casePhone: c.phone,
        caseStatus: c.status,
        assignedTc: c.assignedTc,
        caseValueCents: c.caseValueCents,
        caseUrgency: c.urgency,
      });
    }
    items.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    return items;
  }, [touchpoints, caseById]);

  const todayItems = useMemo(
    () => pendingItems.filter((t) => t.dueDate <= todayIso),
    [pendingItems, todayIso],
  );
  const thisWeekItems = useMemo(
    () => pendingItems.filter((t) => t.dueDate > todayIso && t.dueDate <= weekOutIso),
    [pendingItems, todayIso, weekOutIso],
  );

  // ── Queue callbacks (FollowupActionCard fires these post-confirmation) ────

  const markLocal = useCallback(
    (followupId: string, status: "completed" | "skipped") => {
      // The card confirmed the write but only hands back the id — approximate
      // completedAt locally for the Last Contact column until the next load.
      setTouchpoints((prev) =>
        prev.map((t) =>
          t.followupId === followupId
            ? {
                ...t,
                status,
                completedAt:
                  status === "completed" ? new Date().toISOString() : t.completedAt,
              }
            : t,
        ),
      );
    },
    [],
  );

  const handleRescheduled = useCallback((updated: TcDueFollowup) => {
    setTouchpoints((prev) =>
      prev.map((t) => (t.followupId === updated.followupId ? { ...t, dueDate: updated.dueDate } : t)),
    );
  }, []);

  // ── Row actions ───────────────────────────────────────────────────────────

  const handleAddFinancing = useCallback(
    async (c: TcCaseSummary) => {
      setBusyCaseId(c.caseId);
      try {
        const created = await createFollowup(office, {
          caseId: c.caseId,
          kind: "nurture",
          dueDate: todayIso,
          channel: "text",
          talkingPoint: buildFinancingTalkingPoint(c.patientName, c.caseValueCents),
          nurtureType: "financing",
          source: "manual",
        });
        setTouchpoints((prev) => [...prev, created]);
        toast.success(`Financing touchpoint added for ${c.patientName}`);
      } catch (e) {
        toast.error(tcErrorMessage(e));
      } finally {
        setBusyCaseId(null);
      }
    },
    [office, todayIso],
  );

  const handleExitNurture = useCallback(
    async (c: TcCaseSummary) => {
      const check = validateTransition(EXIT_NURTURE_STATUS, null);
      if (!check.ok) {
        toast.error(check.message);
        return;
      }
      setBusyCaseId(c.caseId);
      try {
        await transitionCase(office, c.caseId, { status: EXIT_NURTURE_STATUS });
        // No longer a nurture case — drop the row (its touchpoints unjoin too).
        setCases((prev) => prev.filter((row) => row.caseId !== c.caseId));
        toast.success(
          `${c.patientName} moved back to the active pipeline (${caseStatusLabel(EXIT_NURTURE_STATUS)})`,
        );
      } catch (e) {
        toast.error(tcErrorMessage(e));
      } finally {
        setBusyCaseId(null);
      }
    },
    [office],
  );

  const handleUnsubscribe = useCallback(
    async (c: TcCaseSummary) => {
      setBusyCaseId(c.caseId);
      try {
        const updated = await patchCase(office, c.caseId, { nurtureUnsubscribed: true });
        mergeCase(updated);
        toast.success(`${c.patientName} marked as unsubscribed`);
      } catch (e) {
        toast.error(tcErrorMessage(e));
      } finally {
        setBusyCaseId(null);
      }
    },
    [office, mergeCase],
  );

  const cadenceTarget = cadenceTargetId ? caseById.get(cadenceTargetId) ?? null : null;

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <TcPageHeader
        title="Nurture Campaign"
        subtitle={`${cases.length} patient${cases.length !== 1 ? "s" : ""} in long-term nurture · ${todayItems.length} touchpoint${todayItems.length !== 1 ? "s" : ""} due today`}
      />

      {error && (
        <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-3 text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* Section 1 — Today's Queue */}
      <section className="space-y-3" aria-label="Today's Queue">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
            Today&apos;s Queue
          </h2>
          {todayItems.length > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300">
              {todayItems.length} due
            </span>
          )}
        </div>

        {todayItems.length === 0 ? (
          <div className="text-sm text-muted-foreground bg-card rounded-xl border border-border p-6 text-center">
            You&apos;re all caught up for today.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {todayItems.map((item) => (
              <FollowupActionCard
                key={item.followupId}
                office={office}
                followup={item}
                today={todayIso}
                onCompleted={(id) => markLocal(id, "completed")}
                onSkipped={(id) => markLocal(id, "skipped")}
                onRescheduled={handleRescheduled}
              />
            ))}
          </div>
        )}
      </section>

      {/* Section 2 — This Week (only when non-empty) */}
      {thisWeekItems.length > 0 && (
        <section className="space-y-3" aria-label="This Week">
          <h2 className="text-base font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
            This Week
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {thisWeekItems.map((item) => (
              <FollowupActionCard
                key={item.followupId}
                office={office}
                followup={item}
                today={todayIso}
                onCompleted={(id) => markLocal(id, "completed")}
                onSkipped={(id) => markLocal(id, "skipped")}
                onRescheduled={handleRescheduled}
              />
            ))}
          </div>
        </section>
      )}

      {/* Section 3 — All Nurture Patients */}
      <section className="space-y-3" aria-label="All Nurture Patients">
        <h2 className="text-base font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
          All Nurture Patients
        </h2>

        {cases.length === 0 ? (
          <div className="text-sm text-muted-foreground bg-card rounded-xl border border-border p-6 text-center">
            No patients in nurture yet. Move stalled cases here from the pipeline to
            keep in touch long-term.
          </div>
        ) : (
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="text-left px-4 py-3 font-medium">Patient</th>
                    <th className="text-left px-4 py-3 font-medium">Phase</th>
                    <th className="text-left px-4 py-3 font-medium">Days Enrolled</th>
                    <th className="text-left px-4 py-3 font-medium">Next Touchpoint</th>
                    <th className="text-left px-4 py-3 font-medium">Last Contact</th>
                    <th className="text-left px-4 py-3 font-medium">Cadence</th>
                    <th className="text-left px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {cases.map((c) => {
                    const phase = getNurturePhase(c, todayIso);
                    const rowTouchpoints = touchpoints.filter((t) => t.caseId === c.caseId);
                    const nextTouchpoint = rowTouchpoints
                      .filter((t) => t.status === "pending")
                      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
                    const lastCompleted = rowTouchpoints
                      .filter((t) => t.status === "completed" && t.completedAt)
                      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))[0];
                    const busy = busyCaseId === c.caseId;

                    return (
                      <tr
                        key={c.caseId}
                        className={`hover:bg-muted/30 transition-colors ${c.nurtureUnsubscribed ? "opacity-50" : ""}`}
                      >
                        <td className="px-4 py-3">
                          <Link
                            href={`/tc/cases/${c.caseId}`}
                            className="font-medium text-foreground hover:underline"
                          >
                            {c.patientName}
                          </Link>
                          <div className="text-xs text-muted-foreground">
                            {c.caseType} · {formatCents(c.caseValueCents)}
                          </div>
                          {c.nurtureUnsubscribed && (
                            <span className="text-[10px] text-muted-foreground">Unsubscribed</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {phase ? (
                            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${PHASE_PILL[phase]}`}>
                              Phase {phase}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-4 py-3">{getDaysEnrolled(c, todayIso)}d</td>
                        <td className="px-4 py-3">
                          {nextTouchpoint ? (
                            <span>
                              {nextTouchpoint.dueDate}{" "}
                              <span className="text-muted-foreground">
                                ({nurtureTypeLabel(nextTouchpoint.nurtureType)})
                              </span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">None scheduled</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {lastCompleted ? (
                            <span>
                              {(lastCompleted.completedAt ?? "").slice(0, 10)}{" "}
                              <span className="text-muted-foreground">
                                ({nurtureTypeLabel(lastCompleted.nurtureType)})
                              </span>
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {formatCadence(c, todayIso)}
                        </td>
                        <td className="px-4 py-3">
                          {!c.nurtureUnsubscribed && (
                            <div className="flex items-center gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0"
                                title="Override cadence"
                                aria-label={`Override cadence for ${c.patientName}`}
                                disabled={busy}
                                onClick={() => setCadenceTargetId(c.caseId)}
                              >
                                <Settings2 className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0"
                                title="Add financing touchpoint"
                                aria-label={`Add financing touchpoint for ${c.patientName}`}
                                disabled={busy}
                                onClick={() => void handleAddFinancing(c)}
                              >
                                <DollarSign className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0"
                                title="Move back to active pipeline"
                                aria-label={`Move ${c.patientName} back to active pipeline`}
                                disabled={busy}
                                onClick={() => void handleExitNurture(c)}
                              >
                                <RefreshCw className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0 text-muted-foreground"
                                title="Mark unsubscribed"
                                aria-label={`Mark ${c.patientName} unsubscribed`}
                                disabled={busy}
                                onClick={() => void handleUnsubscribe(c)}
                              >
                                <BellOff className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0"
                                title="Open case"
                                aria-label={`Open case for ${c.patientName}`}
                                asChild
                              >
                                <Link href={`/tc/cases/${c.caseId}`}>
                                  <ArrowUpRight className="w-3.5 h-3.5" />
                                </Link>
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Cadence override dialog */}
      {cadenceTarget && (
        <CadenceDialog
          office={office}
          caseRow={cadenceTarget}
          onSaved={mergeCase}
          onClose={() => setCadenceTargetId(null)}
        />
      )}
    </div>
  );
}
