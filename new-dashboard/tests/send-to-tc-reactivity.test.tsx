/**
 * "Send to TC" appears as soon as the patient is resolved — no page refresh.
 *
 * THE BUG (reported 2026-08-08): after resolving a patient / sending to chart,
 * the Send to TC button stayed unusable until a full reload.
 *
 * ROOT CAUSE: both success paths hand-patched the two or three fields they
 * assumed had changed —
 *     patchCall(id, { odSyncStatus: 'synced', odPatientId, sentBy, sentAt })
 * — but resolving ALSO sets od_patient_name on the server, and
 * sendToTcState() refuses to fire without it ('patient name unavailable').
 * A reload fetched the real record and the button came right.
 *
 * THE FIX: the resolve response already carries the complete updated call, so
 * render from THAT instead of guessing which fields moved. This test pins the
 * behaviour rather than the mechanism: after a successful send, the button is
 * present and enabled, with no refetch.
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
  getCommlogPreview: vi.fn(),
  resolvePatient: vi.fn(),
  sendCallToTc: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, ...apiMock } };
});

import { type UnifiedCall, type BackendUnifiedCall } from "@/lib/api";
import { SendToChartDialog } from "@/pages/calls/SendToChartDialog";
import { SendToTcButton } from "@/pages/calls/SendToTcButton";

/** An UNMATCHED valley call, exactly as the worklist holds it before resolving. */
function unmatchedCall(): UnifiedCall {
  return {
    id: "mango_call_seed_valley_review",
    officeId: "valley",
    odPatientId: null,
    odPatientName: null,
    odSyncStatus: "needs_review",
    odMatchCandidates: [],
    tcCaseId: null,
    tcCaseUrl: null,
  } as unknown as UnifiedCall;
}

/** What the server returns from resolve-patient: the COMPLETE post-send record. */
function serverCallAfterSend(): BackendUnifiedCall {
  return {
    id: "mango_call_seed_valley_review",
    source: "mango",
    office_id: "valley",
    od_patient_id: 7115,
    od_patient_name: "Stedi TestValley",
    od_sync_status: "synced",
    sent_by: { name: "Sarah Front", email: "sarah@carein.ai" },
    sent_at: "2026-08-08T12:00:00.000Z",
  } as BackendUnifiedCall;
}

/**
 * The two components as the real pages wire them: one call in state, the dialog
 * updating it on success, the TC button reading it. No refetch anywhere.
 */
function Harness() {
  const [call, setCall] = React.useState<UnifiedCall>(unmatchedCall());
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <SendToChartDialog
        open={open}
        onOpenChange={setOpen}
        call={call}
        patientId={7115}
        patientName="Stedi TestValley"
        onSent={(updated) => setCall((prev) => (updated ? { ...prev, ...updated } : prev))}
      />
      <SendToTcButton call={call} onSent={() => {}} />
    </>
  );
}

beforeEach(() => {
  toasts.calls.length = 0;
  apiMock.getCommlogPreview.mockReset();
  apiMock.resolvePatient.mockReset();
  apiMock.sendCallToTc.mockReset();
  apiMock.getCommlogPreview.mockResolvedValue({
    note: "CareIN call - Aug 7, 2026 - Staff (Mango)\nCaller: Stedi TestValley",
    patientId: 7115,
    patientName: "Stedi TestValley",
    office: { officeId: "valley", officeName: "Valley Fort Smith", odConnected: true },
  });
});

afterEach(cleanup);

