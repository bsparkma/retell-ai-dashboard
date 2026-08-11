/**
 * Hygienist attribution in the UI (Roles PR B).
 *
 * The behaviour that matters to a temp hygienist on a shared login:
 *  - the intake form defaults the attribution to them and lets them type a name
 *    that isn't on the roster;
 *  - Submissions defaults to THEIR OWN work (the view they had before), and the
 *    chips let them see anyone else's without stranding them on a filter.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

const authState = vi.hoisted(() => ({ name: "Raegan", email: "raegan@carein.ai" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    fetchCurrentUser: vi.fn(async () => ({
      name: authState.name,
      email: authState.email,
      tenantId: "tid",
      tenant: { slug: "carein", displayName: "CareIN", modules: ["tc"] },
      role: "hygiene" as const,
      isSuperAdmin: false,
      permissions: ["tc.hygiene"],
    })),
  };
});

/** The rows the fake API serves, and what the page asked for. */
const server = vi.hoisted(() => ({
  /** @type {Array<{ hygienistName: string; patientName: string }>} */
  rows: [] as Array<{ hygienistName: string; patientName: string }>,
  hygienists: [] as string[],
  lastFilter: undefined as string | undefined,
  calls: 0,
}));

vi.mock("@/features/tc/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/tc/api")>();
  return {
    ...real,
    hygienistRoster: vi.fn(async () => [
      { email: "raegan@carein.ai", label: "Raegan" },
      { email: "laura@carein.ai", label: "Laura" },
    ]),
    hygieneSubmissions: vi.fn(async (_office: string, hygienist?: string) => {
      server.calls += 1;
      server.lastFilter = hygienist;
      const rows = hygienist ? server.rows.filter((r) => r.hygienistName === hygienist) : server.rows;
      return {
        intakes: rows.map((r, i) => ({
          intakeId: `i${i}`,
          caseId: `c${i}`,
          officeId: "valley" as const,
          submittedBy: "temp@carein.ai",
          submittedByName: "Temp Hygienist",
          hygienistName: r.hygienistName,
          submittedAt: "2026-08-11T15:00:00.000Z",
          visitDate: "2026-08-11",
          chiefConcern: "",
          suspectedTreatment: "",
          flagUrgent: false,
          patientInterestLevel: "warm" as const,
          patientName: r.patientName,
          caseStatus: "hygiene_review" as const,
        })),
        hygienists: server.hygienists,
      };
    }),
  };
});

vi.mock("@/features/tc/components/TcShell", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/tc/components/TcShell")>();
  return { ...real, useTcOffice: () => "valley" as const };
});

import { AuthProvider } from "@/contexts/AuthContext";
import TcHygieneSubmissions from "@/pages/tc/TcHygieneSubmissions";

beforeEach(() => {
  server.rows = [
    { hygienistName: "Raegan", patientName: "Patient One" },
    { hygienistName: "Laura", patientName: "Patient Two" },
    { hygienistName: "Laura", patientName: "Patient Three" },
  ];
  server.hygienists = ["Laura", "Raegan"];
  server.lastFilter = undefined;
  server.calls = 0;
  authState.name = "Raegan";
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPage = () =>
  render(
    <AuthProvider>
      <TcHygieneSubmissions />
    </AuthProvider>,
  );

describe("Submissions filtering", () => {
  it("defaults to the signed-in person's own work — the 'mine' view is preserved", async () => {
    renderPage();
    await waitFor(() => expect(server.lastFilter).toBe("Raegan"));
    expect(await screen.findByText("Patient One")).toBeTruthy();
    expect(screen.queryByText("Patient Two")).toBeNull();
  });

  it("renders a chip per hygienist plus All", async () => {
    renderPage();
    await screen.findByText("Patient One");

    expect(screen.getByTestId("hygienist-chip-all")).toBeTruthy();
    expect(screen.getByTestId("hygienist-chip-Laura")).toBeTruthy();
    expect(screen.getByTestId("hygienist-chip-Raegan")).toBeTruthy();
    // The caller's own chip is the one selected.
    expect(screen.getByTestId("hygienist-chip-Raegan").getAttribute("aria-pressed")).toBe("true");
  });

  it("selecting another hygienist returns that subset", async () => {
    renderPage();
    await screen.findByText("Patient One");

    fireEvent.click(screen.getByTestId("hygienist-chip-Laura"));

    await waitFor(() => expect(server.lastFilter).toBe("Laura"));
    expect(await screen.findByText("Patient Two")).toBeTruthy();
    expect(screen.getByText("Patient Three")).toBeTruthy();
    expect(screen.queryByText("Patient One")).toBeNull();
  });

  it("All clears the filter and shows everyone, attributed", async () => {
    renderPage();
    await screen.findByText("Patient One");

    fireEvent.click(screen.getByTestId("hygienist-chip-all"));

    await waitFor(() => expect(server.lastFilter).toBeUndefined());
    expect(await screen.findByText("Patient Two")).toBeTruthy();
    // In the All view each row names who did the visit — otherwise the shared
    // account makes three rows look like one person's.
    await waitFor(() => {
      expect(screen.getAllByText(/· Laura$/).length).toBeGreaterThan(0);
    });
  });

  it("chips stay visible when a filter returns nothing, so the user can escape", async () => {
    server.rows = [{ hygienistName: "Laura", patientName: "Patient Two" }];
    server.hygienists = ["Laura", "Raegan"];
    renderPage();

    // Raegan has no submissions; the empty state must still carry the chips.
    await waitFor(() => expect(screen.getByTestId("hygienist-chip-all")).toBeTruthy());
    expect(screen.getByTestId("hygienist-chip-Laura")).toBeTruthy();
  });

  it("falls back to All when the signed-in person has no attribution at all", async () => {
    // A TC opening the page: they have never submitted anything, so defaulting
    // to their own name would show a permanently empty list.
    authState.name = "Coordinator";
    server.hygienists = ["Laura", "Raegan"];
    renderPage();

    await waitFor(() => expect(server.lastFilter).toBeUndefined());
    expect(await screen.findByText("Patient One")).toBeTruthy();
  });

  it("hides the chip row entirely when only one hygienist has submitted", async () => {
    server.rows = [{ hygienistName: "Raegan", patientName: "Patient One" }];
    server.hygienists = ["Raegan"];
    renderPage();

    await screen.findByText("Patient One");
    expect(screen.queryByTestId("hygienist-chip-all")).toBeNull();
  });
});
