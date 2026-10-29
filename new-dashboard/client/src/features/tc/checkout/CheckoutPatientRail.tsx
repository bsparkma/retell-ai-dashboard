/**
 * The workup view's patient rail (CO-1 polish): the Checkout list, condensed,
 * in a narrow column beside the workup so the front desk can move from one
 * patient to the next without going back to the list.
 *
 * Same rows and the same Waiting / Done today filters as the Checkout page,
 * read through the same `useCheckoutList` — no fetch of its own. A card shows
 * who, when, the priority and how far the workup has got; Claim and Dismiss
 * stay on the Checkout page and in the workup itself. The patient on screen is
 * highlighted. Choosing another patient is the parent's call (`onSelect`),
 * which is what holds the switch until an in-flight save has finished.
 */
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { OfficeBadge } from "@/features/tc/components/OfficeBadge";
import { PriorityChip, checkoutClock } from "@/features/tc/checkout/CheckoutSidebar";
import { CHECKOUT_TABS, type CheckoutList } from "@/features/tc/checkout/useCheckoutList";
import {
  TC_CHECKOUT_STATUS_LABELS,
  TC_CHECKOUT_WAITING,
  checkoutWorkupProgress,
  checkoutWorkupProgressLabel,
  type TcCheckoutHandoff,
} from "@shared/tc/checkout";

function RailCard({
  row,
  current,
  showOfficeBadges,
  onSelect,
}: {
  row: TcCheckoutHandoff;
  current: boolean;
  showOfficeBadges: boolean;
  onSelect: () => void;
}) {
  const waiting = TC_CHECKOUT_WAITING.includes(row.status);
  const progress = checkoutWorkupProgress(row);
  return (
    <button
      type="button"
      className={`w-full text-left rounded-lg border px-2.5 py-2 transition-colors ${
        current ? "border-primary bg-primary/10 ring-1 ring-primary" : "border-border bg-card hover:bg-accent/40"
      }`}
      aria-current={current ? "page" : undefined}
      onClick={onSelect}
      data-testid="workup-rail-row"
      data-handoff-id={row.handoffId}
    >
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="truncate text-sm font-semibold text-foreground">{row.patientName}</span>
        {showOfficeBadges && <OfficeBadge officeId={row.officeId} />}
        <PriorityChip priority={row.snapshot.priority} />
      </span>
      <span className="mt-0.5 block text-xs text-muted-foreground">
        {checkoutClock(row.createdAt)}
        {waiting ? ` · ${checkoutWorkupProgressLabel(progress)}` : ` · ${TC_CHECKOUT_STATUS_LABELS[row.status]}`}
      </span>
    </button>
  );
}

export function CheckoutPatientRail({
  list,
  currentId,
  showOfficeBadges,
  onSelect,
}: {
  list: CheckoutList;
  currentId: string;
  showOfficeBadges: boolean;
  onSelect: (row: TcCheckoutHandoff) => void;
}) {
  const { tab, setTab, rows, loading, error, load } = list;
  return (
    <nav aria-label="Checkout patients" className="space-y-2" data-testid="workup-rail">
      <div className="flex items-center gap-1" role="tablist">
        {CHECKOUT_TABS.map((t) => (
          <Button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            size="sm"
            variant={tab === t.id ? "default" : "outline"}
            className="h-7 px-2 text-xs"
            onClick={() => setTab(t.id)}
            data-testid={`workup-rail-tab-${t.id}`}
          >
            {t.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 w-7 p-0"
          aria-label="Check again"
          onClick={() => void load()}
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
      </div>
      {loading ? (
        <div className="flex justify-center py-6 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      ) : error ? (
        <div className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-2 text-xs text-red-700 dark:text-red-300 space-y-1.5" data-testid="workup-rail-error">
          <p className="flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
          </p>
          <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => void load()}>Retry</Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground" data-testid="workup-rail-empty">
          {tab === "waiting" ? "No one waiting at checkout." : "No checkouts answered yet today."}
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <RailCard
              key={r.handoffId}
              row={r}
              current={r.handoffId === currentId}
              showOfficeBadges={showOfficeBadges}
              onSelect={() => onSelect(r)}
            />
          ))}
        </div>
      )}
    </nav>
  );
}
