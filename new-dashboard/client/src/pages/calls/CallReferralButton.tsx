/**
 * "Start referral" on the call detail (queue item 54, R3) — beside Send to TC,
 * with the same producer shape: the server takes the patient (the stored
 * match) and the office (the call's) itself; the client sends only the
 * referral's own words plus an `office_id` ASSERTION that can only refuse.
 *
 * It creates a DRAFT; "Save & submit" asks the server to create AND submit it
 * in one transaction, so a failure never leaves a stray draft behind.
 * Shows the referrals already started from this call.
 *
 * Renders nothing unless: the practice has TC, this user may hand calls to TC
 * (voice.send_to_tc), the call has a matched patient and a known office, and
 * referrals is switched on for that office. Nothing is sent to a specialist;
 * no Open Dental write.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { api, ApiError } from "@/lib/api";
import { hasModule } from "@/lib/modules";
import { can } from "@/lib/permissions";
import { getReferralsStatus, listDirectory, listReferrals } from "@/features/tc/referrals/referralsApi";
import { ReferralDialog, ReferralStatusBadge } from "@/features/tc/referrals/ReferralsPanel";
import { TcReferral, type TcReferralInput } from "@shared/tc/referrals";
import type { OfficeId } from "@shared/tc/contract";

export interface CallReferralCall {
  id: string;
  odPatientId?: number | string | null;
  officeId?: string | null;
}

function officeOf(call: CallReferralCall): OfficeId | null {
  return call.officeId === "roland" || call.officeId === "valley" ? call.officeId : null;
}

export function CallReferralButton({ call }: { call: CallReferralCall }) {
  const auth = useAuth();
  const user = auth.status === "authenticated" ? auth.user : null;
  const office = officeOf(call);
  const matched = call.odPatientId !== null && call.odPatientId !== undefined && call.odPatientId !== "";
  const allowed =
    hasModule(user?.tenant?.modules, "tc") && can(user?.permissions, "voice.send_to_tc") && matched && office !== null;

  const [on, setOn] = useState(false);
  const [referrals, setReferrals] = useState<TcReferral[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    if (!allowed || !office) return;
    getReferralsStatus(office)
      .then(async (s) => {
        setOn(s.enabled);
        if (s.enabled) setReferrals(await listReferrals(office, { callId: call.id }));
      })
      .catch(() => setOn(false));
  }, [allowed, office, call.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(input: TcReferralInput, submit: boolean) {
    if (!office) return;
    setSaving(true);
    try {
      const res = await api.startCallReferral(call.id, { referral: input, office_id: office, submit });
      const parsed = TcReferral.safeParse(res.referral);
      if (!parsed.success) throw new Error("The referral answer could not be read");
      if (submit) {
        toast.success(
          parsed.data.status === "approved" ? "Referral approved (sign-off not required)" : "Sent for the doctor's sign-off",
        );
      } else {
        toast.success("Referral saved as a draft — finish it in TC");
      }
      setOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError || e instanceof Error ? e.message : "The referral was not started");
    } finally {
      setSaving(false);
    }
  }

  if (!allowed || !on || !office) return null;

  return (
    <div className="space-y-1.5" data-testid="call-referral">
      <Button variant="outline" size="sm" className="w-full gap-1.5 text-xs" onClick={() => setOpen(true)}>
        <Send size={12} /> Start referral
      </Button>
      {referrals.map((r) => (
        <div key={r.referralId} className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground" data-testid="call-referral-row">
          <span className="truncate">{r.practiceName ?? r.specialty ?? "Referral"}</span>
          <ReferralStatusBadge status={r.status} />
        </div>
      ))}
      <ReferralDialog
        open={open}
        editing={null}
        saving={saving}
        sourceLabel="this call's matched patient"
        loadDirectory={() => listDirectory(office, false)}
        onClose={() => setOpen(false)}
        onSave={(input, submit) => void save(input, submit)}
      />
    </div>
  );
}
