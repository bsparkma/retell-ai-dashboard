/**
 * "Prescriptions needed" + "Pharmacy" on the hygiene visit (Beau's ruling:
 * IN-APP ONLY).
 *
 * Two optional fields so the doctor and the front desk see the request: they
 * appear, read-only, on the checkout card. They are NEVER sent to Open Dental
 * — not in the note, not in any staged write, not in the Send. That is a
 * server guarantee (separate columns the composer cannot read), not something
 * this component promises; it only says so.
 *
 * Saved with its own button, and what is shown after a save is what the
 * server read back. Mounted once the visit is open.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Pill } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fetchVisitPrescriptions, HygApiError, saveVisitPrescriptions } from "@/features/hyg/api";
import type { OfficeId } from "@shared/hyg/contract";
import {
  EMPTY_HYG_PRESCRIPTIONS,
  HYG_PHARMACY_MAX,
  HYG_RX_NEEDED_MAX,
  HygPrescriptionsSchema,
  type HygPrescriptions,
} from "@shared/hyg/prescriptions";

function message(e: unknown): string {
  if (e instanceof HygApiError) return e.message;
  return e instanceof Error ? e.message : "Something went wrong";
}

export function VisitPrescriptions({ office, aptNum }: { office: OfficeId; aptNum: number }) {
  const [stored, setStored] = useState<HygPrescriptions | null>(null);
  const [draft, setDraft] = useState<HygPrescriptions>(EMPTY_HYG_PRESCRIPTIONS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    setLoadError(null);
    fetchVisitPrescriptions(office, aptNum)
      .then((p) => {
        if (!live) return;
        setStored(p);
        setDraft(p);
      })
      .catch((e: unknown) => {
        if (live) setLoadError(message(e));
      });
    return () => {
      live = false;
    };
  }, [office, aptNum]);

  const dirty = stored !== null && (draft.rxNeeded !== stored.rxNeeded || draft.pharmacy !== stored.pharmacy);

  async function save() {
    const parsed = HygPrescriptionsSchema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the fields");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const back = await saveVisitPrescriptions(office, aptNum, parsed.data);
      setStored(back);
      setDraft(back);
      toast.success("Prescriptions saved");
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-border p-4" data-testid="hyg-visit-prescriptions">
      <div>
        <h2 className="flex items-center gap-1.5 text-base font-semibold">
          <Pill className="h-4 w-4" aria-hidden /> Prescriptions
        </h2>
        <p className="text-xs text-muted-foreground">
          For the doctor and the front desk: shown on the checkout card. Stays in CareIN; never sent to Open Dental.
        </p>
      </div>
      {loadError ? (
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
      ) : stored === null ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          <span className="text-sm">Loading…</span>
        </div>
      ) : (
        <>
          <div className="space-y-1">
            <Label htmlFor="hyg-rx-needed">Prescriptions needed</Label>
            <Textarea
              id="hyg-rx-needed"
              rows={3}
              maxLength={HYG_RX_NEEDED_MAX}
              value={draft.rxNeeded}
              disabled={saving}
              placeholder="e.g. Amoxicillin premed before next visit"
              onChange={(e) => {
                setDraft((d) => ({ ...d, rxNeeded: e.target.value }));
                setError(null);
              }}
              data-testid="hyg-rx-needed"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hyg-pharmacy">Pharmacy</Label>
            <Input
              id="hyg-pharmacy"
              maxLength={HYG_PHARMACY_MAX}
              value={draft.pharmacy}
              disabled={saving}
              placeholder="Name and location"
              onChange={(e) => {
                // One line: a pasted line break becomes a space.
                setDraft((d) => ({ ...d, pharmacy: e.target.value.replace(/[\r\n]+/g, " ") }));
                setError(null);
              }}
              data-testid="hyg-pharmacy"
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void save()} disabled={saving || !dirty} data-testid="hyg-prescriptions-save">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
            </Button>
            {!dirty && (stored.rxNeeded !== "" || stored.pharmacy !== "") && (
              <span className="text-xs text-muted-foreground" data-testid="hyg-prescriptions-saved">
                Saved
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
