/**
 * The provider directory, in jsdom.
 *
 *   P  ProviderPicker: a dropdown of the active providers + "Other…" (free
 *      text kept); a value not in the list opens as Other with its text; an
 *      empty directory is free text with the Settings hint; no list (null) is
 *      free text only; NOTHING auto-selects, even with one provider
 *   S  Settings → Providers: the list; admin/office (canEdit) get Add and
 *      "Import from Open Dental", whose summary says what was added, updated
 *      and left out; everyone else reads it only
 *   F  the hub / sign-off field form sends a referring-provider change, and
 *      only when it changed
 *   B  the pre-auth board: "Start case" while unlinked, "Open case" once linked
 *
 * NO NETWORK, NO BACKEND, NO PHI (synthetic names).
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

import type { TcPreauthCase } from "@shared/tc/contract";
import type { TcProviderEntry } from "@shared/tc/providers";
import type { TcReferral } from "@shared/tc/referrals";

const provMock = vi.hoisted(() => ({
  listProviders: vi.fn(),
  listActiveProviders: vi.fn(),
  listSignoffProviders: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  importProviders: vi.fn(),
}));
vi.mock("@/features/tc/providers/providersApi", () => provMock);

const apiMock = vi.hoisted(() => {
  class TcApiError extends Error {
    status = 500;
    code: string | null = null;
  }
  return {
    TcApiError,
    odSearchPatients: vi.fn(async () => ({ patients: [] })),
    createPreauth: vi.fn(),
    patchPreauth: vi.fn(),
    isOdNotConnected: vi.fn(() => false),
    tcErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : "Something went wrong.")),
  };
});
vi.mock("@/features/tc/api", () => apiMock);

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import { ProviderPicker, PROVIDER_SETUP_HINT } from "@/features/tc/providers/ProviderPicker";
import { ProvidersSection, importSummary } from "@/features/tc/settings/ProvidersSection";
import { changedFields } from "@/features/tc/referrals/ReferralFieldsForm";
import { PreauthBoard } from "@/features/tc/preauth/PreauthBoard";
import { PreauthDialog } from "@/features/tc/preauth/PreauthDialog";
import { ReferralDialog } from "@/features/tc/referrals/ReferralsPanel";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

function provider(over: Partial<TcProviderEntry> = {}): TcProviderEntry {
  return {
    providerId: "6b0b6d6e-1f6a-4c55-9d43-2a1f8e3b9c01",
    officeId: "roland",
    name: "Avery Fixture",
    credentialSuffix: "DDS",
    active: true,
    odProvNum: 1,
    createdBy: "admin@carein.ai",
    createdAt: "2026-10-23T12:00:00.000Z",
    updatedBy: "admin@carein.ai",
    updatedAt: "2026-10-23T12:00:00.000Z",
    ...over,
  };
}

const TWO = [
  provider(),
  provider({ providerId: "6b0b6d6e-1f6a-4c55-9d43-2a1f8e3b9c02", name: "Blake Fixture", credentialSuffix: "DMD", odProvNum: 2 }),
];

/** The picker inside a tiny controlled form, so typing round-trips. */
function Harness({ initial = "", providers }: { initial?: string; providers: readonly TcProviderEntry[] | null }) {
  const [value, setValue] = React.useState(initial);
  return (
    <>
      <ProviderPicker id="pp" value={value} onChange={setValue} providers={providers} />
      <output data-testid="value">{value}</output>
    </>
  );
}

const valueOf = () => screen.getByTestId("value").textContent;

// ── P ───────────────────────────────────────────────────────────────────────

