/**
 * Retention in the UI: a pruned call must read as PRUNED, never as broken.
 *
 * After 30 days a call's record is replaced by a thin audit stub — no caller name,
 * no number, no transcript, no summary, no notes. The row for it still exists, so
 * the two failure modes to rule out are:
 *   - a crash or an empty-looking row where the content used to be, and
 *   - action buttons that offer work the backend will refuse with 409.
 *
 * The honest rendering says what happened and shows who did what while the call
 * was still live.
 *
 * No PHI: every value below is synthetic.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/calls", () => {}],
  useRoute: () => [true, { id: "pruned-1" }],
  useParams: () => ({ id: "pruned-1" }),
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: {
      name: "Sarah Front", email: "sarah@carein.ai", tenantId: "t1",
      tenant: { slug: "carein", displayName: "CareIN", modules: ["voice", "tc"] },
      role: "office",
      isSuperAdmin: false,
      permissions: ["voice.read", "voice.write"],
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
  getUnifiedCalls: vi.fn(),
  getSyncStatus: vi.fn(),
  getUnifiedCall: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, ...apiMock } };
});

import { normalizeUnifiedCall, type BackendUnifiedCall, type UnifiedCall } from "@/lib/api";
import { CallWorklist } from "@/pages/calls/CallWorklist";
import CallDetail from "@/pages/CallDetail";
import { callNeedsAttention } from "@/lib/worklist";

/** The stub exactly as the backend serves it — note what is ABSENT. */
const backendStub = (over: Partial<BackendUnifiedCall> = {}): BackendUnifiedCall => ({
  id: "pruned-1",
  record_kind: "stub",
  source: "mango",
  office_id: "valley",
  call_date: "2026-05-01T15:00:00.000Z",
  pruned_at: "2026-08-13T09:30:00.000Z",
  linked_call_id: null,
  link_role: null,
  actions: [
    { action: "transcribed", actor: { name: "Sarah Front", email: "sarah@carein.ai" }, at: "2026-05-01T15:30:00.000Z" },
    { action: "sent_to_chart", actor: { name: "Dana Lead", email: "dana@carein.ai" }, at: "2026-05-01T15:45:00.000Z" },
  ],
  ...over,
} as unknown as BackendUnifiedCall);

const liveCall = (over: Partial<UnifiedCall> = {}): UnifiedCall => ({
  ...normalizeUnifiedCall({
    id: "live-1",
    source: "mango",
    office_id: "valley",
    caller_name: "Synthetic Caller",
    caller_number: "+15550000000",
    called_number: "+14797854390",
    call_date: "2026-08-12T15:00:00.000Z",
    duration_seconds: 120,
    summary: "a synthetic summary",
    od_sync_status: "needs_review",
  } as BackendUnifiedCall),
  ...over,
} as UnifiedCall);

async function renderWorklist(calls: UnifiedCall[], view: "needs" | "all" = "all") {
  apiMock.getUnifiedCalls.mockResolvedValue({ calls, mangoWorklistMode: "all" });
  apiMock.getSyncStatus.mockResolvedValue({ lastSyncedAt: null, nextAutoSync: null, mangoMode: "api" });
  render(React.createElement(CallWorklist));
  if (view === "all") fireEvent.click(screen.getByText("All calls"));
  await waitFor(() => expect(apiMock.getUnifiedCalls).toHaveBeenCalled());
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
});
afterEach(cleanup);

// --- normalization ---------------------------------------------------------

describe("a stub survives normalization as a stub", () => {
  it("carries recordKind, prunedAt and the action list", () => {
    const call = normalizeUnifiedCall(backendStub());

    expect(call.recordKind).toBe("stub");
    expect(call.isPruned).toBe(true);
    expect(call.prunedAt).toBe("2026-08-13T09:30:00.000Z");
    expect(call.retentionActions.map((a) => a.action)).toEqual(["transcribed", "sent_to_chart"]);
  });

  it("does not invent a caller name out of the absent fields", () => {
    // normalizeUnifiedCall falls back through caller_name → transcript scraping →
    // caller_number → "Unknown". A stub has none of those, and a row reading
    // "Unknown" would look like a data bug rather than a retention outcome.
    const call = normalizeUnifiedCall(backendStub());

    expect(call.patientName).toBe("");
    expect(call.fromNumber).toBe("");
    expect(call.hasTranscript).toBe(false);
    expect(call.summary).toBe("");
  });

  it("leaves an ordinary call untouched", () => {
    const call = liveCall();

    expect(call.recordKind).toBe("call");
    expect(call.isPruned).toBe(false);
    expect(call.retentionActions).toEqual([]);
  });
});

