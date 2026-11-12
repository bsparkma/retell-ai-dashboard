/**
 * "Prescriptions needed" and "Pharmacy" on a hygiene visit (Beau's ruling:
 * IN-APP ONLY).
 *
 * Two optional free-form fields the hygienist fills in so the doctor and the
 * front desk see the request: the prescription(s) needed (multi-line) and the
 * pharmacy (one line). Shown and edited on the visit screen; shown read-only
 * on the checkout card.
 *
 * NEVER SENT TO OPEN DENTAL. They are stored in their own hyg_visit columns,
 * not in the routing slip, so the staged-write composer (which reads the slip
 * and the items) has no way to reach them; no chart payload carries them.
 * backend/routes/hyg/hygRxNeverToOd.test.js pins it.
 */
import { z } from "zod";

/** Caps, in characters. The DB CHECKs (1794600000000) carry the same. */
export const HYG_RX_NEEDED_MAX = 1000;
export const HYG_PHARMACY_MAX = 200;

/** The two fields. "" = not filled in. Pharmacy is a single line. */
export const HygPrescriptionsSchema = z
  .object({
    rxNeeded: z
      .string()
      .max(HYG_RX_NEEDED_MAX, `Keep prescriptions under ${HYG_RX_NEEDED_MAX} characters`),
    pharmacy: z
      .string()
      .max(HYG_PHARMACY_MAX, `Keep the pharmacy under ${HYG_PHARMACY_MAX} characters`)
      .refine((v) => !/[\r\n]/.test(v), "The pharmacy is one line"),
  })
  .strict();
export type HygPrescriptions = z.infer<typeof HygPrescriptionsSchema>;

export const EMPTY_HYG_PRESCRIPTIONS: HygPrescriptions = Object.freeze({ rxNeeded: "", pharmacy: "" });

/** PUT /api/hyg/visit/:aptNum/prescriptions — the whole pair, trimmed server-side. */
export const HygPrescriptionsSaveRequestSchema = HygPrescriptionsSchema;
export type HygPrescriptionsSaveRequest = z.infer<typeof HygPrescriptionsSaveRequestSchema>;

/** GET and PUT /api/hyg/visit/:aptNum/prescriptions — what is stored, as read back. */
export const HygPrescriptionsResponseSchema = z.object({
  success: z.literal(true),
  office: z.enum(["roland", "valley"]),
  aptNum: z.number().int().positive(),
  prescriptions: HygPrescriptionsSchema,
});
export type HygPrescriptionsResponse = z.infer<typeof HygPrescriptionsResponseSchema>;

/** Whether either field says anything. */
export function hasPrescriptions(p: HygPrescriptions | null | undefined): boolean {
  return !!p && (p.rxNeeded.trim() !== "" || p.pharmacy.trim() !== "");
}
