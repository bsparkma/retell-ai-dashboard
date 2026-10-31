/**
 * CO-5b — checkout cards from today's schedule, in jsdom.
 *
 *  - the line under the tabs: "Today's schedule checked at …"; a FAILED read
 *    (or an ask that never arrived) is the amber "Couldn't check today's
 *    schedule" with the last success — never a quiet stale list; an office
 *    with the switch off shows nothing; a partial read says so
 *  - the polling: asks on mount, every 60 s while visible, on focus and on
 *    becoming visible — never while hidden; a running read is re-asked in a
 *    few seconds; a finished read that MADE cards reloads the list
 *  - the card: "From today's schedule" with the visit type; no hygiene data is
 *    pretended; the workup and the sidebar say where it came from
 *
 * With TC_SHOTS=1 it also dumps the screenshots (tccheckout-co5b-*).
 * NO NETWORK, NO BACKEND, NO PHI: synthetic names, roland test PatNums.
 */
import * as React from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  checkoutHasHygieneData,
  emptyCheckoutSnapshot,
  emptyCheckoutWorkup,
  TcCheckoutHandoff as HandoffSchema,
  type TcCheckoutHandoff,
  type TcCheckoutScheduleCheck,
} from "@shared/tc/checkout";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const { toastMock, api, ref } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  api: {
    listCheckout: vi.fn(),
    getScheduleCheck: vi.fn(),
    getCheckoutHandoff: vi.fn(),
    setCheckoutWorkup: vi.fn(),
    claimCheckout: vi.fn(),
    dismissCheckout: vi.fn(),
    recordCheckoutOutcome: vi.fn(),
    getCheckoutSummary: vi.fn(),
  },
  ref: {
    getReferralsStatus: vi.fn(async () => ({ success: true, enabled: false })),
    listDirectory: vi.fn(async () => []),
    listReferrals: vi.fn(async () => []),
    createReferral: vi.fn(),
    updateReferral: vi.fn(),
    referralVerb: vi.fn(),
    listReferralAttachments: vi.fn(async () => []),
    openReferralAttachment: vi.fn(),
    uploadReferralAttachment: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/checkout/checkoutApi", () => api);
vi.mock("@/features/tc/referrals/referralsApi", () => ref);
vi.mock("@/features/tc/providers/providersApi", () => ({ listActiveProviders: vi.fn(async () => []) }));

import { CheckoutInbox } from "@/pages/tc/TcCheckout";
import { ScheduleCheckLine, SCHEDULE_CHECK_FOLLOW_UP_MS, SCHEDULE_CHECK_INTERVAL_MS } from "@/features/tc/checkout/ScheduleCheck";
import { checkoutOriginText } from "@/features/tc/checkout/checkoutOrigin";
import { CheckoutWorkup } from "@/features/tc/checkout/CheckoutWorkup";

function card(over: Partial<TcCheckoutHandoff> = {}): TcCheckoutHandoff {
  return HandoffSchema.parse({
    handoffId: "5d2a7e10-0000-4000-8000-0000000005b1",
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Kiwi, Sam",
    provider: "",
    providerSeen: "DOC1",
    operatory: "Op 3",
    visitDate: "2026-10-30",
    snapshot: emptyCheckoutSnapshot(),
    final: false,
    revision: 1,
    submittedBy: "system:auto_checkout",
    createdAt: "2026-10-30T15:02:00.000Z",
    updatedAt: "2026-10-30T15:02:00.000Z",
    status: "open",
    workup: emptyCheckoutWorkup(),
    source: "schedule",
    scheduleAppointment: { aptNum: 5001, dateTime: "2026-10-30 09:00:00", appointmentType: "Crown Prep", provider: "DOC1", operatory: "Op 3" },
    ...over,
  });
}

function check(over: Partial<TcCheckoutScheduleCheck> = {}): TcCheckoutScheduleCheck {
  return {
    success: true,
    office: "roland",
    status: "ok",
    running: false,
    lastSuccessAt: "2026-10-30T15:02:00.000Z",
    lastAttemptAt: "2026-10-30T15:02:00.000Z",
    summary: { completedNonHygiene: 3, created: 0, alreadyCarded: 3, skippedHygiene: 9, skippedNoPatient: 1, deferred: 0, partial: false },
    ...over,
  };
}

function setVisibility(v: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listCheckout.mockResolvedValue({ success: true, today: "2026-10-30", view: "waiting", handoffs: [] });
  api.getScheduleCheck.mockResolvedValue(check());
  setVisibility("visible");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderInbox() {
  const memory = memoryLocation({ path: "/tc/checkout" });
  return render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <CheckoutInbox offices={["roland"]} showOfficeBadges={false} />
    </WouterRouter>,
  );
}

// ── the line ────────────────────────────────────────────────────────────────

describe("the schedule line", () => {
  it("a good read: when the schedule was checked", () => {
    render(<ScheduleCheckLine states={[{ officeId: "roland", kind: "answer", check: check() }]} showOfficeBadges={false} />);
    expect(screen.getByTestId("schedule-check-ok-roland").textContent).toMatch(/Today's schedule checked at \d{1,2}:\d{2}/);
    expect(screen.queryByTestId("schedule-check-failed-roland")).toBeNull();
  });

  it("a FAILED read: Couldn't check today's schedule, with the last success — never a quiet stale list", () => {
    render(
      <ScheduleCheckLine
        states={[{ officeId: "roland", kind: "answer", check: check({ status: "failed", lastAttemptAt: "2026-10-30T15:10:00.000Z" }) }]}
        showOfficeBadges={false}
      />,
    );
    const banner = screen.getByTestId("schedule-check-failed-roland");
    expect(banner.textContent).toMatch(/Couldn't check today's schedule/);
    expect(banner.textContent).toMatch(/Last successful check: \d{1,2}:\d{2}/);
    expect(screen.queryByTestId("schedule-check-ok-roland")).toBeNull();
  });

  it("a failed read that never succeeded says so plainly", () => {
    render(
      <ScheduleCheckLine
        states={[{ officeId: "roland", kind: "answer", check: check({ status: "failed", lastSuccessAt: null, summary: null }) }]}
        showOfficeBadges={false}
      />,
    );
    expect(screen.getByTestId("schedule-check-failed-roland").textContent).toMatch(/has not been read successfully yet/);
  });

  it("the ask itself failing is the same amber line", () => {
    render(<ScheduleCheckLine states={[{ officeId: "roland", kind: "unreachable", lastSuccessAt: null }]} showOfficeBadges={false} />);
    expect(screen.getByTestId("schedule-check-failed-roland").textContent).toMatch(/Couldn't check today's schedule/);
  });

  it("switch off: nothing at all", () => {
    const { container } = render(
      <ScheduleCheckLine states={[{ officeId: "roland", kind: "answer", check: check({ status: "off", lastSuccessAt: null, summary: null }) }]} showOfficeBadges={false} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("pending: checking, not 'checked'; a partial read says so", () => {
    render(
      <ScheduleCheckLine
        states={[
          { officeId: "roland", kind: "answer", check: check({ status: "pending", running: true, lastSuccessAt: null, summary: null }) },
          { officeId: "valley", kind: "answer", check: check({ office: "valley", summary: { ...check().summary!, partial: true } }) },
        ]}
        showOfficeBadges
      />,
    );
    expect(screen.getByTestId("schedule-check-ok-roland").textContent).toMatch(/Checking today's schedule/);
    expect(screen.getByTestId("schedule-check-partial-valley").textContent).toMatch(/Only part of the schedule/);
  });
});

// ── the polling ─────────────────────────────────────────────────────────────

describe("the polling (the day-progress pattern)", () => {
  it("asks on mount, every 60 s while visible, on focus and on becoming visible — never while hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderInbox();
    await waitFor(() => expect(api.getScheduleCheck).toHaveBeenCalledTimes(1));
    expect(api.getScheduleCheck).toHaveBeenCalledWith("roland");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCHEDULE_CHECK_INTERVAL_MS);
    });
    expect(api.getScheduleCheck).toHaveBeenCalledTimes(2);

    setVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCHEDULE_CHECK_INTERVAL_MS * 3);
    });
    expect(api.getScheduleCheck).toHaveBeenCalledTimes(2);

    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(api.getScheduleCheck).toHaveBeenCalledTimes(3));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(api.getScheduleCheck).toHaveBeenCalledTimes(4));
  });

  it("a running read is re-asked in a few seconds; when it MADE cards, the list reloads and shows them", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getScheduleCheck
      .mockResolvedValueOnce(check({ status: "pending", running: true, lastSuccessAt: null, summary: null }))
      .mockResolvedValue(check({ summary: { ...check().summary!, created: 1 } }));
    api.listCheckout
      .mockResolvedValueOnce({ success: true, today: "2026-10-30", view: "waiting", handoffs: [] })
      .mockResolvedValue({ success: true, today: "2026-10-30", view: "waiting", handoffs: [card()] });
    renderInbox();
    expect((await screen.findByTestId("schedule-check-ok-roland")).textContent).toMatch(/Checking today's schedule/);
    expect(api.listCheckout).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCHEDULE_CHECK_FOLLOW_UP_MS);
    });
    await waitFor(() => expect(api.getScheduleCheck).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.listCheckout).toHaveBeenCalledTimes(2));
    const row = await screen.findByTestId("checkout-row");
    expect(within(row).getByTestId("checkout-row-schedule").textContent).toMatch(/From today's schedule/);

    // The same success seen again does not reload again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCHEDULE_CHECK_INTERVAL_MS);
    });
    await waitFor(() => expect(api.getScheduleCheck).toHaveBeenCalledTimes(3));
    expect(api.listCheckout).toHaveBeenCalledTimes(2);
  });

  it("a failed ask shows the amber line on the page", async () => {
    api.getScheduleCheck.mockRejectedValue(new Error("network"));
    renderInbox();
    expect((await screen.findByTestId("schedule-check-failed-roland")).textContent).toMatch(/Couldn't check today's schedule/);
  });

  it("checkout off for every office: no schedule ask at all", async () => {
    const { TcApiError } = await import("@/features/tc/api");
    api.listCheckout.mockRejectedValue(new TcApiError("off", 403, "CHECKOUT_DISABLED", null, []));
    renderInbox();
    await screen.findByTestId("checkout-off");
    expect(api.getScheduleCheck).not.toHaveBeenCalled();
  });
});

