/**
 * "Start referral" beside the visit's Note & treatment | Ortho screening
 * switcher (queue item 54, R3).
 *
 * The hygienist drafts the referral chairside — specialist, reason, teeth, how
 * soon, notes — and it goes straight to the doctor's sign-off (or to approved,
 * when this office does not require one). The PATIENT is the visit's: the
 * server takes office + PatNum + name from the stored visit; the form never
 * asks. Shows what this visit has already started, newest first.
 *
 * Renders nothing while referrals is off for the office or the practice has no
 * TC (the list read answers 403 then). Nothing is sent to the specialist; no
 * Open Dental write.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fetchVisitReferralDirectory, fetchVisitReferrals, HygApiError, startVisitReferral } from "@/features/hyg/api";
import { ReferralDialog, ReferralStatusBadge } from "@/features/tc/referrals/ReferralsPanel";
import type { OfficeId } from "@shared/tc/contract";
import type { TcReferral, TcReferralInput } from "@shared/tc/referrals";

export function VisitReferral({ office, aptNum }: { office: OfficeId; aptNum: number }) {
  const [available, setAvailable] = useState(false);
  const [referrals, setReferrals] = useState<TcReferral[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fetchVisitReferrals(office, aptNum)
      .then((list) => {
        setAvailable(true);
        setReferrals(list);
      })
      .catch(() => setAvailable(false));
  }, [office, aptNum]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(input: TcReferralInput) {
    setSaving(true);
    try {
      const r = await startVisitReferral(office, aptNum, input);
      toast.success(r.status === "approved" ? "Referral approved (sign-off not required)" : "Sent for the doctor's sign-off");
      setOpen(false);
      load();
    } catch (e) {
      toast.error(e instanceof HygApiError || e instanceof Error ? e.message : "The referral was not saved");
    } finally {
      setSaving(false);
    }
  }

  if (!available) return null;

  const latest = referrals[0];
  return (
    <div className="inline-flex items-center gap-2" data-testid="hyg-visit-referral">
      <Button variant="outline" className="min-h-11 gap-1.5" onClick={() => setOpen(true)}>
        <Send className="w-4 h-4" /> Start referral
      </Button>
      {latest && (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="hyg-visit-referral-latest">
          {referrals.length === 1 ? "1 referral" : `${referrals.length} referrals`}
          <ReferralStatusBadge status={latest.status} />
        </span>
      )}
      <ReferralDialog
        open={open}
        editing={null}
        saving={saving}
        submitOnly
        sourceLabel="this visit"
        loadDirectory={() => fetchVisitReferralDirectory(office, aptNum)}
        onClose={() => setOpen(false)}
        onSave={(input) => void save(input)}
      />
    </div>
  );
}
