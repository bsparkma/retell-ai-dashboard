/**
 * Triage on the call-detail page.
 *
 * THE PROBLEM: "Flag for follow-up" and "Mark done" existed only on the worklist row.
 * The team reads the call on the DETAIL page, so closing one out meant navigating back
 * to the list and hunting for the row — which is why handled calls kept sitting in
 * "Needs attention".
 *
 * What these pin:
 *   - ONE component in two shapes. The worklist keeps its icon-only row (PR #53); the
 *     detail header gets words, because there the whole point is discoverability.
 *   - The same five outcomes and the same optional note in both.
 *   - The detail page updates optimistically and PUTS THE OLD STATE BACK when the save
 *     fails — a call must never look handled because a request died.
 *   - The buttons follow voice.write. A `tc` user (read-only voice) sees the state and
 *     no controls; the 403 on PATCH /triage is the real boundary either way.
 *   - Marking done does NOT navigate away: filing the chart note is a separate decision
 *     the same person may want to make next.
 *
 * No PHI: every name and number below is synthetic.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

// jsdom has no ResizeObserver; radix's Popover positioning needs one and the outcome
// picker lives in a popover. Same stub the other popover suites use.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const toasts = vi.hoisted(() => ({ calls: [] as Array<{ kind: string; text: string }> }));
vi.mock("sonner", () => ({
  toast: {
    success: (text: string) => toasts.calls.push({ kind: "success", text }),
    info: (text: string) => toasts.calls.push({ kind: "info", text }),
    error: (text: string) => toasts.calls.push({ kind: "error", text }),
  },
}));

/** Where the router thinks we are — a navigation would change this. */
const routerState = vi.hoisted(() => ({ path: "/calls/c1" }));
vi.mock("wouter", () => ({
  useLocation: () => [routerState.path, (to: string) => { routerState.path = to; }],
  useRoute: () => [true, { id: "c1" }],
  useParams: () => ({ id: "c1" }),
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

/**
 * The signed-in user. `permissions` is what decides whether triage is offered.
 *
 * The office set includes voice.chart_write because the real role holds it — the
 * "stays on the call" test below reads the Send to chart button as proof the page
 * did not navigate, and that button follows voice.chart_write.
 */
const authState = vi.hoisted(() => ({
  role: "office" as string,
  permissions: ["voice.read", "voice.write", "voice.chart_write"] as string[],
  isSuperAdmin: false,
}));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: {
      name: "Sarah Front", email: "sarah@carein.ai", tenantId: "t1",
      tenant: { slug: "carein", displayName: "CareIN", modules: ["voice", "tc"] },
      role: authState.role,
      isSuperAdmin: authState.isSuperAdmin,
      permissions: authState.permissions,
      homeOffice: null,
    },
  }),
}));

vi.mock("@/contexts/OfficeContext", () => ({
  ALL_OFFICES: "__all__",
  useOffice: () => ({
    office: "valley",
    offices: [{ officeId: "valley", officeName: "Valley Family Dental", odConnected: true }],
    selected: { officeId: "valley", officeName: "Valley Family Dental", odConnected: true },
  }),
}));

vi.mock("@/hooks/useTranscribeCall", () => ({
  useTranscribeCall: () => ({
    isRunning: () => false,
    request: vi.fn(),
    pendingConfirm: null,
    pendingConfirmKind: null,
    confirm: vi.fn(),
    cancelConfirm: vi.fn(),
  }),
}));

const apiMock = vi.hoisted(() => ({
  getUnifiedCall: vi.fn(),
  triageCall: vi.fn(),
  getOpenDentalPatient: vi.fn(),
  searchPatientByPhone: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, ...apiMock } };
});

import {
  normalizeUnifiedCall, type BackendUnifiedCall, type UnifiedCall, type TriageOutcome,
} from "@/lib/api";
import CallDetail from "@/pages/CallDetail";
import { TriageActions, TriageStatePill } from "@/components/calls/TriageActions";
import { OUTCOMES, OUTCOME_LABEL, outcomeLabel } from "@/lib/triage";

