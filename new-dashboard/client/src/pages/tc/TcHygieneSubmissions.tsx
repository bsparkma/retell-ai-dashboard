/**
 * /tc/hygiene/submissions — "My Submissions", the hygienist's live view of
 * what happened to every patient they handed off.
 *
 * GET /tc/hygiene-intakes/mine is scoped to the SSO session server-side, so
 * this page just renders. The case status badge is the real pipeline status;
 * the caption under it translates TC vocabulary into hygienist-friendly copy.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, Inbox, Loader2, Plus, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CaseStatusBadge,
  TcOfficeGate,
  TcPageHeader,
  useTcOffice,
} from "@/features/tc/components/TcShell";
import { myHygieneIntakes, tcErrorMessage, type TcMyIntake } from "@/features/tc/api";
import type { CaseStatusId } from "@/features/tc/status";
import type { OfficeId } from "@shared/tc/contract";

/** Hygienist-friendly caption under the live case status. */
const STATUS_CAPTIONS: Partial<Record<CaseStatusId, string>> = {
  hygiene_review: "Waiting for TC review",
  pending_tc: "Claimed — TC working it",
  diagnosed: "Claimed — TC working it",
  presented: "Presented to patient",
  accepted: "Moving forward",
  scheduled: "Moving forward",
  completed: "Moving forward",
  lost: "Didn't move forward",
};
const DEFAULT_CAPTION = "With TC — in progress";

type InterestId = TcMyIntake["patientInterestLevel"];

const INTEREST_CHIP: Record<InterestId, { label: string; cls: string }> = {
  hot: { label: "Hot", cls: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" },
  warm: { label: "Warm", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  cold: { label: "Cold", cls: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" },
  unknown: {
    label: "Interest unknown",
    cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  },
};

function formatSubmittedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** YYYY-MM-DD → "Mar 10, 2026" without timezone drift. */
function formatDay(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function SubmissionsList({ office }: { office: OfficeId }) {
  const [rows, setRows] = useState<TcMyIntake[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await myHygieneIntakes(office));
    } catch (e) {
      setRows([]);
      setError(tcErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [office]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-700 dark:text-red-300 flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </span>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center py-20 gap-3 text-muted-foreground">
        <Inbox className="w-10 h-10 opacity-30" />
        <p className="text-sm font-medium text-foreground">No handoffs yet</p>
        <p className="text-xs max-w-xs">
          When you hand a patient off chairside, it shows up here with the live status of their
          case.
        </p>
        <Button asChild size="sm" className="gap-1.5">
          <Link href="/tc/hygiene">
            <Plus className="w-4 h-4" /> Create your first handoff
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((r) => {
        const interest = INTEREST_CHIP[r.patientInterestLevel];
        return (
          <div key={r.intakeId} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-foreground truncate">
                    {r.patientName}
                  </span>
                  {r.flagUrgent && (
                    <Badge
                      variant="outline"
                      className="border-transparent bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300 gap-1"
                    >
                      <AlertTriangle className="w-3 h-3" /> Urgent
                    </Badge>
                  )}
                  <span
                    className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${interest.cls}`}
                  >
                    {interest.label}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Submitted {formatSubmittedAt(r.submittedAt)} · Visit {formatDay(r.visitDate)}
                </p>
                {r.suspectedTreatment && (
                  <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">
                    <span className="font-medium text-foreground">Suspected:</span>{" "}
                    {r.suspectedTreatment}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <CaseStatusBadge status={r.caseStatus} />
                <span className="text-[11px] text-muted-foreground">
                  {STATUS_CAPTIONS[r.caseStatus] ?? DEFAULT_CAPTION}
                </span>
              </div>
            </div>
          </div>
        );
      })}
      <div className="flex justify-center pt-1">
        <Button size="sm" variant="ghost" className="gap-1.5 text-xs" onClick={() => void load()}>
          <RefreshCw className="w-3.5 h-3.5" /> Refresh statuses
        </Button>
      </div>
    </div>
  );
}

export default function TcHygieneSubmissions() {
  const office = useTcOffice();
  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <TcPageHeader
        title="My Submissions"
        subtitle="Live status of every patient you handed off"
        actions={
          <Button asChild size="sm" className="gap-1.5">
            <Link href="/tc/hygiene">
              <Plus className="w-4 h-4" /> New handoff
            </Link>
          </Button>
        }
      />
      <SubmissionsList office={office} />
    </div>
  );
}
