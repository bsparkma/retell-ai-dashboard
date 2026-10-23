/**
 * The TC Checkout switch, per office (queue item 50).
 *
 * Mirrors the Hygiene panel's honesty rules: the state shown is what the
 * server answered after the write (never the click), the layer that answered
 * is named, and an env break-glass that is overriding the switch is said out
 * loud. Turning an office ON asks for confirmation; turning it OFF does not —
 * the fast path is the safe one.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, DoorOpen, Loader2, ShieldAlert } from "lucide-react";

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
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import type { TcCheckoutOfficeSwitch, TcCheckoutSwitchState } from "@/lib/api";

const OFFICE_LABELS: Record<string, string> = { roland: "Roland", valley: "Riley (valley)" };

const SOURCE_LABELS: Record<TcCheckoutOfficeSwitch["source"], string> = {
  db: "Set here",
  env: "Environment override",
  default: "Default (off)",
};

export function TcCheckoutPanel() {
  const [state, setState] = useState<TcCheckoutSwitchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setState(await api.getTcCheckoutOffices());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the checkout switch");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const commit = async (office: string, enabled: boolean) => {
    setSaving(office);
    try {
      const next = await api.setTcCheckoutOfficeEnabled(office, enabled);
      setState(next);
      const now = next.offices.find((o) => o.office === office);
      toast.success(`Checkout ${now?.enabled ? "on" : "off"} for ${OFFICE_LABELS[office] ?? office}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the checkout switch");
      await load();
    } finally {
      setSaving(null);
    }
  };

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-700 dark:text-red-300 flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </span>
        <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  return (
    <section className="space-y-4" data-testid="tc-checkout-panel">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <DoorOpen className="w-4 h-4" /> TC Checkout
        </h2>
        <p className="text-sm text-muted-foreground">
          When on, the hygiene visit can alert checkout, the visit&apos;s Send updates it, and the TC
          Checkout page shows today&apos;s patients. Per office. The TC module must also be bought.
        </p>
      </div>
      {state.controlPlaneError && (
        <p className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
          <ShieldAlert className="w-4 h-4" /> The control plane could not be read just now; what you see may be stale.
        </p>
      )}
      <div className="divide-y divide-border rounded-xl border border-border">
        {state.offices.map((o) => (
          <div key={o.office} className="flex items-center justify-between gap-3 p-3" data-testid={`tc-checkout-office-${o.office}`}>
            <div>
              <p className="font-medium text-foreground">{OFFICE_LABELS[o.office] ?? o.office}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{SOURCE_LABELS[o.source]}</Badge>
                {o.source === "env" && !o.enabled && (
                  <span className="text-amber-700 dark:text-amber-300">
                    {o.envVar}=false is forcing this office OFF; this switch cannot override it.
                  </span>
                )}
                {o.source === "env" && o.enabled && (
                  <span className="text-amber-700 dark:text-amber-300">
                    On through the {o.envVar}=true fallback — nobody has chosen here yet.
                  </span>
                )}
                {o.updatedBy && <span>Last changed by {o.updatedBy}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {saving === o.office && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
              <Switch
                checked={o.enabled}
                disabled={saving !== null}
                aria-label={`Checkout for ${OFFICE_LABELS[o.office] ?? o.office}`}
                onCheckedChange={(on) => (on ? setConfirming(o.office) : void commit(o.office, false))}
                data-testid={`tc-checkout-switch-${o.office}`}
              />
            </div>
          </div>
        ))}
      </div>

      <Dialog open={confirming !== null} onOpenChange={(open) => (open ? undefined : setConfirming(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn checkout on for {confirming ? OFFICE_LABELS[confirming] ?? confirming : ""}?</DialogTitle>
            <DialogDescription>
              Every hygiene visit Send in this office will hand the patient to the TC Checkout page.
              It writes nothing to Open Dental. You can turn it off again at any time, instantly.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button
              onClick={() => {
                const office = confirming;
                setConfirming(null);
                if (office) void commit(office, true);
              }}
              data-testid="tc-checkout-confirm-on"
            >
              Turn on
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
