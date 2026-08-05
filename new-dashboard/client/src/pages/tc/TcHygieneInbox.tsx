/**
 * /tc/hygiene/inbox — the TC's queue of unclaimed hygiene handoffs
 * (hygiene_review cases). Urgent-first ordering comes from the server and is
 * preserved as-is. Claim assigns the SSO caller and moves the case to
 * pending_tc; a concurrent claim surfaces as 409/404 → toast the server
 * message and refresh the list.
 *
 * All-offices: the inbox fans out over every office in scope and badges each
 * row; Claim writes back to the office that owns the intake.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import {
  AlertTriangle,
  Clock,
  Inbox,
  Loader2,
  Phone,
  RefreshCw,
  Stethoscope,
  UserCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  TcOfficeGate,
  TcPageHeader,
  TcPartialDataNotice,
  UrgencyBadge,
} from "@/features/tc/components/TcShell";
import { OfficeBadge } from "@/features/tc/components/OfficeBadge";
import {
  fanOutOfficeRows,
  hardErrorMessage,
  officeScopeKey,
  partialNotice,
  useTcOfficeScope,
  type WithOffice,
} from "@/features/tc/officeScope";
import {
  claimHygieneCase,
  hygieneInbox,
  TcApiError,
  tcErrorMessage,
  type TcInboxIntake,
} from "@/features/tc/api";
import type { OfficeId } from "@shared/tc/contract";

type CategoryId = TcInboxIntake["category"];
type InterestId = TcInboxIntake["patientInterestLevel"];

const CATEGORY_LABELS: Record<CategoryId, string> = {
  single_tooth: "Single tooth",
  quadrant: "Quadrant",
  implant: "Implant",
  full_mouth_rehab: "Full mouth rehab",
  full_arch: "Full arch (All-on-X)",
  cosmetic: "Cosmetic",
  ortho: "Orthodontics",
};

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

function InboxList({
  offices,
  showOfficeBadges,
}: {
  offices: OfficeId[];
  showOfficeBadges: boolean;
}) {
  const [, navigate] = useLocation();
  const [rows, setRows] = useState<WithOffice<TcInboxIntake>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    // Server orders urgent-first, newest within — preserved per office, then
    // urgent-first again across the merge so the top of the list stays honest.
    const result = await fanOutOfficeRows(offices, (o) => hygieneInbox(o));
    const merged = [...result.rows].sort(
      (a, b) =>
        Number(b.flagUrgent) - Number(a.flagUrgent) ||
        b.submittedAt.localeCompare(a.submittedAt),
    );
    setRows(merged);
    setError(hardErrorMessage(result));
    setNotice(partialNotice(result));
    setLoading(false);
  }, [offices]);

  useEffect(() => {
    void load();
  }, [load]);

  const claim = async (row: WithOffice<TcInboxIntake>) => {
    setClaimingId(row.caseId);
    try {
      // Claim is a write — always to the office that owns the intake.
      await claimHygieneCase(row.officeId, row.caseId);
      setRows((prev) => prev.filter((r) => r.caseId !== row.caseId));
      toast.success(`Claimed ${row.patientName} — moved to Pending TC`, {
        action: {
          label: "Open case",
          onClick: () => navigate(`/tc/cases/${row.caseId}`),
        },
      });
    } catch (e) {
      if (e instanceof TcApiError && (e.status === 409 || e.status === 404)) {
        // Someone else beat us to it — show the server's message and re-sync.
        toast.error(e.message);
        void load();
      } else {
        toast.error(tcErrorMessage(e));
      }
    } finally {
      setClaimingId(null);
    }
  };

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
        <p className="text-sm">Inbox zero — no hygiene handoffs waiting.</p>
        <Button size="sm" variant="ghost" className="gap-1.5 text-xs" onClick={() => void load()}>
          <RefreshCw className="w-3.5 h-3.5" /> Check again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {notice && <TcPartialDataNotice message={notice} />}
      {rows.map((r) => {
        const interest = INTEREST_CHIP[r.patientInterestLevel];
        return (
          <div
            key={r.intakeId}
            className={`rounded-xl border bg-card p-4 ${
              r.flagUrgent ? "border-red-300 dark:border-red-900" : "border-border"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link
                    href={`/tc/cases/${r.caseId}`}
                    className="text-base font-semibold text-foreground hover:underline truncate"
                  >
                    {r.patientName}
                  </Link>
                  {r.flagUrgent && (
                    <Badge
                      variant="outline"
                      className="border-transparent bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300 gap-1"
                    >
                      <AlertTriangle className="w-3 h-3" /> Urgent
                    </Badge>
                  )}
                  <UrgencyBadge urgency={r.urgency} />
                  {showOfficeBadges && <OfficeBadge officeId={r.officeId} />}
                  <span
                    className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${interest.cls}`}
                  >
                    {interest.label}
                  </span>
                </div>

                <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground mt-1">
                  <span>{CATEGORY_LABELS[r.category]}</span>
                  {r.patientAge !== null && <span>Age {r.patientAge}</span>}
                  {r.phone && (
                    <span className="inline-flex items-center gap-1">
                      <Phone className="w-3 h-3" /> {r.phone}
                    </span>
                  )}
                  {r.diagnosingProvider && (
                    <span className="inline-flex items-center gap-1">
                      <Stethoscope className="w-3 h-3" /> {r.diagnosingProvider}
                    </span>
                  )}
                </div>

                {r.chiefConcern && <p className="text-sm text-foreground mt-2">{r.chiefConcern}</p>}
                {r.suspectedTreatment && (
                  <p className="text-xs text-muted-foreground mt-1.5">
                    <span className="font-medium text-foreground">Suspected:</span>{" "}
                    {r.suspectedTreatment}
                  </p>
                )}
                {r.hygienistRecommendation && (
                  <p className="text-xs text-muted-foreground mt-1">
                    <span className="font-medium text-foreground">Hygienist:</span>{" "}
                    {r.hygienistRecommendation}
                  </p>
                )}

                <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-2">
                  <Clock className="w-3 h-3" />
                  {r.submittedByName || "Hygiene"} · {formatSubmittedAt(r.submittedAt)}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border">
              <Button
                size="sm"
                className="gap-1.5"
                disabled={claimingId === r.caseId}
                onClick={() => void claim(r)}
              >
                {claimingId === r.caseId ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <UserCheck className="w-4 h-4" />
                )}
                Claim
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={`/tc/cases/${r.caseId}`}>Open case</Link>
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function TcHygieneInbox() {
  const scope = useTcOfficeScope();
  if (scope.offices.length === 0) {
    return (
      <div className="p-6">
        <TcOfficeGate loading={scope.loading} />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <TcPageHeader
        title="Hygiene Inbox"
        subtitle={
          scope.showOfficeBadges
            ? "Unclaimed handoffs from every office — claim one to start working it"
            : "Unclaimed handoffs from hygiene — claim one to start working it"
        }
      />
      <InboxList
        key={officeScopeKey(scope.offices)}
        offices={scope.offices}
        showOfficeBadges={scope.showOfficeBadges}
      />
    </div>
  );
}
