/**
 * Choosing which practice's chart a call gets written to, in jsdom.
 *
 * The call belongs to the office it rang at. The chart belongs to the practice the
 * patient is a patient of. Those used to be forced to be the same, and the cost
 * landed on one person: whoever is at the front desk of one practice when a call
 * comes in about the other practice's patient. Pick Patient searched only their own
 * Open Dental, the patient was not in it, and the call could not be charted at all.
 *
 * The server enforces the safety (validated office, per-office client, per-office
 * DefNum, both offices audited — see backend/test/crossOfficeChartTarget.test.js).
 * What is pinned HERE is the part a HUMAN acts on, and can therefore get wrong:
 *
 *  1. The selector DEFAULTS to the call's own office. Opening either dialog and
 *     carrying on must never quietly aim somewhere else.
 *  2. Switching offices CLEARS the selected patient and re-searches. A PatNum means
 *     a different person in the other database, so carrying one across is how a note
 *     lands on a stranger.
 *  3. The mismatch warning renders only when the offices actually differ — so its
 *     presence is information, not furniture.
 *  4. The confirm button names the practice being written to.
 *  5. The send carries the chosen office as the target AND as the assertion.
 *
 * No PHI: roland 12827 "Test 2, Stedi" and valley 7115 "Stedi TestValley" are the
 * synthetic staging fixtures. 7115 exists in BOTH databases as different people,
 * which is the whole reason this care is needed.
 */
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

const toasts = vi.hoisted(() => ({ calls: [] as Array<{ kind: string; text: string }> }));
vi.mock("sonner", () => ({
  toast: {
    success: (text: string) => toasts.calls.push({ kind: "success", text }),
    info: (text: string) => toasts.calls.push({ kind: "info", text }),
    error: (text: string) => toasts.calls.push({ kind: "error", text }),
  },
}));

const apiMock = vi.hoisted(() => ({
  getOffices: vi.fn(),
  getCommlogPreview: vi.fn(),
  searchPatientsForCall: vi.fn(),
  resolvePatient: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, ...apiMock } };
});

import { SendToChartDialog } from "@/pages/calls/SendToChartDialog";
import { PickPatientModal } from "@/pages/calls/PickPatientModal";
import type { UnifiedCall, OfficeConfig } from "@/lib/api";

// ── jsdom gaps Radix Select needs ───────────────────────────────────────────

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const ROLAND: OfficeConfig = { officeId: "roland", officeName: "Roland", odConnected: true };
const VALLEY: OfficeConfig = { officeId: "valley", officeName: "Valley Fort Smith", odConnected: true };

const ROLAND_TYPES = {
  available: true,
  options: [{ defNum: 486, name: "CareIN AI Call" }, { defNum: 401, name: "ODHQ" }],
  defaultDefNum: 486,
  defaultName: "CareIN AI Call",
  stale: false,
};
const VALLEY_TYPES = {
  available: true,
  options: [{ defNum: 451, name: "CareIN AI Call" }, { defNum: 401, name: "Crown by Moolah" }],
  defaultDefNum: 451,
  defaultName: "CareIN AI Call",
  stale: false,
};

/** A call that rang at Riley/valley — the motivating case's origin. */
function valleyCall(over: Partial<UnifiedCall> = {}): UnifiedCall {
  return {
    id: "call-valley-1",
    officeId: "valley",
    fromNumber: "+14795550101",
    patientName: "Unknown caller",
    odMatchCandidates: [],
    ...over,
  } as UnifiedCall;
}

/**
 * The preview endpoint, answering for whichever office was asked about — exactly as
 * the server does. Rigging it per-office is what lets these tests prove the dialog
 * re-reads the note types when the target changes, instead of reusing a stale list.
 */
function previewPerOffice(defaultOffice: OfficeConfig) {
  apiMock.getCommlogPreview.mockImplementation(
    async (_id: string, _ct: string | undefined, targetOffice?: string) => {
      const officeId = targetOffice ?? defaultOffice.officeId;
      const office = officeId === "roland" ? ROLAND : VALLEY;
      return {
        note: `CareIN call - Aug 24, 2026 - Staff (Mango)`,
        patientId: null,
        patientName: null,
        office,
        callOffice: VALLEY,
        crossOffice: office.officeId !== "valley",
        commlogTypes: office.officeId === "roland" ? ROLAND_TYPES : VALLEY_TYPES,
      };
    },
  );
}

