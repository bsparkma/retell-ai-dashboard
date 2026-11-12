/**
 * Next-touch view: the Follow-ups page's main list. "None of my patients
 * fall through the cracks."
 *
 * Every OPEN case in the office shows here exactly once. Either it appears
 * under its ONE next touch (its earliest pending follow-up, from
 * GET /tc/followups/next-touch), date-sorted Overdue → Due today → Upcoming,
 * or it appears in the pinned "No next step" section, with one click to set
 * one. Terminal cases (accepted … lost, and scheduled) are not open work and
 * do not appear.
 *
 * Completing or skipping a case's last pending touch prompts for the next
 * one. "Not now" dismisses it, and the case then sits in "No next step",
 * which is the honest state. `office` may be several offices (all-offices
 * view). Each office is fetched on its own, and one failing leaves the rest
 * workable.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarCheck2,
  CalendarDays,
  CalendarPlus,
  Inbox,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { OfficeId } from "@shared/tc/contract";
import { nextTouchState } from "@shared/tc/nextTouch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createFollowup,
  nextTouchView,
  type TcDueFollowup,
  type TcNoNextStepCase,
} from "../api";
import {
  fanOutOfficeValues,
  hardErrorMessage,
  officesOf,
  partialNotice,
  showsOfficeBadges,
  type TcOfficeSelection,
} from "../officeScope";
import { todayIsoDate } from "../lib/followups";
import { CaseStatusBadge, TcPartialDataNotice, UrgencyBadge } from "../components/TcShell";
import { OfficeBadge } from "../components/OfficeBadge";
import { formatCents } from "../money";
import { NextTouchChip, SetNextTouchDialog, type NextTouchValues } from "../nextTouch/NextTouch";
import { FollowupActionCard } from "./FollowupActionCard";

export interface NextTouchBuckets {
  overdue: TcDueFollowup[];
  today: TcDueFollowup[];
  upcoming: TcDueFollowup[];
}

function byDateThenName(a: TcDueFollowup, b: TcDueFollowup): number {
  return a.dueDate.localeCompare(b.dueDate) || a.patientName.localeCompare(b.patientName);
}

/** Overdue → today → upcoming, each date-sorted (pure, for tests). */
export function bucketNextTouches(touches: readonly TcDueFollowup[], today: string): NextTouchBuckets {
  const out: NextTouchBuckets = { overdue: [], today: [], upcoming: [] };
  for (const t of touches) out[nextTouchState(t.dueDate, today)].push(t);
  out.overdue.sort(byDateThenName);
  out.today.sort(byDateThenName);
  out.upcoming.sort(byDateThenName);
  return out;
}

/** Matches an owner filter against the owner identity (case-insensitive). */
function ownerMatches(owner: string | null, needle: string): boolean {
  if (needle === "") return true;
  return (owner ?? "").toLowerCase().includes(needle);
}

interface PromptTarget {
  caseId: string;
  officeId: OfficeId;
  patientName: string;
  /** "complete" = the last touch was just closed; "set" = picked from No next step. */
  reason: "complete" | "set";
}

export interface NextTouchViewProps {
  office: TcOfficeSelection;
  /** YYYY-MM-DD "today" override for deterministic tests. */
  today?: string;
}

