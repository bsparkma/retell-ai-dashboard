/**
 * EL-1 screenshot dumps: /admin/patient-emails rendered in jsdom, written to
 * tests/.shots/tcemlib-*.html, then scripts/shoot-tc-email-library.mjs wraps
 * each in the built CSS and photographs it in light and dark.
 *
 *   pnpm exec vite build
 *   TC_SHOTS=1 pnpm exec vitest run tests/tc-email-library-shots.test.tsx
 *   node scripts/shoot-tc-email-library.mjs
 *
 * REAL WORDING, NO NETWORK: the catalog and the preview come from the backend
 * library itself (services/tcEmailLibrary: the frozen source and its composer),
 * loaded in-process, with the same sample merge values the server uses
 * ("Jordan", fixed appointment samples). Sample office answers only; no patient.
 * Skipped unless TC_SHOTS=1.
 */
import * as React from "react";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import type {
  EmailLibraryCatalogResponse,
  EmailLibraryPreviewRequest,
  EmailLibraryPreviewResponse,
  EmailLibraryProfileResponse,
} from "@shared/tc/emailLibrary";

const SHOOT = process.env.TC_SHOTS === "1";
const requireCjs = createRequire(import.meta.url);

interface LibraryEmail {
  id: string;
  procedure_id: string;
  procedure_name: string;
  stage: string;
  stage_label: string;
  variant: "A" | "B" | "C";
  tone: string;
  subject: string;
  preheader: string;
  body_text: string;
  merge_fields: string[];
  word_count: number;
}
interface LibraryModule {
  catalog: (office: string, answers: Record<string, unknown>) => EmailLibraryCatalogResponse;
  missingSettings: (answers: Record<string, unknown>) => EmailLibraryProfileResponse["missing"];
  composeOne: (pick: { procedureId: string; stage: string; variant: string }, answers: Record<string, unknown>) => LibraryEmail;
  resolveMergeFields: (texts: string[], values: Record<string, string | null>) => { texts: string[]; unresolved: string[] };
}
const library = (SHOOT ? requireCjs("../../backend/services/tcEmailLibrary/index.js") : null) as LibraryModule | null;

const ANSWERS = {
  same_day_crowns: true,
  same_day_length: "about two hours",
  digital_scanner: true,
  buffered: true,
  sedation: ["nitrous"],
  doctor_name: "Dr. Sample",
  insurance_mode: "in_network",
  schedule_perks: ["early", "friday"],
  services_off: ["braces", "full_arch"],
};

const state = vi.hoisted(() => ({ canEdit: true }));

vi.mock("@/contexts/OfficeContext", () => ({
  ALL_OFFICES: "all",
  useOffice: () => ({ office: "roland", offices: [{ officeId: "roland", officeName: "Roland" }], loading: false, error: null }),
}));
vi.mock("@/features/tc/emailLibrary/emailLibraryApi", () => ({
  getEmailLibraryCatalog: async () => library!.catalog("roland", ANSWERS),
  getEmailLibraryProfile: async (): Promise<EmailLibraryProfileResponse> => ({
    success: true,
    office: "roland",
    saved: true,
    answers: ANSWERS,
    libraryVersion: "1.1.0",
    updatedBy: "admin@example.test",
    updatedAt: "2026-11-19T15:00:00.000Z",
    missing: library!.missingSettings(ANSWERS),
    canEdit: state.canEdit,
  }),
  saveEmailLibraryProfile: async () => {
    throw new Error("not in the shots");
  },
  previewEmailLibrary: async (_office: string, req: EmailLibraryPreviewRequest): Promise<EmailLibraryPreviewResponse> => {
    const answers = (req.answers ?? ANSWERS) as Record<string, unknown>;
    const e = library!.composeOne({ procedureId: req.procedure_id, stage: req.stage, variant: req.variant }, answers);
    const r = library!.resolveMergeFields([e.subject, e.preheader, e.body_text], {
      first_name: "Jordan",
      appointment_date: "Tuesday, March 3",
      appointment_time: "9:00 AM",
      office_name: "Sample Family Dental",
      office_phone: null,
      sender_name: "Sample Coordinator",
      doctor_name: typeof answers.doctor_name === "string" ? answers.doctor_name : null,
      schedule_link: null,
      review_link: null,
    });
    return {
      success: true,
      office: "roland",
      id: e.id,
      procedureId: e.procedure_id,
      procedureName: e.procedure_name,
      stage: e.stage,
      stageLabel: e.stage_label,
      variant: e.variant,
      tone: e.tone,
      answersSource: req.answers ? "unsaved" : "saved",
      subject: r.texts[0] ?? "",
      preheader: r.texts[1] ?? "",
      bodyText: r.texts[2] ?? "",
      mergeFields: e.merge_fields,
      unresolved: r.unresolved,
      wordCount: e.word_count,
      clinicallyApproved: false,
    };
  },
}));

import AdminPatientEmails from "@/pages/AdminPatientEmails";

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), `<div style="padding:24px">${document.body.innerHTML}</div>`, "utf8");
}

afterEach(() => cleanup());

describe.skipIf(!SHOOT)("TC patient email library screenshot dumps", () => {
  it("01: an admin, saved sample answers, the crown recap preview", async () => {
    state.canEdit = true;
    render(<AdminPatientEmails />);
    await screen.findByTestId("patient-emails-save");
    await waitFor(() => screen.getByTestId("patient-emails-body"), { timeout: 3000 });
    dump("tcemlib-01-admin-preview");
  });

  it("02: a TC user, read-only", async () => {
    state.canEdit = false;
    render(<AdminPatientEmails />);
    await screen.findByTestId("patient-emails-read-only");
    await waitFor(() => screen.getByTestId("patient-emails-body"), { timeout: 3000 });
    dump("tcemlib-02-read-only");
  });
});
