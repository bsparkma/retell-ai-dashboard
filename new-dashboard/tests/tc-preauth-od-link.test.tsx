/**
 * Linking an Open Dental patient to a pre-auth case, in jsdom.
 *
 * The pre-auth board grew the same picker the New Case dialog has. Four
 * properties are what make it safe:
 *
 *  1. Create sends odPatientId ONLY when a patient was actually picked. A
 *     pre-auth for someone not yet in Open Dental is a normal pre-auth.
 *  2. Edit sends odPatientId ONLY when the link CHANGED — link, or clear. A
 *     save that touched every other field must not rewrite a column nobody
 *     touched, and an unchanged link must not read as a re-link.
 *  3. Linking PREFILLS name/phone/email and then gets out of the way: every
 *     prefilled field stays editable.
 *  4. An existing link renders as a PatNum badge. We do not fetch Open Dental
 *     just to print a name we have not read back.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OfficeId, TcPreauthCase } from "@shared/tc/contract";

(globalThis as Record<string, unknown>).React = React;

const apiMock = vi.hoisted(() => {
  class TcApiError extends Error {
    status = 500;
    code: string | null = null;
    feature: string | null = null;
    issues: { path: string; code: string; message: string }[] = [];
  }
  return {
    TcApiError,
    odSearchPatients: vi.fn(),
    createPreauth: vi.fn(),
    patchPreauth: vi.fn(),
    isOdNotConnected: vi.fn(
      (e: unknown) => e instanceof TcApiError && e.code === "OFFICE_NOT_CONNECTED",
    ),
    tcErrorMessage: vi.fn((e: unknown) =>
      e instanceof Error ? e.message : "Something went wrong.",
    ),
  };
});
vi.mock("@/features/tc/api", () => apiMock);

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import { PreauthDialog } from "@/features/tc/preauth/PreauthDialog";
import type { OdPatient } from "@/features/tc/api";

// ── Fixtures (synthetic test patients only) ─────────────────────────────────

const MANGO: OdPatient = {
  patNum: 12828,
  firstName: "MangoTest",
  lastName: "Test",
  displayName: "Test, MangoTest",
  birthdate: "1990-04-01",
  phone: "9185550100",
  email: "mangotest@example.test",
  status: "Patient",
};

/** The brief shape: OD serves no phone/email, so the client blanks them. */
const BRIEF: OdPatient = {
  patNum: 12827,
  firstName: "Stedi",
  lastName: "Test 2",
  displayName: "Test 2, Stedi",
  birthdate: "1985-11-20",
  phone: "",
  email: "",
  status: "",
};

function preauthCase(over: Partial<TcPreauthCase> = {}): TcPreauthCase {
  return {
    preauthId: "11111111-1111-4111-8111-111111111111",
    legacyId: null,
    officeId: "roland",
    caseId: null,
    patientName: "Typed Name",
    phone: null,
    email: null,
    odPatientId: null,
    preauthType: "treatment",
    description: "",
    insuranceCarrier: "Delta Dental",
    status: "not_submitted",
    doctorName: "Dr. Example",
    createdAt: "2026-08-20T12:00:00.000Z",
    submittedDate: null,
    decisionDate: null,
    referenceNumber: "",
    notes: "",
    ...over,
  };
}

function renderDialog(editing: TcPreauthCase | null = null, office: OfficeId = "roland") {
  return render(
    <PreauthDialog
      office={office}
      open
      onOpenChange={vi.fn()}
      editing={editing}
      onSaved={vi.fn()}
    />,
  );
}

const searchField = () => screen.getByLabelText(/link an open dental patient/i);

async function pick(patient: OdPatient) {
  fireEvent.change(searchField(), { target: { value: patient.lastName } });
  const hit = await screen.findByText(patient.displayName, {}, { timeout: 3000 });
  fireEvent.click(hit.closest("button")!);
}

/** The dialog labels fields with a wrapping <label>, not htmlFor. */
const field = (label: RegExp): HTMLInputElement =>
  screen.getByText(label).closest("label")!.querySelector("input")!;

