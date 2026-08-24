/**
 * Office visibility in the chart-writing UI (per-location slice), in jsdom.
 *
 * Once two practices are connected, "which patient?" stops being enough — PatNum
 * numbering restarts per Open Dental database. Verified live on 2026-08-07:
 * PatNum 7115 is "Stedi TestValley" in Riley and a different real patient in
 * Roland. The server refuses cross-office writes; what is pinned HERE is the part
 * a HUMAN can get wrong, and therefore has to be able to SEE:
 *
 *   - the Pick Patient modal searches the office of the CALL BY DEFAULT, and says
 *     which one (searching another practice is now possible, but only as a
 *     deliberate choice — see cross-office-chart-target.test.tsx);
 *   - a failed search never reads as "no such patient";
 *   - the Send dialog states which practice's chart it is about to write to, and
 *     asserts that office back to the server;
 *   - a call whose office has no OD gets no chart actions and an honest reason.
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Vitest compiles .tsx with esbuild's classic JSX transform, while the app's Vite build
// uses the automatic runtime — so component modules never import React themselves.
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
  searchPatientsForCall: vi.fn(),
  getCommlogPreview: vi.fn(),
  resolvePatient: vi.fn(),
  // Both dialogs now load the office roster to populate the chart-target picker.
  getOffices: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, ...apiMock } };
});

import { PickPatientModal } from "@/pages/calls/PickPatientModal";
import { SendToChartDialog } from "@/pages/calls/SendToChartDialog";
import type { UnifiedCall, OfficeConfig } from "@/lib/api";

const VALLEY: OfficeConfig = { officeId: "valley", officeName: "Valley Fort Smith", odConnected: true };

/** A minimal Riley/valley call — only the fields these dialogs read. */
function valleyCall(over: Partial<UnifiedCall> = {}): UnifiedCall {
  return {
    id: "call-valley-1",
    officeId: "valley",
    fromNumber: "+14795550101",
    patientName: "Stedi TestValley",
    odMatchCandidates: [],
    ...over,
  } as UnifiedCall;
}

beforeEach(() => {
  toasts.calls.length = 0;
  apiMock.searchPatientsForCall.mockReset();
  apiMock.getCommlogPreview.mockReset();
  apiMock.resolvePatient.mockReset();
  apiMock.getOffices.mockReset();
  apiMock.getOffices.mockResolvedValue([VALLEY]);
});

afterEach(cleanup);

describe("Pick Patient modal — office visibility", () => {
  it("searches THIS CALL's own office unless someone deliberately changes it", async () => {
    apiMock.searchPatientsForCall.mockResolvedValue({ patients: [], office: VALLEY });

    render(
      <PickPatientModal
        open
        onOpenChange={() => {}}
        call={valleyCall()}
        onChoosePatient={() => {}}
        onNotPatient={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Last name, first name, or phone/i), {
      target: { value: "TestValley" },
    });

    await waitFor(() => expect(apiMock.searchPatientsForCall).toHaveBeenCalled());
    // The search is still call-scoped — the call id is always the first argument, so
    // the server fixes the ORIGIN office and the audit trail records which call sent
    // us looking through a practice's records.
    //
    // The office is no longer implicit, because searching only the call's office made
    // a caller who belongs to the other practice impossible to find at all. But it
    // still DEFAULTS to the call's own: opening this modal and typing must never
    // quietly look somewhere else.
    expect(apiMock.searchPatientsForCall).toHaveBeenCalledWith("call-valley-1", "TestValley", "valley");
  });

  it("names the office whose patients it searched", async () => {
    apiMock.searchPatientsForCall.mockResolvedValue({
      patients: [{ id: 7115, fullName: "Stedi TestValley" }],
      office: VALLEY,
    });

    render(
      <PickPatientModal
        open
        onOpenChange={() => {}}
        call={valleyCall()}
        onChoosePatient={() => {}}
        onNotPatient={() => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Last name, first name, or phone/i), {
      target: { value: "TestValley" },
    });

    // This line is how a human catches a wrong-office moment BEFORE picking.
    await waitFor(() => expect(screen.getByText(/Searching Valley Fort Smith patients/i)).toBeTruthy());
  });

  it("a failed search does not read as 'no patients found'", async () => {
    // Reporting a broken search as an empty result invites a duplicate chart or the
    // wrong record — the two states must never look the same.
    apiMock.searchPatientsForCall.mockResolvedValue({
      patients: [],
      office: null,
      error: "Open Dental is not available for this office",
    });

    render(
      <PickPatientModal
        open
        onOpenChange={() => {}}
        call={valleyCall()}
        onChoosePatient={() => {}}
        onNotPatient={() => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Last name, first name, or phone/i), {
      target: { value: "TestValley" },
    });

    await waitFor(() => expect(screen.getByText(/Open Dental is not available/i)).toBeTruthy());
    expect(screen.queryByText(/No patients found/i)).toBeNull();
  });
});

