/**
 * The TC Checkout page, its patient sidebar, the arrival toast and the nav
 * badge (queue item 50).
 *
 *   - newest first; a row opens the SIDEBAR; the toast's link (?handoff=)
 *     opens the SAME sidebar component (one testid, one component).
 *   - the sidebar renders the snapshot: treatment, priority, next-visit needs,
 *     notes-pending, referral placeholder "None".
 *   - each outcome button sends exactly that outcome (and the appointment note
 *     only for Scheduled); an answered checkout leaves the Waiting list.
 *   - claim / dismiss (a reason is required) like the opportunities inbox.
 *   - switched off for the office → "isn't switched on", never an error.
 *   - useCheckoutWatch: the first answer never toasts a backlog; a NEW newest
 *     handoff toasts with an Open action to /tc/checkout?office=&handoff=.
 *
 * NO NETWORK, NO BACKEND, NO PHI. The api module is faked; names are synthetic,
 * PatNums are the roland test fixtures.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import type { TcCheckoutHandoff, TcCheckoutSummary } from "@shared/tc/checkout";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const { toastMock, state } = vi.hoisted(() => {
  const toastMock = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return {
    toastMock,
    state: {
      rows: [] as TcCheckoutHandoff[],
      disabled: false,
      outcomes: [] as unknown[][],
      claims: [] as string[],
      dismissals: [] as unknown[][],
      summaries: [] as TcCheckoutSummary[],
    },
  };
});

vi.mock("sonner", () => ({ toast: toastMock }));

function handoff(over: Partial<TcCheckoutHandoff> = {}): TcCheckoutHandoff {
  return {
    handoffId: "5d2a7e10-0000-4000-8000-0000000000c1",
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Kiwi, Sam",
    provider: "DOC1",
    providerSeen: "HYG1",
    operatory: "Hyg 1",
    visitDate: "2026-09-08",
    snapshot: {
      procedures: [
        { teeth: [3], code: "Crown", category: "Restorative", priority: "urgent", status: "proposed", surfaces: ["O"], scheduleNext: true, note: "" },
      ],
      priority: "urgent",
      nextVisit: { type: "Prophy", intervalMonths: 6, lengthMin: 60, withDoctor: true, rtc: "6 mo" },
      notesPending: true,
      frontDeskNote: "Prefers afternoons.",
      financialNote: "",
    },
    final: false,
    revision: 1,
    submittedBy: "hygienist@carein.ai",
    createdAt: "2026-09-08T14:42:00.000Z",
    updatedAt: "2026-09-08T14:42:00.000Z",
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
    ...over,
  };
}

vi.mock("@/features/tc/checkout/checkoutApi", async () => {
  const { TcApiError } = await import("@/features/tc/api");
  const find = (id: string) => state.rows.find((r) => r.handoffId === id) ?? null;
  return {
    listCheckout: vi.fn(async (_office: string, view: string) => {
      if (state.disabled) throw new TcApiError("off", 403, "CHECKOUT_DISABLED", null, []);
      const waiting = (r: TcCheckoutHandoff) => r.status === "open" || r.status === "claimed";
      return {
        success: true,
        today: "2026-09-08",
        view,
        handoffs: state.rows.filter((r) => (view === "waiting" ? waiting(r) : !waiting(r))),
      };
    }),
    getCheckoutHandoff: vi.fn(async (_o: string, id: string) => {
      const r = find(id);
      if (!r) throw new TcApiError("Checkout handoff not found", 404, "NOT_FOUND", null, []);
      return r;
    }),
    claimCheckout: vi.fn(async (_o: string, id: string) => {
      state.claims.push(id);
      const r = find(id)!;
      Object.assign(r, { status: "claimed", claimedBy: "tc@carein.ai", claimedAt: "2026-09-08T14:50:00.000Z" });
      return { ...r };
    }),
    dismissCheckout: vi.fn(async (o: string, id: string, reason: string) => {
      state.dismissals.push([o, id, reason]);
      const r = find(id)!;
      Object.assign(r, { status: "dismissed", dismissedReason: reason });
      return { ...r };
    }),
    recordCheckoutOutcome: vi.fn(async (o: string, id: string, outcome: string, note: string) => {
      state.outcomes.push([o, id, outcome, note]);
      const r = find(id)!;
      const caseId = outcome === "nothing_needed" ? null : "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
      Object.assign(r, { status: outcome, outcomeBy: "tc@carein.ai", outcomeAt: "2026-09-08T15:00:00.000Z", caseId, appointmentNote: note || null });
      return { success: true, handoff: { ...r }, caseId, url: caseId ? `/tc/cases/${caseId}` : null, attached: false };
    }),
    getCheckoutSummary: vi.fn(async () => {
      const next = state.summaries.shift();
      if (!next) throw new Error("no summary scripted");
      return next;
    }),
  };
});

import { CheckoutInbox } from "@/pages/tc/TcCheckout";
import { useCheckoutWatch } from "@/features/tc/checkout/useCheckoutWatch";

beforeEach(() => {
  state.rows = [];
  state.disabled = false;
  state.outcomes = [];
  state.claims = [];
  state.dismissals = [];
  state.summaries = [];
  toastMock.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});
afterEach(() => cleanup());

function renderInbox(path = "/tc/checkout") {
  const memory = memoryLocation({ path });
  return render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <CheckoutInbox offices={["roland"]} showOfficeBadges={false} />
    </WouterRouter>,
  );
}

describe("the Checkout inbox", () => {
  it("lists today's handoffs newest first", async () => {
    state.rows = [
      handoff({ handoffId: "5d2a7e10-0000-4000-8000-000000000001", patientName: "Older, Pat", createdAt: "2026-09-08T13:00:00.000Z" }),
      handoff({ handoffId: "5d2a7e10-0000-4000-8000-000000000002", patientName: "Newer, Pat", createdAt: "2026-09-08T14:00:00.000Z" }),
    ];
    renderInbox();
    const rows = await screen.findAllByTestId("checkout-row");
    expect(rows.map((r) => within(r).getByText(/, Pat$/).textContent)).toEqual(["Newer, Pat", "Older, Pat"]);
  });

  it("an office with checkout switched off reads as 'not on here', never an error", async () => {
    state.disabled = true;
    renderInbox();
    expect(await screen.findByTestId("checkout-off")).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });

  it("Quick look opens the sidebar, which renders the snapshot", async () => {
    state.rows = [handoff()];
    renderInbox();
    // RULING (CO-1): a row now opens the full-screen workup view; the sidebar
    // is the row's "Quick look" (and the toast's link), unchanged inside.
    fireEvent.click(await screen.findByTestId("checkout-row-quicklook"));
    const sheet = await screen.findByTestId("checkout-sidebar");
    await within(sheet).findByTestId("checkout-procedures");
    expect(within(sheet).getByTestId("checkout-procedures").textContent).toMatch(/#3 Crown/);
    // RULING (checkout v2): the sheet's priority chip SAYS it is a priority, so
    // it cannot be read as the category.
    expect(within(sheet).getAllByTestId("checkout-priority")[0].textContent).toBe("Priority: Urgent");
    expect(within(sheet).getByTestId("checkout-notes-pending")).toBeTruthy();
    expect(within(sheet).getByTestId("checkout-next-visit").textContent).toMatch(/Prophy/);
    expect(within(sheet).getByTestId("checkout-next-visit").textContent).toMatch(/6 months/);
    expect(within(sheet).getByTestId("checkout-referral").textContent).toMatch(/None/);
  });

  it("CO-1: a row opens the linkable workup view (/tc/checkout/:id?office=), not the sidebar", async () => {
    state.rows = [handoff()];
    const memory = memoryLocation({ path: "/tc/checkout", record: true });
    render(
      <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
        <CheckoutInbox offices={["roland"]} showOfficeBadges={false} />
      </WouterRouter>,
    );
    fireEvent.click(await screen.findByTestId("checkout-row"));
    await waitFor(() => expect(memory.history.at(-1)).toBe(`/tc/checkout/${handoff().handoffId}?office=roland`));
    expect(screen.queryByTestId("checkout-sidebar")).toBeNull();
  });

  it("CO-1: each waiting card says how far its workup has got", async () => {
    state.rows = [handoff()];
    renderInbox();
    expect((await screen.findByTestId("checkout-row-progress")).textContent).toMatch(/^0 of \d+ sections? done$/);
  });

  it("the toast's link (?handoff=) opens the SAME sidebar", async () => {
    state.rows = [handoff()];
    renderInbox(`/tc/checkout?office=roland&handoff=${handoff().handoffId}`);
    const sheet = await screen.findByTestId("checkout-sidebar");
    expect(await within(sheet).findByTestId("checkout-procedures")).toBeTruthy();
  });

  it("Scheduled sends the outcome WITH the appointment note; the row leaves Waiting", async () => {
    state.rows = [handoff()];
    renderInbox();
    // RULING (CO-1): a row now opens the full-screen workup view; the sidebar
    // is the row's "Quick look" (and the toast's link), unchanged inside.
    fireEvent.click(await screen.findByTestId("checkout-row-quicklook"));
    const sheet = await screen.findByTestId("checkout-sidebar");
    fireEvent.change(await within(sheet).findByTestId("checkout-appointment-note"), {
      target: { value: "Tue 9am" },
    });
    fireEvent.click(within(sheet).getByTestId("checkout-outcome-scheduled"));
    await within(sheet).findByTestId("checkout-answered");
    expect(state.outcomes).toEqual([["roland", handoff().handoffId, "scheduled", "Tue 9am"]]);
    expect(within(sheet).getByTestId("checkout-answered").textContent).toMatch(/Scheduled/);
    await waitFor(() => expect(screen.queryAllByTestId("checkout-row")).toHaveLength(0));
  });

  it.each([
    ["not_scheduled", "Not scheduled"],
    ["nothing_needed", "Nothing needed"],
  ])("%s sends exactly that outcome, and no appointment note", async (outcome, label) => {
    state.rows = [handoff()];
    renderInbox();
    // RULING (CO-1): a row now opens the full-screen workup view; the sidebar
    // is the row's "Quick look" (and the toast's link), unchanged inside.
    fireEvent.click(await screen.findByTestId("checkout-row-quicklook"));
    const sheet = await screen.findByTestId("checkout-sidebar");
    fireEvent.change(await within(sheet).findByTestId("checkout-appointment-note"), {
      target: { value: "ignored" },
    });
    fireEvent.click(within(sheet).getByTestId(`checkout-outcome-${outcome}`));
    await within(sheet).findByTestId("checkout-answered");
    expect(state.outcomes).toEqual([["roland", handoff().handoffId, outcome, ""]]);
    expect(within(sheet).getByTestId("checkout-answered").textContent).toMatch(label);
  });

  it("Claim marks the row claimed and keeps it waiting", async () => {
    state.rows = [handoff()];
    renderInbox();
    fireEvent.click(await screen.findByTestId("checkout-row-claim"));
    await waitFor(() => expect(screen.getByTestId("checkout-row").textContent).toMatch(/Claimed · tc@carein.ai/));
    expect(state.claims).toEqual([handoff().handoffId]);
  });

  it("Dismiss needs a reason, then the row leaves Waiting", async () => {
    state.rows = [handoff()];
    renderInbox();
    fireEvent.click(await screen.findByTestId("checkout-row-dismiss"));
    const confirm = await screen.findByTestId("checkout-dismiss-confirm");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("checkout-dismiss-reason"), { target: { value: "Doctor saw them" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryAllByTestId("checkout-row")).toHaveLength(0));
    expect(state.dismissals).toEqual([["roland", handoff().handoffId, "Doctor saw them"]]);
  });
});

// ── the badge + toast hook ──────────────────────────────────────────────────

function Probe({ offices }: { offices: ("roland" | "valley")[] }) {
  const w = useCheckoutWatch(offices);
  return <div data-testid="probe">{`${w.enabled}:${w.waiting}`}</div>;
}

function summary(over: Partial<TcCheckoutSummary> = {}): TcCheckoutSummary {
  return { success: true, office: "roland", enabled: true, today: "2026-09-08", waiting: 0, newest: null, ...over };
}

describe("useCheckoutWatch", () => {
  it("answering the newest does NOT announce the older patient beneath it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const older = { handoffId: "5d2a7e10-0000-4000-8000-000000000001", patientName: "Older, Pat", createdAt: "2026-09-08T13:00:00.000Z" };
      const newer = { handoffId: "5d2a7e10-0000-4000-8000-000000000002", patientName: "Newer, Pat", createdAt: "2026-09-08T14:00:00.000Z" };
      // Both waiting; then the desk answers the newer one, so the server's
      // newest WAITING handoff becomes the older one.
      state.summaries = [summary({ waiting: 2, newest: newer }), summary({ waiting: 1, newest: older })];
      const memory = memoryLocation({ path: "/tc" });
      render(
        <WouterRouter hook={memory.hook}>
          <Probe offices={["roland"]} />
        </WouterRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("true:2"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("true:1"));
      expect(toastMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("off for the office → not enabled, no badge, no toast", async () => {
    state.summaries = [summary({ enabled: false, today: null })];
    const memory = memoryLocation({ path: "/tc" });
    render(
      <WouterRouter hook={memory.hook}>
        <Probe offices={["roland"]} />
      </WouterRouter>,
    );
    await waitFor(() => expect(state.summaries).toHaveLength(0));
    expect(screen.getByTestId("probe").textContent).toBe("false:0");
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("the first answer never toasts a backlog; a NEW newest handoff does, with an Open link", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const first = { handoffId: "5d2a7e10-0000-4000-8000-000000000001", patientName: "Older, Pat", createdAt: "2026-09-08T13:00:00.000Z" };
      const second = { handoffId: "5d2a7e10-0000-4000-8000-000000000002", patientName: "Newer, Pat", createdAt: "2026-09-08T14:00:00.000Z" };
      state.summaries = [summary({ waiting: 1, newest: first }), summary({ waiting: 2, newest: second })];
      const memory = memoryLocation({ path: "/tc", record: true });
      render(
        <WouterRouter hook={memory.hook}>
          <Probe offices={["roland"]} />
        </WouterRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("true:1"));
      expect(toastMock).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("true:2"));
      expect(toastMock).toHaveBeenCalledTimes(1);
      const [message, opts] = toastMock.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
      expect(message).toBe("Newer, Pat is headed to checkout");
      expect(opts.action.label).toBe("Open");
      act(() => opts.action.onClick());
      expect(memory.history?.at(-1)).toBe(`/tc/checkout?office=roland&handoff=${second.handoffId}`);
    } finally {
      vi.useRealTimers();
    }
  });
});