// ── the card ────────────────────────────────────────────────────────────────

describe("a card from the schedule", () => {
  it("on the list: the badge and the visit type; no hygiene data pretended", async () => {
    api.listCheckout.mockResolvedValue({ success: true, today: "2026-10-30", view: "waiting", handoffs: [card()] });
    renderInbox();
    const row = await screen.findByTestId("checkout-row");
    expect(within(row).getByTestId("checkout-row-schedule")).toBeTruthy();
    expect(row.textContent).toMatch(/Crown Prep · no hygiene visit data/);
    expect(within(row).queryByTestId("checkout-row-manual")).toBeNull();
    expect(checkoutHasHygieneData(card())).toBe(false);
    expect(checkoutHasHygieneData(card({ hygieneMergedAt: "2026-10-30T15:30:00.000Z" }))).toBe(true);
  });

  it("where it came from, in words: never 'Sent by hygiene', never an invented visit type", () => {
    expect(checkoutOriginText(card())).toMatch(/^Made from today's schedule at \d{1,2}:\d{2} [AP]M · Crown Prep$/);
    expect(checkoutOriginText(card({ scheduleAppointment: { aptNum: 5001, dateTime: "2026-10-30 09:00:00", appointmentType: "", provider: "", operatory: "" } }))).toMatch(
      /^Made from today's schedule at \d{1,2}:\d{2} [AP]M$/,
    );
    expect(checkoutOriginText(card({ source: "manual", submittedBy: "tc@carein.ai" }))).toMatch(/^Added by hand at .* by tc@carein.ai$/);
    expect(checkoutOriginText(card({ source: "hygiene" }))).toMatch(/^Sent by hygiene at/);
  });

  it("the workup: badge, origin line, and the honest empty hygiene sections; a merged visit is noted", () => {
    const memory = memoryLocation({ path: "/tc/checkout/x?office=roland" });
    const { rerender } = render(
      <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
        <CheckoutWorkup office="roland" handoff={card()} onChange={vi.fn()} onReload={vi.fn(async () => {})} />
      </WouterRouter>,
    );
    expect(screen.getByTestId("workup-schedule").textContent).toMatch(/From today's schedule/);
    expect(screen.getByTestId("workup-origin").textContent).toMatch(/Made from today's schedule at .* · Crown Prep · seen by DOC1 · Op 3/);
    expect(screen.queryByTestId("workup-manual")).toBeNull();
    expect(screen.getByTestId("workup-no-hygiene-data").textContent).toMatch(/made from today's schedule \(a finished visit that was not a hygiene visit\), and no hygiene visit/);
    expect(screen.getByTestId("workup-no-hygiene-data").textContent).not.toMatch(/added at the desk/);

    rerender(
      <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
        <CheckoutWorkup
          office="roland"
          handoff={card({ hygieneMergedAt: "2026-10-30T15:30:00.000Z" })}
          onChange={vi.fn()}
          onReload={vi.fn(async () => {})}
        />
      </WouterRouter>,
    );
    expect(screen.getByTestId("workup-origin").textContent).toMatch(/hygiene visit arrived at/);
  });
});

// ── screenshot dumps ────────────────────────────────────────────────────────

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

describe.skipIf(process.env.TC_SHOTS !== "1")("CO-5b screenshot dumps", () => {
  const hygieneCard = (): TcCheckoutHandoff =>
    HandoffSchema.parse({
      ...card({
        handoffId: "5d2a7e10-0000-4000-8000-0000000005b2",
        patientName: "Lime, Pat",
        source: "hygiene",
        scheduleAppointment: null,
        provider: "HYG1",
        providerSeen: "DOC1",
        operatory: "Hyg 1",
        submittedBy: "hygienist@carein.ai",
        createdAt: "2026-10-30T14:40:00.000Z",
      }),
      snapshot: {
        ...emptyCheckoutSnapshot(),
        procedures: [{ teeth: [3], code: "Crown", category: "Restorative", priority: "urgent", status: "proposed", surfaces: ["O"], scheduleNext: false, note: "" }],
        priority: "urgent",
      },
    });

  it("co5b-01 — the Checkout list with cards from today's schedule", async () => {
    api.listCheckout.mockResolvedValue({
      success: true,
      today: "2026-10-30",
      view: "waiting",
      handoffs: [
        card(),
        card({
          handoffId: "5d2a7e10-0000-4000-8000-0000000005b3",
          patientName: "Fig, Alex",
          odPatientId: 12828,
          createdAt: "2026-10-30T15:20:00.000Z",
          scheduleAppointment: { aptNum: 5003, dateTime: "2026-10-30 10:00:00", appointmentType: "Limited Exam", provider: "DOC1", operatory: "Op 2" },
        }),
        hygieneCard(),
      ],
    });
    api.getScheduleCheck.mockResolvedValue(check({ lastSuccessAt: "2026-10-30T15:21:00.000Z" }));
    render(
      <div className="p-6 max-w-4xl mx-auto">
        <WouterRouter hook={memoryLocation({ path: "/tc/checkout" }).hook}>
          <CheckoutInbox offices={["roland"]} showOfficeBadges={false} />
        </WouterRouter>
      </div>,
    );
    await screen.findAllByTestId("checkout-row-schedule");
    await screen.findByTestId("schedule-check-ok-roland");
    dump("tccheckout-co5b-01-list@1280x900");
  });

  it("co5b-02 — the schedule could not be read", async () => {
    api.listCheckout.mockResolvedValue({ success: true, today: "2026-10-30", view: "waiting", handoffs: [card()] });
    api.getScheduleCheck.mockResolvedValue(check({ status: "failed", lastSuccessAt: "2026-10-30T15:02:00.000Z", lastAttemptAt: "2026-10-30T15:31:00.000Z" }));
    render(
      <div className="p-6 max-w-4xl mx-auto">
        <WouterRouter hook={memoryLocation({ path: "/tc/checkout" }).hook}>
          <CheckoutInbox offices={["roland"]} showOfficeBadges={false} />
        </WouterRouter>
      </div>,
    );
    await screen.findByTestId("schedule-check-failed-roland");
    await screen.findByTestId("checkout-row");
    dump("tccheckout-co5b-02-read-failed@1280x900");
  });

  it("co5b-03 — the workup of a card from the schedule", () => {
    const memory = memoryLocation({ path: "/tc/checkout/x?office=roland" });
    render(
      <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
        <div className="p-6 max-w-5xl mx-auto">
          <CheckoutWorkup office="roland" handoff={card()} onChange={vi.fn()} onReload={vi.fn(async () => {})} />
        </div>
      </WouterRouter>,
    );
    dump("tccheckout-co5b-03-workup@1280x900");
  });
});