const save = () =>
  fireEvent.click(screen.getByRole("button", { name: /create pre-auth|save changes/i }));

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.odSearchPatients.mockResolvedValue({
    query: "Test",
    matchMode: "prefix",
    patients: [MANGO, BRIEF],
    truncated: false,
    notes: [],
  });
  apiMock.createPreauth.mockImplementation(async () => preauthCase());
  apiMock.patchPreauth.mockImplementation(async () => preauthCase());
});
afterEach(cleanup);

// ── Create ──────────────────────────────────────────────────────────────────

describe("pre-auth create", () => {
  it("omits odPatientId when no patient is linked", async () => {
    renderDialog();

    fireEvent.change(field(/patient name/i), { target: { value: "Walk In" } });
    fireEvent.change(field(/insurance carrier/i), { target: { value: "Delta Dental" } });
    fireEvent.change(field(/^doctor \*$/i), { target: { value: "Dr. Example" } });
    save();

    await waitFor(() => expect(apiMock.createPreauth).toHaveBeenCalledTimes(1));
    const input = apiMock.createPreauth.mock.calls[0][1];
    expect("odPatientId" in input).toBe(false);
    expect(input.patientName).toBe("Walk In");
    expect(apiMock.odSearchPatients).not.toHaveBeenCalled();
  });

  it("includes odPatientId when a patient is linked, scoped to the dialog's office", async () => {
    renderDialog(null, "roland");
    await pick(MANGO);

    fireEvent.change(field(/insurance carrier/i), { target: { value: "Delta Dental" } });
    fireEvent.change(field(/^doctor \*$/i), { target: { value: "Dr. Example" } });
    save();

    await waitFor(() => expect(apiMock.createPreauth).toHaveBeenCalledTimes(1));
    // The office travels with the query AND with the save — a PatNum means
    // nothing without the database it came from.
    expect(apiMock.odSearchPatients.mock.calls[0][0]).toBe("roland");
    expect(apiMock.createPreauth.mock.calls[0][0]).toBe("roland");
    expect(apiMock.createPreauth.mock.calls[0][1].odPatientId).toBe(12828);
  });

  it("drops odPatientId again when the link is cleared before saving", async () => {
    renderDialog();
    await pick(MANGO);
    fireEvent.click(screen.getByRole("button", { name: /unlink this patient/i }));

    fireEvent.change(field(/insurance carrier/i), { target: { value: "Delta Dental" } });
    fireEvent.change(field(/^doctor \*$/i), { target: { value: "Dr. Example" } });
    save();

    await waitFor(() => expect(apiMock.createPreauth).toHaveBeenCalledTimes(1));
    const input = apiMock.createPreauth.mock.calls[0][1];
    expect("odPatientId" in input).toBe(false);
    // The prefilled name survives the unlink — it is a normal typed value now.
    expect(input.patientName).toBe("MangoTest Test");
  });
});

// ── Prefill ─────────────────────────────────────────────────────────────────

describe("prefill from the linked patient", () => {
  it("fills name, phone and email — and leaves every one of them editable", async () => {
    renderDialog();
    await pick(MANGO);

    expect(field(/patient name/i).value).toBe("MangoTest Test");
    expect(field(/^phone$/i).value).toBe("9185550100");
    expect(field(/^email$/i).value).toBe("mangotest@example.test");

    // Editable: the link is a convenience, not a lock.
    fireEvent.change(field(/patient name/i), { target: { value: "Preferred Name" } });
    fireEvent.change(field(/^phone$/i), { target: { value: "(479) 555-0100" } });
    expect(field(/patient name/i).value).toBe("Preferred Name");

    fireEvent.change(field(/insurance carrier/i), { target: { value: "Delta Dental" } });
    fireEvent.change(field(/^doctor \*$/i), { target: { value: "Dr. Example" } });
    save();

    await waitFor(() => expect(apiMock.createPreauth).toHaveBeenCalledTimes(1));
    const input = apiMock.createPreauth.mock.calls[0][1];
    expect(input.patientName).toBe("Preferred Name");
    expect(input.phone).toBe("(479) 555-0100");
    // Still linked — editing the prefilled text does not unlink the patient.
    expect(input.odPatientId).toBe(12828);
  });

  it("does not blank a phone the user already typed when OD has none", async () => {
    renderDialog();
    fireEvent.change(field(/^phone$/i), { target: { value: "(479) 555-0100" } });
    await pick(BRIEF);

    expect(field(/^phone$/i).value).toBe("(479) 555-0100");
    expect(field(/patient name/i).value).toBe("Stedi Test 2");
  });
});

