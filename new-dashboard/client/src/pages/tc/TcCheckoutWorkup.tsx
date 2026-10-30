/**
 * /tc/checkout/:id?office= — one checkout's full-screen workup view (CO-1).
 *
 * LINKABLE: the handoff id is in the path and the office in the query, so the
 * address can be pasted into another tab. Back returns to the Checkout list.
 *
 * MASTER-DETAIL (CO-1 polish): the Checkout list stays beside the workup as a
 * narrow rail. Choosing another patient there swaps the workup in place and
 * updates the address; if a checklist tick is still saving, the switch waits
 * for it to finish (the workup's one-save-at-a-time guard reports busy). On a
 * narrow screen the rail folds behind a "Patients" toggle so the workup keeps
 * the screen.
 * The office must be one the signed-in user's scope includes; the SERVER is
 * what decides the record belongs to it (another office's id is a 404 there).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { AlertTriangle, ArrowLeft, DoorOpen, Loader2, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TcOfficeGate } from "@/features/tc/components/TcShell";
import { TcApiError, tcErrorMessage } from "@/features/tc/api";
import { officeScopeKey, useTcOfficeScope } from "@/features/tc/officeScope";
import { getCheckoutHandoff } from "@/features/tc/checkout/checkoutApi";
import { CheckoutWorkup } from "@/features/tc/checkout/CheckoutWorkup";
import { CheckoutPatientRail } from "@/features/tc/checkout/CheckoutPatientRail";
import { checkoutWorkupHref } from "@/features/tc/checkout/CheckoutSidebar";
import { useCheckoutList } from "@/features/tc/checkout/useCheckoutList";
import { OfficeId, type OfficeId as OfficeIdT } from "@shared/tc/contract";
import type { TcCheckoutHandoff } from "@shared/tc/checkout";

function BackLink() {
  return (
    <Link href="/tc/checkout" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" data-testid="workup-back">
      <ArrowLeft className="w-4 h-4" /> Back to Checkout
    </Link>
  );
}

export function CheckoutWorkupScreen({
  office,
  handoffId,
  showOfficeBadge,
  onChanged,
  onBusyChange,
}: {
  office: OfficeIdT;
  handoffId: string;
  showOfficeBadge: boolean;
  /** Every read-back of this checkout, so the rail's card keeps up. */
  onChanged?: (next: TcCheckoutHandoff) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [handoff, setHandoff] = useState<TcCheckoutHandoff | null>(null);
  // A ref, not a dependency: the rail's callback changes with its tab, and that
  // must not refetch the workup on screen.
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const adopt = useCallback((next: TcCheckoutHandoff) => {
    setHandoff(next);
    changed.current?.(next);
  }, []);
  const [error, setError] = useState<{ message: string; off: boolean } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      adopt(await getCheckoutHandoff(office, handoffId));
    } catch (e) {
      setError({ message: tcErrorMessage(e), off: e instanceof TcApiError && e.code === "CHECKOUT_DISABLED" });
    }
  }, [office, handoffId, adopt]);

  useEffect(() => {
    setHandoff(null);
    void load();
  }, [load]);

  return (
    <div className="min-w-0 flex-1 max-w-5xl space-y-4">
      <BackLink />
      {error ? (
        error.off ? (
          <div className="flex flex-col items-center justify-center text-center py-20 gap-3 text-muted-foreground" data-testid="workup-off">
            <DoorOpen className="w-10 h-10 opacity-30" />
            <p className="text-sm">Checkout isn&apos;t switched on for this office yet.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-700 dark:text-red-300 flex items-center justify-between gap-3" data-testid="workup-error">
            <span className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" /> {error.message}
            </span>
            <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
          </div>
        )
      ) : !handoff ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : (
        <CheckoutWorkup office={office} handoff={handoff} showOfficeBadge={showOfficeBadge} onChange={adopt} onReload={load} onBusyChange={onBusyChange} />
      )}
    </div>
  );
}

/**
 * The rail and the workup side by side. The rail's list outlives a switch (it
 * is not keyed by patient); the workup screen is, so its state — including
 * which "Not discussed" groups are open — belongs to the patient on screen.
 */
export function CheckoutWorkupLayout({
  offices,
  office,
  handoffId,
  showOfficeBadges,
}: {
  offices: OfficeIdT[];
  office: OfficeIdT;
  handoffId: string;
  showOfficeBadges: boolean;
}) {
  const [, navigate] = useLocation();
  const list = useCheckoutList(offices);
  const [railOpen, setRailOpen] = useState(false);
  const busy = useRef(false);
  const pending = useRef<string | null>(null);

  const go = (href: string) => {
    if (busy.current) pending.current = href;
    else navigate(href);
  };
  const onBusyChange = useCallback(
    (b: boolean) => {
      busy.current = b;
      if (!b && pending.current) {
        const href = pending.current;
        pending.current = null;
        navigate(href);
      }
    },
    [navigate],
  );

  return (
    <div className="p-4 sm:p-6 flex flex-col lg:flex-row gap-4 lg:gap-6">
      <aside className="lg:w-72 lg:shrink-0 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 lg:hidden"
          aria-expanded={railOpen}
          aria-controls="workup-rail-panel"
          onClick={() => setRailOpen((o) => !o)}
          data-testid="workup-rail-toggle"
        >
          <Users className="w-4 h-4" /> Patients ({list.rows.length})
        </Button>
        <div id="workup-rail-panel" className={`${railOpen ? "mt-2" : "hidden"} lg:mt-0 lg:block`}>
          <CheckoutPatientRail
            list={list}
            currentId={handoffId}
            showOfficeBadges={showOfficeBadges}
            onSelect={(row) => {
              setRailOpen(false);
              if (row.handoffId !== handoffId) go(checkoutWorkupHref(row.officeId, row.handoffId));
            }}
          />
        </div>
      </aside>
      <CheckoutWorkupScreen
        key={`${office}:${handoffId}`}
        office={office}
        handoffId={handoffId}
        showOfficeBadge={showOfficeBadges}
        onChanged={list.replace}
        onBusyChange={onBusyChange}
      />
    </div>
  );
}

export default function TcCheckoutWorkup() {
  const { id } = useParams<{ id: string }>();
  const search = useSearch();
  const scope = useTcOfficeScope();
  const office = OfficeId.safeParse(new URLSearchParams(search).get("office"));

  if (scope.offices.length === 0) {
    return (
      <div className="p-6">
        <TcOfficeGate loading={scope.loading} />
      </div>
    );
  }
  if (!office.success || !scope.offices.includes(office.data)) {
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-4">
        <BackLink />
        <p className="text-sm text-muted-foreground" data-testid="workup-wrong-office">
          This checkout is not in the office you are looking at. Switch offices, or go back to the Checkout list.
        </p>
      </div>
    );
  }
  return (
    <CheckoutWorkupLayout
      key={officeScopeKey(scope.offices)}
      offices={scope.offices}
      office={office.data}
      handoffId={id}
      showOfficeBadges={scope.showOfficeBadges}
    />
  );
}
