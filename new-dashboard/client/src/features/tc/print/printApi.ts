/**
 * Print templates (CO-3): Settings → Print templates, and printing from the
 * checkout workup. One function per route; every JSON answer is parsed through
 * the shared contract, so a server that drifted is a loud error here.
 */
import { z } from "zod";

import { TcApiError, tcFetchObjectUrl, tcPostForObjectUrl, tcRequest, tcUpload } from "@/features/tc/api";
import {
  PrintTemplateSaveResponse,
  PrintTemplatesResponse,
  TcCheckoutPrintDefaults,
  type PrintTemplateFields,
  type PrintTemplateState,
  type PrintTemplateType,
  type TcCheckoutPrintRequest,
} from "@shared/tc/printTemplates";
import type { PrintStyling } from "@shared/tc/printStyling";
import type { OfficeId } from "@shared/tc/contract";

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new TcApiError("The print templates answer could not be read", 0, "CONTRACT_MISMATCH", null, []);
  return parsed.data;
}

const SETTINGS = "/platform/print-templates";

/** Both templates for an office, as they print now. */
export async function getPrintTemplates(office: OfficeId): Promise<PrintTemplatesResponse> {
  return parse(PrintTemplatesResponse, await tcRequest<unknown>(SETTINGS, { office }));
}

/** Save one template's wording; answers it as read back. */
export async function savePrintTemplate(
  office: OfficeId,
  type: PrintTemplateType,
  fields: PrintTemplateFields,
): Promise<PrintTemplateState> {
  return parse(PrintTemplateSaveResponse, await tcRequest<unknown>(`${SETTINGS}/${type}`, { office, method: "PUT", body: fields })).template;
}

/** Upload a logo (PNG or JPEG, ≤ 2 MB). Refused by name when logo storage is not set up. */
export async function uploadPrintLogo(office: OfficeId, type: PrintTemplateType, file: File): Promise<PrintTemplateState> {
  return parse(PrintTemplateSaveResponse, await tcUpload<unknown>(`${SETTINGS}/${type}/logo`, office, file)).template;
}

/** Print without a logo again. */
export async function removePrintLogo(office: OfficeId, type: PrintTemplateType): Promise<PrintTemplateState> {
  return parse(PrintTemplateSaveResponse, await tcRequest<unknown>(`${SETTINGS}/${type}/logo/remove`, { office, method: "POST" })).template;
}

/**
 * CO-3b: save one template's styling — null goes back to the defaults (today's
 * printout). Refused by name when it is not on the curated list or the accent
 * is too light to read; answers the template as read back.
 */
export async function savePrintStyling(office: OfficeId, type: PrintTemplateType, styling: PrintStyling | null): Promise<PrintTemplateState> {
  return parse(PrintTemplateSaveResponse, await tcRequest<unknown>(`${SETTINGS}/${type}/styling`, { office, method: "PUT", body: { styling } })).template;
}

/** CO-3b: a bundled print font's bytes as an object URL — the very file the PDF embeds. */
export function fetchPrintFontUrl(office: OfficeId, file: string): Promise<string> {
  return tcFetchObjectUrl(`${SETTINGS}/fonts/${encodeURIComponent(file)}`, office);
}

/** The logo's bytes as an object URL, for the preview. The caller revokes it. */
export function fetchPrintLogoUrl(office: OfficeId, type: PrintTemplateType): Promise<string> {
  return tcFetchObjectUrl(`${SETTINGS}/${type}/logo`, office);
}

/** What the workup's print dialog starts from. */
export async function getCheckoutPrintDefaults(office: OfficeId, handoffId: string): Promise<TcCheckoutPrintDefaults> {
  return parse(TcCheckoutPrintDefaults, await tcRequest<unknown>(`/tc/checkout/${handoffId}/print`, { office }));
}

/** Generate the printout. Answers its PDF as an object URL, and whether the logo made it. */
export async function printCheckout(
  office: OfficeId,
  handoffId: string,
  body: TcCheckoutPrintRequest,
): Promise<{ url: string; logo: "included" | "none" | "omitted" }> {
  const { url, headers } = await tcPostForObjectUrl(`/tc/checkout/${handoffId}/print`, office, body);
  const logo = headers.get("x-print-logo");
  return { url, logo: logo === "included" || logo === "omitted" ? logo : "none" };
}
