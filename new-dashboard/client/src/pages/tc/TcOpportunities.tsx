/**
 * /tc/opportunities — treatment planned in Open Dental and sitting unscheduled
 * (queue item 41), in the hygiene-inbox pattern.
 *
 * Rows are CANDIDATES from the nightly sync. Nothing becomes a case until a TC
 * claims it (→ a new case, or ATTACHED to the patient's open case — never a
 * duplicate), and nothing leaves the inbox silently: dismissing asks why.
 *
 * Reads Postgres only. Every number here is the last completed sync's
 * snapshot, and the header says when that was, per office.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarClock,
  CircleDollarSign,
  Eye,
  Link2,
  Loader2,
  Phone,
  RefreshCw,
  Sparkles,
  Telescope,
  UserCheck,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { TcOfficeGate, TcPageHeader, TcPartialDataNotice } from "@/features/tc/components/TcShell";
import { OfficeBadge } from "@/features/tc/components/OfficeBadge";
import {
  fanOutOfficeValues,
  hardErrorMessage,
  officeScopeKey,
  partialNotice,
  tcOfficeLabel,
  useTcOfficeScope,
  type WithOffice,
} from "@/features/tc/officeScope";
import { TcApiError, tcErrorMessage } from "@/features/tc/api";
import {
  claimOpportunity,
  dismissOpportunity,
  formatCents,
  listOpportunities,
  type OpportunityStatus,
  type OpportunitySyncState,
  type TcOpportunity,
} from "@/features/tc/opportunities/opportunitiesApi";
import {
  SORT_LABELS,
  formatPlannedDate,
  sortOpportunities,
  syncSentence,
  type OpportunitySort,
} from "@/features/tc/opportunities/opportunityView";
import type { OfficeId } from "@shared/tc/contract";

const TABS: { id: OpportunityStatus; label: string }[] = [
  { id: "new", label: "New" },
  { id: "existing_case", label: "Already in a case" },
  { id: "claimed", label: "Claimed" },
  { id: "dismissed", label: "Dismissed" },
];

type Row = WithOffice<TcOpportunity>;

function SyncLines({ syncs, showOffice }: { syncs: { officeId: OfficeId; sync: OpportunitySyncState | null }[]; showOffice: boolean }) {
  return (
    <div className="space-y-1 mb-4">
      {syncs.map(({ officeId, sync }) => {
        const s = syncSentence(sync);
        const cls =
          s.tone === "warn"
            ? "text-amber-700 dark:text-amber-300"
            : s.tone === "ok"
              ? "text-muted-foreground"
              : "text-muted-foreground italic";
        return (
          <p key={officeId} className={`text-xs flex items-center gap-1.5 ${cls}`} data-testid={`sync-${officeId}`}>
            {s.tone === "warn" ? <AlertTriangle className="w-3.5 h-3.5" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {showOffice && <span className="font-medium">{tcOfficeLabel(officeId)}:</span>} {s.text}
          </p>
        );
      })}
    </div>
  );
}

function DismissDialog({
  row,
  onClose,
  onDismissed,
}: {
  row: Row | null;
  onClose: () => void;
  onDismissed: (row: Row) => void;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => setReason(""), [row]);
  const trimmed = reason.trim();

  const submit = async () => {
    if (!row || !trimmed) return;
    setSaving(true);
    try {
      await dismissOpportunity(row.officeId, row.opportunityId, trimmed);
      toast.success("Dismissed — it comes back only if new treatment is planned");
      onDismissed(row);
      onClose();
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={row !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dismiss this opportunity?</DialogTitle>
          <DialogDescription>
            Say why, so the next person knows. It stays dismissed unless Open Dental shows a new
            planned procedure for this patient — a fee change will not bring it back.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="Reason"
          placeholder="e.g. Patient declined — going elsewhere"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!trimmed || saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
            Dismiss
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OpportunityCard({
  row,
  showOfficeBadges,
  busy,
  onClaim,
  onDismiss,
}: {
  row: Row;
  showOfficeBadges: boolean;
  busy: boolean;
  onClaim: (r: Row) => void;
  onDismiss: (r: Row) => void;
}) {
  const actionable = row.status === "new" || (row.status === "existing_case" && row.claimedCaseId === null);
  const namePending = row.patientName === null;
  return (
    <div className="rounded-xl border border-border bg-card p-4" data-testid="opportunity-row">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-base font-semibold ${namePending ? "text-muted-foreground italic" : "text-foreground"}`}>
              {row.patientName ?? "Name pending"}
            </span>
            {showOfficeBadges && <OfficeBadge officeId={row.officeId} />}
            {/* The PatNum travels with its office badge/scope — on its own it
                names a different person in each practice database. */}
            <Badge variant="outline" className="gap-1 text-[10px]">
              <Link2 className="w-3 h-3" /> OD #{row.odPatientId}
            </Badge>
            {row.status === "existing_case" && (
              <Badge variant="outline" className="border-transparent bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                Already in an open case
              </Badge>
            )}
            {row.resurrectedAt && row.status === "new" && (
              <Badge variant="outline" className="gap-1 border-transparent bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                <Sparkles className="w-3 h-3" /> New treatment since dismissed
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground mt-1">
            <span className="inline-flex items-center gap-1 font-semibold text-foreground">
              <CircleDollarSign className="w-3.5 h-3.5" /> {formatCents(row.valueCents)}
            </span>
            <span className="inline-flex items-center gap-1">
              <CalendarClock className="w-3 h-3" /> Planned {formatPlannedDate(row.plannedDate)}
            </span>
            <span>
              {row.procedures.length} procedure{row.procedures.length === 1 ? "" : "s"}
            </span>
            {row.patientPhone && (
              <span className="inline-flex items-center gap-1">
                <Phone className="w-3 h-3" /> {row.patientPhone}
              </span>
            )}
            {row.lastSeenAt && (
              <span className="inline-flex items-center gap-1">
                <Eye className="w-3 h-3" /> Last seen in OD {new Date(row.lastSeenAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {row.procedures.slice(0, 8).map((p) => (
              <span key={p.procNum} className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-foreground">
                {p.code}
                {p.tooth ? ` #${p.tooth}` : ""} · {p.description || "—"} · {formatCents(p.feeCents)}
              </span>
            ))}
            {row.procedures.length > 8 && (
              <span className="text-[11px] text-muted-foreground">+{row.procedures.length - 8} more</span>
            )}
          </div>
          {row.status === "dismissed" && row.dismissedReason && (
            <p className="text-xs text-muted-foreground mt-2">
              <span className="font-medium text-foreground">Dismissed:</span> {row.dismissedReason}
              {row.dismissedBy ? ` — ${row.dismissedBy}` : ""}
            </p>
          )}
          {row.claimedCaseId && (
            <p className="text-xs text-muted-foreground mt-2">
              {row.status === "claimed" ? "Claimed" : "Attached"}
              {row.claimedBy ? ` by ${row.claimedBy}` : ""} ·{" "}
              <Link href={`/tc/cases/${row.claimedCaseId}`} className="underline">
                Open case
              </Link>
            </p>
          )}
          {namePending && actionable && (
            <p className="text-[11px] text-muted-foreground mt-2">
              The name arrives with the next nightly sync — it can be claimed then.
            </p>
          )}
        </div>
      </div>
      {actionable && (
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border">
          <Button size="sm" className="gap-1.5" disabled={busy || namePending} onClick={() => onClaim(row)}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCheck className="w-4 h-4" />}
            {row.status === "existing_case" ? "Attach to open case" : "Claim"}
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => onDismiss(row)}>
            <X className="w-4 h-4" /> Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

export function OpportunitiesInbox({ offices, showOfficeBadges }: { offices: OfficeId[]; showOfficeBadges: boolean }) {
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<OpportunityStatus>("new");
  const [sort, setSort] = useState<OpportunitySort>("value");
  const [rows, setRows] = useState<Row[]>([]);
  const [syncs, setSyncs] = useState<{ officeId: OfficeId; sync: OpportunitySyncState | null }[]>([]);
  const [totals, setTotals] = useState({ count: 0, valueCents: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<Row | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    const result = await fanOutOfficeValues(offices, (o) => listOpportunities(o, tab));
    const merged: Row[] = [];
    let count = 0;
    let valueCents = 0;
    for (const { officeId, value } of result.values) {
      merged.push(...value.opportunities.map((o) => ({ ...o, officeId })));
      count += value.totals.count;
      valueCents += value.totals.valueCents;
    }
    setRows(merged);
    setTotals({ count, valueCents });
    setSyncs(result.values.map(({ officeId, value }) => ({ officeId, sync: value.sync })));
    setError(hardErrorMessage(result));
    setNotice(partialNotice(result));
    setLoading(false);
  }, [offices, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(() => sortOpportunities(rows, sort), [rows, sort]);

  const remove = (r: Row) => {
    setRows((prev) => prev.filter((x) => x.opportunityId !== r.opportunityId));
    setTotals((t) => ({ count: Math.max(0, t.count - 1), valueCents: Math.max(0, t.valueCents - r.valueCents) }));
  };

  const claim = async (r: Row) => {
    setBusyId(r.opportunityId);
    try {
      const result = await claimOpportunity(r.officeId, r);
      remove(r);
      toast.success(
        result.attached
          ? `Attached to ${r.patientName}'s open case`
          : `Claimed ${r.patientName} — new case in Pending TC`,
        { action: { label: "Open case", onClick: () => navigate(result.url) } },
      );
    } catch (e) {
      if (e instanceof TcApiError && (e.status === 409 || e.status === 404)) {
        toast.error(e.message);
        void load();
      } else {
        toast.error(tcErrorMessage(e));
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <SyncLines syncs={syncs} showOffice={showOfficeBadges} />

      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <div className="flex gap-1 rounded-lg bg-muted p-1" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                tab === t.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
              }`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Sort</span>
          {(Object.keys(SORT_LABELS) as OpportunitySort[]).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={sort === s ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              aria-pressed={sort === s}
              onClick={() => setSort(s)}
            >
              {SORT_LABELS[s]}
            </Button>
          ))}
        </div>
      </div>

      {!loading && !error && (
        <p className="text-sm text-muted-foreground mb-3" data-testid="opportunity-totals">
          <span className="font-semibold text-foreground">{totals.count}</span>{" "}
          {totals.count === 1 ? "patient" : "patients"} ·{" "}
          <span className="font-semibold text-foreground">{formatCents(totals.valueCents)}</span> planned
        </p>
      )}

      {notice && <TcPartialDataNotice message={notice} />}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-700 dark:text-red-300 flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
          </span>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-20 gap-3 text-muted-foreground">
          <Telescope className="w-10 h-10 opacity-30" />
          <p className="text-sm">
            {tab === "new" ? "No unscheduled treatment waiting." : "Nothing here."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map((r) => (
            <OpportunityCard
              key={r.opportunityId}
              row={r}
              showOfficeBadges={showOfficeBadges}
              busy={busyId === r.opportunityId}
              onClaim={(x) => void claim(x)}
              onDismiss={setDismissing}
            />
          ))}
        </div>
      )}

      <DismissDialog row={dismissing} onClose={() => setDismissing(null)} onDismissed={remove} />
    </>
  );
}

export default function TcOpportunities() {
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
        title="Opportunities"
        subtitle="Treatment planned in Open Dental and not yet scheduled — claim one to start a case"
      />
      <OpportunitiesInbox
        key={officeScopeKey(scope.offices)}
        offices={scope.offices}
        showOfficeBadges={scope.showOfficeBadges}
      />
    </div>
  );
}
