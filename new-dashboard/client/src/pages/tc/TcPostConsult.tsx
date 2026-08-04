/**
 * /tc/cases/:id/post-consult — Post-Consult Capture (ported from DentaFlow
 * PostConsult). Reached automatically when the presentation deck exits.
 *
 * Two steps: pick the outcome, then outcome-specific detail. Submit builds a
 * PURE mutation plan (features/tc/consult/outcomeActions) and applies it
 * SEQUENTIALLY — objection log, status transition, follow-up creation each
 * await the server row (confirmed-save). A partial failure toasts exactly
 * which step failed and keeps the form open; nothing is silently retried.
 *
 * Unlike the presentation deck this page renders inside the normal shell
 * (legacy rendered PostConsult in the shell too) — content is just centered.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { toast } from "sonner";
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Layers,
  Loader2,
  MessageSquare,
  Sparkles,
  XCircle,
} from "lucide-react";
import type { z } from "zod";
import type { LibraryCadenceConfig, OfficeId, TcCase } from "@shared/tc/contract";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getCase, getLibrarySection, tcErrorMessage } from "@/features/tc/api";
import { TcOfficeGate, useTcOffice } from "@/features/tc/components/TcShell";
import { formatCents } from "@/features/tc/money";
import type { LostReasonId } from "@/features/tc/status";
import {
  cadenceOffsets,
  consultCaseInfo,
  executeConsultPlan,
  planConsultOutcome,
  type ConsultOutcome,
} from "@/features/tc/consult/outcomeActions";
import { OBJECTION_SCRIPTS, objectionScriptFor } from "@/features/tc/consult/objectionScripts";
import { todayIsoDate } from "@/features/tc/lib/followups";

type CadenceConfig = z.infer<typeof LibraryCadenceConfig>;

/** Legacy decline buttons → platform LostReason ids ("other" = nurture track). */
const DECLINE_REASONS: { key: LostReasonId; label: string }[] = [
  { key: "chose_another_provider", label: "Going elsewhere" },
  { key: "declined_permanently", label: "Doesn't want treatment" },
  { key: "unresponsive", label: "Can't afford / no financing" },
  { key: "other", label: "Not now — may return" },
];

function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}

export default function TcPostConsult() {
  const office = useTcOffice();
  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }
  return <PostConsultInner office={office} />;
}