export function NextTouchView({ office, today }: NextTouchViewProps) {
  const todayIso = today ?? todayIsoDate();
  const offices = useMemo(() => officesOf(office), [office]);
  const showOfficeBadges = showsOfficeBadges(office);

  const [touches, setTouches] = useState<TcDueFollowup[]>([]);
  const [noNextStep, setNoNextStep] = useState<TcNoNextStepCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilter] = useState("");
  const [prompt, setPrompt] = useState<PromptTarget | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await fanOutOfficeValues(offices, (o) => nextTouchView(o));
    setTouches(result.values.flatMap((v) => v.value.touches));
    setNoNextStep(
      result.values
        .flatMap((v) => v.value.noNextStep)
        .sort((a, b) => a.patientName.localeCompare(b.patientName)),
    );
    setError(hardErrorMessage(result));
    const truncated = result.values.some((v) => v.value.truncated);
    setNotice(
      partialNotice(result) ??
        (truncated ? "Showing the first 2,000 open cases for an office; some are not listed." : null),
    );
    setLoading(false);
  }, [offices]);

  useEffect(() => {
    void load();
  }, [load]);

  const afterClose = useCallback(
    (row: TcDueFollowup) => (_id: string, info: { nextTouchNeeded: boolean }) => {
      if (info.nextTouchNeeded) {
        setPrompt({
          caseId: row.caseId,
          officeId: row.officeId,
          patientName: row.patientName,
          reason: "complete",
        });
      }
      void load();
    },
    [load],
  );

  const replaceRow = useCallback((updated: TcDueFollowup) => {
    setTouches((prev) => prev.map((f) => (f.followupId === updated.followupId ? updated : f)));
  }, []);

  const saveTouch = useCallback(
    async (values: NextTouchValues) => {
      if (!prompt) return;
      await createFollowup(prompt.officeId, {
        caseId: prompt.caseId,
        kind: "followup",
        dueDate: values.dueDate,
        channel: values.channel,
        talkingPoint: "",
        owner: values.owner,
        source: "manual",
      });
      toast.success(`Next touch set for ${prompt.patientName}`);
      void load();
    },
    [prompt, load],
  );

  const needle = ownerFilter.trim().toLowerCase();
  const buckets = useMemo(
    () => bucketNextTouches(touches.filter((t) => ownerMatches(t.owner, needle)), todayIso),
    [touches, needle, todayIso],
  );
  const shownTouches = buckets.overdue.length + buckets.today.length + buckets.upcoming.length;

  const renderGroup = (label: string, Icon: typeof AlertTriangle, iconClass: string, items: TcDueFollowup[]) => {
    if (items.length === 0) return null;
    return (
      <section aria-label={label}>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground mb-2">
          <Icon className={`w-4 h-4 ${iconClass}`} />
          {label}
          <span className="text-xs font-medium text-muted-foreground bg-muted rounded-full px-2 py-0.5">
            {items.length}
          </span>
        </h2>
        <div className="space-y-3">
          {items.map((f) => (
            <div key={f.followupId} className="space-y-1">
              <NextTouchChip nextTouch={f} today={todayIso} />
              <FollowupActionCard
                office={f.officeId}
                followup={f}
                showOfficeBadge={showOfficeBadges}
                today={todayIso}
                onCompleted={afterClose(f)}
                onSkipped={afterClose(f)}
                onRescheduled={replaceRow}
              />
            </div>
          ))}
        </div>
      </section>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          value={ownerFilter}
          onChange={(e) => setOwnerFilter(e.target.value)}
          placeholder="Filter by owner…"
          aria-label="Filter by owner"
          className="h-8 w-48 text-sm"
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 text-xs"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {notice && <TcPartialDataNotice message={notice} />}

      {error && (
        <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-3 text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : (
        <>
          {/* Pinned: open cases nobody has a next step for. Never filtered by
              owner, because they have none, and that is the point. */}
          {noNextStep.length > 0 && (
            <section
              aria-label="No next step"
              className="rounded-xl border border-dashed border-red-300 dark:border-red-900 bg-red-50/50 dark:bg-red-950/30 p-3"
            >
              <h2 className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-300 mb-2">
                <AlertTriangle className="w-4 h-4" />
                No next step
                <span className="text-xs font-medium bg-background rounded-full px-2 py-0.5">
                  {noNextStep.length}
                </span>
              </h2>
              <ul className="divide-y divide-border">
                {noNextStep.map((c) => (
                  <li key={`${c.officeId}:${c.caseId}`} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0 flex items-center gap-2 flex-wrap">
                      <Link
                        href={`/tc/cases/${c.caseId}`}
                        className="text-sm font-semibold text-foreground hover:underline truncate"
                      >
                        {c.patientName}
                      </Link>
                      <CaseStatusBadge status={c.caseStatus} />
                      <UrgencyBadge urgency={c.caseUrgency} />
                      {showOfficeBadges && <OfficeBadge officeId={c.officeId} />}
                      <span className="text-xs text-muted-foreground">
                        {formatCents(c.caseValueCents)}
                        {c.assignedTc ? ` · ${c.assignedTc}` : ""}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 shrink-0"
                      onClick={() =>
                        setPrompt({
                          caseId: c.caseId,
                          officeId: c.officeId,
                          patientName: c.patientName,
                          reason: "set",
                        })
                      }
                    >
                      <CalendarPlus className="w-3.5 h-3.5" /> Set next step
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {shownTouches === 0 && noNextStep.length === 0 && !error ? (
            <div className="flex flex-col items-center justify-center text-center py-16 gap-2 text-muted-foreground">
              <Inbox className="w-8 h-8 opacity-40" />
              <p className="text-sm font-medium text-foreground">No open cases</p>
              <p className="text-xs">Every open case will show its next touch here.</p>
            </div>
          ) : (
            <>
              {renderGroup("Overdue", AlertTriangle, "text-red-600 dark:text-red-400", buckets.overdue)}
              {renderGroup("Due today", CalendarCheck2, "text-amber-600 dark:text-amber-400", buckets.today)}
              {renderGroup("Upcoming", CalendarDays, "text-muted-foreground", buckets.upcoming)}
            </>
          )}
        </>
      )}

      <SetNextTouchDialog
        open={prompt !== null}
        onOpenChange={(o) => {
          if (!o) setPrompt(null);
        }}
        today={todayIso}
        title={prompt?.reason === "complete" ? "What's the next touch?" : "Set the next step"}
        description={
          prompt
            ? prompt.reason === "complete"
              ? `That was the last touch on file for ${prompt.patientName}, and the case is still open. Set the next one, or choose Not now to leave it flagged "No next step".`
              : `${prompt.patientName} has no next step. When is the next touch, and who makes it?`
            : ""
        }
        onSave={saveTouch}
      />
    </div>
  );
}
