/**
 * R6.3 — Settings → Email identity: "Send a copy to (BCC)", in jsdom.
 *
 *   - the box says what it does, that the specialist never sees it, and that
 *     the copy inbox should be a mailbox the PRACTICE controls
 *   - nothing saved = "No copy is sent"; what is shown after a save is the
 *     server's answer (lowercased), never what was typed
 *   - a typed address is sent trimmed; an emptied box is sent as null (no copy)
 *   - the From stays read-only; the other fields go with the save unchanged
 *
 * NO NETWORK, NO BACKEND, NO PHI.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TcEmailIdentityResponse } from "@shared/tc/emailIdentity";

(globalThis as Record<string, unknown>).React = React;

vi.mock("@/features/tc/api", () => ({
  tcErrorMessage: (e: unknown) => (e instanceof Error ? e.message : "Something went wrong."),
}));
const idMock = vi.hoisted(() => ({ getEmailIdentity: vi.fn(), saveEmailIdentity: vi.fn() }));
vi.mock("@/features/tc/emailIdentity/emailIdentityApi", () => idMock);
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import { EmailIdentitySection } from "@/features/tc/settings/EmailIdentitySection";

const NONE = (setting: string) => ({ value: null, source: "none" as const, stored: null, fallback: null, fallbackSetting: setting });

function identity(referralBcc: string | null | undefined): TcEmailIdentityResponse {
  return {
    success: true,
    office: "roland",
    fields: {
      replyTo: {
        value: "frontdesk@roland.example.test",
        source: "stored",
        stored: "frontdesk@roland.example.test",
        fallback: null,
        fallbackSetting: "ACS_EMAIL_REPLY_TO_ROLAND",
      },
      practiceName: NONE("TC_EMAIL_PRACTICE_NAME_ROLAND"),
      practicePhone: NONE("TC_EMAIL_PRACTICE_PHONE_ROLAND"),
    },
    ...(referralBcc === undefined ? {} : { referralBcc }),
    from: { patientEmail: "donotreply@roland.example.test", referral: "donotreply@roland.example.test" },
    policyKnown: true,
    updatedAt: null,
    updatedBy: null,
  };
}

const BCC = "tc-email-identity-referralBcc";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("Send a copy to (BCC)", () => {
  it("explains itself — blind, referral letters, a practice-controlled mailbox — and says when no copy is sent", async () => {
    idMock.getEmailIdentity.mockResolvedValue(identity(null));
    render(<EmailIdentitySection office="roland" />);
    await screen.findByTestId("tc-email-identity-section");
    expect(screen.getByLabelText("Send a copy to (BCC)")).toBeTruthy();
    const hint = screen.getByTestId(`${BCC}-hint`).textContent ?? "";
    expect(hint).toContain("Every referral letter from this office is blind-copied here");
    expect(hint).toContain("the specialist never sees it");
    expect(hint).toContain("a mailbox the practice controls");
    expect(hint).toContain("Leave it empty for no copy");
    expect(screen.getByTestId(`${BCC}-in-use`).textContent).toBe("No copy is sent");
    expect((screen.getByTestId(BCC) as HTMLInputElement).value).toBe("");
  });

  it("an older server that omits it reads as no copy", async () => {
    idMock.getEmailIdentity.mockResolvedValue(identity(undefined));
    render(<EmailIdentitySection office="roland" />);
    expect((await screen.findByTestId(`${BCC}-in-use`)).textContent).toBe("No copy is sent");
  });

  it("saves trimmed with the rest of the identity, and shows the SERVER's answer", async () => {
    idMock.getEmailIdentity.mockResolvedValue(identity(null));
    idMock.saveEmailIdentity.mockResolvedValue(identity("referral-copies@roland.example.test"));
    render(<EmailIdentitySection office="roland" />);
    await screen.findByTestId("tc-email-identity-section");
    const save = screen.getByTestId("tc-email-identity-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByTestId(BCC), { target: { value: "  Referral-Copies@Roland.example.test " } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(idMock.saveEmailIdentity).toHaveBeenCalledWith("roland", {
        replyTo: "frontdesk@roland.example.test",
        practiceName: null,
        practicePhone: null,
        referralBcc: "Referral-Copies@Roland.example.test",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId(`${BCC}-in-use`).textContent).toBe("In use: referral-copies@roland.example.test"),
    );
    expect((screen.getByTestId(BCC) as HTMLInputElement).value).toBe("referral-copies@roland.example.test");
  });

  it("emptying the box sends null — no copy", async () => {
    idMock.getEmailIdentity.mockResolvedValue(identity("referral-copies@roland.example.test"));
    idMock.saveEmailIdentity.mockResolvedValue(identity(null));
    render(<EmailIdentitySection office="roland" />);
    await screen.findByTestId("tc-email-identity-section");
    expect(screen.getByTestId(`${BCC}-in-use`).textContent).toBe("In use: referral-copies@roland.example.test");
    fireEvent.change(screen.getByTestId(BCC), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("tc-email-identity-save"));
    await waitFor(() =>
      expect(idMock.saveEmailIdentity).toHaveBeenCalledWith("roland", expect.objectContaining({ referralBcc: null })),
    );
    await waitFor(() => expect(screen.getByTestId(`${BCC}-in-use`).textContent).toBe("No copy is sent"));
  });
});