/** A live staff call, exactly as the backend serves one. Synthetic throughout. */
const backendCall = (over: Partial<BackendUnifiedCall> = {}): BackendUnifiedCall => ({
  id: "c1",
  source: "mango",
  office_id: "valley",
  caller_name: "Synthetic Caller",
  caller_number: "+15550000000",
  called_number: "+15551111111",
  call_date: "2026-08-18T15:00:00.000Z",
  duration_seconds: 120,
  summary: "a synthetic summary",
  od_sync_status: "needs_review",
  od_patient_id: 12828,
  od_patient_name: "Test, MangoTest",
  has_transcript: true,
  ...over,
} as unknown as BackendUnifiedCall);

const call = (over: Partial<BackendUnifiedCall> = {}): UnifiedCall =>
  normalizeUnifiedCall(backendCall(over));

async function renderDetail(c: UnifiedCall = call()) {
  apiMock.getUnifiedCall.mockResolvedValue(c);
  apiMock.searchPatientByPhone.mockResolvedValue(null);
  apiMock.getOpenDentalPatient.mockRejectedValue(new Error("no OD in tests"));
  render(React.createElement(CallDetail));
  await waitFor(() => expect(screen.getByTestId("call-header-actions")).toBeTruthy());
}

beforeEach(() => {
  toasts.calls.length = 0;
  routerState.path = "/calls/c1";
  authState.role = "office";
  authState.permissions = ["voice.read", "voice.write", "voice.chart_write"];
  authState.isSuperAdmin = false;
  for (const fn of Object.values(apiMock)) fn.mockReset();
});
afterEach(cleanup);

// --- the shared vocabulary --------------------------------------------------

describe("the outcome vocabulary is shared, not copied", () => {
  it("labels every outcome the closed union allows", () => {
    const all: TriageOutcome[] = [
      "scheduled", "called_back", "left_voicemail", "no_answer", "no_action_needed",
    ];
    expect(OUTCOMES.map((o) => o.value).sort()).toEqual([...all].sort());
    for (const o of all) expect(OUTCOME_LABEL[o]).toBeTruthy();
  });

  it("falls back to 'Done' for a call closed before outcomes existed", () => {
    expect(outcomeLabel(null)).toBe("Done");
    expect(outcomeLabel("scheduled")).toBe("Scheduled");
  });
});

// --- the shared component, both shapes --------------------------------------

function renderActions(
  c: UnifiedCall,
  variant: "icon" | "labeled",
  handlers: Partial<{
    onFollowUp: () => void;
    onDone: (call: UnifiedCall, status: "done", outcome: TriageOutcome, note?: string) => void;
    onReopen: () => void;
  }> = {},
) {
  const spies = {
    onFollowUp: handlers.onFollowUp ?? vi.fn(),
    onDone: handlers.onDone ?? vi.fn(),
    onReopen: handlers.onReopen ?? vi.fn(),
  };
  render(React.createElement(TriageActions, { call: c, variant, ...spies }));
  return spies;
}

describe("TriageActions renders in two shapes from one implementation", () => {
  it("labeled: the words are on the buttons", () => {
    renderActions(call(), "labeled");
    expect(screen.getByTestId("triage-follow-up").textContent).toContain("Follow up");
    expect(screen.getByTestId("triage-mark-done").textContent).toContain("Mark done");
  });

  it("icon: no words, but every button still says what it is", () => {
    renderActions(call(), "icon");
    // The worklist row's whole reason for existing: no visible label eating the width.
    expect(screen.queryByTestId("triage-follow-up")).toBeNull();
    expect(screen.queryByTestId("triage-mark-done")).toBeNull();
    expect(screen.getByLabelText("Flag for follow up")).toBeTruthy();
    expect(screen.getByLabelText("Mark done — choose an outcome")).toBeTruthy();
  });

  it("says the call is already flagged without renaming the action", () => {
    renderActions(call({ triage_status: "needs_action" }), "labeled");
    const button = screen.getByTestId("triage-follow-up");
    // Still "Follow up" — that names what clicking does. Being flagged is state.
    expect(button.textContent).toContain("Follow up");
    expect(button.getAttribute("title")).toContain("Following up");
  });

  for (const variant of ["icon", "labeled"] as const) {
    it(variant + ": the Done popover offers all five outcomes", async () => {
      renderActions(call(), variant);
      fireEvent.click(screen.getByLabelText("Mark done — choose an outcome"));
      for (const o of OUTCOMES) {
        expect(await screen.findByText(o.label)).toBeTruthy();
      }
    });
  }

  it("hands back the status, the outcome and the typed note", async () => {
    const onDone = vi.fn();
    const c = call();
    renderActions(c, "labeled", { onDone });

    fireEvent.click(screen.getByTestId("triage-mark-done"));
    fireEvent.change(await screen.findByPlaceholderText("Optional note…"), {
      target: { value: "  patient will call back Monday  " },
    });
    fireEvent.click(screen.getByText("Scheduled"));

    expect(onDone).toHaveBeenCalledWith(c, "done", "scheduled", "patient will call back Monday");
  });

  it("omits an empty note rather than sending an empty string", async () => {
    const onDone = vi.fn();
    renderActions(call(), "labeled", { onDone });
    fireEvent.click(screen.getByTestId("triage-mark-done"));
    fireEvent.click(await screen.findByText("No answer"));
    expect(onDone).toHaveBeenCalledWith(expect.anything(), "done", "no_answer", undefined);
  });

  it("a done call offers Reopen and nothing else", () => {
    const onReopen = vi.fn();
    renderActions(call({ triage_status: "done", triage_outcome: "scheduled" }), "labeled", { onReopen });

    expect(screen.queryByTestId("triage-follow-up")).toBeNull();
    expect(screen.queryByTestId("triage-mark-done")).toBeNull();

    fireEvent.click(screen.getByTestId("triage-reopen"));
    expect(onReopen).toHaveBeenCalledTimes(1);
  });
});

