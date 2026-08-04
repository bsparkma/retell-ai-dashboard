/**
 * Cadence override dialog — per-case Phase 1 / Phase 2 interval overrides,
 * persisted through patchCase (nurturePhase1DaysOverride /
 * nurturePhase2DaysOverride). Confirmed-save: the dialog stays open with the
 * typed values on failure; success toasts fire only after the server row
 * returns, and the returned case is handed to the parent to merge into state.
 */
import { useId, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { OfficeId, TcCase } from "@shared/tc/contract";
import { patchCase, tcErrorMessage, type TcCaseSummary } from "../api";
import {
  NURTURE_PHASE1_DEFAULT_DAYS,
  NURTURE_PHASE2_DEFAULT_DAYS,
} from "./nurtureUtils";

function parseInterval(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = parseInt(text.trim(), 10);
  return n >= 1 && n <= 365 ? n : null;
}

export interface CadenceDialogProps {
  office: OfficeId;
  caseRow: TcCaseSummary;
  /** Called with the persisted case after the server confirms. */
  onSaved: (updated: TcCase) => void;
  onClose: () => void;
}

export function CadenceDialog({ office, caseRow, onSaved, onClose }: CadenceDialogProps) {
  const phase1Id = useId();
  const phase2Id = useId();
  const [phase1Days, setPhase1Days] = useState(
    String(caseRow.nurturePhase1DaysOverride ?? NURTURE_PHASE1_DEFAULT_DAYS),
  );
  const [phase2Days, setPhase2Days] = useState(
    String(caseRow.nurturePhase2DaysOverride ?? NURTURE_PHASE2_DEFAULT_DAYS),
  );
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const p1 = parseInterval(phase1Days);
    const p2 = parseInterval(phase2Days);
    if (p1 === null || p2 === null) {
      toast.error("Intervals must be whole numbers between 1 and 365 days.");
      return;
    }
    setSaving(true);
    try {
      const updated = await patchCase(office, caseRow.caseId, {
        nurturePhase1DaysOverride: p1,
        nurturePhase2DaysOverride: p2,
      });
      toast.success("Cadence updated");
      onSaved(updated);
      onClose();
    } catch (e) {
      // Keep the dialog open with the typed values.
      toast.error(tcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !saving && !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Override cadence — {caseRow.patientName}</DialogTitle>
          <DialogDescription>
            How often this patient gets a nurture touch, per phase. Defaults are{" "}
            {NURTURE_PHASE1_DEFAULT_DAYS}d (Phase 1) and {NURTURE_PHASE2_DEFAULT_DAYS}d
            (Phase 2).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={phase1Id}>Phase 1 interval (days)</Label>
            <Input
              id={phase1Id}
              type="number"
              min={1}
              max={365}
              value={phase1Days}
              onChange={(e) => setPhase1Days(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={phase2Id}>Phase 2 interval (days)</Label>
            <Input
              id={phase2Id}
              type="number"
              min={1}
              max={365}
              value={phase2Days}
              onChange={(e) => setPhase2Days(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void handleSave()}>
            {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
            Save override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
