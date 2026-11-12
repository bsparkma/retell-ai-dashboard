/**
 * The checkout arrival BANNER's acknowledge state (Beau's prominence ruling).
 *
 *   - A new arrival is a persistent banner: it is still there after more ticks
 *     with nothing new (it never times out the way the toast did).
 *   - Acknowledge removes THAT arrival; the same newest on a later tick does
 *     not bring it back; a genuinely newer arrival shows again.
 *   - Two arrivals (two offices) stack; "Acknowledge all" clears both.
 *   - No sound at `banner` (the default); `sound_banner` is the only level that
 *     chimes (covered in tc-notification-prefs.test.tsx).
 *   - The marker's pulse is motion-safe (reduced motion: no animation).
 *
 * NO NETWORK, NO BACKEND. Synthetic names only.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import type { TcCheckoutSummary } from "@shared/tc/checkout";

(globalThis as Record<string, unknown>).React = React;

const { state, chime } = vi.hoisted(() => ({
  chime: vi.fn(() => true),
  state: { summaries: new Map<string, TcCheckoutSummary[]>(), level: "sound_banner" as "silent" | "banner" | "sound_banner" },
}));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/features/tc/notifications/chime", () => ({ playChime: chime, resetChimeForTests: vi.fn() }));
vi.mock("@/features/tc/notifications/notificationsApi", () => ({
  getNotificationPrefs: vi.fn(async (office: string) => ({
    success: true,
    office,
    canEditOffice: false,
    events: [{ event: "checkout_handoff", level: state.level, source: "user", mine: state.level, officeDefault: null }],
  })),
}));
vi.mock("@/features/tc/checkout/checkoutApi", () => ({
  getCheckoutSummary: vi.fn(async (office: string) => {
    const queue = state.summaries.get(office) ?? [];
    // The last scripted answer repeats: "nothing new" on every later tick.
    return queue.length > 1 ? queue.shift()! : queue[0];
  }),
}));

import { useCheckoutWatch } from "@/features/tc/checkout/useCheckoutWatch";
import { CheckoutArrivalBanner } from "@/features/tc/checkout/CheckoutArrivalBanner";

function summary(office: "roland" | "valley", n: number | null): TcCheckoutSummary {
  return {
    success: true,
    office,
    enabled: true,
    today: "2026-11-11",
    waiting: n ?? 0,
    newest:
      n === null
        ? null
        : {
            handoffId: `5d2a7e10-0000-4000-8000-${office === "roland" ? "1" : "2"}0000000000${n}`,
            patientName: `${office === "roland" ? "Kiwi" : "Fern"}, Pat ${n}`,
            createdAt: `2026-11-11T1${n}:00:00.000Z`,
          },
  };
}

function Shell({ offices }: { offices: ("roland" | "valley")[] }) {
  const w = useCheckoutWatch(offices);
  return <CheckoutArrivalBanner arrivals={w.arrivals} onAcknowledge={w.acknowledge} />;
}

async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
}

beforeEach(() => {
  state.summaries = new Map();
  state.level = "banner";
  chime.mockClear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function renderShell(offices: ("roland" | "valley")[]) {
  const memory = memoryLocation({ path: "/calls" });
  render(
    <WouterRouter hook={memory.hook}>
      <Shell offices={offices} />
    </WouterRouter>,
  );
}

describe("checkout arrival banner", () => {
  it("persists until acknowledged; the same arrival does not come back; a newer one does", async () => {
    state.summaries.set("roland", [summary("roland", 1), summary("roland", 2)]);
    renderShell(["roland"]);
    await waitFor(() => expect(state.summaries.get("roland")).toHaveLength(1)); // first answer: backlog only
    expect(screen.queryByTestId("checkout-arrival-banner")).toBeNull();

    await tick();
    await waitFor(() => expect(screen.getByTestId("checkout-arrival-banner")).toBeTruthy());
    expect(screen.getByTestId("checkout-arrival-name").textContent).toBe("Kiwi, Pat 2");

    // Ticks with nothing new: still there (a banner, not a toast that times out).
    await tick();
    await tick();
    expect(screen.getAllByTestId("checkout-arrival")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("checkout-arrival-ack"));
    expect(screen.queryByTestId("checkout-arrival-banner")).toBeNull();
    await tick();
    expect(screen.queryByTestId("checkout-arrival-banner")).toBeNull();

    state.summaries.set("roland", [summary("roland", 3)]);
    await tick();
    await waitFor(() => expect(screen.getByTestId("checkout-arrival-name").textContent).toBe("Kiwi, Pat 3"));
    expect(chime).not.toHaveBeenCalled();
  });

  it("two offices' arrivals stack; Acknowledge all clears both; never a sound", async () => {
    state.summaries.set("roland", [summary("roland", null), summary("roland", 4)]);
    state.summaries.set("valley", [summary("valley", null), summary("valley", 5)]);
    renderShell(["roland", "valley"]);
    await waitFor(() => expect(state.summaries.get("valley")).toHaveLength(1));
    await tick();
    await waitFor(() => expect(screen.getAllByTestId("checkout-arrival")).toHaveLength(2));
    fireEvent.click(screen.getByTestId("checkout-arrival-ack-all"));
    expect(screen.queryByTestId("checkout-arrival-banner")).toBeNull();
    expect(chime).not.toHaveBeenCalled();
  });

  it("silent: no banner at all", async () => {
    state.level = "silent";
    state.summaries.set("roland", [summary("roland", 1), summary("roland", 2)]);
    renderShell(["roland"]);
    await waitFor(() => expect(state.summaries.get("roland")).toHaveLength(1));
    await tick();
    await tick();
    expect(screen.queryByTestId("checkout-arrival-banner")).toBeNull();
  });

  it("is high-contrast and its pulse is motion-safe", () => {
    render(
      <WouterRouter hook={memoryLocation({ path: "/" }).hook}>
        <CheckoutArrivalBanner
          arrivals={[{ office: "roland", handoffId: "x", patientName: "Kiwi, Pat", createdAt: "", href: "/tc/checkout" }]}
          onAcknowledge={() => {}}
        />
      </WouterRouter>,
    );
    const banner = screen.getByTestId("checkout-arrival-banner");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.className).toContain("bg-amber-300");
    expect(banner.className).toContain("text-black");
    const pulse = banner.querySelector(".motion-safe\\:animate-ping");
    expect(pulse).not.toBeNull();
    expect(banner.querySelector(".animate-ping:not([class*='motion-safe'])")).toBeNull();
  });
});
