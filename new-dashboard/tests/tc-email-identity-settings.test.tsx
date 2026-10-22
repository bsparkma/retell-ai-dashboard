/**
 * Settings → Email identity (R5c), in jsdom.
 *
 *   1  in the nav only for a caller who holds tc.notification_defaults (admin,
 *      office); absent for everyone else
 *   2  each field says what is in use and where it comes from; the From
 *      address is shown read-only with the "managed by the platform" line, and
 *      there is no box to type one into
 *   3  Save sends the WHOLE identity (trimmed; an empty box is null = back to
 *      the app setting), and what is shown afterwards is the server's answer,
 *      not what was typed
 *   4  a refused save shows the server's sentence and keeps what was in force
 *
 * NO NETWORK, NO BACKEND, NO PHI.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TcEmailIdentityResponse } from "@shared/tc/emailIdentity";

(globalThis as Record<string, unknown>).React = React;

const apiMock = vi.hoisted(() => {
  class TcApiError extends Error {
    status = 500;
    code: string | null = null;
    feature: string | null = null;
    issues: { path: string; code: string; message: string }[] = [];
  }
  return {
    getLibrary: vi.fn(async () => ({})),
    getLibrarySection: vi.fn(),
    putLibrarySection: vi.fn(),
    odStatus: vi.fn(async () => ({
      office: "roland" as const,
      officeName: "Roland Family Dental",
      odConnected: true,
      reachable: true,
      detail: "",
      writeEnabled: false,
    })),
    isOdNotConnected: vi.fn(() => false),
    tcErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : "Something went wrong.")),
    TcApiError,
  };
});
vi.mock("@/features/tc/api", () => apiMock);

const idMock = vi.hoisted(() => ({ getEmailIdentity: vi.fn(), saveEmailIdentity: vi.fn() }));
vi.mock("@/features/tc/emailIdentity/emailIdentityApi", () => idMock);

vi.mock("@/features/tc/referrals/referralsApi", () => ({
  getReferralsStatus: vi.fn(async () => ({ success: true, office: "roland", enabled: false })),
}));

const authState = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: vi.fn(() => ({
    status: "authenticated" as const,
    user: {
      name: "Office Manager",
      email: "om@carein.ai",
      tenantId: "tenant-1",
      tenant: { slug: "x", displayName: "X", modules: ["tc"] },
      permissions: authState.permissions,
    },
  })),
}));
vi.mock("@/contexts/OfficeContext", () => ({
  ALL_OFFICES: "all",
  useOffice: vi.fn(() => ({
    offices: [{ officeId: "roland", officeName: "Roland Family Dental", odConnected: true }],
    office: "roland",
    setOffice: vi.fn(),
    selected: { officeId: "roland", officeName: "Roland Family Dental", odConnected: true },
    loading: false,
  })),
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import TcSettings from "@/pages/tc/TcSettings";
import { EmailIdentitySection } from "@/features/tc/settings/EmailIdentitySection";

function identity(over: Partial<TcEmailIdentityResponse["fields"]> = {}): TcEmailIdentityResponse {
  return {
    success: true,
    office: "roland",
    fields: {
      replyTo: {
        value: "env@roland.example.test",
        source: "env",
        stored: null,
        fallback: "env@roland.example.test",
        fallbackSetting: "ACS_EMAIL_REPLY_TO_ROLAND",
      },
      practiceName: {
        value: null,
        source: "none",
        stored: null,
        fallback: null,
        fallbackSetting: "TC_EMAIL_PRACTICE_NAME_ROLAND",
      },
      practicePhone: {
        value: "(918) 555-0142",
        source: "stored",
        stored: "(918) 555-0142",
        fallback: null,
        fallbackSetting: "TC_EMAIL_PRACTICE_PHONE_ROLAND",
      },
      ...over,
    },
    from: { patientEmail: "donotreply@roland.example.test", referral: "donotreply@roland.example.test" },
    policyKnown: true,
    updatedAt: null,
    updatedBy: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
  authState.permissions = [];
  idMock.getEmailIdentity.mockResolvedValue(identity());
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

function navLabels() {
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  return within(nav).getAllByRole("button").map((b) => b.textContent?.trim());
}

describe("1: the section is shown only to admin and office", () => {
  it("is in the nav, after Notifications, for a caller holding tc.notification_defaults", async () => {
    authState.permissions = ["tc.full", "tc.notification_defaults"];
    render(<TcSettings />);
    await screen.findByRole("region", { name: "Practice" });
    const labels = navLabels();
    expect(labels).toContain("Email identity");
    expect(labels.indexOf("Email identity")).toBe(labels.indexOf("Notifications") + 1);
  });

  it("is absent for a caller without it (a TC), even on a deep link", async () => {
    authState.permissions = ["tc.full"];
    window.location.hash = "#email_identity";
    render(<TcSettings />);
    expect(await screen.findByRole("region", { name: "Practice" })).toBeTruthy();
    expect(navLabels()).not.toContain("Email identity");
    expect(idMock.getEmailIdentity).not.toHaveBeenCalled();
  });
});

describe("2: what is in force, and the From read-only", () => {
  it("says where each value comes from and locks the From address", async () => {
    render(<EmailIdentitySection office="roland" />);
    await screen.findByTestId("tc-email-identity-section");
    expect(screen.getByTestId("tc-email-identity-replyTo-in-use").textContent).toBe(
      "In use: env@roland.example.test (from the app setting ACS_EMAIL_REPLY_TO_ROLAND)",
    );
    expect(screen.getByTestId("tc-email-identity-practiceName-in-use").textContent).toBe("Not set");
    expect(screen.getByTestId("tc-email-identity-practicePhone-in-use").textContent).toBe(
      "In use: (918) 555-0142 (saved here)",
    );
    const from = screen.getByTestId("tc-email-identity-from");
    expect(from.textContent).toContain("donotreply@roland.example.test");
    expect(from.textContent).toContain("Managed by the platform");
    expect(within(from).queryByRole("textbox")).toBeNull();
    // Three boxes, none of them the From.
    expect(screen.getAllByRole("textbox")).toHaveLength(3);
    expect(screen.queryAllByRole("textbox", { name: /from/i })).toHaveLength(0);
  });

  it("names the referral sender separately when it differs from the patient-email one", async () => {
    idMock.getEmailIdentity.mockResolvedValue({
      ...identity(),
      from: { patientEmail: "donotreply@shared.example.test", referral: null },
    });
    render(<EmailIdentitySection office="roland" />);
    expect((await screen.findByTestId("tc-email-identity-from-referral")).textContent).toContain(
      "no sending address for this office yet",
    );
  });
});

describe("3: save sends the whole identity and shows the server's answer", () => {
  it("trims, sends an empty box as null, and renders the read-back", async () => {
    idMock.saveEmailIdentity.mockResolvedValue(
      identity({
        replyTo: {
          value: "frontdesk@roland.example.test",
          source: "stored",
          stored: "frontdesk@roland.example.test",
          fallback: "env@roland.example.test",
          fallbackSetting: "ACS_EMAIL_REPLY_TO_ROLAND",
        },
        practicePhone: {
          value: null,
          source: "none",
          stored: null,
          fallback: null,
          fallbackSetting: "TC_EMAIL_PRACTICE_PHONE_ROLAND",
        },
      }),
    );
    render(<EmailIdentitySection office="roland" />);
    await screen.findByTestId("tc-email-identity-section");
    const save = screen.getByTestId("tc-email-identity-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("tc-email-identity-replyTo"), { target: { value: "  FrontDesk@Roland.example.test " } });
    fireEvent.change(screen.getByTestId("tc-email-identity-practicePhone"), { target: { value: "" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() =>
      expect(idMock.saveEmailIdentity).toHaveBeenCalledWith("roland", {
        replyTo: "FrontDesk@Roland.example.test",
        practiceName: null,
        practicePhone: null,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("tc-email-identity-replyTo-in-use").textContent).toBe(
        "In use: frontdesk@roland.example.test (saved here)",
      ),
    );
    expect((screen.getByTestId("tc-email-identity-replyTo") as HTMLInputElement).value).toBe(
      "frontdesk@roland.example.test",
    );
    expect(screen.getByTestId("tc-email-identity-practicePhone-in-use").textContent).toBe("Not set");
    expect(toastMock.success).toHaveBeenCalledWith("Saved");
  });
});

describe("4: a refused save", () => {
  it("shows the server's sentence and leaves what is in force on screen", async () => {
    idMock.saveEmailIdentity.mockRejectedValue(new Error("replyTo: must be one plain email address"));
    render(<EmailIdentitySection office="roland" />);
    await screen.findByTestId("tc-email-identity-section");
    fireEvent.change(screen.getByTestId("tc-email-identity-replyTo"), { target: { value: "not an address" } });
    fireEvent.submit(screen.getByTestId("tc-email-identity-save").closest("form") as HTMLFormElement);
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("replyTo: must be one plain email address"));
    expect(screen.getByTestId("tc-email-identity-replyTo-in-use").textContent).toBe(
      "In use: env@roland.example.test (from the app setting ACS_EMAIL_REPLY_TO_ROLAND)",
    );
  });
});