/**
 * Open the office picker and choose one.
 *
 * Waits for the trigger to become enabled first: the roster is fetched on open, and
 * the control stays disabled while there is nothing (or only one office) to choose
 * between — so acting too early silently does nothing instead of failing loudly.
 */
async function chooseOffice(testId: string, optionText: string | RegExp) {
  await waitFor(() => expect((screen.getByTestId(testId) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.keyDown(screen.getByTestId(testId), { key: "Enter" });
  const option = await screen.findByRole("option", { name: optionText });
  fireEvent.click(option);
}

beforeEach(() => {
  toasts.calls.length = 0;
  apiMock.getOffices.mockReset();
  apiMock.getCommlogPreview.mockReset();
  apiMock.searchPatientsForCall.mockReset();
  apiMock.resolvePatient.mockReset();
  apiMock.getOffices.mockResolvedValue([ROLAND, VALLEY]);
  apiMock.searchPatientsForCall.mockResolvedValue({ patients: [], office: null });
});

afterEach(cleanup);

// ── Pick Patient: the surface that makes the motivating case possible ───────

describe("Pick Patient — searching the other practice", () => {
  it("defaults to the call's own office", async () => {
    render(
      <PickPatientModal
        open onOpenChange={() => {}} call={valleyCall()}
        onLinked={() => {}} onNotPatient={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Last name, first name, or phone/i), {
      target: { value: "Stedi" },
    });

    await waitFor(() => expect(apiMock.searchPatientsForCall).toHaveBeenCalled());
    // Not "no office" and not "whatever was last used" — the call's own, every time.
    expect(apiMock.searchPatientsForCall).toHaveBeenCalledWith("call-valley-1", "Stedi", "valley");
    expect(screen.queryByTestId("cross-office-warning")).toBeNull();
  });

  it("switching offices clears the results and re-searches the new one", async () => {
    apiMock.searchPatientsForCall.mockResolvedValue({
      patients: [{ id: 7115, fullName: "Stedi TestValley" }],
      office: VALLEY,
    });

    render(
      <PickPatientModal
        open onOpenChange={() => {}} call={valleyCall()}
        onLinked={() => {}} onNotPatient={() => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Last name, first name, or phone/i), {
      target: { value: "Stedi" },
    });
    await waitFor(() => expect(screen.getByText("Stedi TestValley")).toBeTruthy());

    apiMock.searchPatientsForCall.mockResolvedValue({
      patients: [{ id: 12827, fullName: "Test 2, Stedi" }],
      office: ROLAND,
    });
    await chooseOffice("search-office-select", /^Roland/);

    // The valley result must be GONE, not left on screen under a Roland heading.
    // PatNum 7115 is a real Roland patient too, and a different person.
    await waitFor(() => expect(screen.queryByText("Stedi TestValley")).toBeNull());
    // And the query is cleared, so nothing is silently re-run against the new office.
    expect((screen.getByPlaceholderText(/Last name, first name, or phone/i) as HTMLInputElement).value).toBe("");

    fireEvent.change(screen.getByPlaceholderText(/Last name, first name, or phone/i), {
      target: { value: "Stedi" },
    });
    await waitFor(() =>
      expect(apiMock.searchPatientsForCall).toHaveBeenLastCalledWith("call-valley-1", "Stedi", "roland"),
    );
  });

  it("warns, in words, once the office being searched is not the call's", async () => {
    render(
      <PickPatientModal
        open onOpenChange={() => {}} call={valleyCall()}
        onLinked={() => {}} onNotPatient={() => {}}
      />,
    );
    expect(screen.queryByTestId("cross-office-warning")).toBeNull();

    await chooseOffice("search-office-select", /^Roland/);

    const warning = await screen.findByTestId("cross-office-warning");
    expect(warning.textContent).toMatch(/came in at/i);
    expect(warning.textContent).toMatch(/Valley Fort Smith/);
    expect(warning.textContent).toMatch(/Roland/);
  });

  it("hides the stored suggestions once another practice is being searched", async () => {
    // The candidates were matched in the CALL's database. Their PatNums mean someone
    // else in the other one, so offering them under a new office name is a trap.
    const call = valleyCall({ odMatchCandidates: [{ id: 7115, name: "Stedi TestValley" }] } as Partial<UnifiedCall>);
    render(
      <PickPatientModal open onOpenChange={() => {}} call={call} onLinked={() => {}} onNotPatient={() => {}} />,
    );
    expect(screen.getByText("Stedi TestValley")).toBeTruthy();

    await chooseOffice("search-office-select", /^Roland/);

    await waitFor(() => expect(screen.queryByText("Stedi TestValley")).toBeNull());
  });

  it("links against the office the patient was found in", async () => {
    apiMock.resolvePatient.mockResolvedValue({ success: true, call: { call_id: "call-valley-1" } });
    apiMock.searchPatientsForCall.mockResolvedValue({
      patients: [{ id: 12827, fullName: "Test 2, Stedi" }],
      office: ROLAND,
    });

    render(
      <PickPatientModal
        open onOpenChange={() => {}} call={valleyCall()}
        onLinked={() => {}} onNotPatient={() => {}}
      />,
    );
    await chooseOffice("search-office-select", /^Roland/);
    fireEvent.change(screen.getByPlaceholderText(/Last name, first name, or phone/i), {
      target: { value: "Stedi" },
    });
    await waitFor(() => expect(screen.getByText("Test 2, Stedi")).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: /Link/i })[0]);

    await waitFor(() => expect(apiMock.resolvePatient).toHaveBeenCalled());
    const [, body] = apiMock.resolvePatient.mock.calls[0];
    expect(body.patientId).toBe(12827);
    // target_office selects the database this PatNum is verified and stored against;
    // office_id only asserts. Both name Roland, because that is where it was found.
    expect(body.target_office).toBe("roland");
    expect(body.office_id).toBe("roland");
    expect(body.linkOnly).toBe(true);
  });
});

// ── Send to chart: the confirm the note is written from ─────────────────────

describe("Send to chart — which practice's chart", () => {
  it("defaults to the office the server resolved, and shows no warning when it matches", async () => {
    previewPerOffice(VALLEY);
    render(
      <SendToChartDialog
        open onOpenChange={() => {}} call={valleyCall()}
        patientId={7115} patientName="Stedi TestValley" onSent={() => {}}
      />,
    );

    await waitFor(() => expect(apiMock.getCommlogPreview).toHaveBeenCalled());
    // Nothing chosen yet, so the client asks for no particular office and lets the
    // server decide — the third argument is undefined, not a guess.
    expect(apiMock.getCommlogPreview).toHaveBeenCalledWith("call-valley-1", "summary", undefined);
    await waitFor(() => expect(screen.getByText(/Writing to/)).toBeTruthy());
    expect(screen.queryByTestId("cross-office-warning")).toBeNull();
    expect(screen.getByTestId("send-to-chart-confirm").textContent).toMatch(/Send to Valley Fort Smith chart/);
  });

  it("switching the office clears the patient and asks for one in the new office", async () => {
    previewPerOffice(VALLEY);
    render(
      <SendToChartDialog
        open onOpenChange={() => {}} call={valleyCall()}
        patientId={7115} patientName="Stedi TestValley" onSent={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Stedi TestValley/)).toBeTruthy());

    await chooseOffice("chart-office-select", /^Roland/);

    // 7115 is a real person in Roland too — a DIFFERENT one. Carrying the selection
    // across would file this note on their chart, so it goes, and Send goes with it.
    await waitFor(() => expect(screen.getByTestId("cross-office-patient-search")).toBeTruthy());
    expect((screen.getByTestId("send-to-chart-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Find the patient in Roland/i)).toBeTruthy();
  });

  it("re-reads the note types for the new office — never reuses the old list", async () => {
    previewPerOffice(VALLEY);
    render(
      <SendToChartDialog
        open onOpenChange={() => {}} call={valleyCall()}
        patientId={7115} patientName="Stedi TestValley" onSent={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Writing to/)).toBeTruthy());

    await chooseOffice("chart-office-select", /^Roland/);

    await waitFor(() =>
      expect(apiMock.getCommlogPreview).toHaveBeenLastCalledWith("call-valley-1", "summary", "roland"),
    );
    // 401 is a valid DefNum in BOTH practices and names a different type in each, so
    // a list carried over from the other office would be silently wrong.
    fireEvent.keyDown(screen.getByTestId("commlog-type-select"), { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("option", { name: /ODHQ/ })).toBeTruthy());
    expect(screen.queryByRole("option", { name: /Crown by Moolah/ })).toBeNull();
  });

  it("warns persistently and names the target on the confirm button", async () => {
    previewPerOffice(VALLEY);
    apiMock.searchPatientsForCall.mockResolvedValue({
      patients: [{ id: 12827, fullName: "Test 2, Stedi" }],
      office: ROLAND,
    });

    render(
      <SendToChartDialog
        open onOpenChange={() => {}} call={valleyCall()}
        patientId={7115} patientName="Stedi TestValley" onSent={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Writing to/)).toBeTruthy());
    await chooseOffice("chart-office-select", /^Roland/);

    const warning = await screen.findByTestId("cross-office-warning");
    expect(warning.textContent).toMatch(/This call came in at/i);
    expect(warning.textContent).toMatch(/Valley Fort Smith/);
    expect(warning.textContent).toMatch(/writing to a/i);
    expect(warning.textContent).toMatch(/Roland/);

    // Pick a patient in the new office — the warning must still be there afterwards.
    fireEvent.change(screen.getByTestId("cross-office-patient-search"), { target: { value: "Stedi" } });
    await waitFor(() => expect(screen.getByText("Test 2, Stedi")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Use/i }));

    await waitFor(() =>
      expect((screen.getByTestId("send-to-chart-confirm") as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getByTestId("cross-office-warning")).toBeTruthy();
    expect(screen.getByTestId("send-to-chart-confirm").textContent).toMatch(/Send to Roland chart/);
  });

  it("sends the chosen office as the target AND as the assertion", async () => {
    previewPerOffice(VALLEY);
    apiMock.searchPatientsForCall.mockResolvedValue({
      patients: [{ id: 12827, fullName: "Test 2, Stedi" }],
      office: ROLAND,
    });
    apiMock.resolvePatient.mockResolvedValue({ success: true, commLogNum: 486486, office: ROLAND });

    render(
      <SendToChartDialog
        open onOpenChange={() => {}} call={valleyCall()}
        patientId={7115} patientName="Stedi TestValley" onSent={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Writing to/)).toBeTruthy());
    await chooseOffice("chart-office-select", /^Roland/);
    fireEvent.change(screen.getByTestId("cross-office-patient-search"), { target: { value: "Stedi" } });
    await waitFor(() => expect(screen.getByText("Test 2, Stedi")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Use/i }));
    await waitFor(() =>
      expect((screen.getByTestId("send-to-chart-confirm") as HTMLButtonElement).disabled).toBe(false),
    );

    fireEvent.click(screen.getByTestId("send-to-chart-confirm"));

    await waitFor(() => expect(apiMock.resolvePatient).toHaveBeenCalled());
    const [, body] = apiMock.resolvePatient.mock.calls[0];
    // The PatNum sent is the one found in ROLAND — never the valley 7115 the dialog
    // opened with.
    expect(body.patientId).toBe(12827);
    expect(body.target_office).toBe("roland");
    expect(body.office_id).toBe("roland");
    // And the office's own default note type, read from Roland's list.
    expect(body.commTypeDefNum).toBe(486);
    // The confirmation names the practice, because "sent to chart" would not say
    // which chart, and this one is not the obvious one.
    expect(toasts.calls[0].text).toMatch(/Roland/);
  });

  it("switching back restores the original patient — nothing about them changed", async () => {
    previewPerOffice(VALLEY);
    render(
      <SendToChartDialog
        open onOpenChange={() => {}} call={valleyCall()}
        patientId={7115} patientName="Stedi TestValley" onSent={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Stedi TestValley/)).toBeTruthy());

    await chooseOffice("chart-office-select", /^Roland/);
    await waitFor(() => expect(screen.getByTestId("cross-office-patient-search")).toBeTruthy());

    await chooseOffice("chart-office-select", /Valley Fort Smith/);

    await waitFor(() => expect(screen.queryByTestId("cross-office-patient-search")).toBeNull());
    expect((screen.getByTestId("send-to-chart-confirm") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("send-to-chart-confirm").textContent).toMatch(/Send to Valley Fort Smith chart/);
  });
});
