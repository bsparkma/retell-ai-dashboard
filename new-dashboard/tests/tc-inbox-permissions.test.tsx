/**
 * Pre-IA fix F3 (docs/reports/feature-tc-incoming-work-ia.md §4 D1, §7):
 * the TC Inbox hides Claim and Open case from users without tc.full.
 *
 * The page is on the Hygiene grant, so a hygienist can read it. But Claim
 * 403s without tc.full and /tc/cases/:id bounces them home, so neither door
 * is drawn for them — and the patient's name is not a link either.
 *
 * Also pins the F8 title: the page is called "TC Inbox", like its nav item.
 *
 * No PHI: the patient is the synthetic Roland fixture.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const authMock = vi.hoisted(() => ({ permissions: [] as string[], isSuperAdmin: false }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: {
      name: "Viewer",
      email: "viewer@carein.ai",
      tenantId: "t1",
      tenant: { slug: "carein", displayName: "CareIN", modules: ["tc"] },
      role: "hygiene",
      isSuperAdmin: authMock.isSuperAdmin,
      permissions: authMock.permissions,
    },
  }),
}));

vi.mock("@/features/tc/officeScope", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/tc/officeScope")>();
  return {
    ...real,
    useTcOfficeScope: () => ({ offices: ["roland"], loading: false, showOfficeBadges: false }),
  };
});

const apiMock = vi.hoisted(() => ({ hygieneInbox: vi.fn(), claimHygieneCase: vi.fn() }));
vi.mock("@/features/tc/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/tc/api")>();
  return { ...real, ...apiMock };
});

import TcHygieneInbox from "@/pages/tc/TcHygieneInbox";

const CASE_ID = "11111111-1111-4111-8111-111111111111";

function inboxRow() {
  return {
    intakeId: "22222222-2222-4222-8222-222222222222",
    caseId: CASE_ID,
    officeId: "roland",
    submittedBy: "hygienist@carein.ai",
    submittedByName: "Hygiene",
    hygienistName: "HYG1",
    submittedAt: "2026-10-22T15:00:00.000Z",
    visitDate: "2026-10-22",
    chiefConcern: "",
    perioStatus: "healthy",
    recallType: "prophy",
    radiographs: [],
    intraoralPhotosTaken: false,
    areasOfConcern: "",
    suspectedTreatment: "Crown",
    hygienistRecommendation: "",
    insuranceNoted: "",
    patientInterestLevel: "warm",
    flagUrgent: false,
    patientName: "Test 2, Stedi",
    patientAge: null,
    phone: null,
    category: "single_tooth",
    urgency: "medium",
    diagnosingProvider: null,
    odPatientId: 12827,
    orthoScreening: null,
  };
}

beforeEach(() => {
  authMock.permissions = [];
  authMock.isSuperAdmin = false;
  apiMock.hygieneInbox.mockReset();
  apiMock.hygieneInbox.mockResolvedValue([inboxRow()]);
  apiMock.claimHygieneCase.mockReset();
});
afterEach(cleanup);

describe("F3: TC Inbox actions follow tc.full", () => {
  it("a hygienist (tc.hygiene only) sees the queue but no Claim, no Open case, and no case link", async () => {
    authMock.permissions = ["tc.hygiene", "hyg.visit"];
    render(<TcHygieneInbox />);
    expect(await screen.findByText("Test 2, Stedi")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /claim/i })).toBeNull();
    expect(screen.queryByText("Open case")).toBeNull();
    expect(document.querySelector(`a[href="/tc/cases/${CASE_ID}"]`)).toBeNull();
    expect(screen.getByText("Hygiene handoffs waiting for a treatment coordinator to claim them")).toBeTruthy();
  });

  it("a TC (tc.full) gets Claim and Open case, and Claim writes", async () => {
    authMock.permissions = ["tc.full", "tc.hygiene"];
    apiMock.claimHygieneCase.mockResolvedValue({});
    render(<TcHygieneInbox />);
    fireEvent.click(await screen.findByRole("button", { name: /claim/i }));
    await waitFor(() => expect(apiMock.claimHygieneCase).toHaveBeenCalledWith("roland", CASE_ID));
  });

  it("Open case and the name link go to the case for a TC", async () => {
    authMock.permissions = ["tc.full"];
    render(<TcHygieneInbox />);
    expect(await screen.findByText("Open case")).toBeTruthy();
    expect(document.querySelectorAll(`a[href="/tc/cases/${CASE_ID}"]`).length).toBe(2);
  });

  it("a super admin can work it", async () => {
    authMock.isSuperAdmin = true;
    render(<TcHygieneInbox />);
    expect(await screen.findByRole("button", { name: /claim/i })).toBeTruthy();
  });

  it("F8: the page is titled TC Inbox, like its nav item", async () => {
    authMock.permissions = ["tc.full"];
    render(<TcHygieneInbox />);
    expect(await screen.findByRole("heading", { name: "TC Inbox" })).toBeTruthy();
  });
});
