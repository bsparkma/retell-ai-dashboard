/**
 * The platform console's TC referrals switch (queue item 52).
 *
 *   - shows each real office with the layer that answered;
 *   - turning ON asks first; turning OFF is instant (the safe path is fast);
 *   - the switch shows what the SERVER answered, never the click;
 *   - an env break-glass forcing an office off is said out loud.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { TcReferralsSwitchState } from "@/lib/api";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const state = vi.hoisted(() => ({
  view: null as TcReferralsSwitchState | null,
  sets: [] as [string, boolean][],
}));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

function office(o: string, enabled: boolean, source: "env" | "db" | "default" = "db") {
  return {
    office: o,
    enabled,
    source,
    policyKnown: true,
    envValue: source === "env" ? false : null,
    settingKey: "tc_referrals_enabled",
    envVar: `TC_REFERRALS_ENABLED_${o.toUpperCase()}`,
    updatedAt: null,
    updatedBy: null,
  };
}

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: {
      ...real.api,
      getTcReferralsOffices: vi.fn(async () => state.view),
      setTcReferralsOfficeEnabled: vi.fn(async (o: string, enabled: boolean) => {
        state.sets.push([o, enabled]);
        state.view = {
          ...(state.view as TcReferralsSwitchState),
          offices: (state.view as TcReferralsSwitchState).offices.map((x) =>
            x.office === o ? { ...x, enabled, source: "db" as const } : x,
          ),
        };
        return state.view;
      }),
    },
  };
});

import { TcReferralsPanel } from "@/pages/platform/TcReferralsPanel";

beforeEach(() => {
  state.view = {
    offices: [office("roland", false, "default"), office("valley", true)],
    settingKey: "tc_referrals_enabled",
    controlPlaneError: null,
  };
  state.sets = [];
});
afterEach(() => cleanup());

describe("TC referrals switch panel", () => {
  it("lists the real offices (never the 'unknown' bucket) with the layer that answered", async () => {
    render(<TcReferralsPanel />);
    expect(await screen.findByTestId("tc-referrals-office-roland")).toBeTruthy();
    expect(screen.getByTestId("tc-referrals-office-valley")).toBeTruthy();
    expect(screen.queryByTestId("tc-referrals-office-unknown")).toBeNull();
    expect(screen.getByTestId("tc-referrals-office-roland").textContent).toMatch(/Default \(off\)/);
  });

  it("turning ON asks first, then shows the server's answer", async () => {
    render(<TcReferralsPanel />);
    fireEvent.click(await screen.findByTestId("tc-referrals-switch-roland"));
    expect(state.sets).toEqual([]);
    fireEvent.click(await screen.findByTestId("tc-referrals-confirm-on"));
    await waitFor(() => expect(state.sets).toEqual([["roland", true]]));
    await waitFor(() =>
      expect(screen.getByTestId("tc-referrals-switch-roland").getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("turning OFF is instant — no confirmation", async () => {
    render(<TcReferralsPanel />);
    fireEvent.click(await screen.findByTestId("tc-referrals-switch-valley"));
    await waitFor(() => expect(state.sets).toEqual([["valley", false]]));
    expect(screen.queryByTestId("tc-referrals-confirm-on")).toBeNull();
  });

  it("an env break-glass forcing an office off is said out loud", async () => {
    state.view = { ...(state.view as TcReferralsSwitchState), offices: [office("roland", false, "env")] };
    render(<TcReferralsPanel />);
    expect((await screen.findByTestId("tc-referrals-office-roland")).textContent).toMatch(
      /TC_REFERRALS_ENABLED_ROLAND=false is forcing this office OFF/,
    );
  });
});