describe("ProviderPicker", () => {
  it("offers the providers and Other…, and selects nothing on its own — even with one provider", () => {
    render(<Harness providers={[provider()]} />);
    const select = document.getElementById("pp") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Choose…", "Avery Fixture, DDS", "Other…"]);
    expect(select.value).toBe("");
    expect(valueOf()).toBe("");
  });

  it("a pick writes the provider's display name", () => {
    render(<Harness providers={TWO} />);
    fireEvent.change(document.getElementById("pp")!, { target: { value: "Blake Fixture, DMD" } });
    expect(valueOf()).toBe("Blake Fixture, DMD");
    expect(screen.queryByLabelText("Other provider")).toBeNull();
  });

  it("Other… opens free text, and what is typed is the value", () => {
    render(<Harness providers={TWO} />);
    fireEvent.change(document.getElementById("pp")!, { target: { value: "__other__" } });
    fireEvent.change(screen.getByLabelText("Other provider"), { target: { value: "Dr. Visiting" } });
    expect(valueOf()).toBe("Dr. Visiting");
  });

  it("a value that is not in the list (typed before, or since deactivated) opens as Other with its text", () => {
    render(<Harness providers={TWO} initial="Dr. Typed Before" />);
    expect((document.getElementById("pp") as HTMLSelectElement).value).toBe("__other__");
    expect((screen.getByLabelText("Other provider") as HTMLInputElement).value).toBe("Dr. Typed Before");
  });

  it("an empty directory is free text, with where to set it up", () => {
    render(<Harness providers={[]} initial="Dr. Typed" />);
    const box = document.getElementById("pp") as HTMLInputElement;
    expect(box.tagName).toBe("INPUT");
    expect(box.value).toBe("Dr. Typed");
    expect(screen.getByText(PROVIDER_SETUP_HINT)).toBeTruthy();
  });

  it("no list on this surface (null) is free text with no hint", () => {
    render(<Harness providers={null} />);
    expect((document.getElementById("pp") as HTMLElement).tagName).toBe("INPUT");
    expect(screen.queryByText(PROVIDER_SETUP_HINT)).toBeNull();
  });
});

// ── S ───────────────────────────────────────────────────────────────────────

describe("Settings → Providers", () => {
  it("admin/office: lists, imports from Open Dental (no fields sent) and says what it did", async () => {
    provMock.listProviders.mockResolvedValue({ entries: TWO, canEdit: true });
    provMock.importProviders.mockResolvedValue({
      success: true,
      added: 2,
      updated: 1,
      unchanged: 3,
      skippedHidden: 1,
      skippedHygienists: 2,
      skippedNoName: 0,
      entries: TWO,
    });
    render(<ProvidersSection office="roland" />);
    expect(await screen.findByText("Avery Fixture")).toBeTruthy();
    expect(screen.getAllByTestId("tc-provider-row")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /import from open dental/i }));
    await waitFor(() => expect(provMock.importProviders).toHaveBeenCalledWith("roland"));
    expect(await screen.findByTestId("tc-provider-import-summary")).toBeTruthy();
    expect(screen.getByTestId("tc-provider-import-summary").textContent).toContain(
      "2 added, 1 updated, 3 already up to date. Left out: 1 hidden in Open Dental, 2 hygienists.",
    );
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });

  it("a tc user reads the list only: no Add, no Import, no Edit", async () => {
    provMock.listProviders.mockResolvedValue({ entries: TWO, canEdit: false });
    render(<ProvidersSection office="roland" />);
    expect(await screen.findByText("Avery Fixture")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /import from open dental/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add provider/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^edit /i })).toBeNull();
    expect(screen.getByText(/only a practice admin or office manager/i)).toBeTruthy();
  });

  it("adding one sends the validated form and re-reads the list", async () => {
    provMock.listProviders.mockResolvedValue({ entries: [], canEdit: true });
    provMock.createProvider.mockResolvedValue(provider({ odProvNum: null }));
    render(<ProvidersSection office="valley" />);
    fireEvent.click(await screen.findByRole("button", { name: /add provider/i }));
    fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "  Casey Fixture " } });
    fireEvent.change(screen.getByLabelText("Credential"), { target: { value: "DDS" } });
    fireEvent.click(screen.getAllByRole("button", { name: /add provider/i }).at(-1)!);
    await waitFor(() =>
      expect(provMock.createProvider).toHaveBeenCalledWith("valley", { name: "Casey Fixture", credentialSuffix: "DDS", active: true }),
    );
    await waitFor(() => expect(provMock.listProviders).toHaveBeenCalledTimes(2));
  });

  it("importSummary leaves out the skip line when nothing was skipped", () => {
    expect(importSummary({ added: 0, updated: 0, unchanged: 4, skippedHidden: 0, skippedHygienists: 0, skippedNoName: 0 })).toBe(
      "0 added, 0 updated, 4 already up to date.",
    );
  });
});

// ── F ───────────────────────────────────────────────────────────────────────

describe("the field edit carries the referring provider", () => {
  const ref = { directoryEntryId: null, referringProvider: "Dr. Typed", urgency: "routine", reason: "Endo eval", teeth: [3], doctorNote: null, patientReason: null } as unknown as TcReferral;
  const base = { directoryEntryId: "", urgency: "routine" as const, reason: "Endo eval", teeth: [3] };

  it("sends it when it changed, trimmed", () => {
    expect(changedFields(ref, { ...base, referringProvider: " Avery Fixture, DDS " }, false)).toEqual({
      referringProvider: "Avery Fixture, DDS",
    });
  });

  it("sends nothing when it did not", () => {
    expect(changedFields(ref, { ...base, referringProvider: "Dr. Typed" }, false)).toEqual({});
  });
});