// ── Edit ────────────────────────────────────────────────────────────────────

describe("pre-auth edit", () => {
  it("shows an existing link as a PatNum badge without fetching Open Dental", () => {
    renderDialog(preauthCase({ odPatientId: 12827 }));

    expect(screen.getByText(/PatNum 12827/)).toBeTruthy();
    // No name lookup — the badge is what we actually know.
    expect(apiMock.odSearchPatients).not.toHaveBeenCalled();
  });

  it("leaves odPatientId out of the patch when the link did not change", async () => {
    renderDialog(preauthCase({ odPatientId: 12827 }));

    fireEvent.change(field(/reference #/i), { target: { value: "REF-9" } });
    save();

    await waitFor(() => expect(apiMock.patchPreauth).toHaveBeenCalledTimes(1));
    const patch = apiMock.patchPreauth.mock.calls[0][2];
    expect("odPatientId" in patch).toBe(false);
    expect(patch.referenceNumber).toBe("REF-9");
  });

  it("leaves odPatientId out of the patch when the case never had a link", async () => {
    renderDialog(preauthCase({ odPatientId: null }));
    save();

    await waitFor(() => expect(apiMock.patchPreauth).toHaveBeenCalledTimes(1));
    expect("odPatientId" in apiMock.patchPreauth.mock.calls[0][2]).toBe(false);
  });

  it("patches the new PatNum when the link is changed by re-searching", async () => {
    renderDialog(preauthCase({ odPatientId: 12827 }));
    await pick(MANGO);
    save();

    await waitFor(() => expect(apiMock.patchPreauth).toHaveBeenCalledTimes(1));
    expect(apiMock.patchPreauth.mock.calls[0][2].odPatientId).toBe(12828);
  });

  it("patches odPatientId to null when the link is explicitly cleared", async () => {
    renderDialog(preauthCase({ odPatientId: 12827 }));
    fireEvent.click(screen.getByRole("button", { name: /unlink this patient/i }));
    save();

    await waitFor(() => expect(apiMock.patchPreauth).toHaveBeenCalledTimes(1));
    const patch = apiMock.patchPreauth.mock.calls[0][2];
    expect("odPatientId" in patch).toBe(true);
    expect(patch.odPatientId).toBe(null);
  });

  it("keeps the dialog open and does not toast success when the save fails", async () => {
    apiMock.patchPreauth.mockRejectedValue(new Error("nope"));
    const onOpenChange = vi.fn();
    render(
      <PreauthDialog
        office="roland"
        open
        onOpenChange={onOpenChange}
        editing={preauthCase({ odPatientId: 12827 })}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /unlink this patient/i }));
    save();

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    // Values intact for retry: the unlink is still shown as unlinked.
    expect(screen.queryByText(/PatNum 12827/)).toBeNull();
  });
});

// ── Not connected ───────────────────────────────────────────────────────────

describe("an office with no Open Dental connection", () => {
  it("degrades to the shared not-connected state, with no office-specific copy", async () => {
    const err = new apiMock.TcApiError("not connected");
    err.code = "OFFICE_NOT_CONNECTED";
    apiMock.odSearchPatients.mockRejectedValue(err);

    renderDialog(null, "valley");
    fireEvent.change(searchField(), { target: { value: "Test" } });

    expect(await screen.findByText(/OD not connected for this office yet\./i)).toBeTruthy();
    expect(screen.queryByText(/Try again/i)).toBeNull();
    // The rest of the form is untouched — a pre-auth can still be created.
    expect(field(/patient name/i)).toBeTruthy();
  });
});
