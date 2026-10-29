/**
 * /tc/checkout/:id?office= — one checkout's full-screen workup view (CO-1).
 *
 * LINKABLE: the handoff id is in the path and the office in the query, so the
 * address can be pasted into another tab. Back returns to the Checkout list.
 * The office must be one the signed-in user's scope includes; the SERVER is
 * what decides the record belongs to it (another office's id is a 404 there).
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearch } from "wouter";
import { AlertTriangle, ArrowLeft, DoorOpen, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TcOfficeGate } from "@/features/tc/components/TcShell";
import { TcApiError, tcErrorMessage } from "@/features/tc/api";
import { useTcOfficeScope } from "@/features/tc/officeScope";
import { getCheckoutHandoff } from "@/features/tc/checkout/checkoutApi";
import { CheckoutWorkup } from "@/features/tc/checkout/CheckoutWorkup";
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
}: {
  office: OfficeIdT;
  handoffId: string;
  showOfficeBadge: boolean;
}) {
  const [handoff, setHandoff] = useState<TcCheckoutHandoff | null>(null);
  const [error, setError] = useState<{ message: string; off: boolean } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setHandoff(await getCheckoutHandoff(office, handoffId));
    } catch (e) {
      setError({ message: tcErrorMessage(e), off: e instanceof TcApiError && e.code === "CHECKOUT_DISABLED" });
    }
  }, [office, handoffId]);

  useEffect(() => {
    setHandoff(null);
    void load();
  }, [load]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
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
        <CheckoutWorkup office={office} handoff={handoff} showOfficeBadge={showOfficeBadge} onChange={setHandoff} onReload={load} />
      )}
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
  return <CheckoutWorkupScreen key={`${office.data}:${id}`} office={office.data} handoffId={id} showOfficeBadge={scope.showOfficeBadges} />;
}
