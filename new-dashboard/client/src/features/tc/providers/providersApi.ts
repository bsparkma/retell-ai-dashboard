/**
 * Provider directory api. One function per route in
 * backend/routes/tc/providers.js (plus the doctor's read in
 * referralSignoff.js); every answer is parsed through the shared contract.
 */
import { z } from "zod";

import { tcRequest, TcApiError } from "@/features/tc/api";
import {
  TcProviderEntry,
  TcProviderImportResponse,
  TcProviderListResponse,
  type TcProviderInput,
} from "@shared/tc/providers";
import type { OfficeId } from "@shared/tc/contract";

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new TcApiError("The provider list answer could not be read", 0, "CONTRACT_MISMATCH", null, []);
  }
  return parsed.data;
}

const OneResponse = z.object({ success: z.literal(true), entry: TcProviderEntry });
const ActiveResponse = z.object({ success: z.literal(true), entries: z.array(TcProviderEntry) });

/** The office's providers, and whether this caller may change them. */
export async function listProviders(
  office: OfficeId,
  includeInactive = false,
): Promise<{ entries: TcProviderEntry[]; canEdit: boolean }> {
  const res = parse(
    TcProviderListResponse,
    await tcRequest<unknown>("/tc/providers", {
      office,
      params: includeInactive ? { includeInactive: "true" } : undefined,
    }),
  );
  return { entries: res.entries, canEdit: res.canEdit === true };
}

/** The ACTIVE providers, for a pick (tc.full). */
export async function listActiveProviders(office: OfficeId): Promise<TcProviderEntry[]> {
  return (await listProviders(office, false)).entries;
}

/** The doctor's read of the ACTIVE providers, at sign-off. */
export async function listSignoffProviders(office: OfficeId): Promise<TcProviderEntry[]> {
  return parse(ActiveResponse, await tcRequest<unknown>("/tc/referrals/signoff/providers", { office })).entries;
}

export async function createProvider(office: OfficeId, input: TcProviderInput): Promise<TcProviderEntry> {
  return parse(OneResponse, await tcRequest<unknown>("/tc/providers", { office, method: "POST", body: input })).entry;
}

export async function updateProvider(
  office: OfficeId,
  providerId: string,
  input: TcProviderInput,
): Promise<TcProviderEntry> {
  return parse(
    OneResponse,
    await tcRequest<unknown>(`/tc/providers/${providerId}`, { office, method: "PUT", body: input }),
  ).entry;
}

/** "Import from Open Dental": one read of this office's providers, merged in. */
export async function importProviders(office: OfficeId): Promise<TcProviderImportResponse> {
  return parse(
    TcProviderImportResponse,
    await tcRequest<unknown>("/tc/providers/import", { office, method: "POST", body: {} }),
  );
}
