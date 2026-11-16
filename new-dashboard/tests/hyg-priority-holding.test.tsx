/**
 * "Holding" — the 4th treatment-item priority (Beau's ruling).
 *
 * Holding marks an ALTERNATIVE or secondary option to the proposed treatment
 * (a bridge held as the alternative to the proposed implant). It is not an
 * urgency: neutral grey, never a warning, sorted after the other three, and it
 * never sets the visit's / card's priority.
 *
 *   1. the contract: items accept it; the visit-level TC value does not
 *   2. the hygiene card: a 4th one-tap option (2×2 on a phone) that patches
 *      the item to holding; the default for a new item is still preventative
 *   3. the TC checkout card: the holding procedure reads "Holding", in grey,
 *      LAST; the card's priority chip comes from the other items
 *
 * Synthetic data only (roland 12827).
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import {
  TREATMENT_PRIORITY_LABELS,
  TreatmentItemInputSchema,
  TreatmentPrioritySchema,
  countsTowardUrgency,
  type TreatmentItem,
  type TreatmentItemInput,
} from "@shared/hyg/contract";
import {
  TC_CHECKOUT_PRIORITY_LABELS,
  TcCheckoutHandoff as TcCheckoutHandoffSchema,
  TcCheckoutItemPriority,
  TcCheckoutPriority,
  TcCheckoutSnapshot,
  checkoutPriorityOf,
  holdingLast,
  type TcCheckoutHandoff,
} from "@shared/tc/checkout";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const { state } = vi.hoisted(() => ({ state: { row: null as TcCheckoutHandoff | null } }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/features/tc/checkout/checkoutApi", () => ({
  getCheckoutHandoff: vi.fn(async () => state.row),
  claimCheckout: vi.fn(),
  recordCheckoutOutcome: vi.fn(),
}));

import { TreatmentItems } from "@/features/hyg/visit/TreatmentItems";
import { CheckoutSidebar } from "@/features/tc/checkout/CheckoutSidebar";

afterEach(() => cleanup());

// ─── 1. contract ─────────────────────────────────────────────────────────────

describe("the vocabulary", () => {
  it("items accept 'holding', labelled Holding, LAST", () => {
    expect(TreatmentPrioritySchema.options.at(-1)).toBe("holding");
    expect(TREATMENT_PRIORITY_LABELS.holding).toBe("Holding");
    expect(countsTowardUrgency("holding")).toBe(false);
    const input: TreatmentItemInput = {
      teeth: [30],
      code: "Bridge",
      category: "Prosth",
      surfaces: [],
      dx: [],
      priority: "holding",
      motivation: [],
      status: "proposed",
      scheduleNext: false,
      photos: [],
    };
    expect(TreatmentItemInputSchema.safeParse(input).success).toBe(true);
  });

  it("TC: a procedure may be holding; the VISIT-level priority may not", () => {
    expect(TcCheckoutItemPriority.safeParse("holding").success).toBe(true);
    expect(TcCheckoutPriority.safeParse("holding").success).toBe(false);
    expect(TC_CHECKOUT_PRIORITY_LABELS.holding).toBe("Holding");
    expect(checkoutPriorityOf([{ priority: "holding" }])).toBeNull();
    expect(checkoutPriorityOf([{ priority: "holding" }, { priority: "urgent" }])).toBe("urgent");
    const snap = {
      procedures: [],
      priority: "holding",
      nextVisit: { type: null, intervalMonths: null, lengthMin: null, withDoctor: false, rtc: "" },
      notesPending: true,
      frontDeskNote: "",
      financialNote: "",
    };
    expect(TcCheckoutSnapshot.safeParse(snap).success).toBe(false);
  });

  it("holdingLast is a stable partition", () => {
    const rows = (["holding", "cosmetic", "urgent", "holding"] as const).map((priority, i) => ({ priority, i }));
    expect(holdingLast(rows, (r) => r.priority).map((r) => r.i)).toEqual([1, 2, 0, 3]);
  });
});

// ─── 2. the hygiene card ─────────────────────────────────────────────────────

describe("the hygiene card's one-tap priority control", () => {
  const fake = { items: [] as TreatmentItem[], seq: 0, patches: [] as { id: string; patch: Partial<TreatmentItemInput> }[] };
  beforeEach(() => {
    fake.items = [];
    fake.seq = 0;
    fake.patches = [];
  });

  function Harness() {
    const [items, setItems] = React.useState<TreatmentItem[]>(fake.items);
    const commit = (next: TreatmentItem[]) => {
      fake.items = next;
      setItems(next);
    };
    return (
      <TreatmentItems
        items={items}
        busy={false}
        onAdd={async (input) => {
          fake.seq += 1;
          const next = [...fake.items, { ...input, id: `item-${fake.seq}`, createdBy: "hygienist@carein.ai", createdAt: "2026-11-16T14:00:00.000Z" }];
          commit(next);
          return next;
        }}
        onRemove={async () => true}
        onPatch={(id, patch) => {
          fake.patches.push({ id, patch });
          commit(fake.items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
        }}
      />
    );
  }

  it("has Holding as the 4th option, 2×2 on a phone, 44px targets; a tap patches to holding in grey", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("hyg-tooth-30"));
    fireEvent.click(screen.getByTestId("hyg-add-Crown"));
    await waitFor(() => expect(fake.items).toHaveLength(1));
    const id = fake.items[0].id;

    // The default for a new item is unchanged.
    expect(fake.items[0].priority).toBe("preventative");

    const group = within(screen.getByTestId(`hyg-item-priority-${id}`)).getByRole("group", { name: "How soon?" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Urgent", "Preventative", "Cosmetic", "Holding"]);
    expect(group.className).toMatch(/\bgrid-cols-2\b/);
    expect(group.className).toMatch(/\bsm:grid-cols-4\b/);
    for (const b of buttons) expect(b.className).toMatch(/min-h-11/);

    const holding = screen.getByTestId(`hyg-item-${id}-priority-holding`);
    expect(holding.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(holding);
    expect(fake.patches).toEqual([{ id, patch: { priority: "holding" } }]);
    await waitFor(() => expect(screen.getByTestId(`hyg-item-${id}-priority-holding`).getAttribute("aria-pressed")).toBe("true"));
    const cls = screen.getByTestId(`hyg-item-${id}-priority-holding`).className;
    expect(cls).toMatch(/bg-slate-100/);
    expect(cls).not.toMatch(/red|amber|orange|yellow/);
  });
});

// ─── 3. the TC checkout card ─────────────────────────────────────────────────

function handoff(procedures: { code: string; priority: "urgent" | "preventative" | "cosmetic" | "holding" }[]): TcCheckoutHandoff {
  const procs = procedures.map((p) => ({
    teeth: [30],
    code: p.code,
    category: "Prosth",
    priority: p.priority,
    status: "proposed",
    surfaces: [],
    scheduleNext: false,
    note: "",
  }));
  return TcCheckoutHandoffSchema.parse({
    handoffId: "00e65dd8-0000-4000-8000-0000000000d1",
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    provider: "DOC1",
    providerSeen: "HYG1",
    operatory: "Hyg 1",
    visitDate: "2026-11-16",
    snapshot: {
      procedures: procs,
      priority: checkoutPriorityOf(procs),
      nextVisit: { type: "Prophy", intervalMonths: 6, lengthMin: 60, withDoctor: true, rtc: "6 mo" },
      notesPending: true,
      frontDeskNote: "",
      financialNote: "",
    },
    final: true,
    revision: 1,
    submittedBy: "hygienist@carein.ai",
    createdAt: "2026-11-16T15:00:00.000Z",
    updatedAt: "2026-11-16T15:00:00.000Z",
  });
}

async function openCard(row: TcCheckoutHandoff) {
  state.row = row;
  render(<CheckoutSidebar office="roland" handoffId={row.handoffId} onClose={() => {}} onChanged={() => {}} />);
  return screen.findByTestId("checkout-procedures");
}

describe("the TC checkout card", () => {
  beforeEach(() => {
    state.row = null;
  });

  it("shows the holding procedure as Holding, grey, LAST — and the card's priority from the others", async () => {
    const list = await openCard(
      handoff([
        { code: "Bridge", priority: "holding" },
        { code: "Implant", priority: "urgent" },
        { code: "Sealant", priority: "preventative" },
      ]),
    );
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByTestId("checkout-proc-priority").textContent)).toEqual([
      "PriorityUrgent",
      "PriorityPreventative",
      "PriorityHolding",
    ]);
    expect(rows[2].textContent).toMatch(/Bridge/);
    const pill = within(rows[2]).getByTestId("checkout-proc-priority");
    expect(pill.getAttribute("aria-label")).toBe("Priority: Holding");
    expect(pill.className).toMatch(/bg-slate-100/);
    expect(pill.className).not.toMatch(/red|amber|orange|yellow/);

    expect(screen.getByTestId("checkout-priority").textContent).toBe("Priority: Urgent");
  });

  it("holding only: the card reads exactly as one with nothing staged would — no priority", async () => {
    await openCard(handoff([{ code: "Bridge", priority: "holding" }]));
    expect(state.row?.snapshot.priority).toBeNull();
    // The priority chip with no priority is the "Nothing staged" badge, not "Holding".
    expect(screen.queryByTestId("checkout-priority")).toBeNull();
    expect(screen.getByText("Nothing staged")).toBeTruthy();
  });
});
