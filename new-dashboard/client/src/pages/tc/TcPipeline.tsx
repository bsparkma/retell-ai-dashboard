/**
 * /tc — the pipeline surface: kanban board + list views over listCases().
 *
 * Data flow: listCases(office) on mount (and office change); status moves go
 * through the guarded transition path and merge the server's returned case
 * back into the summary row (scalars only) — no optimistic writes, success
 * toasts only after the server persists (Slice-0 confirmed-save rule).
 *
 * All-offices: there is no server-side all-offices query, so the selection
 * fans out over every office in scope and rows carry an officeId badge. Moves
 * are written back to the office that owns the row; creating a case still
 * needs one unambiguous office.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { ClipboardList, LayoutGrid, List, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { CaseCategory } from "@shared/tc/contract";
import type { OfficeId, TcCase } from "@shared/tc/contract";
import { listCases, tcErrorMessage, transitionCase } from "@/features/tc/api";
import type { TcCaseSummary } from "@/features/tc/api";
import { ALL_CASE_STATUSES, caseStatusLabel, validateTransition } from "@/features/tc/status";
import type { CaseStatusId, LostReasonId } from "@/features/tc/status";
import {
  TcOfficeGate,
  TcPageHeader,
  TcPartialDataNotice,
} from "@/features/tc/components/TcShell";
import {
  fanOutOfficeRows,
  hardErrorMessage,
  officeScopeKey,
  partialNotice,
  useTcOfficeScope,
  type WithOffice,
} from "@/features/tc/officeScope";
import { PipelineBoard } from "@/features/tc/cases/PipelineBoard";
import { CaseListTable } from "@/features/tc/cases/CaseListTable";
import { NewCaseDialog, CASE_CATEGORY_LABELS } from "@/features/tc/cases/NewCaseDialog";
import type { CaseCategoryId } from "@/features/tc/cases/NewCaseDialog";

export default function TcPipeline() {
  const scope = useTcOfficeScope();
  if (scope.offices.length === 0) {
    return <div className="p-6"><TcOfficeGate loading={scope.loading} /></div>;
  }
  // Inner component so data/UI hooks never render in the gated state
  // (the scope can flip between empty and concrete via the global picker).
  return (
    <PipelineInner
      key={officeScopeKey(scope.offices)}
      offices={scope.offices}
      writeOffice={scope.office}
      showOfficeBadges={scope.showOfficeBadges}
    />
  );
}

function PipelineInner({
  offices,
  writeOffice,
  showOfficeBadges,
}: {
  offices: OfficeId[];
  /** The single office new cases are created in, or null on all-offices. */
  writeOffice: OfficeId | null;
  showOfficeBadges: boolean;
}) {
  const [, navigate] = useLocation();
  const [cases, setCases] = useState<WithOffice<TcCaseSummary>[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [view, setView] = useState<"board" | "list">("board");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<CaseCategoryId | "all">("all");
  const [statusFilter, setStatusFilter] = useState<CaseStatusId | "all">("all");
  const [newCaseOpen, setNewCaseOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // One office failing must not blank the board: keep what loaded and say so.
    fanOutOfficeRows(offices, (o) => listCases(o))
      .then((result) => {
        if (cancelled) return;
        setCases(result.rows);
        setNotice(partialNotice(result));
        const hard = hardErrorMessage(result);
        if (hard) toast.error(hard);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [offices]);

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

  const handleTransition = useCallback(
    async (
      caseId: string,
      status: CaseStatusId,
      lostReason: LostReasonId | null,
      note?: string,
    ): Promise<boolean> => {
      const check = validateTransition(status, lostReason);
      if (!check.ok) {
        toast.error(check.message);
        return false;
      }
      // The write goes to the office that owns the row, never the page scope.
      const rowOffice = cases.find((row) => row.caseId === caseId)?.officeId;
      if (!rowOffice) {
        toast.error("That case is no longer loaded — refresh and try again.");
        return false;
      }
      try {
        const result = await transitionCase(rowOffice, caseId, {
          status,
          lostReason,
          ...(note !== undefined ? { note } : {}),
        });
        mergeCase(result.case);
        toast.success(`${result.case.patientName} moved to ${caseStatusLabel(status)}`);
        return true;
      } catch (err) {
        toast.error(tcErrorMessage(err));
        return false;
      }
    },
    [cases, mergeCase],
  );

  const openCase = useCallback(
    (caseId: string) => navigate(`/tc/cases/${caseId}`),
    [navigate],
  );

  // Search + category apply to both views; the status filter is list-only.
  const filteredCases = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cases.filter((row) => {
      if (q !== "" && !row.patientName.toLowerCase().includes(q)) return false;
      if (categoryFilter !== "all" && row.category !== categoryFilter) return false;
      return true;
    });
  }, [cases, search, categoryFilter]);

  const listCasesFiltered = useMemo(
    () =>
      statusFilter === "all"
        ? filteredCases
        : filteredCases.filter((row) => row.status === statusFilter),
    [filteredCases, statusFilter],
  );

  return (
    <div className="p-6">
      <TcPageHeader
        title="Pipeline"
        subtitle="Track every case from diagnosis to scheduled"
        actions={<NewCaseButton writeOffice={writeOffice} onClick={() => setNewCaseOpen(true)} />}
      />

      {notice && <div className="mb-4"><TcPartialDataNotice message={notice} /></div>}

      <Tabs value={view} onValueChange={(v) => setView(v as "board" | "list")}>
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <TabsList>
            <TabsTrigger value="board" className="gap-1.5">
              <LayoutGrid className="w-3.5 h-3.5" />
              Board
            </TabsTrigger>
            <TabsTrigger value="list" className="gap-1.5">
              <List className="w-3.5 h-3.5" />
              List
            </TabsTrigger>
          </TabsList>

          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search patients…"
              className="pl-8 w-56"
            />
          </div>

          <Select
            value={categoryFilter}
            onValueChange={(v) => setCategoryFilter(v as CaseCategoryId | "all")}
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {CaseCategory.options.map((c) => (
                <SelectItem key={c} value={c}>{CASE_CATEGORY_LABELS[c]}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {view === "list" && (
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as CaseStatusId | "all")}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {ALL_CASE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{caseStatusLabel(s)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {loading ? (
          <PipelineSkeleton />
        ) : cases.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
            <ClipboardList size={32} className="text-muted-foreground" />
            <div>
              <h2 className="text-base font-semibold text-foreground">No cases yet</h2>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                Cases land here from the hygiene inbox or can be started by hand.
              </p>
            </div>
            <NewCaseButton writeOffice={writeOffice} onClick={() => setNewCaseOpen(true)} />
          </div>
        ) : (
          <>
            <TabsContent value="board">
              <PipelineBoard
                cases={filteredCases}
                onOpen={openCase}
                onTransition={handleTransition}
                showOfficeBadges={showOfficeBadges}
              />
            </TabsContent>
            <TabsContent value="list">
              <CaseListTable
                cases={listCasesFiltered}
                onOpen={openCase}
                showOfficeBadges={showOfficeBadges}
              />
            </TabsContent>
          </>
        )}
      </Tabs>

      {writeOffice && (
        <NewCaseDialog
          office={writeOffice}
          open={newCaseOpen}
          onOpenChange={setNewCaseOpen}
          onCreated={(created) => openCase(created.caseId)}
        />
      )}
    </div>
  );
}

/**
 * Creating a case is a write, so it needs one unambiguous office. On the
 * all-offices view the button stays visible but disabled with an honest
 * "pick an office" prompt rather than silently guessing a location.
 */
function NewCaseButton({
  writeOffice,
  onClick,
}: {
  writeOffice: OfficeId | null;
  onClick: () => void;
}) {
  if (!writeOffice) {
    return (
      <Button
        disabled
        className="gap-1.5"
        title="Pick a single office to add a case"
        aria-label="New Case — pick a single office first"
      >
        <Plus className="w-4 h-4" />
        New Case — pick an office
      </Button>
    );
  }
  return (
    <Button onClick={onClick} className="gap-1.5">
      <Plus className="w-4 h-4" />
      New Case
    </Button>
  );
}

function PipelineSkeleton() {
  return (
    <div className="flex gap-4 overflow-hidden">
      {[0, 1, 2, 3, 4].map((col) => (
        <div key={col} className="w-[270px] shrink-0 space-y-3">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      ))}
    </div>
  );
}