function PostConsultInner({ office }: { office: OfficeId }) {
  const { id } = useParams<{ id: string }>();
  const caseId = id ?? "";
  const [, setLocation] = useLocation();

  const [tcCase, setTcCase] = useState<TcCase | null>(null);
  const [cadence, setCadence] = useState<CadenceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [outcome, setOutcome] = useState<ConsultOutcome | null>(null);
  const [note, setNote] = useState("");
  const [objectionCategory, setObjectionCategory] = useState<string | null>(null);
  const [objectionWords, setObjectionWords] = useState("");
  const [acceptedPhaseIds, setAcceptedPhaseIds] = useState<Set<string>>(new Set());
  const [declineReason, setDeclineReason] = useState<LostReasonId | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!caseId) {
      setLoadError("No case id.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    getCase(office, caseId)
      .then((c) => {
        if (!cancelled) setTcCase(c);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(tcErrorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // Cadence config is optional — unconfigured offices use the legacy default.
    getLibrarySection(office, "cadence_config")
      .then((value) => {
        if (!cancelled) setCadence(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [office, caseId]);

  const objectionScript = objectionCategory ? objectionScriptFor(objectionCategory) : null;

  const firstTouchDays = useMemo(() => {
    if (!tcCase || !objectionCategory) return null;
    return (
      cadenceOffsets(tcCase.caseValueCents, tcCase.urgency, objectionCategory, cadence)[0] ?? null
    );
  }, [tcCase, objectionCategory, cadence]);

  function resetDetail() {
    setOutcome(null);
    setObjectionCategory(null);
    setObjectionWords("");
    setAcceptedPhaseIds(new Set());
    setDeclineReason(null);
  }

  function togglePhase(phaseId: string) {
    setAcceptedPhaseIds((prev) => {
      const next = new Set(prev);
      if (next.has(phaseId)) next.delete(phaseId);
      else next.add(phaseId);
      return next;
    });
  }

  async function handleSubmit() {
    if (!outcome || !tcCase || submitting) return;
    const plan = planConsultOutcome({
      outcome,
      tcCase: consultCaseInfo(tcCase),
      today: todayIsoDate(),
      note,
      objectionCategory,
      objectionWords,
      acceptedPhaseIds: Array.from(acceptedPhaseIds),
      declineReason,
      cadence,
    });
    if (!plan.ok) {
      toast.error(plan.message);
      return;
    }
    setSubmitting(true);
    const result = await executeConsultPlan(office, tcCase.caseId, plan.steps);
    setSubmitting(false);
    if (!result.ok) {
      const committed =
        result.completedCount > 0
          ? ` ${result.completedCount} earlier step${result.completedCount === 1 ? "" : "s"} already saved.`
          : "";
      toast.error(
        `Failed while ${result.failedLabel}: ${tcErrorMessage(result.error)}.${committed}`,
      );
      return; // keep the form — nothing lost.
    }
    toast.success(plan.successMessage);
    setLocation(`/tc/cases/${caseId}`);
  }

  if (loading) {
    return (
      <div className="p-6 max-w-2xl mx-auto space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!tcCase) {
    return (
      <div className="p-6">
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
          <p className="text-sm text-muted-foreground">{loadError ?? "Case not found."}</p>
          <Button asChild variant="outline">
            <Link href="/tc">Back to Treatment Coordinator</Link>
          </Button>
        </div>
      </div>
    );
  }

  const firstName = tcCase.patientName.split(" ")[0] ?? tcCase.patientName;

  const outcomeButton = (
    key: ConsultOutcome,
    icon: React.ReactNode,
    iconBg: string,
    hoverBorder: string,
    title: string,
    desc: string,
  ) => (
    <button
      type="button"
      onClick={() => setOutcome(key)}
      className={`w-full flex items-center gap-4 p-5 rounded-xl border-2 border-border bg-card ${hoverBorder} transition-colors text-left`}
    >
      <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${iconBg}`}>
        {icon}
      </div>
      <div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
    </button>
  );

  return (
    <div className="p-6">
      <div className="w-full max-w-2xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-full mx-auto flex items-center justify-center text-lg font-bold bg-primary text-primary-foreground mb-4">
            {initials(tcCase.patientName)}
          </div>
          <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
            How did it go with {firstName}?
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {[tcCase.caseType || null, formatCents(tcCase.caseValueCents)]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>

        {/* Step 1: outcome selection */}
        {!outcome && (
          <div className="space-y-3">
            {outcomeButton(
              "accepted_full",
              <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />,
              "bg-emerald-100/60 dark:bg-emerald-950/40",
              "hover:border-emerald-400",
              "Accepted — Full Plan",
              "Patient committed to the entire treatment plan",
            )}
            {outcomeButton(
              "accepted_phased",
              <Layers className="w-5 h-5 text-blue-600 dark:text-blue-400" />,
              "bg-blue-100/60 dark:bg-blue-950/40",
              "hover:border-blue-400",
              "Accepted — Phased",
              "Patient accepted some phases but not all",
            )}
            {outcomeButton(
              "thinking_objection",
              <MessageSquare className="w-5 h-5 text-amber-600 dark:text-amber-400" />,
              "bg-amber-100/60 dark:bg-amber-950/40",
              "hover:border-amber-400",
              "Thinking — Has a Concern",
              "Patient has a specific objection or concern",
            )}
            {outcomeButton(
              "thinking_no_objection",
              <Clock className="w-5 h-5 text-blue-500 dark:text-blue-300" />,
              "bg-blue-50 dark:bg-blue-950/30",
              "hover:border-blue-300",
              "Thinking — No Specific Concern",
              "Patient wants time but didn't raise a specific issue",
            )}
            {outcomeButton(
              "declined",
              <XCircle className="w-5 h-5 text-red-500 dark:text-red-400" />,
              "bg-red-50 dark:bg-red-950/30",
              "hover:border-red-300",
              "Declined",
              "Patient is not moving forward at this time",
            )}
          </div>
        )}

        {/* Step 2: outcome-specific detail */}
        {outcome && (
          <div className="bg-card rounded-xl border border-border p-6 shadow-sm space-y-5">
            <button
              type="button"
              onClick={resetDetail}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              ← Change outcome
            </button>

            {/* Accepted — full */}
            {outcome === "accepted_full" && (
              <div className="text-center space-y-3">
                <div className="w-16 h-16 rounded-full mx-auto flex items-center justify-center bg-emerald-100/60 dark:bg-emerald-950/40">
                  <Sparkles className="w-8 h-8 text-emerald-600 dark:text-emerald-400" />
                </div>
                <h2 className="text-lg font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                  Great work!
                </h2>
                <p className="text-sm text-muted-foreground">
                  {firstName} accepted the full {formatCents(tcCase.caseValueCents)} plan.
                </p>
              </div>
            )}

            {/* Accepted — phased */}
            {outcome === "accepted_phased" && (
              <div className="space-y-4">
                <h2 className="text-sm font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                  Which phases did they accept?
                </h2>
                {tcCase.phases.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    This case has no phases yet — add phases from the case view first.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {tcCase.phases.map((phase) => {
                      const isSelected = acceptedPhaseIds.has(phase.phaseId);
                      const phaseTotal = phase.items.reduce((s, i) => s + i.patientPortionCents, 0);
                      return (
                        <button
                          key={phase.phaseId}
                          type="button"
                          onClick={() => togglePhase(phase.phaseId)}
                          className={`w-full flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-colors ${
                            isSelected
                              ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/40"
                              : "border-border bg-card hover:bg-muted/30"
                          }`}
                        >
                          {isSelected ? (
                            <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                          ) : (
                            <div className="w-5 h-5 rounded-full border-2 border-muted-foreground/30 shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold text-foreground">{phase.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {phase.items.length} item{phase.items.length === 1 ? "" : "s"}
                            </div>
                          </div>
                          <div className="text-sm font-bold text-foreground shrink-0">
                            {formatCents(phaseTotal)}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
                {acceptedPhaseIds.size > 0 && acceptedPhaseIds.size < tcCase.phases.length && (
                  <div className="p-3 rounded-lg bg-primary/10">
                    <p className="text-xs text-primary">
                      The case moves to Partially Accepted and the{" "}
                      {tcCase.phases.length - acceptedPhaseIds.size} deferred phase
                      {tcCase.phases.length - acceptedPhaseIds.size === 1 ? "" : "s"} will be
                      recorded on the case for follow-up.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Thinking — objection */}
            {outcome === "thinking_objection" && (
              <div className="space-y-4">
                <h2 className="text-sm font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                  What was their concern?
                </h2>
                <div className="grid grid-cols-2 gap-2">
                  {OBJECTION_SCRIPTS.map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setObjectionCategory(key)}
                      className={`px-3 py-2.5 rounded-lg border text-xs font-medium transition-colors text-left ${
                        objectionCategory === key
                          ? "border-amber-400 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300"
                          : "border-border bg-card text-foreground hover:bg-muted/30"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div>
                  <label
                    htmlFor="post-consult-words"
                    className="text-xs font-semibold text-muted-foreground block mb-1"
                  >
                    What did they say? (their words)
                  </label>
                  <textarea
                    id="post-consult-words"
                    value={objectionWords}
                    onChange={(e) => setObjectionWords(e.target.value)}
                    placeholder="e.g., 'I need to talk to my husband first'"
                    className="w-full text-sm rounded-lg border border-border bg-background text-foreground p-3 resize-none h-20 focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>

                {objectionScript && (
                  <div className="tc-script-card space-y-2">
                    <div className="flex items-center gap-2 mb-1">
                      <Sparkles className="w-3.5 h-3.5 text-primary" />
                      <span className="text-xs font-semibold text-primary">
                        Response for "{objectionScript.title}"
                      </span>
                    </div>
                    {objectionScript.scripts.slice(0, 2).map((script, i) => (
                      <p key={i} className="text-xs leading-relaxed text-foreground">
                        {script}
                      </p>
                    ))}
                    {objectionScript.tips.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-primary/15">
                        <p className="text-[10px] font-semibold mb-1 text-primary">Tips:</p>
                        {objectionScript.tips.slice(0, 2).map((tip, i) => (
                          <p key={i} className="text-[10px] leading-relaxed text-muted-foreground">
                            • {tip}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {firstTouchDays !== null && (
                  <div className="p-3 rounded-lg bg-amber-100/50 dark:bg-amber-950/30">
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      A follow-up cadence will be auto-generated based on this objection type.
                      First touch in {firstTouchDays} day{firstTouchDays === 1 ? "" : "s"}.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Thinking — no objection */}
            {outcome === "thinking_no_objection" && (
              <div className="space-y-3">
                <div className="p-4 rounded-lg bg-blue-100/50 dark:bg-blue-950/30">
                  <p className="text-xs text-blue-700 dark:text-blue-300">
                    A standard follow-up cadence will be generated. First check-in in 5 days,
                    then at 12 and 21 days.
                  </p>
                </div>
              </div>
            )}

            {/* Declined */}
            {outcome === "declined" && (
              <div className="space-y-4">
                <h2 className="text-sm font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                  What happened?
                </h2>
                <div className="space-y-2">
                  {DECLINE_REASONS.map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setDeclineReason(key)}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border text-xs font-medium transition-colors text-left ${
                        declineReason === key
                          ? "border-red-300 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300"
                          : "border-border bg-card text-foreground hover:bg-muted/30"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {declineReason === "other" && (
                  <div className="p-3 rounded-lg bg-violet-100/50 dark:bg-violet-950/30">
                    <p className="text-xs text-violet-700 dark:text-violet-300">
                      This patient will move to the nurture track for gentle long-term
                      check-ins. They won't be forgotten.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Quick note (all outcomes) */}
            <div>
              <label
                htmlFor="post-consult-note"
                className="text-xs font-semibold text-muted-foreground block mb-1"
              >
                Quick note (optional)
              </label>
              <textarea
                id="post-consult-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Any details worth remembering..."
                className="w-full text-sm rounded-lg border border-border bg-background text-foreground p-3 resize-none h-16 focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            {/* Submit */}
            <Button
              onClick={handleSubmit}
              disabled={submitting}
              className="w-full gap-2 font-semibold"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Saving…
                </>
              ) : (
                <>
                  Save &amp; Continue <ArrowRight className="w-4 h-4" />
                </>
              )}
            </Button>
          </div>
        )}

        {/* Skip */}
        <div className="text-center mt-4">
          <Link
            href={`/tc/cases/${caseId}`}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Skip — go back to case
          </Link>
        </div>
      </div>
    </div>
  );
}
