/**
 * FASTER TREATMENT ENTRY — the selection modes, the work picker, surfaces at
 * add, priority on the card, and Undo.
 *
 * Beau: "after adding work to one tooth, picking the next tooth leaves the first
 * one selected, so the next tap adds work to both unless she unselects first."
 *
 * Rendered against a small in-memory fake of the server so every add and remove
 * resolves the way the page's own wiring does: onAdd → the items after the
 * create (or null on failure), onRemove → whether it went through.
 *
 * jsdom has no layout engine, so the 390px checks assert the classes that make
 * the layout (one scrolling tab row, a 3-column grid, 44/48px minimums) rather
 * than measured pixels.
 *
 * NO NETWORK, NO BACKEND, NO PHI.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { TreatmentItem, TreatmentItemInput } from "@shared/hyg/contract";
import { TreatmentItems } from "@/features/hyg/visit/TreatmentItems";
import {
  addMessage,
  itemToInput,
  nextSelection,
  selectionForMode,
  targetText,
} from "@/features/hyg/visit/treatmentEntry";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

/** The fake server, and a record of every call the screen made. */
const fake = {
  items: [] as TreatmentItem[],
  seq: 0,
  adds: [] as TreatmentItemInput[],
  removes: [] as string[],
  patches: [] as { id: string; patch: Partial<TreatmentItemInput> }[],
  /** An add naming any of these teeth fails. */
  failTeeth: [] as number[],
  failRemove: false,
};

