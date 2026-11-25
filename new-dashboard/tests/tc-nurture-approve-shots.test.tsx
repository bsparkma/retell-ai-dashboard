/**
 * Screenshot DUMPS for EL-2c (approve up front).
 *
 *   pnpm exec vite build
 *   TC_SHOTS=1 pnpm exec vitest run tests/tc-nurture-approve-shots.test.tsx
 *   node scripts/shoot-tc-nurture.mjs
 *
 *   tcnurture-10-review-campaign    Review campaign: the banner, "3 of 10
 *                                   approved", Approve all, each email's planned
 *                                   time / stage / subject / chip, one shown
 *   tcnurture-11-review-actions     Approve all's confirm, one email in Edit and
 *                                   one in Change date
 *   tcnurture-12-campaign-strip     the case strip on a library campaign
 *   tcnurture-13-outbox-campaigns   the outbox: library campaigns per case with
 *                                   a needs-approval count, a hand-written group below
 *
 * The email text is the library's own composed text for the roland test
 * patient (tests/fixtures/tc-nurture-crown-campaign.json). NO NETWORK, NO
 * BACKEND, NO PHI: designated test-patient names only, 555-01xx numbers, a
 * synthetic staff name. Skipped unless TC_SHOTS=1.
 */
import * as React from "react";
import { afterEach, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { NurtureCaseResponse } from "@shared/tc/nurture";
import { CASE_A, CATALOG, ENR_A, campaignResponse, libraryEnrollment, outboxWithCampaigns, rendered } from "./fixtures/tcNurtureCampaign";

(globalThis as Record<string, unknown>).React = React;

const api = vi.hoisted(() => ({
  getNurtureOutbox: vi.fn(),
  skipNurtureDraft: vi.fn(),
  getCaseNurture: vi.fn(),
  startNurture: vi.fn(),
  pauseNurture: vi.fn(),
  resumeNurture: vi.fn(),
  stopNurture: vi.fn(),
  getNurtureCampaign: vi.fn(),
  approveNurtureEmail: vi.fn(),
  unapproveNurtureEmail: vi.fn(),
  rescheduleNurtureEmail: vi.fn(),
  approveAllNurtureEmails: vi.fn(),
  markPatientReplied: vi.fn(),
  getEmailLibraryCatalog: vi.fn(),
  editDraft: vi.fn(),
  renderEmail: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock("@/features/tc/nurture/campaignApi", () => ({
  getNurtureOutbox: api.getNurtureOutbox,
  skipNurtureDraft: api.skipNurtureDraft,
  getCaseNurture: api.getCaseNurture,
  startNurture: api.startNurture,
  pauseNurture: api.pauseNurture,
  resumeNurture: api.resumeNurture,
  stopNurture: api.stopNurture,
  getNurtureCampaign: api.getNurtureCampaign,
  approveNurtureEmail: api.approveNurtureEmail,
  unapproveNurtureEmail: api.unapproveNurtureEmail,
  rescheduleNurtureEmail: api.rescheduleNurtureEmail,
  approveAllNurtureEmails: api.approveAllNurtureEmails,
  markPatientReplied: api.markPatientReplied,
}));
vi.mock("@/features/tc/messaging/messagingApi", () => ({
  editDraft: api.editDraft,
  renderEmail: api.renderEmail,
  sendMessage: api.sendMessage,
}));
vi.mock("@/features/tc/emailLibrary/emailLibraryApi", () => ({ getEmailLibraryCatalog: api.getEmailLibraryCatalog }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NurtureCampaignBar } from "@/features/tc/nurture/NurtureCampaignBar";
import { NurtureCampaignReview } from "@/features/tc/nurture/NurtureCampaignReview";
import { NurtureOutbox } from "@/features/tc/nurture/NurtureOutbox";
import { TcPageHeader } from "@/features/tc/components/TcShell";

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  // innerHTML carries attributes, not live state: write typed values back.
  document.querySelectorAll("input").forEach((el) => el.setAttribute("value", (el as HTMLInputElement).value));
  document.querySelectorAll("textarea").forEach((el) => {
    el.textContent = (el as HTMLTextAreaElement).value;
  });
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

function wrap(node: React.ReactNode) {
  const { hook } = memoryLocation({ path: "/tc/texts" });
  return render(<WouterRouter hook={hook}>{node}</WouterRouter>);
}

const TRACKS: NurtureCaseResponse["tracks"] = [
  { trackKey: "warm_followup", label: "Warm Follow-Up", goal: "Schedule presented treatment while it's fresh.", intensity: "standard", touchCount: 6, channels: ["sms", "email"], available: false, reason: "already_enrolled", libraryAvailable: false, libraryBlockedReason: "This case already has a campaign running or paused." },
];

afterEach(() => cleanup());

describe.skipIf(!process.env.TC_SHOTS)("nurture approve-up-front shots", () => {
  api.getEmailLibraryCatalog.mockResolvedValue(CATALOG);
  api.getNurtureCampaign.mockResolvedValue(campaignResponse());
  api.renderEmail.mockImplementation(async () => rendered(3));

  it("10 review campaign", async () => {
    wrap(<NurtureCampaignReview office="roland" enrollmentId={ENR_A} open onOpenChange={() => {}} />);
    const rows = await screen.findAllByTestId("nurture-review-email");
    await waitFor(() => rows[3].textContent?.includes("What to expect"));
    fireEvent.click(within(rows[3]).getByTestId("nurture-review-preview-toggle"));
    await within(rows[3]).findByTestId("email-preview-frame");
    dump("tcnurture-10-review-campaign@1280x1500");
  });

  it("11 review actions", async () => {
    wrap(<NurtureCampaignReview office="roland" enrollmentId={ENR_A} open onOpenChange={() => {}} />);
    const rows = await screen.findAllByTestId("nurture-review-email");
    fireEvent.click(screen.getByTestId("nurture-approve-all"));
    fireEvent.click(within(rows[3]).getByText("Edit"));
    fireEvent.click(within(rows[4]).getByText("Change date"));
    await waitFor(() => rows[4].textContent?.includes("Cost and payment options"));
    dump("tcnurture-11-review-actions@1280x2300");
  });

  it("12 campaign strip", async () => {
    api.getCaseNurture.mockResolvedValue({ enabled: true, enrollments: [libraryEnrollment()], tracks: TRACKS } satisfies NurtureCaseResponse);
    wrap(
      <div className="p-6">
        <TcPageHeader title="Test 2, Stedi" subtitle="Roland · Dental Crown" />
        <NurtureCampaignBar office="roland" caseId={CASE_A} onCaseChanged={() => {}} />
      </div>,
    );
    await waitFor(() => screen.getByTestId("nurture-chip-pace").textContent?.includes("Dental Crown"));
    await screen.findByText(/3 of 10 approved/);
    dump("tcnurture-12-campaign-strip");
  });

  it("13 outbox campaigns", async () => {
    api.getNurtureOutbox.mockResolvedValue(outboxWithCampaigns());
    wrap(
      <div className="p-6">
        <TcPageHeader title="Texts" subtitle="Nurture Outbox" />
        <NurtureOutbox office="roland" />
      </div>,
    );
    await screen.findAllByTestId("outbox-campaign");
    await waitFor(() => screen.getAllByTestId("outbox-campaign-email")[0].textContent?.includes("Treatment recap"));
    dump("tcnurture-13-outbox-campaigns@1280x1200");
  });
});
