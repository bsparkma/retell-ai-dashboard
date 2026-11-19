/**
 * PA details + the after-Send addendum — the screens.
 *
 *   PA details: the box is HIDDEN until PAs is picked under X-rays taken,
 *   appears when it is, and what is typed persists into the slip (and survives
 *   a mis-tap that un-picks PAs). The TC checkout card shows the line.
 *
 *   Addenda: nothing before the note is sent; same day, a box to add one and
 *   a two-press Send per addendum (it names the shown preview's fingerprint);
 *   day closed, read-only — no box, no Send.
 *
 * NO NETWORK, NO BACKEND, NO PHI (roland 12827 is the staging fixture).
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { emptySlip, HygSlipSchema, type HygAddendum, type HygSlip } from "@shared/hyg/contract";
import type { TcCheckoutHandoff } from "@shared/tc/checkout";
import { TcCheckoutSnapshot } from "@shared/tc/checkout";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const { state } = vi.hoisted(() => ({ state: { handoff: null as TcCheckoutHandoff | null } }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/features/tc/checkout/checkoutApi", () => ({
  getCheckoutHandoff: vi.fn(async () => state.handoff),
  claimCheckout: vi.fn(),
  recordCheckoutOutcome: vi.fn(),
}));

import { RouterSlip } from "@/features/hyg/visit/RouterSlip";
import { VisitAddenda } from "@/features/hyg/visit/VisitAddenda";
import { CheckoutSidebar } from "@/features/tc/checkout/CheckoutSidebar";

afterEach(() => cleanup());

function Host({ onSlip }: { onSlip: (s: HygSlip) => void }) {
  const [slip, setSlip] = React.useState(emptySlip());
  return (
    <RouterSlip
      slip={slip}
      recordsNeeded={[]}
      onChange={(next) => {
        setSlip(next);
        onSlip(next);
      }}
    />
  );
}

describe("PA details on the routing slip", () => {
  it("is hidden until PAs is picked, then shown, and what is typed persists into the slip", () => {
    const seen: HygSlip[] = [];
    render(<Host onSlip={(s) => seen.push(s)} />);
    expect(screen.queryByTestId("hyg-slip-pa-details")).toBeNull();

    // Another X-ray does not show it.
    fireEvent.click(screen.getByTestId("hyg-slip-xray-BW-4"));
    expect(screen.queryByTestId("hyg-slip-pa-details")).toBeNull();

    fireEvent.click(screen.getByTestId("hyg-slip-xray-PA"));
    const box = screen.getByTestId("hyg-slip-pa-details") as HTMLTextAreaElement;
    expect(box.maxLength).toBe(1000);
    fireEvent.change(box, { target: { value: "#19 and #30" } });
    fireEvent.blur(box);
    const last = seen[seen.length - 1];
    expect(last.xrayTypes).toEqual(["BW-4", "PA"]);
    expect(last.paDetails).toBe("#19 and #30");
    // What the page would PUT is a slip the server's own schema accepts.
    expect(HygSlipSchema.safeParse(last).success).toBe(true);

    // A mis-tap that un-picks PAs hides the box but keeps the words.
    fireEvent.click(screen.getByTestId("hyg-slip-xray-PA"));
    expect(screen.queryByTestId("hyg-slip-pa-details")).toBeNull();
    expect(seen[seen.length - 1].paDetails).toBe("#19 and #30");
    fireEvent.click(screen.getByTestId("hyg-slip-xray-PA"));
    expect((screen.getByTestId("hyg-slip-pa-details") as HTMLTextAreaElement).value).toBe("#19 and #30");
  });
});

function handoff(over: Partial<TcCheckoutHandoff["snapshot"]> = {}): TcCheckoutHandoff {
  return {
    handoffId: "5d2a7e10-0000-4000-8000-0000000000c9",
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    provider: "DOC1",
    providerSeen: "HYG1",
    operatory: "Hyg 1",
    visitDate: "2026-09-08",
    snapshot: {
      procedures: [],
      priority: null,
      nextVisit: { type: null, intervalMonths: null, lengthMin: null, withDoctor: false, rtc: "" },
      notesPending: false,
      frontDeskNote: "",
      financialNote: "",
      ...over,
    },
    final: true,
    revision: 1,
    submittedBy: "hygienist@carein.ai",
    createdAt: "2026-09-08T14:42:00.000Z",
    updatedAt: "2026-09-08T14:55:00.000Z",
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
  };
}

function sidebar() {
  const memory = memoryLocation({ path: "/tc/checkout" });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <CheckoutSidebar office="roland" handoffId="5d2a7e10-0000-4000-8000-0000000000c9" onClose={() => {}} />
    </WouterRouter>,
  );
}

describe("PA details on the TC checkout card", () => {
  it("shows the PA line in 'From the hygienist' — even when it is the only note", async () => {
    state.handoff = handoff({ paDetails: "#19 and #30, sensitivity on biting" });
    expect(TcCheckoutSnapshot.safeParse(state.handoff.snapshot).success).toBe(true);
    sidebar();
    const sheet = await screen.findByTestId("checkout-sidebar");
    const notes = await within(sheet).findByTestId("checkout-hygiene-notes");
    expect(within(notes).getByTestId("checkout-pa-details").textContent).toBe(
      "PA details: #19 and #30, sensitivity on biting",
    );
  });

  it("draws nothing for a snapshot without it (every older checkout)", async () => {
    state.handoff = handoff({ frontDeskNote: "Prefers afternoons." });
    sidebar();
    const sheet = await screen.findByTestId("checkout-sidebar");
    await within(sheet).findByTestId("checkout-hygiene-notes");
    expect(within(sheet).queryByTestId("checkout-pa-details")).toBeNull();
  });
});

const ADDENDUM: HygAddendum = {
  id: "00000000-0000-4000-8000-000000000001",
  text: "Called back: resolved.",
  author: "frontdesk@carein.ai",
  createdAt: "2026-09-08T21:30:00.000Z",
  state: "Staged",
  preview: [
    "ADDENDUM to the hygiene visit note of 2026-09-08 (GroupNote 60001)",
    "Called back: resolved.",
    "Entered in CareIN by frontdesk@carein.ai at 2026-09-08 16:30 CDT. Unsigned.",
  ],
  previewFingerprint: "fp-of-what-is-shown",
  writtenRef: null,
  errorMessage: null,
  sentBy: null,
  sentAt: null,
};

describe("after-Send addenda", () => {
  it("draws nothing before the visit note is sent", () => {
    const { container } = render(
      <VisitAddenda
        addenda={[]}
        window={{ open: false, reason: "note_not_sent", day: null }}
        busy={false}
        onAdd={async () => true}
        onSend={() => {}}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("same day: add one, then Send is two presses and names the SHOWN preview", async () => {
    const onAdd = vi.fn(async () => true);
    const onSend = vi.fn();
    render(
      <VisitAddenda
        addenda={[ADDENDUM]}
        window={{ open: true, reason: null, day: "2026-09-08" }}
        busy={false}
        onAdd={onAdd}
        onSend={onSend}
      />,
    );
    // The full preview is on screen — exactly what the chart will get.
    expect(screen.getByTestId("hyg-addendum-preview").textContent).toBe(ADDENDUM.preview.join("\n"));
    expect(screen.getByTestId("hyg-addendum-state").textContent).toBe("Not sent to the chart yet");

    const add = screen.getByTestId("hyg-addendum-add") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("hyg-addendum-text"), { target: { value: "Second one" } });
    fireEvent.click(add);
    expect(onAdd).toHaveBeenCalledWith("Second one");

    // First press only asks; nothing is sent until the second.
    fireEvent.click(screen.getByTestId("hyg-addendum-send"));
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("hyg-addendum-confirm-send"));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0].previewFingerprint).toBe("fp-of-what-is-shown");
  });

  it("day closed: read-only — the addenda stay visible, with no box and no Send", () => {
    render(
      <VisitAddenda
        addenda={[ADDENDUM, { ...ADDENDUM, id: "00000000-0000-4000-8000-000000000002", state: "Written", writtenRef: "GroupNote 60002 (addendum)", sentBy: "x", sentAt: "2026-09-08T21:40:00.000Z" }]}
        window={{ open: false, reason: "day_closed", day: "2026-09-08" }}
        busy={false}
        onAdd={async () => true}
        onSend={() => {}}
      />,
    );
    expect(screen.getAllByTestId("hyg-addendum-preview")).toHaveLength(2);
    expect(screen.queryByTestId("hyg-addendum-text")).toBeNull();
    expect(screen.queryByTestId("hyg-addendum-send")).toBeNull();
    expect(screen.getByTestId("hyg-addenda-window").textContent).toMatch(/read-only/);
    expect(screen.getByTestId("hyg-addendum-ref").textContent).toBe("GroupNote 60002 (addendum)");
  });
});