function Harness() {
  const [items, setItems] = React.useState<TreatmentItem[]>(fake.items);
  const commitItems = (next: TreatmentItem[]) => {
    fake.items = next;
    setItems(next);
  };
  return (
    <TreatmentItems
      items={items}
      busy={false}
      onAdd={async (input) => {
        fake.adds.push(input);
        await Promise.resolve();
        if (input.teeth !== "mouth" && input.teeth.some((t) => fake.failTeeth.includes(t))) return null;
        fake.seq += 1;
        const item: TreatmentItem = {
          ...input,
          id: `item-${fake.seq}`,
          createdBy: "hygienist@carein.ai",
          createdAt: "2026-09-08T13:05:00.000Z",
        };
        const next = [...fake.items, item];
        commitItems(next);
        return next;
      }}
      onRemove={async (id) => {
        fake.removes.push(id);
        await Promise.resolve();
        if (fake.failRemove) return false;
        commitItems(fake.items.filter((i) => i.id !== id));
        return true;
      }}
      onPatch={(id, patch) => {
        fake.patches.push({ id, patch });
        commitItems(fake.items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
      }}
    />
  );
}

const tap = (testId: string) => fireEvent.click(screen.getByTestId(testId));
const target = () => screen.getByTestId("hyg-add-selection").textContent;
const pressed = (testId: string) => screen.getByTestId(testId).getAttribute("aria-pressed");
const notice = async () => (await screen.findByTestId("hyg-treatment-notice-text")).textContent;

beforeEach(() => {
  fake.items = [];
  fake.seq = 0;
  fake.adds = [];
  fake.removes = [];
  fake.patches = [];
  fake.failTeeth = [];
  fake.failRemove = false;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ─── 1. Selection mode ───────────────────────────────────────────────────────

describe("One tooth (the default): a tap replaces, and the pick survives an add", () => {
  it("is the default, and tapping a second tooth REPLACES the first", async () => {
    render(<Harness />);
    expect(pressed("hyg-select-mode-one")).toBe("true");

    tap("hyg-tooth-30");
    tap("hyg-tooth-3");
    expect(pressed("hyg-tooth-3")).toBe("true");
    // The bug: #30 stayed picked and the next add landed on both.
    expect(pressed("hyg-tooth-30")).toBe("false");
    expect(target()).toBe("Tooth #3");

    tap("hyg-add-Crown");
    await waitFor(() => expect(fake.adds).toHaveLength(1));
    expect(fake.adds[0].teeth).toEqual([3]);
  });

  it("tapping the picked tooth clears it", () => {
    render(<Harness />);
    tap("hyg-tooth-30");
    tap("hyg-tooth-30");
    expect(target()).toBe("No tooth picked");
  });

  it("#30 → Build-up → Crown → RC is still three taps, and says it is still on #30", async () => {
    render(<Harness />);
    tap("hyg-tooth-30");
    tap("hyg-add-Build-up");
    expect(await notice()).toBe("Added Build-up on #30. Still on #30.");
    tap("hyg-add-Crown");
    await waitFor(() => expect(fake.adds).toHaveLength(2));
    tap("hyg-code-tab-Endo");
    tap("hyg-add-RC");
    await waitFor(() => expect(fake.items).toHaveLength(3));

    expect(fake.adds.map((a) => a.teeth)).toEqual([[30], [30], [30]]);
    expect(fake.adds.map((a) => a.code)).toEqual(["Build-up", "Crown", "RC"]);
    await waitFor(async () => expect(await notice()).toBe("Added RC on #30. Still on #30."));
    expect(target()).toBe("Tooth #30");
  });

  it("the hint says what the mode does", () => {
    render(<Harness />);
    expect(screen.getByTestId("hyg-select-mode-hint").textContent).toMatch(/stays picked after you add/i);
    tap("hyg-select-mode-several");
    expect(screen.getByTestId("hyg-select-mode-hint").textContent).toMatch(/one item per tooth/i);
    tap("hyg-spread-across");
    expect(screen.getByTestId("hyg-select-mode-hint").textContent).toMatch(/one item across all of them/i);
  });
});

describe("Several teeth: toggles, each vs across, and the selection clears after an add", () => {
  it("toggles teeth in and out, and shows the second switch only in this mode", () => {
    render(<Harness />);
    expect(screen.queryByTestId("hyg-spread-each")).toBeNull();
    tap("hyg-select-mode-several");
    expect(pressed("hyg-spread-each")).toBe("true");

    tap("hyg-tooth-14");
    tap("hyg-tooth-3");
    expect(target()).toBe("Teeth #3, #14");
    tap("hyg-tooth-14");
    expect(target()).toBe("Tooth #3");
  });

  it("Add to each tooth: sealants on four teeth are FOUR items, then the selection clears — and says so", async () => {
    render(<Harness />);
    tap("hyg-select-mode-several");
    for (const t of [3, 14, 19, 30]) tap(`hyg-tooth-${t}`);
    tap("hyg-code-tab-Other");
    tap("hyg-add-Sealant");

    expect(await notice()).toBe("Added Sealant to 4 teeth. Selection cleared.");
    expect(fake.adds.map((a) => a.teeth)).toEqual([[3], [14], [19], [30]]);
    expect(fake.items).toHaveLength(4);
    expect(target()).toBe("No tooth picked");
  });

  it("One item across teeth: a bridge is ONE item spanning the set, then the selection clears", async () => {
    render(<Harness />);
    tap("hyg-select-mode-several");
    tap("hyg-spread-across");
    for (const t of [5, 3, 4]) tap(`hyg-tooth-${t}`);
    tap("hyg-code-tab-Prosth");
    tap("hyg-add-Bridge");

    expect(await notice()).toBe("Added Bridge on #3, #4, #5. Selection cleared.");
    expect(fake.adds).toHaveLength(1);
    expect(fake.adds[0].teeth).toEqual([3, 4, 5]);
    expect(target()).toBe("No tooth picked");
  });

  it("switching back to One tooth keeps only the tooth tapped last", () => {
    render(<Harness />);
    tap("hyg-select-mode-several");
    tap("hyg-tooth-3");
    tap("hyg-tooth-19");
    tap("hyg-tooth-14");
    tap("hyg-select-mode-one");
    expect(target()).toBe("Tooth #14");
  });

  it("a whole-mouth add does not consume the selection", async () => {
    render(<Harness />);
    tap("hyg-select-mode-several");
    tap("hyg-tooth-3");
    tap("hyg-tooth-14");
    tap("hyg-code-tab-Cosmetic");
    tap("hyg-add-Whitening");
    expect(await notice()).toBe("Added Whitening (whole mouth). Still on #3, #14.");
    expect(target()).toBe("Teeth #3, #14");
  });

  it("the selection rules, without a render", () => {
    expect(nextSelection("one", [30], 3)).toEqual([3]);
    expect(nextSelection("one", [30], 30)).toEqual([]);
    expect(nextSelection("several", [30], 3)).toEqual([30, 3]);
    expect(nextSelection("several", [30, 3], 30)).toEqual([3]);
    expect(selectionForMode("one", [3, 14, 19], 14)).toEqual([14]);
    // The last tap was a de-select: keep the last tooth still in the set.
    expect(selectionForMode("one", [3, 19], 14)).toEqual([19]);
    expect(selectionForMode("several", [3], 3)).toEqual([3]);
    expect(targetText([])).toBe("No tooth picked");
    expect(targetText([14, 3])).toBe("Teeth #3, #14");
  });
});

// ─── 2. The work picker ──────────────────────────────────────────────────────

describe("the work picker: tabs and a 3-column grid, phone-sized", () => {
  it("one scrolling row of the existing category tabs, the selected group's codes in a 3-column grid", () => {
    render(<Harness />);
    const tablist = screen.getByTestId("hyg-code-tabs");
    expect(tablist.getAttribute("role")).toBe("tablist");
    // Horizontally scrollable at 390px rather than wrapping into rows.
    expect(tablist.className).toMatch(/overflow-x-auto/);
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Restorative", "Endo", "Surgery", "Perio", "Prosth", "Ortho", "Cosmetic", "Other",
    ]);
    for (const t of tabs) {
      expect(t.className).toMatch(/min-h-11/); // 44px
      expect(t.className).toMatch(/shrink-0/);
    }

    // Restorative is showing; the rest are hidden panels.
    expect(screen.getByTestId("hyg-code-panel-Restorative").hidden).toBe(false);
    expect(screen.getByTestId("hyg-code-panel-Endo").hidden).toBe(true);
    const grid = screen.getByTestId("hyg-add-Crown").parentElement as HTMLElement;
    expect(grid.className).toMatch(/grid-cols-3/);
    expect(screen.getByTestId("hyg-add-Crown").className).toMatch(/min-h-12/); // 48px

    tap("hyg-code-tab-Endo");
    expect(screen.getByTestId("hyg-code-tab-Endo").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("hyg-code-panel-Endo").hidden).toBe(false);
    expect(screen.getByTestId("hyg-code-panel-Restorative").hidden).toBe(true);
  });

  it("tooth codes are disabled with 'Pick a tooth first'; whole-mouth codes are labelled and live", () => {
    render(<Harness />);
    const crown = screen.getByTestId("hyg-add-Crown") as HTMLButtonElement;
    expect(crown.disabled).toBe(true);
    expect(crown.title).toBe("Pick a tooth first");
    // Said on screen, not only in a hover title a phone never shows.
    expect(screen.getByTestId("hyg-code-panel-hint-Restorative").textContent).toMatch(/Pick a tooth first/);

    tap("hyg-code-tab-Cosmetic");
    const whitening = screen.getByTestId("hyg-add-Whitening") as HTMLButtonElement;
    expect(whitening.disabled).toBe(false);
    expect(whitening.textContent).toMatch(/whole mouth/);

    tap("hyg-tooth-30");
    expect(crown.disabled).toBe(false);
    expect(screen.queryByTestId("hyg-code-panel-hint-Restorative")).toBeNull();
  });

  it("the target line is always there, with Clear when something is picked", () => {
    render(<Harness />);
    expect(target()).toBe("No tooth picked");
    expect(screen.queryByTestId("hyg-clear-selection")).toBeNull();
    tap("hyg-tooth-30");
    expect(target()).toBe("Tooth #30");
    expect(screen.getByTestId("hyg-clear-selection").className).toMatch(/min-h-11/);
    tap("hyg-clear-selection");
    expect(target()).toBe("No tooth picked");
  });

  it("every control above the chart is a 44px target", () => {
    render(<Harness />);
    tap("hyg-select-mode-several");
    for (const id of ["hyg-select-mode-one", "hyg-select-mode-several", "hyg-spread-each", "hyg-spread-across"]) {
      expect(screen.getByTestId(id).className).toMatch(/min-h-11/);
    }
  });
});

// ─── 3. Surfaces at add ──────────────────────────────────────────────────────

describe("surfaces at add: Comp and Amal on one tooth", () => {
  it("opens an inline step, adds nothing until Add, and sends the surfaces in chart order", async () => {
    render(<Harness />);
    tap("hyg-tooth-30");
    tap("hyg-add-Comp");
    const step = screen.getByTestId("hyg-surfaces-step");
    expect(step.textContent).toMatch(/Comp on #30: which surfaces\?/);
    expect(fake.adds).toHaveLength(0);

    tap("hyg-surface-O");
    tap("hyg-surface-M");
    expect(screen.getByTestId("hyg-surfaces-add").textContent).toBe("Add Comp MO");
    expect(screen.getByTestId("hyg-surface-M").className).toMatch(/min-h-11/);
    tap("hyg-surfaces-add");

    expect(await notice()).toBe("Added Comp MO on #30. Still on #30.");
    expect(fake.adds[0]).toMatchObject({ code: "Comp", teeth: [30], surfaces: ["M", "O"] });
    expect(screen.queryByTestId("hyg-surfaces-step")).toBeNull();
  });

  it("surfaces are optional: Add with none adds Comp with []", async () => {
    render(<Harness />);
    tap("hyg-tooth-14");
    tap("hyg-add-Amal");
    expect(screen.getByTestId("hyg-surfaces-add").textContent).toBe("Add Amal");
    tap("hyg-surfaces-add");
    await waitFor(() => expect(fake.adds).toHaveLength(1));
    expect(fake.adds[0].surfaces).toEqual([]);
  });

  it("Cancel adds nothing", () => {
    render(<Harness />);
    tap("hyg-tooth-30");
    tap("hyg-add-Comp");
    tap("hyg-surface-O");
    tap("hyg-surfaces-cancel");
    expect(screen.queryByTestId("hyg-surfaces-step")).toBeNull();
    expect(fake.adds).toHaveLength(0);
    expect(target()).toBe("Tooth #30");
  });

  it("every other code, and Comp in Several-teeth mode, is one tap", async () => {
    render(<Harness />);
    tap("hyg-tooth-30");
    tap("hyg-add-Crown");
    await waitFor(() => expect(fake.adds).toHaveLength(1));
    expect(screen.queryByTestId("hyg-surfaces-step")).toBeNull();

    tap("hyg-select-mode-several");
    tap("hyg-tooth-3");
    tap("hyg-add-Comp");
    expect(screen.queryByTestId("hyg-surfaces-step")).toBeNull();
    await waitFor(() => expect(fake.adds).toHaveLength(3));
    expect(fake.adds.slice(1).map((a) => [a.code, a.teeth, a.surfaces])).toEqual([
      ["Comp", [3], []],
      ["Comp", [30], []],
    ]);
  });
});

// ─── 4. Cards ────────────────────────────────────────────────────────────────

describe("cards: priority one tap on the card, everything else under More", () => {
  it("tapping Urgent on the card patches the item, without opening anything", async () => {
    render(<Harness />);
    tap("hyg-tooth-30");
    tap("hyg-add-Crown");
    await waitFor(() => expect(fake.items).toHaveLength(1));
    const id = fake.items[0].id;

    expect(pressed(`hyg-item-${id}-priority-preventative`)).toBe("true");
    expect(screen.getByTestId(`hyg-item-${id}-priority-urgent`).className).toMatch(/min-h-11/);
    tap(`hyg-item-${id}-priority-urgent`);
    expect(fake.patches).toEqual([{ id, patch: { priority: "urgent" } }]);
    await waitFor(() => expect(pressed(`hyg-item-${id}-priority-urgent`)).toBe("true"));
    // Today's colour for urgent.
    expect(screen.getByTestId(`hyg-item-${id}-priority-urgent`).className).toMatch(/bg-red-100/);
    // Category still behind More.
    expect(screen.queryByTestId(`hyg-item-${id}-category-Endo`)).toBeNull();
  });

  it("Edit is now More, and More holds category, status, surfaces, diagnosis, motivation", async () => {
    render(<Harness />);
    tap("hyg-tooth-30");
    tap("hyg-add-Crown");
    await waitFor(() => expect(fake.items).toHaveLength(1));
    const id = fake.items[0].id;

    const more = screen.getByTestId(`hyg-item-edit-${id}`);
    expect(more.textContent).toBe("More");
    fireEvent.click(more);
    const card = screen.getByTestId(`hyg-item-${id}`);
    for (const label of [/what kind of work\?/i, /where is it\?/i, /surfaces/i, /diagnosis/i, /why the patient might say yes/i]) {
      expect(within(card).getByText(label)).toBeTruthy();
    }
    // Priority is not repeated under More: one control per question.
    expect(within(card).getAllByText(/how soon\?/i)).toHaveLength(1);
    expect(screen.getByTestId(`hyg-item-remove-${id}`)).toBeTruthy();
  });
});

// ─── 5. Undo ─────────────────────────────────────────────────────────────────

describe("Undo", () => {
  it("undo of a single add removes exactly that item", async () => {
    fake.items = [
      { id: "item-old", teeth: [3], code: "Crown", category: "Restorative", surfaces: [], dx: [], priority: "preventative", motivation: [], status: "proposed", scheduleNext: false, photos: [], createdBy: "h", createdAt: "t" },
    ];
    render(<Harness />);
    tap("hyg-tooth-30");
    tap("hyg-add-Crown");
    expect(await notice()).toBe("Added Crown on #30. Still on #30.");
    const created = fake.items.find((i) => i.id !== "item-old")!.id;

    tap("hyg-treatment-undo");
    await waitFor(async () => expect(await notice()).toBe("Undone. Removed Crown on #30."));
    expect(fake.removes).toEqual([created]);
    expect(fake.items.map((i) => i.id)).toEqual(["item-old"]);
    expect(screen.queryByTestId("hyg-treatment-undo")).toBeNull();
  });

  it("undo of an add-to-each removes every item that add created", async () => {
    render(<Harness />);
    tap("hyg-select-mode-several");
    for (const t of [3, 14, 19]) tap(`hyg-tooth-${t}`);
    tap("hyg-code-tab-Other");
    tap("hyg-add-Sealant");
    expect(await notice()).toBe("Added Sealant to 3 teeth. Selection cleared.");
    const created = fake.items.map((i) => i.id);

    tap("hyg-treatment-undo");
    await waitFor(async () => expect(await notice()).toBe("Undone. Removed Sealant on 3 teeth."));
    expect(fake.removes).toEqual(created);
    expect(fake.items).toHaveLength(0);
  });

  it("undo of a remove re-creates the item with the same fields", async () => {
    render(<Harness />);
    tap("hyg-tooth-30");
    tap("hyg-add-Comp");
    tap("hyg-surface-D");
    tap("hyg-surfaces-add");
    await waitFor(() => expect(fake.items).toHaveLength(1));
    const id = fake.items[0].id;
    tap(`hyg-item-${id}-priority-urgent`);
    const before = fake.items[0];

    tap(`hyg-item-remove-${id}`);
    expect(await notice()).toMatch(/^Removed Comp D on #30\.$/);
    expect(fake.items).toHaveLength(0);

    tap("hyg-treatment-undo");
    await waitFor(async () => expect(await notice()).toBe("Put back Comp D on #30."));
    expect(fake.adds).toHaveLength(2);
    expect(fake.adds[1]).toEqual(itemToInput(before));
    expect(fake.adds[1]).toMatchObject({ priority: "urgent", surfaces: ["D"] });
    expect(fake.items).toHaveLength(1);
  });

  it("a failed remove says so and offers no Undo", async () => {
    render(<Harness />);
    tap("hyg-tooth-30");
    tap("hyg-add-Crown");
    await waitFor(() => expect(fake.items).toHaveLength(1));
    fake.failRemove = true;
    tap(`hyg-item-remove-${fake.items[0].id}`);
    await waitFor(async () => expect(await notice()).toBe("Crown on #30 was not removed."));
    expect(screen.queryByTestId("hyg-treatment-undo")).toBeNull();
  });

  it("steps aside after about six seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness />);
    tap("hyg-tooth-30");
    tap("hyg-add-Crown");
    await screen.findByTestId("hyg-treatment-notice");
    // Let the notice's effect register its timer BEFORE the clock moves —
    // under a loaded run the passive effect can land after findBy resolves.
    await act(async () => {});
    act(() => {
      vi.advanceTimersByTime(5900);
    });
    expect(screen.queryByTestId("hyg-treatment-notice")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByTestId("hyg-treatment-notice")).toBeNull();
  });
});

// ─── Honest state ────────────────────────────────────────────────────────────

describe("honest state: never claim what did not land", () => {
  it("a partial add-to-each names which teeth were added and which were not", async () => {
    fake.failTeeth = [14];
    render(<Harness />);
    tap("hyg-select-mode-several");
    for (const t of [3, 14, 19]) tap(`hyg-tooth-${t}`);
    tap("hyg-code-tab-Other");
    tap("hyg-add-Sealant");

    expect(await notice()).toBe(
      "Added Sealant to #3, #19. Not added to #14 — still selected, so you can try again.",
    );
    expect(fake.items.map((i) => i.teeth)).toEqual([[3], [19]]);
    // The tooth that failed is still picked — stated, not silent.
    expect(target()).toBe("Tooth #14");

    // And Undo removes only what landed.
    const created = fake.items.map((i) => i.id);
    tap("hyg-treatment-undo");
    await waitFor(() => expect(fake.removes).toEqual(created));
  });

  it("a failed single add says it was not added, keeps the tooth, and offers no Undo", async () => {
    fake.failTeeth = [30];
    render(<Harness />);
    tap("hyg-tooth-30");
    tap("hyg-add-Crown");
    expect(await notice()).toBe("Crown was not added to #30. Nothing changed; still on #30.");
    expect(screen.queryByTestId("hyg-treatment-undo")).toBeNull();
    expect(target()).toBe("Tooth #30");
  });

  it("a handler that reports nothing gets no confirmation", () => {
    render(
      <TreatmentItems items={[]} busy={false} onAdd={() => {}} onPatch={() => {}} onRemove={() => {}} />,
    );
    tap("hyg-tooth-30");
    tap("hyg-add-Crown");
    expect(screen.queryByTestId("hyg-treatment-notice")).toBeNull();
  });

  it("the message, without a render", () => {
    expect(
      addMessage({ label: "Sealant", added: [[3], [19]], failed: [[14]], perTooth: true, after: { kind: "kept", selected: [14] } }),
    ).toBe("Added Sealant to #3, #19. Not added to #14 — still selected, so you can try again.");
    expect(
      addMessage({ label: "Sealant", added: [], failed: [[3], [14]], perTooth: true, after: { kind: "kept", selected: [] } }),
    ).toBe("Sealant was not added to #3, #14. Nothing changed.");
  });
});
