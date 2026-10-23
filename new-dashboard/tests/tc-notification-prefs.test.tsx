/**
 * In-app notification preferences, on the client (queue item 51).
 *
 *   - Settings → Notifications shows what you get and why; your choice saves
 *     through the api ("Use the office default" clears it); the office default
 *     is editable only when the server says you may.
 *   - The checkout arrival obeys the level: silent ⇒ badge only, no banner, no
 *     sound; banner ⇒ banner; sound_banner ⇒ banner + chime; a preference that
 *     cannot be read ⇒ banner (never lost).
 *
 * NO NETWORK, NO BACKEND, NO PHI.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import type { TcCheckoutSummary } from "@shared/tc/checkout";
import type { TcNotificationLevel, TcNotificationPrefsResponse } from "@shared/tc/notifications";

(globalThis as Record<string, unknown>).React = React;

const { toastMock, chime, state } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  chime: vi.fn(() => true),
  state: {
    prefs: null as TcNotificationPrefsResponse | null,
    prefsFail: false,
    sets: [] as unknown[][],
    summaries: [] as TcCheckoutSummary[],
  },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/notifications/chime", () => ({ playChime: chime, resetChimeForTests: vi.fn() }));

function prefs(level: TcNotificationLevel, over: Partial<TcNotificationPrefsResponse> = {}): TcNotificationPrefsResponse {
  return {
    success: true,
    office: "roland",
    canEditOffice: false,
    events: [
      { event: "checkout_handoff", level, source: "user", mine: level, officeDefault: null },
      { event: "referral_signoff", level: "banner", source: "default", mine: null, officeDefault: null },
    ],
    ...over,
  };
}

vi.mock("@/features/tc/notifications/notificationsApi", () => ({
  getNotificationPrefs: vi.fn(async () => {
    if (state.prefsFail) throw new Error("down");
    return state.prefs;
  }),
  setMyNotificationLevel: vi.fn(async (office: string, event: string, level: TcNotificationLevel | null) => {
    state.sets.push(["mine", office, event, level]);
    const base = state.prefs as TcNotificationPrefsResponse;
    state.prefs = {
      ...base,
      events: base.events.map((e) =>
        e.event === event
          ? { ...e, mine: level, level: level ?? e.officeDefault ?? "banner", source: level ? "user" : e.officeDefault ? "office" : "default" }
          : e,
      ),
    };
    return state.prefs;
  }),
  setOfficeNotificationLevel: vi.fn(async (office: string, event: string, level: TcNotificationLevel | null) => {
    state.sets.push(["office", office, event, level]);
    return state.prefs;
  }),
}));

vi.mock("@/features/tc/checkout/checkoutApi", () => ({
  getCheckoutSummary: vi.fn(async () => {
    const next = state.summaries.shift();
    if (!next) throw new Error("no summary scripted");
    return next;
  }),
}));

import { NotificationsSection } from "@/features/tc/settings/NotificationsSection";
import { useCheckoutWatch } from "@/features/tc/checkout/useCheckoutWatch";

beforeEach(() => {
  state.prefs = prefs("banner");
  state.prefsFail = false;
  state.sets = [];
  state.summaries = [];
  toastMock.mockClear();
  toastMock.success.mockClear();
  chime.mockClear();
});
afterEach(() => cleanup());

describe("Settings → Notifications", () => {
  it("shows what you get and why", async () => {
    state.prefs = prefs("sound_banner");
    render(<NotificationsSection office="roland" />);
    expect((await screen.findByTestId("tc-notify-checkout_handoff-effective")).textContent).toBe(
      "You get: Sound + banner (your choice)",
    );
    expect(screen.getByTestId("tc-notify-referral_signoff-effective").textContent).toBe(
      "You get: Banner (built-in default)",
    );
  });

  it("your choice saves; 'Use the office default' clears it", async () => {
    render(<NotificationsSection office="roland" />);
    const mine = (await screen.findByTestId("tc-notify-checkout_handoff-mine")) as HTMLSelectElement;
    fireEvent.change(mine, { target: { value: "silent" } });
    await waitFor(() => expect(state.sets).toEqual([["mine", "roland", "checkout_handoff", "silent"]]));
    await waitFor(() =>
      expect(screen.getByTestId("tc-notify-checkout_handoff-effective").textContent).toMatch(/Badge only/),
    );
    fireEvent.change(screen.getByTestId("tc-notify-checkout_handoff-mine"), { target: { value: "__office__" } });
    await waitFor(() => expect(state.sets.at(-1)).toEqual(["mine", "roland", "checkout_handoff", null]));
  });

  it("choosing sound plays the chime once, so you hear what you picked", async () => {
    render(<NotificationsSection office="roland" />);
    fireEvent.change(await screen.findByTestId("tc-notify-checkout_handoff-mine"), { target: { value: "sound_banner" } });
    await waitFor(() => expect(chime).toHaveBeenCalledTimes(1));
  });

  it("the office default is read-only unless the server says you may edit it", async () => {
    render(<NotificationsSection office="roland" />);
    expect(((await screen.findByTestId("tc-notify-checkout_handoff-office")) as HTMLSelectElement).disabled).toBe(true);
    cleanup();
    state.prefs = prefs("banner", { canEditOffice: true });
    render(<NotificationsSection office="roland" />);
    const office = (await screen.findByTestId("tc-notify-checkout_handoff-office")) as HTMLSelectElement;
    expect(office.disabled).toBe(false);
    fireEvent.change(office, { target: { value: "silent" } });
    await waitFor(() => expect(state.sets).toEqual([["office", "roland", "checkout_handoff", "silent"]]));
  });
});

// ── the arrival obeys the preference ────────────────────────────────────────

function Probe() {
  const w = useCheckoutWatch(["roland"]);
  return <div data-testid="probe">{`${w.enabled}:${w.waiting}`}</div>;
}

function summary(waiting: number, n: number | null): TcCheckoutSummary {
  return {
    success: true,
    office: "roland",
    enabled: true,
    today: "2026-09-08",
    waiting,
    newest:
      n === null
        ? null
        : { handoffId: `5d2a7e10-0000-4000-8000-00000000000${n}`, patientName: `Pat ${n}`, createdAt: `2026-09-08T1${n}:00:00.000Z` },
  };
}

/** First tick records the backlog; the second brings a new arrival. */
async function arrive() {
  state.summaries = [summary(1, 1), summary(2, 2)];
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const memory = memoryLocation({ path: "/tc" });
    render(
      <WouterRouter hook={memory.hook}>
        <Probe />
      </WouterRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("true:1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("true:2"));
  } finally {
    vi.useRealTimers();
  }
}

describe("the checkout arrival obeys the preference", () => {
  it("silent: the badge count updates, but no banner and no sound", async () => {
    state.prefs = prefs("silent");
    await arrive();
    expect(toastMock).not.toHaveBeenCalled();
    expect(chime).not.toHaveBeenCalled();
  });

  it("banner: a banner, no sound", async () => {
    state.prefs = prefs("banner");
    await arrive();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(chime).not.toHaveBeenCalled();
  });

  it("sound + banner: a banner AND the chime", async () => {
    state.prefs = prefs("sound_banner");
    await arrive();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(chime).toHaveBeenCalledTimes(1);
  });

  it("a preference that cannot be read falls back to a banner — the alert is never lost", async () => {
    state.prefsFail = true;
    await arrive();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(chime).not.toHaveBeenCalled();
  });
});
