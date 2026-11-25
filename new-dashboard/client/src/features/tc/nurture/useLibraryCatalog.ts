/**
 * EL-2: the patient email library's catalog, for the nurture UI's library
 * pieces — the Start Nurture picker's procedure list (this office's, after its
 * services_off), and the procedure names / stage labels the campaign strip and
 * the Nurture Outbox show on library enrollments and drafts.
 *
 * Fetched only when `enabled` (a library enrollment or draft is on screen, or
 * the picker is open), so a page with no library work makes no catalog call.
 * Read-only: GET /api/tc/email-library/catalog.
 */
import { useEffect, useState } from "react";
import type { OfficeId } from "@shared/tc/contract";
import type { EmailLibraryCatalogResponse } from "@shared/tc/emailLibrary";
import { getEmailLibraryCatalog } from "../emailLibrary/emailLibraryApi";
import { nurtureErrorText } from "./campaignCopy";

export interface LibraryCatalogState {
  catalog: EmailLibraryCatalogResponse | null;
  error: string | null;
}

export function useLibraryCatalog(office: OfficeId, enabled: boolean): LibraryCatalogState {
  const [state, setState] = useState<LibraryCatalogState>({ catalog: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    getEmailLibraryCatalog(office)
      .then((catalog) => live && setState({ catalog, error: null }))
      .catch((e: unknown) => live && setState({ catalog: null, error: nurtureErrorText(e) }));
    return () => {
      live = false;
    };
  }, [office, enabled]);
  return state;
}

/** "Dental Crown" — or the id itself while the catalog is loading or lacks it. */
export function libraryProcedureName(catalog: EmailLibraryCatalogResponse | null, id: string): string {
  return catalog?.allProcedures.find((p) => p.id === id)?.name ?? id;
}

/** "Why it matters" — or the stage id itself while the catalog is loading or lacks it. */
export function libraryStageLabel(catalog: EmailLibraryCatalogResponse | null, stage: string): string {
  return catalog?.stages.find((s) => s.id === stage)?.label ?? stage;
}
