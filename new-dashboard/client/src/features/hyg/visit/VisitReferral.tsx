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
 *
 * Item 55: the form takes X-rays (drag, pick, or paste the Win+Shift+S snip).
 * They upload onto the referral once it exists; each file's result is said.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  fetchVisitProviderDirectory,
  fetchVisitReferralDirectory,
  fetchVisitReferrals,
  HygApiError,
  startVisitReferral,
  submitVisitReferral,
  uploadVisitReferralAttachment,
} from "@/features/hyg/api";
import { ReferralDialog, ReferralStatusBadge, reportFailedUploads, uploadAll } from "@/features/tc/referrals/ReferralsPanel";
import type { OfficeId } from "@shared/tc/contract";
import { referralReturnedLine, type TcReferral, type TcReferralInput } from "@shared/tc/referrals";

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

  async function send(referralId: string) {
    const r = await submitVisitReferral(office, aptNum, referralId);
    toast.success(r.status === "approved" ? "Referral approved (sign-off not required)" : "Sent for the doctor's sign-off");
  }

  async function save(input: TcReferralInput, files: File[]) {
    setSaving(true);
    try {
      if (files.length === 0) {
        // No files: create and submit in one transaction.
        const r = await startVisitReferral(office, aptNum, input);
        toast.success(r.status === "approved" ? "Referral approved (sign-off not required)" : "Sent for the doctor's sign-off");
      } else {
        // Item 55: the X-rays land on the DRAFT, then it is submitted — so the
        // doctor sees them, and an office without sign-off does not approve it
        // before they arrive. A file that did not land keeps it a draft (with a
        // Send button below), so nothing goes out missing an X-ray.
        const draft = await startVisitReferral(office, aptNum, input, false);
        const { failed } = await uploadAll(files, (f) => uploadVisitReferralAttachment(office, aptNum, draft.referralId, f));
        if (failed.length > 0) {
          reportFailedUploads(failed);
          toast.error("Kept as a draft so the missing file can be added — press Send for sign-off when ready");
        } else {
          await send(draft.referralId);
        }
      }
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
  const drafts = referrals.filter((r) => r.status === "draft");

  async function retry(referralId: string) {
    try {
      await send(referralId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "It was not sent");
    } finally {
      load();
    }
  }
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
      {drafts.map((d) =>
        referralReturnedLine(d.returned) ? (
          <span key={`${d.referralId}:q`} className="text-xs font-medium text-amber-800 dark:text-amber-300" data-testid="hyg-visit-referral-returned">
            {referralReturnedLine(d.returned)}
          </span>
        ) : null,
      )}
      {drafts.map((d) => (
        <Button
          key={d.referralId}
          size="sm"
          variant="outline"
          className="min-h-11"
          onClick={() => void retry(d.referralId)}
          data-testid="hyg-visit-referral-send"
        >
          Send for sign-off{drafts.length > 1 ? ` (${d.reason.slice(0, 24)})` : ""}
        </Button>
      ))}
      <ReferralDialog
        open={open}
        editing={null}
        saving={saving}
        submitOnly
        sourceLabel="this visit"
        loadDirectory={() => fetchVisitReferralDirectory(office, aptNum)}
        loadProviders={() => fetchVisitProviderDirectory(office, aptNum)}
        onClose={() => setOpen(false)}
        onSave={(input, _submit, files) => void save(input, files)}
      />
    </div>
  );
}
