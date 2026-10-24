/**
 * The provider directory: the office's own list of providers (dentists), kept
 * in the app, for the two fields that name one — a referral's referring
 * provider and a pre-auth's doctor.
 *
 * The app OWNS the list. "Import from Open Dental" reads that office's
 * providers once, READ-ONLY, and merges them in additively: it updates names,
 * adds the new ones, and never deletes or deactivates anything (staff do that
 * by hand). There is no automatic sync; the button is the refresh.
 *
 * The two fields keep storing TEXT (`referring_provider`, `doctor_name`). A
 * pick writes the provider's display name into that text, and "Other" keeps
 * today's free text — so nothing that reads those columns changes.
 */
import { z } from "zod";

export const TC_PROVIDER_NAME_MAX = 200;
export const TC_PROVIDER_SUFFIX_MAX = 40;

/** POST / PUT /api/tc/providers[/:id] — what the Settings form sends. */
export const TcProviderInput = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(TC_PROVIDER_NAME_MAX),
    /** "DDS", "DMD", "RDH" — printed after the name. Optional. */
    credentialSuffix: z.string().trim().max(TC_PROVIDER_SUFFIX_MAX).default(""),
    active: z.boolean().default(true),
  })
  .strict();
export type TcProviderInput = z.infer<typeof TcProviderInput>;

/** One provider, as the API returns it. */
export const TcProviderEntry = z.object({
  providerId: z.string().uuid(),
  officeId: z.enum(["roland", "valley"]),
  name: z.string(),
  credentialSuffix: z.string(),
  active: z.boolean(),
  /** Open Dental's ProvNum when the row came from an import; null when added by hand. */
  odProvNum: z.number().int().positive().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type TcProviderEntry = z.infer<typeof TcProviderEntry>;

/** GET /api/tc/providers — `canEdit` says whether this caller may change it (admin + office). */
export const TcProviderListResponse = z.object({
  success: z.literal(true),
  entries: z.array(TcProviderEntry),
  canEdit: z.boolean().optional(),
});
export type TcProviderListResponse = z.infer<typeof TcProviderListResponse>;

/** POST /api/tc/providers/import — no fields: the office is the request's, the list is Open Dental's. */
export const TcProviderImportRequest = z.object({}).strict();
export type TcProviderImportRequest = z.infer<typeof TcProviderImportRequest>;

/**
 * What an import did. `skippedHidden` / `skippedHygienists` are Open Dental
 * providers it left out on purpose (hidden = no longer practising there;
 * hygienists do not refer or sign a pre-auth); `skippedNoName` had no name to
 * show. Names on rows already linked to a ProvNum are updated; nothing is ever
 * deleted or deactivated.
 */
export const TcProviderImportResponse = z.object({
  success: z.literal(true),
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  skippedHidden: z.number().int().nonnegative(),
  skippedHygienists: z.number().int().nonnegative(),
  skippedNoName: z.number().int().nonnegative(),
  entries: z.array(TcProviderEntry),
});
export type TcProviderImportResponse = z.infer<typeof TcProviderImportResponse>;

/** "Jane Smith, DDS" — what a pick writes into the referral / pre-auth text field. Pure. */
export function providerDisplayName(p: { name: string; credentialSuffix: string }): string {
  const name = p.name.trim();
  const suffix = p.credentialSuffix.trim();
  return suffix ? `${name}, ${suffix}` : name;
}

/** POST /api/tc/preauth/:id/start-case — no fields: the patient and office come from the pre-auth row. */
export const TcPreauthStartCaseRequest = z.object({}).strict();
export type TcPreauthStartCaseRequest = z.infer<typeof TcPreauthStartCaseRequest>;
