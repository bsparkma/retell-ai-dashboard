/**
 * TcSettings shell tests (jsdom via the .tsx glob).
 *
 * The TC api, auth, and office contexts are mocked so the page is driven
 * purely by the mocks. Covers: all eight sections present in the nav, section
 * switching updating both the content region and location.hash, hash deep
 * links selecting a section on mount, and — the point of the honest
 * adaptation — that Team, Integrations, and Data & Backup render their
 * explanatory copy and expose NO enabled controls implying functionality the
 * platform does not have.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

// Match the harness used by the other .tsx suites: provide the classic-runtime
// global so component modules render regardless of JSX transform.
(globalThis as Record<string, unknown>).React = React;

const apiMock = vi.hoisted(() => {
  class TcApiError extends Error {
    status = 500;
    code: string | null = null;
    feature: string | null = null;
    issues: { path: string; code: string; message: string }[] = [];
  }
  return {
    getLibrary: vi.fn(),
    getLibrarySection: vi.fn(),
    putLibrarySection: vi.fn(),
    // Slice 5: Integrations probes the live OD status for the selected office.
    odStatus: vi.fn(async () => ({
      office: "roland" as const,
      officeName: "Roland Family Dental",
      odConnected: true,
      reachable: true,
      detail: "",
      writeEnabled: false,
    })),
    isOdNotConnected: vi.fn((e: unknown) => e instanceof TcApiError && e.code === "OFFICE_NOT_CONNECTED"),
    tcErrorMessage: vi.fn((e: unknown) =>
      e instanceof Error ? e.message : "Something went wrong.",
    ),
    TcApiError,
  };
});
vi.mock("@/features/tc/api", () => apiMock);

const authMock = vi.hoisted(() => ({
  useAuth: vi.fn(() => ({
    status: "authenticated" as const,
    user: {
      name: "Amber Reed",
      email: "amber@valleyfamilydental.com",
      tenantId: "tenant-1",
      tenant: {
        slug: "valley-family",
        displayName: "Valley Family Dental",
        modules: ["voice", "tc"],
      },
    },
  })),
}));
vi.mock("@/contexts/AuthContext", () => authMock);

const officeMock = vi.hoisted(() => ({
  ALL_OFFICES: "all",
  useOffice: vi.fn(() => ({
    offices: [
      { officeId: "roland", officeName: "Roland Family Dental", odConnected: true },
      { officeId: "valley", officeName: "Valley Family Dental", odConnected: false },
    ],
    office: "roland",
    setOffice: vi.fn(),
    selected: {
      officeId: "roland",
      officeName: "Roland Family Dental",
      odConnected: true,
    },
    loading: false,
  })),
}));
vi.mock("@/contexts/OfficeContext", () => officeMock);

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import TcSettings from "@/pages/tc/TcSettings";

const SECTION_LABELS = [
  "Practice",
  "Pricing",
  "Financing",
  "Team",
  "Stages",
  "Library",
  "Integrations",
  "Data & Backup",
];

function nav() {
  return screen.getByRole("navigation", { name: "Settings sections" });
}

function navButton(label: string) {
  return within(nav()).getByRole("button", { name: label });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
  // An office with nothing configured yet: the reused library editors render
  // their empty state, which is enough to prove the section mounted.
  apiMock.getLibrary.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("TcSettings shell", () => {
  it("lists all eight sections in the nav, in DentaFlow's order", async () => {
    render(<TcSettings />);

    const items = within(nav()).getAllByRole("button");
    expect(items.map((b) => b.textContent?.trim())).toEqual(SECTION_LABELS);

    // Practice is the default section.
    expect(await screen.findByRole("region", { name: "Practice" })).toBeTruthy();
    expect(navButton("Practice").getAttribute("aria-current")).toBe("page");
  });

  it("switches content and updates the hash when a section is clicked", async () => {
    render(<TcSettings />);
    await screen.findByRole("region", { name: "Practice" });

    fireEvent.click(navButton("Pricing"));

    expect(await screen.findByRole("region", { name: "Pricing" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Practice" })).toBeNull();
    expect(window.location.hash).toBe("#pricing");
    expect(navButton("Pricing").getAttribute("aria-current")).toBe("page");

    fireEvent.click(navButton("Integrations"));

    expect(
      await screen.findByRole("region", { name: "Integrations" }),
    ).toBeTruthy();
    expect(window.location.hash).toBe("#integrations");
  });

  it("opens the section named by the hash on mount (deep link)", async () => {
    window.location.hash = "#stages";

    render(<TcSettings />);

    expect(await screen.findByRole("region", { name: "Stages" })).toBeTruthy();
    expect(navButton("Stages").getAttribute("aria-current")).toBe("page");
  });

  it("falls back to Practice for an unknown hash", async () => {
    window.location.hash = "#not-a-section";

    render(<TcSettings />);

    expect(await screen.findByRole("region", { name: "Practice" })).toBeTruthy();
  });

  it("reuses the office library editors for the library-backed sections", async () => {
    render(<TcSettings />);
    await screen.findByRole("region", { name: "Practice" });

    fireEvent.click(navButton("Pricing"));
    const region = await screen.findByRole("region", { name: "Pricing" });

    // The shared-write-path note, and the real PricingEditor's empty state.
    await waitFor(() =>
      expect(within(region).getByText(/same settings the Library page/i)).toBeTruthy(),
    );
    expect(
      within(region).getByRole("heading", { name: "Crown pricing" }),
    ).toBeTruthy();
    expect(apiMock.getLibrary).toHaveBeenCalledWith("roland");
  });

  it("renders Practice read-only from the tenant record, with no edit form", async () => {
    render(<TcSettings />);
    const region = await screen.findByRole("region", { name: "Practice" });

    expect(within(region).getByText("Valley Family Dental")).toBeTruthy();
    expect(within(region).getByText("valley-family")).toBeTruthy();
    expect(
      within(region).getByText(/not editable from the Treatment Coordinator module/i),
    ).toBeTruthy();

    // Read-only means read-only: no inputs, no save.
    expect(within(region).queryAllByRole("textbox")).toHaveLength(0);
    expect(within(region).queryAllByRole("button")).toHaveLength(0);
  });
});

describe("TcSettings honest sections", () => {
  const HONEST: { label: string; copy: RegExp[] }[] = [
    {
      label: "Team",
      copy: [
        /Team membership is managed in the platform/i,
        /Entra SSO/i,
        /Amber Reed/i,
      ],
    },
    {
      label: "Integrations",
      copy: [
        /Connections are provisioned by the platform/i,
        // Slice 5: TC reads OD for real, and says so — including that it writes nothing.
        /Treatment Coordinator can read Open Dental for this office/i,
        /writes nothing back/i,
        /Coming with platform email/i,
      ],
    },
    {
      label: "Data & Backup",
      copy: [
        /Platform tenant database/i,
        /Backups are managed by the platform/i,
        /has been retired rather than reimplemented/i,
      ],
    },
  ];

  for (const { label, copy } of HONEST) {
    it(`${label} explains platform reality and exposes no enabled controls`, async () => {
      render(<TcSettings />);
      await screen.findByRole("region", { name: "Practice" });

      fireEvent.click(navButton(label));
      const region = await screen.findByRole("region", { name: label });

      for (const re of copy) {
        expect(within(region).getByText(re)).toBeTruthy();
      }

      // Nothing here may imply a capability the platform does not have: no
      // buttons, no toggles, no inputs — not even disabled-looking ones that
      // a user could click.
      const enabled = within(region)
        .queryAllByRole("button")
        .filter((b) => !(b as HTMLButtonElement).disabled);
      expect(enabled).toHaveLength(0);
      expect(within(region).queryAllByRole("textbox")).toHaveLength(0);
      expect(within(region).queryAllByRole("switch")).toHaveLength(0);
      expect(within(region).queryAllByRole("checkbox")).toHaveLength(0);
      expect(within(region).queryAllByRole("combobox")).toHaveLength(0);
    });
  }

  it("reports the platform connector and the TC read path as two separate facts", async () => {
    render(<TcSettings />);
    await screen.findByRole("region", { name: "Practice" });

    fireEvent.click(navButton("Integrations"));
    const region = await screen.findByRole("region", { name: "Integrations" });

    // Platform connector for this office...
    expect(within(region).getByText("Connected")).toBeTruthy();
    // ...and, separately, whether TC's own OD reads actually work. They can
    // disagree, which is the whole reason both rows exist.
    expect(await within(region).findByText("Reading")).toBeTruthy();
    expect(
      within(region).getByText(/writes nothing back — chart notes arrive in a later slice/i),
    ).toBeTruthy();
    // Email is still the honest "not available" row.
    expect(within(region).getByText("Not available")).toBeTruthy();
  });

  it("says 'not connected' for the TC read path when the office refuses OD", async () => {
    const api = await import("@/features/tc/api");
    const err = new (api.TcApiError as unknown as new (m: string) => Error & { code: string })(
      "Open Dental is not connected for this office yet",
    );
    err.code = "OFFICE_NOT_CONNECTED";
    (api.odStatus as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err);

    window.location.hash = "#integrations";
    render(<TcSettings />);

    const region = await screen.findByRole("region", { name: "Integrations" });
    expect(
      await within(region).findByText(/cannot read Open Dental for this office yet/i),
    ).toBeTruthy();
  });

  it("says 'Unknown' for Open Dental rather than 'disconnected' while offices load", async () => {
    officeMock.useOffice.mockReturnValue({
      offices: [],
      office: "roland",
      setOffice: vi.fn(),
      selected: null as unknown as {
        officeId: string;
        officeName: string;
        odConnected: boolean;
      },
      loading: true,
    });

    window.location.hash = "#integrations";
    render(<TcSettings />);

    const region = await screen.findByRole("region", { name: "Integrations" });
    expect(within(region).getByText("Unknown")).toBeTruthy();
    expect(within(region).queryByText("Not connected")).toBeNull();
  });
});