// --- the state pill ---------------------------------------------------------

describe("the state pill says where the call stands", () => {
  it("says nothing at all about an untouched call", () => {
    render(React.createElement(TriageStatePill, { call: call() }));
    expect(screen.queryByTestId("triage-state-pill")).toBeNull();
  });

  it("names the outcome and who resolved it", () => {
    render(React.createElement(TriageStatePill, {
      call: call({
        triage_status: "done",
        triage_outcome: "left_voicemail",
        triage_by: { name: "Sarah Front", email: "sarah@carein.ai" },
        triage_at: "2026-08-18T15:05:00.000Z",
      }),
    }));
    const pill = screen.getByTestId("triage-state-pill");
    expect(pill.dataset.triageStatus).toBe("done");
    expect(pill.textContent).toContain("Done");
    expect(pill.textContent).toContain("Left voicemail");
    expect(pill.textContent).toContain("Sarah Front");
  });

  it("reads 'Following up' for a flagged call", () => {
    render(React.createElement(TriageStatePill, { call: call({ triage_status: "needs_action" }) }));
    const pill = screen.getByTestId("triage-state-pill");
    expect(pill.dataset.triageStatus).toBe("needs_action");
    expect(pill.textContent).toContain("Following up");
  });
});

// --- the detail page --------------------------------------------------------

