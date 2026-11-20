/**
 * The TC patient email library (EL-1): catalog, profile and preview. One
 * function per route; every answer is parsed through the shared contract, so a
 * server that drifted is a loud error here rather than a page that quietly
 * shows the wrong thing.
 *
 * Nothing here sends, drafts or schedules anything. The server has no route
 * that would.
 */
import { z } from "zod";

import { TcApiError, tcRequest } from "@/features/tc/api";
import type { OfficeId } from "@shared/tc/contract";
import {
  EmailLibraryCatalogResponse,
  EmailLibraryPreviewResponse,
  EmailLibraryProfileResponse,
  type EmailLibraryAnswers,
  type EmailLibraryPreviewRequest,
} from "@shared/tc/emailLibrary";

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new TcApiError("The email library answer could not be read", 0, "CONTRACT_MISMATCH", null, []);
  }
  return parsed.data;
}

const BASE = "/tc/email-library";

/** The library as this office sees it: procedures it provides, stages, tones, questions. */
export async function getEmailLibraryCatalog(office: OfficeId): Promise<EmailLibraryCatalogResponse> {
  return parse(EmailLibraryCatalogResponse, await tcRequest<unknown>(`${BASE}/catalog`, { office }));
}

/** The office's saved answers and the merge settings it has not set. */
export async function getEmailLibraryProfile(office: OfficeId): Promise<EmailLibraryProfileResponse> {
  return parse(EmailLibraryProfileResponse, await tcRequest<unknown>(`${BASE}/profile`, { office }));
}

/**
 * Replace the office's answers. Resolves only with the server's read-back, so
 * "saved" on the page always means "saved and read back".
 */
export async function saveEmailLibraryProfile(
  office: OfficeId,
  answers: EmailLibraryAnswers,
): Promise<EmailLibraryProfileResponse> {
  return parse(
    EmailLibraryProfileResponse,
    await tcRequest<unknown>(`${BASE}/profile`, { office, method: "PUT", body: { answers } }),
  );
}

/** Compose one email (saved answers when `answers` is absent). Never persists anything. */
export async function previewEmailLibrary(
  office: OfficeId,
  request: EmailLibraryPreviewRequest,
): Promise<EmailLibraryPreviewResponse> {
  return parse(
    EmailLibraryPreviewResponse,
    await tcRequest<unknown>(`${BASE}/preview`, { office, method: "POST", body: request }),
  );
}
