/**
 * Settings → Referral templates: text typed the moment the editor appears is
 * kept. The editor used to copy the stored wording into its draft from a
 * mount-time effect; when that effect flushed after the first keystroke
 * (findBy resolves between the commit and the passive-effect flush) it wiped
 * the typed text and the preview fell back to "No prefill". prod-cd #52.
 *
 * Each case types immediately after the editor is found, with no wait in
 * between, and checks the field and the preview straight away and again after
 * a macrotask (so a late effect would have had its chance to undo it). The
 * case repeats because the race needs the timing to line up.
 *
 * No PHI: no patient is involved; sample values only.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

const { toastMock, ref } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  ref: {
    getReferralTemplates: vi.fn(),
    saveReferralTemplate: vi.fn(),
    logReferralCorrespondence: vi.fn(),
    uploadReferralAttachment: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/referrals/referralsApi", () => ref);

import { ReferralTemplatesCard } from "@/features/tc/settings/ReferralTemplatesCard";
import type { ReferralTemplateState, ReferralTemplatesResponse } from "@shared/tc/referralTemplates";

const MESSAGE = "Dear {specialist_name}, please evaluate {teeth} for {reason}. Thank you, {referring_provider}.";
const MESSAGE_PREVIEW =
  "Dear Dr. Sample Specialist, please evaluate #3, #14 for Evaluate for root canal therapy. Thank you, Dr. Sample Provider.";
const STORED = "Stored wording for {reason}.";
const UPDATED = "Updated wording for {reason}.";

function response(specialistMessage: string): ReferralTemplatesResponse {
  const t: ReferralTemplateState[] = [
    { kind: "specialist_message", body: specialistMessage, updatedBy: null, updatedAt: null },
    { kind: "correspondence_note", body: "", updatedBy: null, updatedAt: null },
  ];
  return { success: true, office: "roland", canEdit: true, templates: t };
}

const macrotask = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("Settings: Referral templates — typing as the editor appears", () => {
  for (let i = 1; i <= 10; i++) {
    it(`keeps the typed text and its preview (blank stored template, run ${i})`, async () => {
      ref.getReferralTemplates.mockResolvedValue(response(""));
      render(<ReferralTemplatesCard office="roland" />);
      const message = await screen.findByTestId("tc-ref-template-specialist_message");
      const input = within(message).getByTestId("tc-ref-template-specialist_message-input") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: MESSAGE } });

      expect(input.value).toBe(MESSAGE);
      expect(within(message).getByTestId("tc-ref-template-specialist_message-preview").textContent).toBe(MESSAGE_PREVIEW);
      await macrotask();
      expect(input.value).toBe(MESSAGE);
      expect(within(message).getByTestId("tc-ref-template-specialist_message-preview").textContent).toBe(MESSAGE_PREVIEW);
      expect((within(message).getByTestId("tc-ref-template-specialist_message-save") as HTMLButtonElement).disabled).toBe(false);
    });
  }

  for (let i = 1; i <= 5; i++) {
    it(`keeps the typed text over a stored template (run ${i})`, async () => {
      ref.getReferralTemplates.mockResolvedValue(response(STORED));
      render(<ReferralTemplatesCard office="roland" />);
      const message = await screen.findByTestId("tc-ref-template-specialist_message");
      const input = within(message).getByTestId("tc-ref-template-specialist_message-input") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: MESSAGE } });

      expect(input.value).toBe(MESSAGE);
      await macrotask();
      expect(input.value).toBe(MESSAGE);
      expect(within(message).getByTestId("tc-ref-template-specialist_message-preview").textContent).toBe(MESSAGE_PREVIEW);
    });
  }

  it("still takes the server's read-back after a save (the re-sync is kept for real changes)", async () => {
    ref.getReferralTemplates.mockResolvedValue(response(STORED));
    ref.saveReferralTemplate.mockImplementation(async (_office: string, kind: string) => ({
      kind,
      body: UPDATED,
      updatedBy: "admin@carein.ai",
      updatedAt: "2026-11-12T12:00:00.000Z",
    }));
    render(<ReferralTemplatesCard office="roland" />);
    const message = await screen.findByTestId("tc-ref-template-specialist_message");
    const input = within(message).getByTestId("tc-ref-template-specialist_message-input") as HTMLTextAreaElement;
    expect(input.value).toBe(STORED);
    fireEvent.change(input, { target: { value: "Typed wording for {reason}." } });
    fireEvent.click(within(message).getByTestId("tc-ref-template-specialist_message-save"));
    await waitFor(() => expect(input.value).toBe(UPDATED));
    await within(message).findByText(/Saved by admin@carein.ai/);
  });
});
