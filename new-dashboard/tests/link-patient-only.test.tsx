/**
 * "Link patient only" — identifying the caller stops forcing a chart note.
 *
 * Picking a patient used to hand straight off to the Send-to-chart dialog,
 * because the only way to set od_patient_id was an endpoint that also wrote a
 * commlog. So every match filed a note — including matches made just to see who
 * called, or to hand the call to TC, which is not a chart write at all.
 *
 * Now the modal links and stops. The call lands in 'matched' — the state Slice
 * B.1 already defined as "patient known, note not sent" — and "Send to chart"
 * and "Send to TC" become independent, optional actions.
 *
 * No PHI: the patient below is the synthetic staging fixture.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("wouter", () => ({
  useLocation: () => ["/calls", () => {}],
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: {
      name: "Sarah Front", email: "sarah@carein.ai", tenantId: "t1",
      tenant: { slug: "carein", displayName: "CareIN", modules: ["voice", "tc"] },
    },
  }),
}));

const apiMock = vi.hoisted(() => ({
  resolvePatient: vi.fn(),
  searchPatientsForCall: vi.fn(),
  sendCallToTc: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, ...apiMock } };
});

import { type UnifiedCall, type BackendUnifiedCall } from "@/lib/api";
import { PickPatientModal } from "@/pages/calls/PickPatientModal";
import { SendToTcButton } from "@/pages/calls/SendToTcButton";

/** An unmatched valley call carrying one stored candidate (the one-click path). */
function unmatchedCall(): UnifiedCall {
  return {
    id: "mango_call_seed_valley_review",
    officeId: "valley",
    patientName: "Unknown",
    fromNumber: "+14795550101",
    odPatientId: null,
    odPatientName: null,
    odSyncStatus: "needs_review",
    odMatchCandidates: [{ id: 7115, name: "Stedi TestValley" }],
    tcCaseId: null,
    tcCaseUrl: null,
  } as unknown as UnifiedCall;
}

/** The server's post-LINK record: matched, named, and no chart note. */
function linkedRecord(): BackendUnifiedCall {
  return {
    id: "mango_call_seed_valley_review",
    source: "mango",
    office_id: "valley",
    od_patient_id: 7115,
    od_patient_name: "Stedi TestValley",
    od_sync_status: "matched",
    od_commlog_num: null,
    sent_at: null,
    sent_by: null,
  } as BackendUnifiedCall;
}

beforeEach(() => {
  toasts.calls.length = 0;
  apiMock.resolvePatient.mockReset();
  apiMock.searchPatientsForCall.mockReset();
  apiMock.sendCallToTc.mockReset();
  apiMock.searchPatientsForCall.mockResolvedValue({ patients: [], office: null, error: null });
});

afterEach(cleanup);

describe("Pick Patient links without writing a chart note", () => {
  it("sends linkOnly — never a commlog write — and reports the link", async () => {
    apiMock.resolvePatient.mockResolvedValue({ success: true, linked: true, call: linkedRecord() });
    const onLinked = vi.fn();

    render(
      <PickPatientModal
        open
        onOpenChange={() => {}}
        call={unmatchedCall()}
        onLinked={onLinked}
        onNotPatient={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /link/i }));

    await waitFor(() => expect(apiMock.resolvePatient).toHaveBeenCalled());
    const [, body] = apiMock.resolvePatient.mock.calls[0];
    expect(body.linkOnly).toBe(true);
    expect(body.patientId).toBe(7115);
    // The chart-note fields must be absent — this request must not be a send.
    expect("note" in body).toBe(false);
    expect("content_type" in body).toBe(false);

    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    const updated = onLinked.mock.calls[0][0] as UnifiedCall;
    expect(updated.odPatientId).toBe(7115);
    expect(updated.odPatientName).toBe("Stedi TestValley");
    expect(updated.odSyncStatus).toBe("matched");
    expect(toasts.calls[0]).toEqual({ kind: "success", text: "Linked to Stedi TestValley" });
  });

  it("a failed link reports the failure and links nothing", async () => {
    apiMock.resolvePatient.mockRejectedValue(new Error("Patient not found in Open Dental"));
    const onLinked = vi.fn();

    render(
      <PickPatientModal
        open
        onOpenChange={() => {}}
        call={unmatchedCall()}
        onLinked={onLinked}
        onNotPatient={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /link/i }));

    await waitFor(() => expect(toasts.calls.length).toBeGreaterThan(0));
    expect(toasts.calls[0].kind).toBe("error");
    expect(onLinked).not.toHaveBeenCalled();
  });
});

describe("after linking, the two sends are independent", () => {
  /** The modal, then whatever the matched call can do next. */
  function Harness() {
    const [call, setCall] = React.useState<UnifiedCall>(unmatchedCall());
    const [open, setOpen] = React.useState(true);
    return (
      <>
        <PickPatientModal
          open={open}
          onOpenChange={setOpen}
          call={call}
          onLinked={(updated) => { setCall((prev) => ({ ...prev, ...updated })); setOpen(false); }}
          onNotPatient={() => {}}
        />
        <div data-testid="state">{call.odSyncStatus}</div>
        <SendToTcButton call={call} onSent={() => {}} />
      </>
    );
  }

  it("Send to TC becomes available on a LINKED call that was never sent to chart", async () => {
    apiMock.resolvePatient.mockResolvedValue({ success: true, linked: true, call: linkedRecord() });

    render(<Harness />);

    // Before linking: no TC affordance.
    expect(screen.queryByRole("button", { name: /send to tc/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^link$/i }));

    // After linking: matched, no chart note written, TC ready.
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("matched"));
    const tcButton = await screen.findByRole("button", { name: /send to tc/i });
    expect((tcButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("handing a linked call to TC never triggers a chart write", async () => {
    // The scope in one assertion: TC is reachable with zero commlog traffic.
    apiMock.resolvePatient.mockResolvedValue({ success: true, linked: true, call: linkedRecord() });
    apiMock.sendCallToTc.mockResolvedValue({
      success: true, caseId: "case_1", url: "/tc/cases/case_1", attached: false,
    });

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^link$/i }));

    const tcButton = await screen.findByRole("button", { name: /send to tc/i });
    fireEvent.click(tcButton);

    await waitFor(() => expect(apiMock.sendCallToTc).toHaveBeenCalled());
    // resolvePatient was called exactly once — the link — and never for a note.
    expect(apiMock.resolvePatient).toHaveBeenCalledTimes(1);
    expect(apiMock.resolvePatient.mock.calls[0][1].linkOnly).toBe(true);
  });
});
