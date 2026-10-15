/**
 * The Checkout inbox's api (queue item 50). One function per route in
 * backend/routes/tc/checkout.js; every answer is parsed through the shared
 * contract, so a server that drifted is a loud error here, not a quiet blank.
 */
import { z } from "zod";

import { tcRequest, TcApiError } from "@/features/tc/api";
import {
  TcCheckoutHandoff,
  TcCheckoutSummary,
  type TcCheckoutOutcome,
} from "@shared/tc/checkout";
import type { OfficeId } from "@shared/tc/contract";

export type CheckoutView = "waiting" | "done";

const ListResponse = z.object({
  success: z.literal(true),
  today: z.string(),
  view: z.enum(["waiting", "done"]),
  handoffs: z.array(TcCheckoutHandoff),
});

const OneResponse = z.object({ success: z.literal(true), handoff: TcCheckoutHandoff });

const OutcomeResponse = z.object({
  success: z.literal(true),
  handoff: TcCheckoutHandoff,
  caseId: z.string().uuid().nullable(),
  url: z.string().nullable(),
  attached: z.boolean(),
});
export type CheckoutOutcomeResult = z.infer<typeof OutcomeResponse>;

/** Parse, or throw the mismatch in words. */
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new TcApiError("The checkout answer could not be read", 0, "CONTRACT_MISMATCH", null, []);
  }
  return parsed.data;
}

export async function listCheckout(office: OfficeId, view: CheckoutView) {
  return parse(ListResponse, await tcRequest<unknown>("/tc/checkout", { office, params: { view } }));
}

export async function getCheckoutSummary(office: OfficeId): Promise<TcCheckoutSummary> {
  return parse(TcCheckoutSummary, await tcRequest<unknown>("/tc/checkout/summary", { office }));
}

export async function getCheckoutHandoff(office: OfficeId, handoffId: string): Promise<TcCheckoutHandoff> {
  const res = parse(OneResponse, await tcRequest<unknown>(`/tc/checkout/${handoffId}`, { office }));
  return res.handoff;
}

export async function claimCheckout(office: OfficeId, handoffId: string): Promise<TcCheckoutHandoff> {
  const res = parse(
    OneResponse,
    await tcRequest<unknown>(`/tc/checkout/${handoffId}/claim`, { office, method: "POST", body: {} }),
  );
  return res.handoff;
}

export async function dismissCheckout(
  office: OfficeId,
  handoffId: string,
  reason: string,
): Promise<TcCheckoutHandoff> {
  const res = parse(
    OneResponse,
    await tcRequest<unknown>(`/tc/checkout/${handoffId}/dismiss`, {
      office,
      method: "POST",
      body: { reason },
    }),
  );
  return res.handoff;
}

export async function recordCheckoutOutcome(
  office: OfficeId,
  handoffId: string,
  outcome: TcCheckoutOutcome,
  appointmentNote: string,
): Promise<CheckoutOutcomeResult> {
  return parse(
    OutcomeResponse,
    await tcRequest<unknown>(`/tc/checkout/${handoffId}/outcome`, {
      office,
      method: "POST",
      body: { outcome, appointmentNote },
    }),
  );
}
