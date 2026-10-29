/**
 * The Checkout list's data: one office-fanned `listCheckout` per tab, newest
 * first. Shared by the Checkout page and the workup view's patient rail
 * (CO-1 polish) so both read the list the same way — one fetch pattern, not
 * two.
 *
 * An office with checkout switched off answers CHECKOUT_DISABLED; that office
 * drops out of `enabledOffices` rather than reading as a failed load.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { TcApiError } from "@/features/tc/api";
import { fanOutOfficeValues } from "@/features/tc/officeScope";
import { listCheckout, type CheckoutView } from "@/features/tc/checkout/checkoutApi";
import type { TcCheckoutHandoff } from "@shared/tc/checkout";
import type { OfficeId } from "@shared/tc/contract";

/** The list's filters: the Checkout page's tabs, and the workup rail's. */
export const CHECKOUT_TABS: { id: CheckoutView; label: string }[] = [
  { id: "waiting", label: "Waiting" },
  { id: "done", label: "Done today" },
];

export interface CheckoutList {
  tab: CheckoutView;
  setTab: (tab: CheckoutView) => void;
  rows: TcCheckoutHandoff[];
  loading: boolean;
  error: string | null;
  notice: string | null;
  enabledOffices: OfficeId[] | null;
  load: () => Promise<void>;
  /** Put the server's read-back of one checkout in place (or drop it if it left this tab). */
  replace: (next: TcCheckoutHandoff) => void;
}

export function useCheckoutList(offices: OfficeId[]): CheckoutList {
  const [tab, setTab] = useState<CheckoutView>("waiting");
  const [rows, setRows] = useState<TcCheckoutHandoff[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [enabledOffices, setEnabledOffices] = useState<OfficeId[] | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    const res = await fanOutOfficeValues(offices, async (office) => {
      try {
        return (await listCheckout(office, tab)).handoffs;
      } catch (e) {
        // Off for this office is a fact about the office, not a failed load.
        if (e instanceof TcApiError && e.code === "CHECKOUT_DISABLED") return null;
        throw e;
      }
    });
    if (seq !== loadSeq.current) return;
    const on = res.values.filter((v) => v.value !== null);
    setEnabledOffices(on.map((v) => v.officeId));
    setRows(
      on
        .flatMap((v) => v.value ?? [])
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
    if (res.failed) setError(res.errors[0]?.message ?? "The checkout list could not be loaded.");
    else setNotice(res.partial ? `Some offices could not be loaded: ${res.errors.map((e) => e.officeId).join(", ")}` : null);
    setLoading(false);
  }, [offices, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = useCallback(
    (next: TcCheckoutHandoff) => {
      setRows((prev) => {
        const stillHere = tab === "waiting" ? next.status === "open" || next.status === "claimed" : !(next.status === "open" || next.status === "claimed");
        const without = prev.filter((r) => r.handoffId !== next.handoffId);
        if (!stillHere) return without;
        return prev.some((r) => r.handoffId === next.handoffId)
          ? prev.map((r) => (r.handoffId === next.handoffId ? next : r))
          : [next, ...without];
      });
    },
    [tab],
  );

  return { tab, setTab, rows, loading, error, notice, enabledOffices, load, replace };
}