describe("Send to TC reactivity after resolving a patient", () => {
  it("is absent while the call is unmatched", () => {
    render(<SendToTcButton call={unmatchedCall()} onSent={() => {}} />);
    expect(screen.queryByRole("button", { name: /send to tc/i })).toBeNull();
  });

  it("the old partial patch is exactly what left it unusable (root cause, pinned)", () => {
    // Reproduce the pre-fix post-send state: odPatientId + 'synced' written by
    // hand, od_patient_name never carried across. This is why a refresh "fixed"
    // it — the refetch brought the name. Pinned so a future change cannot make
    // the symptom disappear by loosening the visibility rule instead: the button
    // must keep refusing to fire without the name the TC contract requires.
    const oldPostSendState = {
      ...unmatchedCall(), odPatientId: 7115, odSyncStatus: "synced",
    } as unknown as UnifiedCall;
    render(<SendToTcButton call={oldPostSendState} onSent={() => {}} />);
    const button = screen.getByRole("button", { name: /send to tc/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe("patient name unavailable");
  });

  it("appears ENABLED as soon as the send succeeds — no page refresh", async () => {
    apiMock.resolvePatient.mockResolvedValue({
      success: true, commLogNum: 9001, call: serverCallAfterSend(),
    });

    render(<Harness />);

    // Before: unmatched, so no TC affordance at all.
    expect(screen.queryByRole("button", { name: /send to tc/i })).toBeNull();

    await screen.findByRole("button", { name: /send to chart/i });
    fireEvent.click(screen.getByRole("button", { name: /send to chart/i }));

    // After: the button is there AND usable, from the same render pass.
    const tcButton = await screen.findByRole("button", { name: /send to tc/i });
    expect((tcButton as HTMLButtonElement).disabled).toBe(false);
    expect(tcButton.getAttribute("title")).not.toBe("patient name unavailable");
  });

  it("carries the resolved patient name into the payload it would send", async () => {
    // The regression in miniature: the name is what the TC contract REQUIRES and
    // what the button refuses to fire without.
    apiMock.resolvePatient.mockResolvedValue({
      success: true, commLogNum: 9001, call: serverCallAfterSend(),
    });
    apiMock.sendCallToTc.mockResolvedValue({
      success: true, caseId: "case_1", url: "/tc/cases/case_1", attached: false,
    });

    render(<Harness />);
    await screen.findByRole("button", { name: /send to chart/i });
    fireEvent.click(screen.getByRole("button", { name: /send to chart/i }));

    const tcButton = await screen.findByRole("button", { name: /send to tc/i });
    fireEvent.click(tcButton);

    await waitFor(() => expect(apiMock.sendCallToTc).toHaveBeenCalled());
    // Office comes from the server's record, so the assertion cannot drift to
    // another practice just because the client patched a stale field.
    expect(apiMock.sendCallToTc).toHaveBeenCalledWith(
      "mango_call_seed_valley_review", { office_id: "valley" },
    );
    expect(toasts.calls.some((t) => t.text.includes("Stedi TestValley"))).toBe(true);
  });

  it("still reflects the send when the response carries no call record", async () => {
    // Older/partial responses must not regress the page to a stale state — the
    // fallback patch still marks it synced, even though the TC button then has to
    // wait for a refresh (which is the pre-fix behaviour, not a new failure).
    apiMock.resolvePatient.mockResolvedValue({ success: true, commLogNum: 9001 });

    render(<Harness />);
    await screen.findByRole("button", { name: /send to chart/i });
    fireEvent.click(screen.getByRole("button", { name: /send to chart/i }));

    await waitFor(() => expect(toasts.calls.length).toBeGreaterThan(0));
    expect(toasts.calls[0].kind).toBe("success");
  });

  it("a failed send changes nothing — no TC button, no false success", async () => {
    apiMock.resolvePatient.mockRejectedValue(new Error("OD unavailable"));

    render(<Harness />);
    await screen.findByRole("button", { name: /send to chart/i });
    fireEvent.click(screen.getByRole("button", { name: /send to chart/i }));

    await waitFor(() => expect(toasts.calls.length).toBeGreaterThan(0));
    expect(toasts.calls[0].kind).toBe("error");
    expect(screen.queryByRole("button", { name: /send to tc/i })).toBeNull();
  });
});
