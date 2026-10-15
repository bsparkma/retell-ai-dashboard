/**
 * Settings → Referrals (queue item 52, R1), in jsdom.
 *
 *   1  the specialist directory: list, add (validated), edit, deactivate via
 *      the form, delete with a confirmation, show-inactive; the rows shown are
 *      the server's answer
 *   2  the two policies: admin-only switches; a non-admin sees them read-only;
 *      an env-pinned policy is locked
 *   3  dark: the section is absent from the nav unless /status says on (and a
 *      failed status check reads as off)
 *
 * With TC_SHOTS=1 it also dumps the section for the checkout/TC shooter
 * (tccheckout-08-referrals-settings). NO NETWORK, NO BACKEND, NO PHI.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TcReferralDirectoryEntry, TcReferralSettingsResponse } from "@shared/tc/referrals";

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

const refMock = vi.hoisted(() => ({
  getReferralsStatus: vi.fn(),
  listDirectory: vi.fn(),
  createDirectoryEntry: vi.fn(),
  updateDirectoryEntry: vi.fn(),
  deleteDirectoryEntry: vi.fn(),
  getReferralSettings: vi.fn(),
  updateReferralSettings: vi.fn(),
}));
vi.mock("@/features/tc/referrals/referralsApi", () => refMock);

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: vi.fn(() => ({
    status: "authenticated" as const,
    user: { name: "TC User", email: "tc@carein.ai", tenantId: "tenant-1", tenant: { slug: "x", displayName: "X", modules: ["tc"] } },
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
import { ReferralsSection } from "@/features/tc/settings/ReferralsSection";

function entry(over: Partial<TcReferralDirectoryEntry> = {}): TcReferralDirectoryEntry {
  return {
    entryId: "8a1c2d3e-4f50-4a61-8b72-938495a6b7c8",
    officeId: "roland",
    practiceName: "River Endodontics",
    specialistName: "Dr. Endo Example",
    specialty: "Endodontics",
    contactPerson: "Front Desk",
    email: "referrals@endo.example",
    phone: "479-555-0100",
    fax: "",
    notes: "",
    preferredFormatNotes: "PDF with periapical",
    active: true,
    createdBy: "tc@carein.ai",
    createdAt: "2026-10-15T15:00:00.000Z",
    updatedBy: "tc@carein.ai",
    updatedAt: "2026-10-15T15:00:00.000Z",
    ...over,
  };
}

function settings(over: Partial<TcReferralSettingsResponse> = {}): TcReferralSettingsResponse {
  return {
    success: true,
    office: "roland",
    signoffRequired: { value: true, source: "default" },
    autosendOnApproval: { value: false, source: "default" },
    canEdit: true,
    updatedBy: null,
    updatedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
  refMock.listDirectory.mockResolvedValue([entry()]);
  refMock.getReferralSettings.mockResolvedValue(settings());
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

function navLabels() {
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  return within(nav).getAllByRole("button").map((b) => b.textContent?.trim());
}

describe("3: the Referrals section is dark until /status says on", () => {
  it("absent when referrals is off for the office", async () => {
    refMock.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: false });
    render(<TcSettings />);
    await waitFor(() => expect(refMock.getReferralsStatus).toHaveBeenCalledWith("roland"));
    expect(navLabels()).not.toContain("Referrals");
  });

  it("absent when the status check fails (reads as off)", async () => {
    refMock.getReferralsStatus.mockRejectedValue(new Error("down"));
    render(<TcSettings />);
    await waitFor(() => expect(refMock.getReferralsStatus).toHaveBeenCalled());
    expect(navLabels()).not.toContain("Referrals");
  });

  it("a #referrals deep link while off lands on Practice, not a hidden section", async () => {
    window.location.hash = "#referrals";
    refMock.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: false });
    render(<TcSettings />);
    await waitFor(() => expect(refMock.getReferralsStatus).toHaveBeenCalled());
    expect(screen.getByRole("region").getAttribute("aria-label")).toBe("Practice");
    expect(refMock.listDirectory).not.toHaveBeenCalled();
  });

  it("present, last in the nav, when on — and it opens the directory", async () => {
    refMock.getReferralsStatus.mockResolvedValue({ success: true, office: "roland", enabled: true });
    render(<TcSettings />);
    await waitFor(() => expect(navLabels().at(-1)).toBe("Referrals"));
    fireEvent.click(screen.getByRole("button", { name: "Referrals" }));
    expect(await screen.findByText("River Endodontics")).toBeTruthy();
    expect(refMock.listDirectory).toHaveBeenCalledWith("roland", false);
  });
});

describe("1: the specialist directory", () => {
  it("lists the office's specialists with contact and status", async () => {
    render(<ReferralsSection office="roland" />);
    const row = (await screen.findAllByTestId("tc-referral-entry"))[0];
    expect(within(row).getByText("River Endodontics")).toBeTruthy();
    expect(within(row).getByText("Dr. Endo Example")).toBeTruthy();
    expect(within(row).getByText(/Front Desk · 479-555-0100 · referrals@endo\.example/)).toBeTruthy();
    expect(within(row).getByText("Active")).toBeTruthy();
  });

  it("an empty directory says how to start", async () => {
    refMock.listDirectory.mockResolvedValue([]);
    render(<ReferralsSection office="roland" />);
    expect(await screen.findByText(/No specialists yet/)).toBeTruthy();
  });

  it("add: a bad email is caught on the form and nothing is sent; a good one is saved and the list reloads", async () => {
    refMock.createDirectoryEntry.mockResolvedValue(entry({ entryId: "9a1c2d3e-4f50-4a61-8b72-938495a6b7c8", practiceName: "Ortho Group" }));
    render(<ReferralsSection office="roland" />);
    fireEvent.click(await screen.findByRole("button", { name: /Add specialist/ }));
    const dialog = await screen.findByTestId("tc-referral-entry-dialog");
    fireEvent.change(within(dialog).getByLabelText(/Practice name/), { target: { value: "Ortho Group" } });
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "not-an-email" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add specialist" }));
    expect(await within(dialog).findByText("That email address does not look right")).toBeTruthy();
    expect(refMock.createDirectoryEntry).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "hello@ortho.example" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add specialist" }));
    await waitFor(() => expect(refMock.createDirectoryEntry).toHaveBeenCalledTimes(1));
    const [office, input] = refMock.createDirectoryEntry.mock.calls[0];
    expect(office).toBe("roland");
    expect(input).toMatchObject({ practiceName: "Ortho Group", email: "hello@ortho.example", active: true });
    expect(input).not.toHaveProperty("officeId");
    await waitFor(() => expect(refMock.listDirectory).toHaveBeenCalledTimes(2));
    expect(toastMock.success).toHaveBeenCalledWith("Specialist added");
  });

  it("add: a practice name is required", async () => {
    render(<ReferralsSection office="roland" />);
    fireEvent.click(await screen.findByRole("button", { name: /Add specialist/ }));
    const dialog = await screen.findByTestId("tc-referral-entry-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add specialist" }));
    expect(await within(dialog).findByText("Practice name is required")).toBeTruthy();
    expect(refMock.createDirectoryEntry).not.toHaveBeenCalled();
  });

  it("edit pre-fills the form and can mark the specialist inactive", async () => {
    refMock.updateDirectoryEntry.mockResolvedValue(entry({ active: false }));
    render(<ReferralsSection office="roland" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit River Endodontics" }));
    const dialog = await screen.findByTestId("tc-referral-entry-dialog");
    expect((within(dialog).getByLabelText(/Practice name/) as HTMLInputElement).value).toBe("River Endodontics");
    fireEvent.click(within(dialog).getByRole("switch"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(refMock.updateDirectoryEntry).toHaveBeenCalledTimes(1));
    const [, id, input] = refMock.updateDirectoryEntry.mock.calls[0];
    expect(id).toBe(entry().entryId);
    expect(input.active).toBe(false);
  });

  it("delete asks first; a refusal (named on a referral) is shown and the row stays", async () => {
    refMock.deleteDirectoryEntry.mockRejectedValue(
      new Error("A referral names this specialist, so it cannot be deleted. Mark it inactive instead."),
    );
    render(<ReferralsSection office="roland" />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete River Endodontics" }));
    const confirm = await screen.findByTestId("tc-referral-delete-dialog");
    expect(refMock.deleteDirectoryEntry).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(expect.stringMatching(/Mark it inactive instead/)));
    expect(screen.getByText("River Endodontics")).toBeTruthy();
  });

  it("show inactive asks the server for them", async () => {
    render(<ReferralsSection office="roland" />);
    await screen.findByText("River Endodontics");
    fireEvent.click(screen.getByLabelText("Show inactive"));
    await waitFor(() => expect(refMock.listDirectory).toHaveBeenLastCalledWith("roland", true));
  });
});

describe("2: the policies", () => {
  it("an admin flips sign-off and the switch shows the server's answer", async () => {
    refMock.updateReferralSettings.mockResolvedValue(settings({ signoffRequired: { value: false, source: "office" } }));
    render(<ReferralsSection office="roland" />);
    const signoff = await screen.findByRole("switch", { name: /Doctor signs off/ });
    expect(signoff.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(signoff);
    await waitFor(() => expect(refMock.updateReferralSettings).toHaveBeenCalledWith("roland", { signoffRequired: false }));
    await waitFor(() => expect(signoff.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getAllByText("Set for this office").length).toBeGreaterThan(0);
  });

  it("a non-admin sees the policies read-only", async () => {
    refMock.getReferralSettings.mockResolvedValue(settings({ canEdit: false }));
    render(<ReferralsSection office="roland" />);
    expect(await screen.findByText(/Only a practice admin can change these/)).toBeTruthy();
    for (const name of [/Doctor signs off/, /Send automatically/]) {
      expect((screen.getByRole("switch", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("an env-pinned policy is locked even for an admin", async () => {
    refMock.getReferralSettings.mockResolvedValue(settings({ autosendOnApproval: { value: false, source: "env" } }));
    render(<ReferralsSection office="roland" />);
    const autosend = await screen.findByRole("switch", { name: /Send automatically/ });
    expect((autosend as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Locked by a safety setting")).toBeTruthy();
  });
});

const SHOOT = process.env.TC_SHOTS === "1";
describe.skipIf(!SHOOT)("tc referrals settings screenshot dump", () => {
  it("08 — Settings → Referrals", async () => {
    refMock.listDirectory.mockResolvedValue([
      entry(),
      entry({ entryId: "9a1c2d3e-4f50-4a61-8b72-938495a6b7c8", practiceName: "Valley Oral Surgery", specialistName: "Dr. Surgeon Example", specialty: "Oral surgery", contactPerson: "Referral line", email: "", phone: "479-555-0142" }),
    ]);
    render(
      <div className="p-6 max-w-5xl">
        <ReferralsSection office="roland" />
      </div>,
    );
    await screen.findByText("Valley Oral Surgery");
    const out = resolve(import.meta.dirname, ".shots");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "tccheckout-08-referrals-settings@1280x900.html"), document.body.innerHTML, "utf8");
  });
});
