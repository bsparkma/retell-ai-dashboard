/**
 * Setup polish — Admin → Email identity gets a "Practice address" box.
 *
 *   1  a multi-line textarea with the same "In use: … (saved here / app
 *      setting)" line as the phone
 *   2  Save sends the address (trimmed; empty = null = back to the app
 *      setting) with the rest of the identity, and shows the server's answer
 *   3  against a server that does not report the address, there is no box and
 *      the request carries no practiceAddress (its strict body would refuse it)
 *
 * NO NETWORK, NO BACKEND, NO PHI: synthetic office details.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TcEmailIdentityRequest, type TcEmailIdentityFieldState, type TcEmailIdentityResponse } from "@shared/tc/emailIdentity";

(globalThis as Record<string, unknown>).React = React;

vi.mock("@/features/tc/api", () => ({
  tcErrorMessage: (e: unknown) => (e instanceof Error ? e.message : "Something went wrong."),
}));
const idMock = vi.hoisted(() => ({ getEmailIdentity: vi.fn(), saveEmailIdentity: vi.fn() }));
vi.mock("@/features/tc/emailIdentity/emailIdentityApi", () => idMock);
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import { EmailIdentitySection } from "@/features/tc/settings/EmailIdentitySection";

const NONE = (setting: string): TcEmailIdentityFieldState => ({
  value: null,
  source: "none",
  stored: null,
  fallback: null,
  fallbackSetting: setting,
});

function identity(address: TcEmailIdentityFieldState | undefined): TcEmailIdentityResponse {
  return {
    success: true,
    office: "roland",
    fields: {
      replyTo: NONE("ACS_EMAIL_REPLY_TO_ROLAND"),
      practiceName: NONE("TC_EMAIL_PRACTICE_NAME_ROLAND"),
      practicePhone: NONE("TC_EMAIL_PRACTICE_PHONE_ROLAND"),
      ...(address ? { practiceAddress: address } : {}),
    },
    referralBcc: null,
    from: { patientEmail: "donotreply@roland.example.test", referral: "donotreply@roland.example.test" },
    policyKnown: true,
    updatedAt: null,
    updatedBy: null,
  };
}

const ENV_ADDRESS: TcEmailIdentityFieldState = {
  value: "9 Fallback Rd, Example OK 00000",
  source: "env",
  stored: null,
  fallback: "9 Fallback Rd, Example OK 00000",
  fallbackSetting: "TC_EMAIL_PRACTICE_ADDRESS_ROLAND",
};
const SAVED = "1 Example St\nExample OK 00000";
const STORED_ADDRESS: TcEmailIdentityFieldState = { ...ENV_ADDRESS, value: SAVED, source: "stored", stored: SAVED };

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("1: the Practice address box", () => {
  it("is a multi-line textarea saying what is in use and where it comes from", async () => {
    idMock.getEmailIdentity.mockResolvedValue(identity(ENV_ADDRESS));
    render(<EmailIdentitySection office="roland" />);
    const box = (await screen.findByTestId("tc-email-identity-practiceAddress")) as HTMLTextAreaElement;
    expect(box.tagName).toBe("TEXTAREA");
    expect(box.maxLength).toBe(300);
    expect(screen.getByLabelText("Practice address")).toBe(box);
    expect(screen.getByTestId("tc-email-identity-practiceAddress-in-use").textContent).toBe(
      "In use: 9 Fallback Rd, Example OK 00000 (from the app setting TC_EMAIL_PRACTICE_ADDRESS_ROLAND)",
    );
    cleanup();

    idMock.getEmailIdentity.mockResolvedValue(identity(STORED_ADDRESS));
    render(<EmailIdentitySection office="roland" />);
    const saved = (await screen.findByTestId("tc-email-identity-practiceAddress")) as HTMLTextAreaElement;
    expect(saved.value).toBe(SAVED);
    expect(screen.getByTestId("tc-email-identity-practiceAddress-in-use").textContent).toBe(`In use: ${SAVED} (saved here)`);
  });
});

describe("2: Save sends the address", () => {
  it("sends the typed lines (trimmed) and shows the server's answer; an empty box clears it", async () => {
    idMock.getEmailIdentity.mockResolvedValue(identity(ENV_ADDRESS));
    idMock.saveEmailIdentity.mockResolvedValueOnce(identity(STORED_ADDRESS));
    render(<EmailIdentitySection office="roland" />);
    const box = await screen.findByTestId("tc-email-identity-practiceAddress");
    const save = screen.getByTestId("tc-email-identity-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(box, { target: { value: `  ${SAVED}  ` } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(idMock.saveEmailIdentity).toHaveBeenCalledTimes(1));
    const [office, body] = idMock.saveEmailIdentity.mock.calls[0] as [string, unknown];
    expect(office).toBe("roland");
    expect(body).toEqual({ replyTo: null, practiceName: null, practicePhone: null, referralBcc: null, practiceAddress: SAVED });
    expect(TcEmailIdentityRequest.safeParse(body).success).toBe(true);
    await waitFor(() =>
      expect(screen.getByTestId("tc-email-identity-practiceAddress-in-use").textContent).toBe(`In use: ${SAVED} (saved here)`),
    );

    // Clearing the box sends null: back to the app setting.
    idMock.saveEmailIdentity.mockResolvedValueOnce(identity(ENV_ADDRESS));
    fireEvent.change(screen.getByTestId("tc-email-identity-practiceAddress"), { target: { value: "   " } });
    fireEvent.click(save);
    await waitFor(() => expect(idMock.saveEmailIdentity).toHaveBeenCalledTimes(2));
    expect((idMock.saveEmailIdentity.mock.calls[1] as [string, Record<string, unknown>])[1].practiceAddress).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("tc-email-identity-practiceAddress-in-use").textContent).toContain("from the app setting"),
    );
  });
});

describe("3: an older server that does not report the address", () => {
  it("shows no box and sends no practiceAddress", async () => {
    idMock.getEmailIdentity.mockResolvedValue(identity(undefined));
    idMock.saveEmailIdentity.mockResolvedValue(identity(undefined));
    render(<EmailIdentitySection office="roland" />);
    fireEvent.change(await screen.findByTestId("tc-email-identity-practicePhone"), { target: { value: "(555) 010-0001" } });
    expect(screen.queryByTestId("tc-email-identity-practiceAddress")).toBeNull();
    fireEvent.click(screen.getByTestId("tc-email-identity-save"));
    await waitFor(() => expect(idMock.saveEmailIdentity).toHaveBeenCalledTimes(1));
    const body = (idMock.saveEmailIdentity.mock.calls[0] as [string, Record<string, unknown>])[1];
    expect("practiceAddress" in body).toBe(false);
  });
});
