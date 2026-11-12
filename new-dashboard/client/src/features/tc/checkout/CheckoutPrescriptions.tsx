/**
 * "Prescriptions needed" + "Pharmacy" from the hygiene visit, READ-ONLY on the
 * checkout card (sidebar) and the workup, so the doctor and the front desk see
 * the request. In-app only: this text is never sent to Open Dental. Renders
 * nothing when the hygienist filled in neither.
 */
import { Pill } from "lucide-react";

import { hasPrescriptions, type HygPrescriptions } from "@shared/hyg/prescriptions";

export function CheckoutPrescriptions({
  prescriptions,
  testId = "checkout-prescriptions",
}: {
  prescriptions: HygPrescriptions | undefined;
  testId?: string;
}) {
  if (!prescriptions || !hasPrescriptions(prescriptions)) return null;
  const { rxNeeded, pharmacy } = prescriptions;
  return (
    <section className="space-y-1.5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40" data-testid={testId}>
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
        <Pill className="h-3.5 w-3.5" aria-hidden /> Prescriptions needed
      </h3>
      {rxNeeded.trim() !== "" && (
        <p className="whitespace-pre-wrap text-foreground" data-testid={`${testId}-rx`}>
          {rxNeeded}
        </p>
      )}
      {pharmacy.trim() !== "" && (
        <p data-testid={`${testId}-pharmacy`}>
          <span className="text-muted-foreground">Pharmacy: </span>
          {pharmacy}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">From the hygienist. In CareIN only; not in Open Dental.</p>
    </section>
  );
}