// ── the two forms ───────────────────────────────────────────────────────────

describe("the forms use it", () => {
  it("the referral form: the referring provider is a pick, and the pick is what is saved", async () => {
    const onSave = vi.fn();
    render(
      <ReferralDialog
        open
        editing={null}
        saving={false}
        onClose={vi.fn()}
        onSave={onSave}
        loadDirectory={async () => []}
        loadProviders={async () => TWO}
      />,
    );
    const select = await waitFor(() => {
      const el = document.getElementById("rf-provider");
      if (!el || el.tagName !== "SELECT") throw new Error("not a dropdown yet");
      return el as HTMLSelectElement;
    });
    expect(select.value).toBe("");
    fireEvent.change(select, { target: { value: "Avery Fixture, DDS" } });
    fireEvent.change(screen.getByLabelText("Reason *"), { target: { value: "Endo eval" } });
    fireEvent.click(screen.getByRole("button", { name: /save draft/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ referringProvider: "Avery Fixture, DDS" }), false, []);
  });

  it("the referral form: an empty directory keeps free text and says where to set it up", async () => {
    render(
      <ReferralDialog
        open
        editing={null}
        saving={false}
        onClose={vi.fn()}
        onSave={vi.fn()}
        loadDirectory={async () => []}
        loadProviders={async () => []}
      />,
    );
    expect(await screen.findByText(PROVIDER_SETUP_HINT)).toBeTruthy();
    expect(document.getElementById("rf-provider")!.tagName).toBe("INPUT");
  });

  it("the pre-auth form: Doctor is a pick from the office's providers, nothing preselected", async () => {
    provMock.listActiveProviders.mockResolvedValue(TWO);
    render(<PreauthDialog office="valley" open onOpenChange={vi.fn()} editing={null} onSaved={vi.fn()} />);
    await waitFor(() => expect(provMock.listActiveProviders).toHaveBeenCalledWith("valley"));
    const select = await waitFor(() => {
      const el = document.getElementById("preauth-doctor");
      if (!el || el.tagName !== "SELECT") throw new Error("not a dropdown yet");
      return el as HTMLSelectElement;
    });
    expect(select.value).toBe("");
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Choose…",
      "Avery Fixture, DDS",
      "Blake Fixture, DMD",
      "Other…",
    ]);
  });
});

// ── B ───────────────────────────────────────────────────────────────────────

describe("the pre-auth board's case actions", () => {
  const row = (over: Partial<TcPreauthCase> = {}): TcPreauthCase => ({
    preauthId: "11111111-1111-4111-8111-111111111111",
    legacyId: null,
    officeId: "roland",
    caseId: null,
    patientName: "Testpatient, Alpha",
    phone: null,
    email: null,
    odPatientId: 12827,
    preauthType: "treatment",
    description: "",
    insuranceCarrier: "Fixture Dental",
    status: "pending",
    doctorName: "Dr. Fixture",
    createdAt: "2026-08-01T12:00:00.000Z",
    submittedDate: null,
    decisionDate: null,
    referenceNumber: "",
    notes: "",
    ...over,
  });

  function openMenu() {
    const trigger = screen.getByRole("button", { name: /^Actions for/ });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  }

  it("unlinked: Start case hands the card to the page", async () => {
    const onStartCase = vi.fn();
    const onOpenCase = vi.fn();
    render(
      <PreauthBoard
        cases={[row()]}
        onTransition={vi.fn().mockResolvedValue(undefined)}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onStartCase={onStartCase}
        onOpenCase={onOpenCase}
      />,
    );
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /start case/i }));
    expect(onStartCase).toHaveBeenCalledWith(expect.objectContaining({ preauthId: row().preauthId }));
    expect(screen.queryByRole("menuitem", { name: /open case/i })).toBeNull();
  });

  it("linked: Open case, and no second Start case", async () => {
    const onStartCase = vi.fn();
    const onOpenCase = vi.fn();
    render(
      <PreauthBoard
        cases={[row({ caseId: "33333333-3333-4333-8333-333333333333" })]}
        onTransition={vi.fn().mockResolvedValue(undefined)}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onStartCase={onStartCase}
        onOpenCase={onOpenCase}
      />,
    );
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /open case/i }));
    expect(onOpenCase).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: /start case/i })).toBeNull();
    expect(onStartCase).not.toHaveBeenCalled();
  });
});
