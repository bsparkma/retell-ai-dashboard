/**
 * TC case detail — /tc/cases/:id. Loads the full TcCase aggregate, shows the
 * command bar (identity + money + status) and the working tabs: Treatment,
 * Financing, Objections, Follow-Ups, Messages, Notes, Activity. All mutations live in
 * the tabs/dialogs; this page owns the single case state they update.
 * (Smile Sim lives in the Gallery area in this port, not here.)
 *
 * `?tab=messages` opens the Messages tab; `&draftFrom=<followupId>&channel=sms|email`
 * (the follow-up queue's "Draft message" action) seeds ONE draft from that
 * follow-up and then drops the params, so a reload cannot seed a second one.
 * `&pickTemplate=1` (item 40, the card's "Email template" action) opens the
 * email template picker for that follow-up instead of writing a draft.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import type { OfficeId, TcCase } from "@shared/tc/contract";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, ClipboardCheck, Presentation, SearchX } from "lucide-react";
import { getCase, TcApiError, tcErrorMessage } from "@/features/tc/api";
import { TcOfficeGate, useTcOffice } from "@/features/tc/components/TcShell";
import { ActivityTimeline } from "@/features/tc/caseview/ActivityTimeline";
import { CaseCommandBar } from "@/features/tc/caseview/CaseCommandBar";
import { FinancingTab } from "@/features/tc/caseview/FinancingTab";
import { FollowupsTab } from "@/features/tc/caseview/FollowupsTab";
import { MessagesTab, type MessagesTabSeed } from "@/features/tc/caseview/MessagesTab";
import { NotesTab } from "@/features/tc/caseview/NotesTab";
import { OrthoScreeningSection } from "@/features/tc/caseview/OrthoScreeningSection";
import { ObjectionsTab } from "@/features/tc/caseview/ObjectionsTab";
import { StatusTransitionDialog } from "@/features/tc/caseview/StatusTransitionDialog";
import { TreatmentTab } from "@/features/tc/caseview/TreatmentTab";

export default function TcCaseView() {
  const office = useTcOffice();
  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }
  return <CaseViewInner office={office} />;
}

function CaseViewInner({ office }: { office: OfficeId }) {
  const { id } = useParams<{ id: string }>();
  const caseId = id ?? "";

  const [tcCase, setTcCase] = useState<TcCase | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);

  // Deep link from the follow-up queue: ?tab=messages&draftFrom=<id>&channel=sms
  const search = useSearch();
  const [location, navigate] = useLocation();
  const linked = useMemo(() => {
    const p = new URLSearchParams(search);
    const tab = p.get("tab");
    const draftFrom = p.get("draftFrom");
    const channel = p.get("channel");
    const pickTemplate = p.get("pickTemplate") === "1";
    const seed: MessagesTabSeed | null =
      draftFrom && (channel === "sms" || channel === "email")
        ? { followupId: draftFrom, channel, ...(pickTemplate && channel === "email" ? { pickTemplate: true } : {}) }
        : null;
    return { tab: tab === "messages" || seed ? "messages" : null, seed };
  }, [search]);
  const [tab, setTab] = useState<string>(linked.tab ?? "treatment");
  const [seed, setSeed] = useState<MessagesTabSeed | null>(linked.seed);
  const consumeSeed = useCallback(() => {
    setSeed(null);
    navigate(location, { replace: true });
  }, [location, navigate]);

  const load = useCallback(() => {
    if (!caseId) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    setNotFound(false);
    setLoadError(null);
    getCase(office, caseId)
      .then((c) => setTcCase(c))
      .catch((e: unknown) => {
        if (e instanceof TcApiError && e.status === 404) setNotFound(true);
        else setLoadError(tcErrorMessage(e));
      })
      .finally(() => setLoading(false));
  }, [office, caseId]);

  useEffect(() => {
    load();
  }, [load]);

  /** Server re-fetch used after follow-up mutations so events stay true. */
  const refreshCase = useCallback(
    () => getCase(office, caseId).then((c) => setTcCase(c)),
    [office, caseId],
  );

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-9 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (notFound || (!tcCase && !loadError)) {
    return (
      <div className="p-6">
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
          <SearchX size={32} className="text-muted-foreground" />
          <h2 className="text-lg font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
            Case not found
          </h2>
          <p className="text-sm text-muted-foreground max-w-sm">
            This case doesn't exist for the selected office. It may belong to the
            other office, or the link is stale.
          </p>
          <Button asChild variant="outline">
            <Link href="/tc">
              <ArrowLeft size={14} />
              Back to cases
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  if (!tcCase) {
    return (
      <div className="p-6">
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
          <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
          <Button variant="outline" onClick={load}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Link
          href="/tc"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={14} />
          Back to cases
        </Link>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/tc/cases/${tcCase.caseId}/prep`}>
              <ClipboardCheck size={14} />
              Prep
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link href={`/tc/present/${tcCase.caseId}`}>
              <Presentation size={14} />
              Present Case
            </Link>
          </Button>
        </div>
      </div>

      <CaseCommandBar office={office} tcCase={tcCase} onChangeStatus={() => setStatusDialogOpen(true)} />

      <StatusTransitionDialog
        office={office}
        tcCase={tcCase}
        open={statusDialogOpen}
        onOpenChange={setStatusDialogOpen}
        onSuccess={setTcCase}
      />

      {/* What hygiene handed over (item 33). Renders nothing for a case without
          a screening. Item 22's hygiene treatment list belongs in this slot too. */}
      <OrthoScreeningSection tcCase={tcCase} />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="treatment">Treatment</TabsTrigger>
          <TabsTrigger value="financing">Financing</TabsTrigger>
          <TabsTrigger value="objections">Objections</TabsTrigger>
          <TabsTrigger value="followups">Follow-Ups</TabsTrigger>
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="treatment" className="pt-2">
          <TreatmentTab office={office} tcCase={tcCase} onCaseUpdate={setTcCase} />
        </TabsContent>
        <TabsContent value="financing" className="pt-2">
          <FinancingTab office={office} tcCase={tcCase} />
        </TabsContent>
        <TabsContent value="objections" className="pt-2">
          <ObjectionsTab office={office} tcCase={tcCase} onCaseUpdate={setTcCase} />
        </TabsContent>
        <TabsContent value="followups" className="pt-2">
          <FollowupsTab office={office} tcCase={tcCase} refreshCase={refreshCase} />
        </TabsContent>
        <TabsContent value="messages" className="pt-2">
          <MessagesTab office={office} tcCase={tcCase} seed={seed} onSeedConsumed={consumeSeed} />
        </TabsContent>
        <TabsContent value="notes" className="pt-2">
          <NotesTab office={office} tcCase={tcCase} onCaseUpdate={setTcCase} />
        </TabsContent>
        <TabsContent value="activity" className="pt-2">
          <ActivityTimeline events={tcCase.events} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