describe("Send to chart dialog — which practice", () => {
  it("states the office the note is about to be written to", async () => {
    apiMock.getCommlogPreview.mockResolvedValue({
      note: "CareIN call - Aug 7, 2026 - Staff (Mango)",
      patientId: 7115,
      patientName: "Stedi TestValley",
      office: VALLEY,
    });

    render(
      <SendToChartDialog
        open
        onOpenChange={() => {}}
        call={valleyCall()}
        patientId={7115}
        patientName="Stedi TestValley"
        onSent={() => {}}
      />,
    );

    // "PatNum 7115" alone is ambiguous across practices; the office resolves it.
    // Named in more than one place now (the target picker AND the "Writing to" line),
    // so assert the line that states where the note lands rather than a bare match.
    await waitFor(() => expect(screen.getByText(/Writing to/)).toBeTruthy());
    expect(screen.getByText(/Writing to/).textContent).toMatch(/Valley Fort Smith/);
    expect(screen.getByText(/PatNum 7115/)).toBeTruthy();
  });

  it("asserts the office back to the server on send", async () => {
    apiMock.getCommlogPreview.mockResolvedValue({
      note: "CareIN call", patientId: 7115, patientName: "Stedi TestValley", office: VALLEY,
    });
    apiMock.resolvePatient.mockResolvedValue({ success: true, commLogNum: 451451 });

    render(
      <SendToChartDialog
        open
        onOpenChange={() => {}}
        call={valleyCall()}
        patientId={7115}
        patientName="Stedi TestValley"
        onSent={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Writing to/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Send to .*chart/i }));

    await waitFor(() => expect(apiMock.resolvePatient).toHaveBeenCalled());
    const [, body] = apiMock.resolvePatient.mock.calls[0];
    // A screen whose idea of the target disagrees with the server's gets refused
    // rather than writing a note into the wrong practice. office_id still only ever
    // asserts — target_office is the half that selects, and here they agree because
    // nobody changed the office.
    expect(body.office_id).toBe("valley");
    expect(body.target_office).toBe("valley");
    expect(body.patientId).toBe(7115);
  });

  it("tells the user which practice it landed in", async () => {
    apiMock.getCommlogPreview.mockResolvedValue({
      note: "CareIN call", patientId: 7115, patientName: "Stedi TestValley", office: VALLEY,
    });
    apiMock.resolvePatient.mockResolvedValue({ success: true, commLogNum: 451451 });

    render(
      <SendToChartDialog
        open
        onOpenChange={() => {}}
        call={valleyCall()}
        patientId={7115}
        patientName="Stedi TestValley"
        onSent={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Writing to/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Send to .*chart/i }));

    await waitFor(() => expect(toasts.calls.length).toBeGreaterThan(0));
    expect(toasts.calls[0].kind).toBe("success");
    expect(toasts.calls[0].text).toMatch(/Valley Fort Smith/);
  });
});
