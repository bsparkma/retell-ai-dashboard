/**
 * "New referral" on the Referrals hub (R6.2) — a referral started BY HAND.
 *
 * Two steps, both existing pieces:
 *   1. pick the patient with OdPatientSearch over odAttachSearch — the
 *      per-office Open Dental search (GET /tc/od/patient-search). OD matches
 *      names by PREFIX, so the rows show DOB and nothing is auto-picked;
 *   2. the shared ReferralDialog, then the case panel's own save sequence:
 *      create the draft, attach its files, submit when asked.
 *
 * The client sends only the picked PatNum. The server re-reads that patient
 * from THIS office's Open Dental and takes the name from there; the office is
 * the request's ?office=, never the body. The draft is recorded as source
 * `manual`. Nothing sends.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { odAttachSearch, tcErrorMessage, type OdPatient } from "@/features/tc/api";
import { OdPatientSearch } from "@/features/tc/od/OdShell";
import type { OfficeId } from "@shared/tc/contract";
import type { TcReferral, TcReferralInput } from "@shared/tc/referrals";
import { createReferral, listDirectory } from "./referralsApi";
import { ReferralDialog, attachThenSubmit } from "./ReferralsPanel";

export function NewHubReferral({
  office,
  onCreated,
}: {
  office: OfficeId;
  /** The draft as the server stored it (after any files / submit, re-read by the caller). */
  onCreated: (referral: TcReferral) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [patient, setPatient] = useState<OdPatient | null>(null);
  const [saving, setSaving] = useState(false);

  function close() {
    setPicking(false);
    setPatient(null);
  }

  async function save(input: TcReferralInput, submit: boolean, chosen: File[]) {
    if (!patient) return;
    setSaving(true);
    try {
      const saved = await createReferral(office, { patNum: patient.patNum }, input);
      try {
        await attachThenSubmit(office, saved.referralId, submit, chosen);
      } catch (e) {
        // The draft exists; only the submit was refused. Say so, keep it.
        toast.error(`The draft was saved, but it was not submitted: ${tcErrorMessage(e)}`);
      }
      close();
      onCreated(saved);
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button size="sm" className="gap-1" onClick={() => setPicking(true)} data-testid="tc-hub-new-referral">
        <Plus className="w-4 h-4" /> New referral
      </Button>

      <Dialog open={picking && !patient} onOpenChange={(o) => (!o ? close() : undefined)}>
        <DialogContent className="max-w-lg" data-testid="tc-hub-new-referral-pick">
          <DialogHeader>
            <DialogTitle>New referral</DialogTitle>
            <DialogDescription>
              Find the patient in this office's Open Dental. Names match by how they start, so check the date of birth.
            </DialogDescription>
          </DialogHeader>
          <OdPatientSearch
            office={office}
            search={odAttachSearch}
            onSelect={setPatient}
            label="Patient"
            autoFocus
          />
        </DialogContent>
      </Dialog>

      <ReferralDialog
        open={patient !== null}
        editing={null}
        saving={saving}
        loadDirectory={() => listDirectory(office, false)}
        sourceLabel={patient ? `Open Dental: ${patient.displayName}` : undefined}
        onClose={close}
        onSave={(input, submit, chosen) => void save(input, submit, chosen)}
      />
    </>
  );
}
