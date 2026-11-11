/**
 * CO-6 "Route to…" and CO-7 "Ask hygiene", on the TC checkout card.
 *
 *   - Route to… sends ONLY the destination and the person's words — never a
 *     patient, a PatNum or an office (the server takes them from the card);
 *     the card shown afterwards is the server's read-back.
 *   - Follow-up needs a due date AND a talking point before it can be sent.
 *   - Pipeline offers only the open, non-Inbox statuses (no terminal status).
 *   - An answered card has no Route to….
 *   - Ask hygiene: the thread is the read-back; asking clears the box; "Mark
 *     resolved" appears only while something is open; a failed load says so.
 *   - The list row carries a visible chip for open questions.
 *
 * NO NETWORK, NO BACKEND. Synthetic names only.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import type { TcCheckoutHandoff } from "@shared/tc/checkout";
import type { TcCheckoutQuestionThread, TcCheckoutRouteRequest } from "@shared/tc/checkoutRouting";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const HANDOFF_ID = "5d2a7e10-0000-4000-8000-0000000000c1";
const CASE_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";

const { state, toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  state: {
    routes: [] as unknown[][],
    asks: [] as unknown[][],
    resolves: 0,
    thread: null as TcCheckoutQuestionThread | null,
    threadFail: false,
    rows: [] as TcCheckoutHandoff[],
    openQuestions: {} as Record<string, number>,
  },
}));

vi.mock("sonner", () => ({ toast: toastMock }));

function handoff(over: Partial<TcCheckoutHandoff> = {}): TcCheckoutHandoff {
  return {
    handoffId: HANDOFF_ID,
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Kiwi, Sam",
    provider: "DOC1",
    providerSeen: "HYG1",
    operatory: "Hyg 1",
    visitDate: "2026-11-11",
    snapshot: {
      procedures: [],
      priority: null,
      nextVisit: { type: null, intervalMonths: null, lengthMin: null, withDoctor: false, rtc: "" },
      notesPending: false,
      frontDeskNote: "",
      financialNote: "",
    },
    final: true,
    revision: 1,
    submittedBy: "hygienist@carein.ai",
    createdAt: "2026-11-11T15:00:00.000Z",
    updatedAt: "2026-11-11T15:00:00.000Z",
    status: "open",
    claimedBy: null,
    claimedAt: null,
    dismissedReason: null,
    dismissedBy: null,
    dismissedAt: null,
    outcomeBy: null,
    outcomeAt: null,
    appointmentNote: null,
    caseId: null,
    expiredAt: null,
    expiredBy: null,
    workup: { workedUp: {}, present: {}, collected: null, referrals: null },
    source: "hygiene",
    hygieneMergedAt: null,
    reopenedFrom: null,
    appointment: null,
    scheduleAppointment: null,
    ...over,
  };
}

function thread(messages: TcCheckoutQuestionThread["messages"]): TcCheckoutQuestionThread {
  return {
    handoffId: HANDOFF_ID,
    open: messages.filter((m) => m.authorRole === "tc" && m.resolvedAt === null).length,
    messages,
  };
}

const Q1 = {
  questionId: "7a000000-0000-4000-8000-000000000001",
  handoffId: HANDOFF_ID,
  authorEmail: "tc@carein.ai",
  authorRole: "tc" as const,
  body: "Afternoons only?",
  createdAt: "2026-11-11T15:10:00.000Z",
  resolvedAt: null,
};

vi.mock("@/features/tc/checkout/checkoutApi", () => ({
  routeCheckout: vi.fn(async (office: string, id: string, body: TcCheckoutRouteRequest) => {
    state.routes.push([office, id, body]);
    const inbox = body.destination === "inbox";
    return {
      success: true,
      destination: body.destination,
      handoff: handoff({ caseId: CASE_ID, status: inbox ? "dismissed" : "open" }),
      caseId: CASE_ID,
      url: `/tc/cases/${CASE_ID}`,
      attached: true,
      preauthId: null,
      followupId: null,
      statusChanged: body.destination === "pipeline" ? true : null,
      resolved: inbox,
    };
  }),
  getCheckoutQuestions: vi.fn(async () => {
    if (state.threadFail) throw new Error("boom");
    return state.thread ?? thread([]);
  }),
  askCheckoutQuestion: vi.fn(async (office: string, id: string, body: string) => {
    state.asks.push([office, id, body]);
    state.thread = thread([...(state.thread?.messages ?? []), { ...Q1, body }]);
    return state.thread;
  }),
  resolveCheckoutQuestions: vi.fn(async () => {
    state.resolves += 1;
    state.thread = thread((state.thread?.messages ?? []).map((m) => ({ ...m, resolvedAt: "2026-11-11T16:00:00.000Z" })));
    return state.thread;
  }),
  listCheckout: vi.fn(async (_office: string, view: string) => ({
    success: true,
    today: "2026-11-11",
    view,
    handoffs: state.rows,
    openQuestions: state.openQuestions,
  })),
  claimCheckout: vi.fn(),
  dismissCheckout: vi.fn(),
  getScheduleCheck: vi.fn(async () => {
    throw new Error("not in this test");
  }),
}));

import { CheckoutRouteTo } from "@/features/tc/checkout/CheckoutRouteTo";
import { CheckoutQuestions } from "@/features/tc/checkout/CheckoutQuestions";
import { CheckoutInbox } from "@/pages/tc/TcCheckout";

beforeEach(() => {
  state.routes = [];
  state.asks = [];
  state.resolves = 0;
  state.thread = null;
  state.threadFail = false;
  state.rows = [];
  state.openQuestions = {};
  toastMock.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});
afterEach(() => cleanup());

function renderRoute(h: TcCheckoutHandoff, onAdopt = vi.fn()) {
  const memory = memoryLocation({ path: "/tc/checkout" });
  render(
    <WouterRouter hook={memory.hook}>
      <CheckoutRouteTo office="roland" handoff={h} onAdopt={onAdopt} onReload={async () => {}} />
    </WouterRouter>,
  );
  return onAdopt;
}

describe("CO-6 Route to…", () => {
  it("Pipeline: sends only the destination, the status and the note; adopts the read-back", async () => {
    const onAdopt = renderRoute(handoff());
    fireEvent.click(screen.getByTestId("checkout-route-open"));
    fireEvent.click(await screen.findByTestId("checkout-route-dest-pipeline"));
    fireEvent.change(screen.getByTestId("checkout-route-status"), { target: { value: "presented" } });
    fireEvent.change(screen.getByTestId("checkout-route-note"), { target: { value: "  Reviewed  " } });
    fireEvent.click(screen.getByTestId("checkout-route-confirm"));
    await waitFor(() => expect(state.routes).toHaveLength(1));
    expect(state.routes[0]).toEqual(["roland", HANDOFF_ID, { destination: "pipeline", status: "presented", note: "Reviewed" }]);
    const body = state.routes[0][2] as Record<string, unknown>;
    for (const k of ["odPatientId", "patientName", "office", "officeId", "patNum"]) expect(body).not.toHaveProperty(k);
    await waitFor(() => expect(onAdopt).toHaveBeenCalledTimes(1));
    expect((onAdopt.mock.calls[0][0] as TcCheckoutHandoff).caseId).toBe(CASE_ID);
  });

  it("Pipeline offers only the open, non-Inbox statuses", async () => {
    renderRoute(handoff());
    fireEvent.click(screen.getByTestId("checkout-route-open"));
    const select = (await screen.findByTestId("checkout-route-status")) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["diagnosed", "pending_tc", "pending_pt", "presented", "considering", "financing_pending", "nurture"]);
  });

  it("Follow-up cannot be sent without a due date AND a talking point", async () => {
    renderRoute(handoff());
    fireEvent.click(screen.getByTestId("checkout-route-open"));
    fireEvent.click(await screen.findByTestId("checkout-route-dest-followup"));
    const confirm = screen.getByTestId("checkout-route-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("checkout-route-followup-due"), { target: { value: "2026-11-20" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("checkout-route-followup-talking"), { target: { value: "   " } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("checkout-route-followup-talking"), { target: { value: "Ask about the crown" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(state.routes[0]?.[2]).toEqual({
        destination: "followup",
        dueDate: "2026-11-20",
        talkingPoint: "Ask about the crown",
        channel: "phone_call",
      }),
    );
  });

  it("Pre-auth and TC Inbox send their own shapes", async () => {
    renderRoute(handoff());
    fireEvent.click(screen.getByTestId("checkout-route-open"));
    fireEvent.click(await screen.findByTestId("checkout-route-dest-preauth"));
    fireEvent.change(screen.getByTestId("checkout-route-preauth-carrier"), { target: { value: "Synthetic Dental" } });
    fireEvent.click(screen.getByTestId("checkout-route-confirm"));
    await waitFor(() =>
      expect(state.routes[0]?.[2]).toEqual({
        destination: "preauth",
        preauthType: "treatment",
        insuranceCarrier: "Synthetic Dental",
        notes: "",
      }),
    );
    cleanup();
    renderRoute(handoff());
    fireEvent.click(screen.getByTestId("checkout-route-open"));
    fireEvent.click(await screen.findByTestId("checkout-route-dest-inbox"));
    fireEvent.click(screen.getByTestId("checkout-route-confirm"));
    await waitFor(() => expect(state.routes[1]?.[2]).toEqual({ destination: "inbox", note: "" }));
  });

  it("an answered card has no Route to…; a waiting card on a case says so", () => {
    renderRoute(handoff({ status: "scheduled" }));
    expect(screen.queryByTestId("checkout-route-open")).toBeNull();
    cleanup();
    renderRoute(handoff({ caseId: CASE_ID }));
    expect(screen.getByTestId("checkout-route-linked").querySelector("a")?.getAttribute("href")).toBe(`/tc/cases/${CASE_ID}`);
  });
});

describe("CO-7 Ask hygiene (TC side)", () => {
  it("shows the read-back thread; asking clears the box; resolve shows only while open", async () => {
    render(<CheckoutQuestions office="roland" handoffId={HANDOFF_ID} />);
    expect(await screen.findByText(/No questions yet/)).toBeTruthy();
    expect(screen.queryByTestId("checkout-questions-resolve")).toBeNull();

    fireEvent.change(screen.getByTestId("checkout-question-draft"), { target: { value: "  Afternoons only?  " } });
    fireEvent.click(screen.getByTestId("checkout-question-ask"));
    await waitFor(() => expect(state.asks).toEqual([["roland", HANDOFF_ID, "Afternoons only?"]]));
    await waitFor(() => expect(screen.getByTestId("checkout-open-questions").textContent).toContain("1 open question"));
    expect((screen.getByTestId("checkout-question-draft") as HTMLTextAreaElement).value).toBe("");

    fireEvent.click(screen.getByTestId("checkout-questions-resolve"));
    await waitFor(() => expect(state.resolves).toBe(1));
    await waitFor(() => expect(screen.queryByTestId("checkout-open-questions")).toBeNull());
    expect(screen.queryByTestId("checkout-questions-resolve")).toBeNull();
  });

  it("a hygienist reply renders as a reply; a failed load says so instead of an empty thread", async () => {
    state.thread = thread([
      Q1,
      { ...Q1, questionId: "7a000000-0000-4000-8000-000000000002", authorRole: "hygienist", authorEmail: "hygienist@carein.ai", body: "Yes" },
    ]);
    render(<CheckoutQuestions office="roland" handoffId={HANDOFF_ID} />);
    expect((await screen.findByTestId("checkout-question-hygienist")).textContent).toContain("Hygienist");
    cleanup();
    state.threadFail = true;
    render(<CheckoutQuestions office="roland" handoffId={HANDOFF_ID} />);
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/No questions yet/)).toBeNull();
  });

  it("the list row carries a visible chip for a card with open questions", async () => {
    state.rows = [handoff(), handoff({ handoffId: "5d2a7e10-0000-4000-8000-0000000000c2", patientName: "Test, MangoTest" })];
    state.openQuestions = { [HANDOFF_ID]: 2 };
    const memory = memoryLocation({ path: "/tc/checkout" });
    render(
      <WouterRouter hook={memory.hook}>
        <CheckoutInbox offices={["roland"]} showOfficeBadges={false} />
      </WouterRouter>,
    );
    await waitFor(() => expect(screen.getAllByTestId("checkout-row")).toHaveLength(2));
    const chips = screen.getAllByTestId("checkout-open-questions");
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toContain("2 open questions for hygiene");
  });
});
