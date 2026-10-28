/**
 * Checkout v2 — the slip's two new sections, the tray, and the TC checkout panel.
 *
 *   - Medical history: "No changes" and the changes box exclude each other,
 *     visibly; the line under them says what the note prints; unanswered shows
 *     a reminder at Send that never disables it.
 *   - Collect at checkout: chips stored in the option order, "Other" capped;
 *     on its own it makes the handoff stageable.
 *   - The tray says WHY a staged write is out of date (the server's reason).
 *   - The checkout sidebar: "Collect payment" first, the hygienist's notes,
 *     the records, and a priority that cannot be read as the category.
 *
 * NO NETWORK, NO PHI. Synthetic names; roland 12827 is the fixture.
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { emptySlip, type HygSlip, type StagedWrite } from "@shared/hyg/contract";
import type { TcCheckoutHandoff } from "@shared/tc/checkout";

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

import { VisitNoteFields } from "@/features/hyg/visit/VisitNoteFields";
import { RouterSlip } from "@/features/hyg/visit/RouterSlip";
import { StagedWritesTray } from "@/features/hyg/visit/StagedWritesTray";
import { CheckoutSidebar } from "@/features/tc/checkout/CheckoutSidebar";

afterEach(() => cleanup());

/** The page's own loop, in miniature: the form's onChange becomes its next slip. */
function Stateful({ initial, onSlip }: { initial: HygSlip; onSlip?: (s: HygSlip) => void }) {
  const [slip, setSlip] = React.useState(initial);
  return (
    <VisitNoteFields
      slip={slip}
      doctorOptions={[]}
      suggestion={null}
      onChange={(next) => {
        setSlip(next);
        onSlip?.(next);
      }}
    />
  );
}

describe("medical history on the slip", () => {
  it("sits directly after the visit-type picker", () => {
    render(<Stateful initial={emptySlip()} />);
    const picker = screen.getByTestId("hyg-note-visit-type");
    expect(picker.nextElementSibling?.getAttribute("data-testid")).toBe("hyg-medical-history");
  });

  it("'No changes' and the changes box clear each other, and the line says what prints", () => {
    const seen: HygSlip[] = [];
    render(<Stateful initial={emptySlip()} onSlip={(s) => seen.push(s)} />);
    const none = screen.getByTestId("hyg-medical-history-none");
    const box = screen.getByTestId("hyg-medical-history-text") as HTMLTextAreaElement;
    expect(screen.getByTestId("hyg-medical-history-prints").textContent).toMatch(/Not recorded yet/);

    fireEvent.change(box, { target: { value: "New allergy: latex" } });
    expect(seen.at(-1)?.medicalHistory).toEqual({ status: "changes", text: "New allergy: latex" });
    expect(screen.getByTestId("hyg-medical-history-prints").textContent).toContain(
      "Medical history update: New allergy: latex",
    );

    fireEvent.click(none);
    expect(seen.at(-1)?.medicalHistory).toEqual({ status: "no_changes" });
    // Picking "No changes" empties the box, visibly.
    expect(box.value).toBe("");
    expect(none.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("hyg-medical-history-prints").textContent).toContain(
      "Medical history: reviewed, no changes",
    );

    fireEvent.change(box, { target: { value: "Started a blood thinner" } });
    // Typing un-picks "No changes".
    expect(none.getAttribute("aria-pressed")).toBe("false");

    // Emptying the box is no answer, not an empty "changes".
    fireEvent.change(box, { target: { value: "   " } });
    expect(seen.at(-1)?.medicalHistory).toBeNull();
    expect(box.maxLength).toBe(1000);
  });
});

