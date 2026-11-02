/**
 * "Add patient" on the Checkout page (CO-5a): put someone on today's Checkout
 * whom no hygiene visit sent — a doctor-only visit, a walk-in.
 *
 * The picker is the referrals hub's manual start, reused as is: OdPatientSearch
 * over odAttachSearch, the read-only, per-office Open Dental search. Picking a
 * patient asks the server for a card; the server re-reads the patient from that
 * office's Open Dental and either makes the card or, when the patient already
 * has one today, answers with that one — and either way the workup opens on it.
 * The one-card-per-patient-per-day rule is the server's, never this dialog's.
 *
 * tc.full only. The button is drawn only once /auth/me says so (UX); the route
 * is gated tc.full regardless.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Loader2, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import { can } from "@/lib/permissions";
import { odAttachSearch, tcErrorMessage, type OdPatient } from "@/features/tc/api";
import { OdPatientSearch } from "@/features/tc/od/OdShell";
import { tcOfficeLabel } from "@/features/tc/officeScope";
import type { OfficeId } from "@shared/tc/contract";
import type { TcCheckoutHandoff } from "@shared/tc/checkout";

import { addCheckoutPatient } from "./checkoutApi";
import { checkoutWorkupHref } from "./CheckoutSidebar";

/** Does the signed-in user hold tc.full? False until /auth/me has answered. Pure over the auth state. */
export function useCanAddCheckoutPatient(): boolean {
  const auth = useAuth();
  if (auth.status !== "authenticated") return false;
  return auth.user.isSuperAdmin === true || can(auth.user.permissions, "tc.full");
}

export function AddCheckoutPatient({
  offices,
  onAdded,
}: {
  /** The offices with checkout switched on, in scope. One → no office choice. */
  offices: OfficeId[];
  /** The card the server answered with (new or existing), before the workup opens. */
  onAdded?: (handoff: TcCheckoutHandoff, created: boolean) => void;
}) {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [office, setOffice] = useState<OfficeId | null>(null);
  const [saving, setSaving] = useState(false);
  const chosen = office && offices.includes(office) ? office : (offices[0] ?? null);

  if (offices.length === 0) return null;

  async function pick(patient: OdPatient) {
    if (!chosen || saving) return;
    setSaving(true);
    try {
      const { created, handoff } = await addCheckoutPatient(chosen, patient.patNum);
      if (created) toast.success(`${handoff.patientName} added to today's Checkout`);
      else toast.info(`${handoff.patientName} is already on today's Checkout. Opening their card.`);
      setOpen(false);
      onAdded?.(handoff, created);
      navigate(checkoutWorkupHref(handoff.officeId, handoff.handoffId));
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button size="sm" className="gap-1.5" onClick={() => setOpen(true)} data-testid="checkout-add-patient">
        <UserPlus className="w-4 h-4" /> Add patient
      </Button>
      <Dialog open={open} onOpenChange={(o) => (saving ? undefined : setOpen(o))}>
        <DialogContent className="max-w-lg" data-testid="checkout-add-patient-dialog">
          <DialogHeader>
            <DialogTitle>Add a patient to today&apos;s Checkout</DialogTitle>
            <DialogDescription>
              For a patient no hygiene visit sent. Find them in this office&apos;s Open Dental; names match by how
              they start, so check the date of birth. A patient already on today&apos;s Checkout opens their card.
            </DialogDescription>
          </DialogHeader>
          {offices.length > 1 && (
            <div className="flex items-center gap-2" role="radiogroup" aria-label="Office">
              {offices.map((o) => (
                <Button
                  key={o}
                  size="sm"
                  role="radio"
                  aria-checked={chosen === o}
                  variant={chosen === o ? "default" : "outline"}
                  onClick={() => setOffice(o)}
                  disabled={saving}
                  data-testid={`checkout-add-office-${o}`}
                >
                  {tcOfficeLabel(o)}
                </Button>
              ))}
            </div>
          )}
          {chosen && (
            <OdPatientSearch
              key={chosen}
              office={chosen}
              search={odAttachSearch}
              onSelect={(p) => void pick(p)}
              label="Patient"
              autoFocus
            />
          )}
          {saving && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="checkout-add-saving">
              <Loader2 className="w-4 h-4 animate-spin" /> Adding to today&apos;s Checkout…
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
