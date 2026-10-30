/**
 * Checkout — today's patients the hygiene visit sent to the front desk
 * (queue item 50).
 *
 * Newest first. Claim ("I've got this patient") and Dismiss (a reason is
 * required) work the way the Opportunities inbox does. A row opens the
 * full-screen WORKUP view (/tc/checkout/:id, CO-1), where the front desk works
 * the patient and records Scheduled / Not scheduled / Nothing needed; each
 * waiting card says how far that workup has got ("2 of 4 sections done").
 * "Quick look" — and the arrival toast, which links here with `?handoff=` —
 * opens the patient SIDEBAR instead, the same exit in a narrow sheet. An
 * answered checkout leaves the Waiting tab and shows under Done today.
 *
 * "Add patient" (CO-5a, tc.full) puts someone no hygiene visit sent on today's
 * list by hand, through the referrals hub's Open Dental patient search; a
 * patient who already has a card today gets that card opened instead.
 *
 * Yesterday's unanswered checkouts close themselves as Expired on the server;
 * they never show here.
 *
 * DARK: an office with checkout switched off answers CHECKOUT_DISABLED, which
 * this page reads as "not on here" — never as an error.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { toast } from "sonner";
import { AlertTriangle, DoorOpen, Eye, Hand, Loader2, RefreshCw, X } from "lucide-react";

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
import { tcErrorMessage } from "@/features/tc/api";
import { officeScopeKey, useTcOfficeScope } from "@/features/tc/officeScope";
import { claimCheckout, dismissCheckout } from "@/features/tc/checkout/checkoutApi";
import { CHECKOUT_TABS, useCheckoutList } from "@/features/tc/checkout/useCheckoutList";
import { AddCheckoutPatient, useCanAddCheckoutPatient } from "@/features/tc/checkout/AddCheckoutPatient";
import {
  CheckoutSidebar,
  PriorityChip,
  checkoutClock,
  checkoutWorkupHref,
} from "@/features/tc/checkout/CheckoutSidebar";
import {
  TC_CHECKOUT_STATUS_LABELS,
  checkoutHasHygieneData,
  checkoutWorkupProgress,
  checkoutWorkupProgressLabel,
  type TcCheckoutHandoff,
} from "@shared/tc/checkout";
import type { OfficeId } from "@shared/tc/contract";

function DismissDialog({
  row,
  onClose,
  onDismissed,
}: {
  row: TcCheckoutHandoff | null;
  onClose: () => void;
  onDismissed: (h: TcCheckoutHandoff) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setReason(""), [row]);
  const submit = async () => {
    if (!row) return;
    setBusy(true);
    try {
      onDismissed(await dismissCheckout(row.officeId, row.handoffId, reason.trim()));
      toast.success("Checkout dismissed");
      onClose();
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={row !== null} onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dismiss this checkout?</DialogTitle>
          <DialogDescription>
            Use this when it is not a checkout after all. Say why — it stays with the record.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Doctor saw the patient instead"
          data-testid="checkout-dismiss-reason"
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || reason.trim().length === 0} onClick={() => void submit()} data-testid="checkout-dismiss-confirm">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Dismiss"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  row,
  showOfficeBadges,
  busy,
  onOpen,
  onQuickLook,
  onClaim,
  onDismiss,
}: {
  row: TcCheckoutHandoff;
  showOfficeBadges: boolean;
  busy: boolean;
  onOpen: () => void;
  onQuickLook: () => void;
  onClaim: () => void;
  onDismiss: () => void;
}) {
  const waiting = row.status === "open" || row.status === "claimed";
  const count = row.snapshot.procedures.length;
  const progress = checkoutWorkupProgress(row);
  const hygieneData = checkoutHasHygieneData(row);
  return (
    <div
      className="rounded-xl border border-border bg-card p-3 flex flex-wrap items-center gap-3 cursor-pointer hover:bg-accent/30"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      data-testid="checkout-row"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-foreground">{row.patientName}</span>
          {showOfficeBadges && <OfficeBadge officeId={row.officeId} />}
          {row.source === "manual" && (
            <Badge variant="outline" data-testid="checkout-row-manual">Added by hand</Badge>
          )}
          <PriorityChip priority={row.snapshot.priority} />
          {row.snapshot.notesPending && <Badge variant="outline">Notes pending</Badge>}
          {!waiting || row.status === "claimed" ? (
            <Badge variant="outline">
              {TC_CHECKOUT_STATUS_LABELS[row.status]}
              {row.status === "claimed" && row.claimedBy ? ` · ${row.claimedBy}` : ""}
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {checkoutClock(row.createdAt)} ·{" "}
          {!hygieneData
            ? "no hygiene visit data"
            : count === 0
              ? "nothing staged"
              : `${count} ${count === 1 ? "item" : "items"} staged`}
          {row.providerSeen ? ` · ${row.providerSeen}` : ""}
        </p>
        {waiting && (
          <p
            className={`text-xs font-medium mt-1 ${progress.done === progress.total ? "text-emerald-700 dark:text-emerald-300" : "text-foreground"}`}
            data-testid="checkout-row-progress"
          >
            {checkoutWorkupProgressLabel(progress)}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="ghost" className="gap-1.5" onClick={onQuickLook} data-testid="checkout-row-quicklook">
          <Eye className="w-3.5 h-3.5" /> Quick look
        </Button>
      </div>
      {waiting && (
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {row.status === "open" && (
            <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={onClaim} data-testid="checkout-row-claim">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Hand className="w-3.5 h-3.5" />}
              Claim
            </Button>
          )}
          <Button size="sm" variant="ghost" className="gap-1.5" disabled={busy} onClick={onDismiss} data-testid="checkout-row-dismiss">
            <X className="w-3.5 h-3.5" /> Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

export function CheckoutInbox({ offices, showOfficeBadges }: { offices: OfficeId[]; showOfficeBadges: boolean }) {
  const search = useSearch();
  const [, navigate] = useLocation();
  const query = useMemo(() => new URLSearchParams(search), [search]);
  const { tab, setTab, rows, loading, error, notice, enabledOffices, load, replace } = useCheckoutList(offices);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<TcCheckoutHandoff | null>(null);
  const [opened, setOpened] = useState<{ office: OfficeId; handoffId: string } | null>(null);
  const canAdd = useCanAddCheckoutPatient();

  // The arrival toast links here with ?handoff=&office= — open the same sidebar.
  useEffect(() => {
    const handoffId = query.get("handoff");
    const office = query.get("office");
    if (handoffId && (office === "roland" || office === "valley") && offices.includes(office)) {
      setOpened({ office, handoffId });
    }
  }, [query, offices]);

  const claim = async (row: TcCheckoutHandoff) => {
    setBusyId(row.handoffId);
    try {
      replace(await claimCheckout(row.officeId, row.handoffId));
    } catch (e) {
      toast.error(tcErrorMessage(e));
      await load();
    } finally {
      setBusyId(null);
    }
  };

  if (!loading && enabledOffices !== null && enabledOffices.length === 0 && !error) {
    return (
      <div className="flex flex-col items-center justify-center text-center py-20 gap-3 text-muted-foreground" data-testid="checkout-off">
        <DoorOpen className="w-10 h-10 opacity-30" />
        <p className="text-sm">Checkout isn&apos;t switched on for this office yet.</p>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2 mb-4" role="tablist">
        {CHECKOUT_TABS.map((t) => (
          <Button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            size="sm"
            variant={tab === t.id ? "default" : "outline"}
            onClick={() => setTab(t.id)}
            data-testid={`checkout-tab-${t.id}`}
          >
            {t.label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" className="ml-auto gap-1.5 text-xs" onClick={() => void load()}>
          <RefreshCw className="w-3.5 h-3.5" /> Check again
        </Button>
        {canAdd && enabledOffices && enabledOffices.length > 0 && <AddCheckoutPatient offices={enabledOffices} />}
      </div>

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
          <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-20 gap-3 text-muted-foreground" data-testid="checkout-empty">
          <DoorOpen className="w-10 h-10 opacity-30" />
          <p className="text-sm">{tab === "waiting" ? "No one waiting at checkout." : "No checkouts answered yet today."}</p>
        </div>
      ) : (
        <div className="space-y-2" data-testid="checkout-list">
          {rows.map((r) => (
            <Row
              key={r.handoffId}
              row={r}
              showOfficeBadges={showOfficeBadges}
              busy={busyId === r.handoffId}
              onOpen={() => navigate(checkoutWorkupHref(r.officeId, r.handoffId))}
              onQuickLook={() => setOpened({ office: r.officeId, handoffId: r.handoffId })}
              onClaim={() => void claim(r)}
              onDismiss={() => setDismissing(r)}
            />
          ))}
        </div>
      )}

      <DismissDialog row={dismissing} onClose={() => setDismissing(null)} onDismissed={replace} />
      <CheckoutSidebar
        office={opened?.office ?? null}
        handoffId={opened?.handoffId ?? null}
        showOfficeBadge={showOfficeBadges}
        onClose={() => setOpened(null)}
        onChanged={replace}
      />
    </>
  );
}

export default function TcCheckout() {
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
      <TcPageHeader title="Checkout" subtitle="Patients at the front desk today: sent by the hygiene visit, or added by hand" />
      <CheckoutInbox key={officeScopeKey(scope.offices)} offices={scope.offices} showOfficeBadges={scope.showOfficeBadges} />
    </div>
  );
}