describe("collect at checkout on the slip", () => {
  it("stores the chips in the option order and caps Other at 200", () => {
    const seen: HygSlip[] = [];
    function Host() {
      const [slip, setSlip] = React.useState(emptySlip());
      return (
        <RouterSlip
          slip={slip}
          recordsNeeded={[]}
          onChange={(next) => {
            setSlip(next);
            seen.push(next);
          }}
        />
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByTestId("hyg-slip-collect-mouthwash"));
    fireEvent.click(screen.getByTestId("hyg-slip-collect-sealant"));
    expect(seen.at(-1)?.collectAtCheckout.items).toEqual(["sealant", "mouthwash"]);
    fireEvent.click(screen.getByTestId("hyg-slip-collect-sealant"));
    expect(seen.at(-1)?.collectAtCheckout.items).toEqual(["mouthwash"]);

    const other = screen.getByTestId("hyg-slip-collect-other") as HTMLInputElement;
    expect(other.maxLength).toBe(200);
    fireEvent.blur(other, { target: { value: "Floss picks" } });
    expect(seen.at(-1)?.collectAtCheckout).toEqual({ items: ["mouthwash"], other: "Floss picks" });
  });
});

function stagedWrite(kind: StagedWrite["kind"], over: Partial<StagedWrite> = {}): StagedWrite {
  return {
    id: `staged-${kind}`,
    kind,
    state: "Staged",
    title: "Visit note",
    summary: "The note for 2026-09-08",
    preview: ["Medical history: reviewed, no changes"],
    previewFingerprint: `fp-${kind}`,
    errorMessage: null,
    writtenRef: null,
    stagedBy: "hygienist@carein.ai",
    stagedAt: "2026-09-08T13:10:00.000Z",
    sentBy: null,
    sentAt: null,
    updatedAt: "2026-09-08T13:10:00.000Z",
    existingTxStale: false,
    ...over,
  };
}

function tray(props: Partial<React.ComponentProps<typeof StagedWritesTray>> = {}) {
  render(
    <StagedWritesTray
      staged={[]}
      handoffCategory="Other"
      patientName="Test 2, Stedi"
      itemCount={0}
      busy={false}
      sending={false}
      onStage={() => {}}
      onUnstage={() => {}}
      onSend={() => {}}
      onRetry={() => {}}
      refusal={null}
      perioHref="#"
      perio={null}
      onResumePerio={() => {}}
      {...props}
    />,
  );
}

describe("the tray", () => {
  // RULING (checkout v2 fix): ONLY something to collect used to make the
  // handoff stageable. It opens no case now — the Checkout alert card takes
  // the handoff card's place, and there is nothing to stage.
  it("availability: ONLY something to collect shows the Checkout alert card, not the TC handoff card", () => {
    tray({ collectCount: 2, checkoutEnabled: true });
    expect(screen.queryByTestId("hyg-staged-tc-handoff")).toBeNull();
    expect(screen.queryByTestId("hyg-stage-tc-handoff")).toBeNull();
    const card = screen.getByTestId("hyg-staged-checkout-alert");
    expect(card.textContent).toMatch(/Checkout alert/);
    expect(screen.getByTestId("hyg-checkout-alert-collect").textContent).toMatch(
      /no case is opened.*what to collect payment for \(2\) on the checkout alert/,
    );
    cleanup();

    // An office with checkout alerts off is told so — nothing reaches the desk.
    tray({ collectCount: 1, checkoutEnabled: false });
    expect(screen.getByTestId("hyg-checkout-alert-off").textContent).toMatch(
      /checkout alerts are off for this office.*\(1\)/,
    );
    cleanup();

    // With treatment as well, the TC handoff card is back and stages as before.
    tray({ collectCount: 2, itemCount: 1, checkoutEnabled: true });
    expect(screen.queryByTestId("hyg-staged-checkout-alert")).toBeNull();
    expect((screen.getByTestId("hyg-stage-tc-handoff") as HTMLButtonElement).disabled).toBe(false);
    cleanup();

    tray({ collectCount: 0 });
    expect((screen.getByTestId("hyg-stage-tc-handoff") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("hyg-handoff-no-items").textContent).not.toMatch(/collect at checkout/);
  });

  it("the Send confirm reminds when the medical history is not recorded — and still sends", () => {
    const onSend = vi.fn();
    tray({ staged: [stagedWrite("note")], medicalHistoryRecorded: false, onSend });
    fireEvent.click(screen.getByTestId("hyg-send-all"));
    const dialog = screen.getByTestId("hyg-confirm-send");
    expect(within(dialog).getByTestId("hyg-confirm-medical-history").textContent).toMatch(
      /Medical history not recorded/,
    );
    const accept = within(dialog).getByTestId("hyg-confirm-send-accept") as HTMLButtonElement;
    expect(accept.disabled).toBe(false);
    fireEvent.click(accept);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("no reminder when it is recorded", () => {
    tray({ staged: [stagedWrite("note")], medicalHistoryRecorded: true });
    fireEvent.click(screen.getByTestId("hyg-send-all"));
    expect(screen.queryByTestId("hyg-confirm-medical-history")).toBeNull();
  });

  it("says WHY a staged write is out of date, in the server's reason", () => {
    tray({
      staged: [
        stagedWrite("note", { existingTxStale: true, staleReason: "medical_history" }),
        stagedWrite("tc-handoff", { title: "Hygiene handoff", existingTxStale: true, staleReason: "handoff" }),
      ],
      itemCount: 1,
    });
    expect(screen.getByTestId("hyg-stale-note").textContent).toMatch(/Out of date — medical history changed/);
    expect(screen.getByTestId("hyg-stale-tc-handoff").textContent).toMatch(/Out of date — what TC will receive changed/);
    expect((screen.getByTestId("hyg-send-all") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("hyg-send-all-reason").textContent).toMatch(/medical-history answer changed/);
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
      procedures: [
        { teeth: [30], code: "Crown", category: "Restorative", priority: "preventative", status: "proposed", surfaces: [], scheduleNext: false, note: "" },
      ],
      priority: "preventative",
      nextVisit: { type: "Prophy", intervalMonths: 6, lengthMin: 60, withDoctor: false, rtc: "6 mo" },
      notesPending: false,
      frontDeskNote: "Prefers afternoons.",
      financialNote: "Asked about the crown estimate.",
      collectAtCheckout: ["Sealant", "Fl2 toothpaste"],
      records: [
        { record: "Pre-op PA", status: "taken_today" },
        { record: "Missing teeth note", status: "needed" },
      ],
      ...over,
    },
    final: true,
    revision: 2,
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

describe("the TC checkout panel", () => {
  it("leads with 'Collect payment', then the hygienist's notes, the treatment and the records", async () => {
    state.handoff = handoff();
    sidebar();
    const sheet = await screen.findByTestId("checkout-sidebar");
    const collect = await within(sheet).findByTestId("checkout-collect");
    expect(collect.textContent).toMatch(/Collect payment/);
    expect(within(collect).getByTestId("checkout-collect-items").textContent).toBe("SealantFl2 toothpaste");

    expect(within(sheet).getByTestId("checkout-front-desk-note").textContent).toMatch(/Prefers afternoons/);
    expect(within(sheet).getByTestId("checkout-financial-note").textContent).toMatch(/crown estimate/);

    // Collect first: it precedes the notes, which precede the treatment.
    const order = ["checkout-collect", "checkout-hygiene-notes", "checkout-procedures", "checkout-records"].map(
      (id) => within(sheet).getByTestId(id),
    );
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }

    const records = within(sheet).getAllByTestId("checkout-record").map((r) => r.textContent);
    expect(records).toEqual(["Pre-op PATaken today", "Missing teeth noteStill needed"]);
  });

  it("shows the item's PRIORITY distinct from its CATEGORY", async () => {
    state.handoff = handoff();
    sidebar();
    const sheet = await screen.findByTestId("checkout-sidebar");
    await within(sheet).findByTestId("checkout-procedures");
    const priority = within(sheet).getByTestId("checkout-proc-priority");
    const category = within(sheet).getByTestId("checkout-proc-category");
    expect(priority.textContent).toBe("PriorityPreventative");
    expect(priority.getAttribute("aria-label")).toBe("Priority: Preventative");
    expect(category.textContent).toBe("Restorative");
    expect(category.getAttribute("aria-label")).toBe("Category: Restorative");
    expect(priority).not.toBe(category);
  });

  it("an urgent item's priority is the red one", async () => {
    state.handoff = handoff({
      procedures: [
        { teeth: [3], code: "RC", category: "Endo", priority: "urgent", status: "proposed", surfaces: [], scheduleNext: false, note: "" },
      ],
      priority: "urgent",
    });
    sidebar();
    const sheet = await screen.findByTestId("checkout-sidebar");
    await within(sheet).findByTestId("checkout-procedures");
    expect(within(sheet).getByTestId("checkout-proc-priority").className).toMatch(/bg-red-100/);
  });

  it("an older snapshot with none of the new keys renders as it did — no empty sections", async () => {
    state.handoff = handoff({ collectAtCheckout: undefined, records: undefined, frontDeskNote: "", financialNote: "" });
    sidebar();
    const sheet = await screen.findByTestId("checkout-sidebar");
    await within(sheet).findByTestId("checkout-procedures");
    expect(within(sheet).queryByTestId("checkout-collect")).toBeNull();
    expect(within(sheet).queryByTestId("checkout-records")).toBeNull();
    expect(within(sheet).queryByTestId("checkout-hygiene-notes")).toBeNull();
  });
});
