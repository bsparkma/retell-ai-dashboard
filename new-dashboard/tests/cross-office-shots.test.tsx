/**
 * Screenshot DUMPS for the cross-office chart target.
 *
 * Same shape and same reasons as `detail-triage-shots.test.tsx`: renders the dialog
 * into jsdom with fixture data that lives in this file and writes the markup to
 * `tests/.shots/*.html`, which `scripts/shoot-cross-office.mjs` then wraps in the
 * app's real built CSS and photographs.
 *
 * The point of the pictures is the one thing a screenshot can show and an assertion
 * cannot: whether a person about to write into somebody's chart can SEE, at a glance,
 * that it is not the chart they would have expected.
 *
 * NO NETWORK, NO BACKEND, NO PHI. roland 12827 "Test 2, Stedi" and valley 7115 "Stedi
 * TestValley" are the synthetic staging fixtures — a screenshot of the screen that
 * writes to patient charts physically cannot contain a patient.
 *
 * Skipped unless CROSS_OFFICE_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

(globalThis as Record<string, unknown>).React = React;

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

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
import type { UnifiedCall, OfficeConfig } from "@/lib/api";

const OUT = resolve(import.meta.dirname, ".shots");
const enabled = process.env.CROSS_OFFICE_SHOTS === "1";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

const ROLAND: OfficeConfig = { officeId: "roland", officeName: "Roland", odConnected: true };
const VALLEY: OfficeConfig = { officeId: "valley", officeName: "Valley Fort Smith", odConnected: true };

const NOTE = [
  "CareIN call - Aug 24, 2026 3:04 PM - Staff (Mango)",
  "Caller: (479) 555-0101",
  "",
  "Summary: Caller asked to move a cleaning to the following week and to",
  "confirm what their plan covers for a night guard.",
  "",
  "Action: Call back to confirm the new time",
  "Callback: (479) 555-0101",
].join("\n");

function preview(office: OfficeConfig) {
  return {
    note: NOTE,
    patientId: null,
    patientName: null,
    office,
    callOffice: VALLEY,
    crossOffice: office.officeId !== "valley",
    commlogTypes: {
      available: true,
      options: office.officeId === "roland"
        ? [{ defNum: 486, name: "CareIN AI Call" }, { defNum: 401, name: "ODHQ" }]
        : [{ defNum: 451, name: "CareIN AI Call" }, { defNum: 401, name: "Crown by Moolah" }],
      defaultDefNum: office.officeId === "roland" ? 486 : 451,
      defaultName: "CareIN AI Call",
      stale: false,
    },
  };
}

/** A call that rang at Riley/valley — the origin in every shot below. */
const CALL = {
  id: "call-valley-1",
  officeId: "valley",
  fromNumber: "+14795550101",
  patientName: "Unknown caller",
  odMatchCandidates: [],
} as unknown as UnifiedCall;

function dump(name: string) {
  mkdirSync(OUT, { recursive: true });
  // The dialog is portalled to document.body, so the whole body is the picture.
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

beforeEach(() => {
  apiMock.getOffices.mockReset();
  apiMock.getCommlogPreview.mockReset();
  apiMock.searchPatientsForCall.mockReset();
  apiMock.getOffices.mockResolvedValue([ROLAND, VALLEY]);
  apiMock.searchPatientsForCall.mockResolvedValue({
    patients: [{ id: 12827, fullName: "Test 2, Stedi", dateOfBirth: "1985-04-12", phone: "(918) 555-0142" }],
    office: ROLAND,
  });
});

afterEach(cleanup);

describe.skipIf(!enabled)("cross-office chart target — screenshot dumps", () => {
  it("01 — same office: no warning, the ordinary send", async () => {
    apiMock.getCommlogPreview.mockResolvedValue(preview(VALLEY));
    render(
      <SendToChartDialog
        canCrossOffice
        open onOpenChange={() => {}} call={CALL}
        patientId={7115} patientName="Stedi TestValley" onSent={() => {}}
      />,
    );
    await waitFor(() => screen.getByText(/Writing to/));
    dump("01-same-office");
  });

  it("02 — cross office: the warning, and a confirm that names the practice", async () => {
    apiMock.getCommlogPreview.mockImplementation(async (_id, _ct, targetOffice?: string) =>
      preview(targetOffice === "roland" ? ROLAND : VALLEY),
    );
    render(
      <SendToChartDialog
        canCrossOffice
        open onOpenChange={() => {}} call={CALL}
        patientId={7115} patientName="Stedi TestValley" onSent={() => {}}
      />,
    );
    await waitFor(() => screen.getByText(/Writing to/));

    // Switch to the other practice, then find the patient over there — the state a
    // person is actually in at the moment they press Send on a cross-office note.
    await waitFor(() =>
      ((screen.getByTestId("chart-office-select") as HTMLButtonElement).disabled === false) || Promise.reject(),
    );
    fireEvent.keyDown(screen.getByTestId("chart-office-select"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: /^Roland/ }));

    await waitFor(() => screen.getByTestId("cross-office-patient-search"));
    fireEvent.change(screen.getByTestId("cross-office-patient-search"), { target: { value: "Stedi" } });
    await waitFor(() => screen.getByText("Test 2, Stedi"));
    fireEvent.click(screen.getByRole("button", { name: /Use/i }));
    await waitFor(() =>
      ((screen.getByTestId("send-to-chart-confirm") as HTMLButtonElement).disabled === false) || Promise.reject(),
    );
    dump("02-cross-office");
  });

  it("03 — cross office, patient not chosen yet: Send is not available", async () => {
    apiMock.getCommlogPreview.mockImplementation(async (_id, _ct, targetOffice?: string) =>
      preview(targetOffice === "roland" ? ROLAND : VALLEY),
    );
    apiMock.searchPatientsForCall.mockResolvedValue({ patients: [], office: ROLAND });
    render(
      <SendToChartDialog
        canCrossOffice
        open onOpenChange={() => {}} call={CALL}
        patientId={7115} patientName="Stedi TestValley" onSent={() => {}}
      />,
    );
    await waitFor(() => screen.getByText(/Writing to/));
    await waitFor(() =>
      ((screen.getByTestId("chart-office-select") as HTMLButtonElement).disabled === false) || Promise.reject(),
    );
    fireEvent.keyDown(screen.getByTestId("chart-office-select"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: /^Roland/ }));
    await waitFor(() => screen.getByTestId("cross-office-patient-search"));
    dump("03-cross-office-no-patient");
  });
});
