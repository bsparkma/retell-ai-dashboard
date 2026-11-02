/**
 * Where a checkout card came from, in one line — shared by the patient
 * sidebar and the workup view so the two never word it differently.
 */
import { checkoutClock } from "@/features/tc/checkout/CheckoutOutcome";
import type { TcCheckoutHandoff } from "@shared/tc/checkout";

/**
 * Where a card came from, in one line: "Sent by hygiene at …", "Added by hand
 * at … by …", or "Made from today's schedule at … · Crown Prep". The schedule
 * card names its visit type when Open Dental gave one, and never invents one.
 */
export function checkoutOriginText(h: TcCheckoutHandoff): string {
  if (h.source === "manual") return `Added by hand at ${checkoutClock(h.createdAt)} by ${h.submittedBy}`;
  if (h.source === "schedule") {
    const type = h.scheduleAppointment?.appointmentType ?? "";
    return `Made from today's schedule at ${checkoutClock(h.createdAt)}${type ? ` · ${type}` : ""}`;
  }
  return `Sent by hygiene at ${checkoutClock(h.createdAt)}`;
}