// --- the worklist ----------------------------------------------------------

describe("the worklist renders a pruned call honestly", () => {
  it("never asks anyone to work a call whose content is gone", () => {
    expect(callNeedsAttention(normalizeUnifiedCall(backendStub()), "all")).toBe(false);
  });

  it("shows a pruned row instead of an empty one", async () => {
    await renderWorklist([normalizeUnifiedCall(backendStub()), liveCall()]);

    await waitFor(() => expect(screen.getAllByTestId("worklist-row")).toHaveLength(2));
    const row = screen.getAllByTestId("worklist-row").find((r) => r.dataset.pruned === "true");
    expect(row).toBeTruthy();
    expect(within(row as HTMLElement).getByTestId("pruned-badge").textContent).toMatch(/pruned/i);
  });

  it("offers no actions on a pruned row — the backend would refuse them anyway", async () => {
    await renderWorklist([normalizeUnifiedCall(backendStub())]);

    await waitFor(() => expect(screen.getAllByTestId("worklist-row")).toHaveLength(1));
    const row = screen.getAllByTestId("worklist-row")[0];
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
  });

  it("says WHY the content is gone, not just that it is missing", async () => {
    await renderWorklist([normalizeUnifiedCall(backendStub())]);

    await waitFor(() => expect(screen.getAllByTestId("worklist-row")).toHaveLength(1));
    const row = screen.getAllByTestId("worklist-row")[0];
    expect(row.textContent).toMatch(/retention/i);
  });

  it("still shows the call's date and office so the row is locatable", async () => {
    await renderWorklist([normalizeUnifiedCall(backendStub())]);

    await waitFor(() => expect(screen.getAllByTestId("worklist-row")).toHaveLength(1));
    const row = screen.getAllByTestId("worklist-row")[0];
    expect(within(row).getByTestId("pruned-date")).toBeTruthy();
  });
});

// --- the detail page -------------------------------------------------------

describe("the call detail page renders a pruned call honestly", () => {
  async function renderDetail(stub: BackendUnifiedCall) {
    apiMock.getUnifiedCall.mockResolvedValue(normalizeUnifiedCall(stub));
    render(React.createElement(CallDetail));
    await waitFor(() => expect(screen.getByTestId("pruned-detail")).toBeTruthy());
  }

  it("says the details were removed, rather than showing an empty transcript", async () => {
    await renderDetail(backendStub());

    const panel = screen.getByTestId("pruned-detail");
    expect(panel.textContent).toMatch(/retention/i);
    expect(screen.queryByTestId("transcript")).toBeNull();
  });

  it("lists what was done to the call, with who and when", async () => {
    await renderDetail(backendStub());

    const entries = screen.getAllByTestId("pruned-action");
    expect(entries).toHaveLength(2);
    expect(entries[0].textContent).toMatch(/transcribed/i);
    expect(entries[0].textContent).toContain("Sarah Front");
    expect(entries[1].textContent).toMatch(/chart/i);
    expect(entries[1].textContent).toContain("Dana Lead");
  });

  it("says so plainly when nobody ever touched the call", async () => {
    await renderDetail(backendStub({ actions: [] }));

    expect(screen.queryAllByTestId("pruned-action")).toHaveLength(0);
    expect(screen.getByTestId("pruned-detail").textContent).toMatch(/no recorded actions/i);
  });

  it("offers nothing to click that the backend would refuse", async () => {
    await renderDetail(backendStub());

    // "Transcribed" appears as a past-tense RECORD of what someone did, which is
    // the point of the page. What must not exist is a control that would attempt
    // the work again — every one of those comes back 409 CALL_PRUNED. The only
    // control on the page is the back link out of it.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toMatch(/back to calls/i);
  });
});