describe("triage on the call-detail page", () => {
  it("puts both actions in the header, beside the existing ones", async () => {
    await renderDetail();
    const header = screen.getByTestId("call-header-actions");
    expect(within(header).getByTestId("triage-follow-up")).toBeTruthy();
    expect(within(header).getByTestId("triage-mark-done")).toBeTruthy();
    // Still the same header — nothing was displaced to make room.
    expect(within(header).getByText("Add Callback")).toBeTruthy();
  });

  it("a read-only (tc) user sees the state and no controls", async () => {
    authState.role = "tc";
    authState.permissions = ["voice.read", "tc.full"];
    await renderDetail(call({
      triage_status: "done",
      triage_outcome: "scheduled",
      triage_by: { name: "Sarah Front", email: "sarah@carein.ai" },
    }));

    expect(screen.getByTestId("triage-state-pill").textContent).toContain("Scheduled");
    expect(screen.queryByTestId("triage-follow-up")).toBeNull();
    expect(screen.queryByTestId("triage-mark-done")).toBeNull();
    expect(screen.queryByTestId("triage-reopen")).toBeNull();
  });

  it("a super_admin whose tenant role lacks voice.write still triages", async () => {
    authState.permissions = [];
    authState.isSuperAdmin = true;
    await renderDetail();
    expect(screen.getByTestId("triage-follow-up")).toBeTruthy();
  });

  it("flags for follow-up: optimistic pill, then the server's record", async () => {
    apiMock.triageCall.mockResolvedValue(backendCall({
      triage_status: "needs_action",
      triage_by: { name: "Sarah Front", email: "sarah@carein.ai" },
      triage_at: "2026-08-18T15:05:00.000Z",
    }));
    await renderDetail();

    fireEvent.click(screen.getByTestId("triage-follow-up"));

    await waitFor(() => expect(screen.getByTestId("triage-state-pill").dataset.triageStatus)
      .toBe("needs_action"));
    expect(apiMock.triageCall).toHaveBeenCalledWith("c1", { triage_status: "needs_action" });
    await waitFor(() => expect(toasts.calls).toContainEqual({ kind: "success", text: "Flagged for follow-up" }));
  });

  it("marks done with the outcome and the note, and says which outcome", async () => {
    apiMock.triageCall.mockResolvedValue(backendCall({
      triage_status: "done",
      triage_outcome: "scheduled",
      triage_note: "booked for Tuesday",
      triage_by: { name: "Sarah Front", email: "sarah@carein.ai" },
    }));
    await renderDetail();

    fireEvent.click(screen.getByTestId("triage-mark-done"));
    fireEvent.change(await screen.findByPlaceholderText("Optional note…"), {
      target: { value: "booked for Tuesday" },
    });
    fireEvent.click(screen.getByText("Scheduled"));

    await waitFor(() => expect(apiMock.triageCall).toHaveBeenCalledWith("c1", {
      triage_status: "done",
      triage_outcome: "scheduled",
      triage_note: "booked for Tuesday",
    }));
    // The toast names the outcome — "saved" would not tell you what you just said.
    await waitFor(() => expect(toasts.calls).toContainEqual({
      kind: "success", text: "Marked done — Scheduled",
    }));
    // …and the page now offers Reopen instead of the two actions.
    await waitFor(() => expect(screen.getByTestId("triage-reopen")).toBeTruthy());
    expect(screen.getByTestId("triage-state-pill").textContent).toContain("Done");
  });

  it("stays on the call after marking it done", async () => {
    apiMock.triageCall.mockResolvedValue(backendCall({ triage_status: "done", triage_outcome: "no_answer" }));
    await renderDetail();

    fireEvent.click(screen.getByTestId("triage-mark-done"));
    fireEvent.click(await screen.findByText("No answer"));

    await waitFor(() => expect(apiMock.triageCall).toHaveBeenCalled());
    // Filing the chart note is a separate decision, and it lives on this page.
    expect(routerState.path).toBe("/calls/c1");
    expect(screen.getByText("Send to chart")).toBeTruthy();
  });

  it("PUTS THE OLD STATE BACK when the save fails", async () => {
    // Held open so the OPTIMISTIC state can be observed before the failure lands —
    // otherwise this test would also pass against a page that never updated at all.
    let fail: (err: Error) => void = () => {};
    apiMock.triageCall.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    await renderDetail(call({ triage_status: "needs_action" }));

    expect(screen.getByTestId("triage-state-pill").dataset.triageStatus).toBe("needs_action");

    fireEvent.click(screen.getByTestId("triage-mark-done"));
    fireEvent.click(await screen.findByText("Called back"));

    // In flight: the page already reads as done.
    await waitFor(() => expect(screen.getByTestId("triage-state-pill").dataset.triageStatus).toBe("done"));

    fail(new Error("Request failed with status 500"));

    await waitFor(() => expect(toasts.calls.some((t) => t.kind === "error")).toBe(true));
    // Not "Done" — nothing was saved, so nothing may claim it was.
    await waitFor(() => expect(screen.getByTestId("triage-state-pill").dataset.triageStatus)
      .toBe("needs_action"));
    expect(screen.getByTestId("triage-mark-done")).toBeTruthy();
    expect(screen.queryByTestId("triage-reopen")).toBeNull();
  });

  it("reopens a resolved call and says so", async () => {
    apiMock.triageCall.mockResolvedValue(backendCall({ triage_status: "needs_action" }));
    await renderDetail(call({ triage_status: "done", triage_outcome: "no_action_needed" }));

    fireEvent.click(screen.getByTestId("triage-reopen"));

    await waitFor(() => expect(apiMock.triageCall).toHaveBeenCalledWith("c1", { triage_status: "needs_action" }));
    await waitFor(() => expect(toasts.calls).toContainEqual({ kind: "success", text: "Reopened" }));
  });
});
