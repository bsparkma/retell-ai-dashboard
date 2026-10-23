/**
 * The platform console's referral PATIENT email switch (R5b), beside the
 * referral email switch.
 *
 *   - its own endpoint and setting, default off, per office;
 *   - turning ON asks first; turning OFF is instant;
 *   - it says it gates ONLY the patient's email (the letter keeps its switch);
 *   - an env break-glass forcing an office off is said out loud;
 *   - the Platform page draws it in the TC referrals tab.
 */
import * as React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  letterCalls: 0,
}));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

function office(o: string, enabled: boolean, source: "env" | "db" | "default" = "db") {
  return {
    office: o,
    enabled,
    source,
    policyKnown: true,
    envValue: source === "env" ? false : null,
    settingKey: "tc_referral_patient_email_enabled",
    envVar: `TC_REFERRAL_PATIENT_EMAIL_ENABLED_${o.toUpperCase()}`,
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
      getTcReferralPatientEmailOffices: vi.fn(async () => state.view),
      setTcReferralPatientEmailOfficeEnabled: vi.fn(async (o: string, enabled: boolean) => {
        state.sets.push([o, enabled]);
        state.view = {
          ...(state.view as TcReferralsSwitchState),
          offices: (state.view as TcReferralsSwitchState).offices.map((x) =>
            x.office === o ? { ...x, enabled, source: "db" as const } : x,
          ),
        };
        return state.view;
      }),
      setTcReferralEmailOfficeEnabled: vi.fn(async () => {
        state.letterCalls += 1;
        return state.view;
      }),
    },
  };
});

import { TcReferralPatientEmailPanel } from "@/pages/platform/TcReferralsPanel";

beforeEach(() => {
  state.view = {
    offices: [office("roland", false, "default"), office("valley", true)],
    settingKey: "tc_referral_patient_email_enabled",
    controlPlaneError: null,
  };
  state.sets = [];
  state.letterCalls = 0;
});
afterEach(() => cleanup());

describe("TC referral patient email switch panel", () => {
  it("lists the real offices with the layer that answered, and says it gates only the patient's email", async () => {
    render(<TcReferralPatientEmailPanel />);
    expect((await screen.findByTestId("tc-referral-patient-email-office-roland")).textContent).toMatch(/Default \(off\)/);
    expect(screen.getByTestId("tc-referral-patient-email-office-valley")).toBeTruthy();
    expect(screen.queryByTestId("tc-referral-patient-email-office-unknown")).toBeNull();
    const panel = screen.getByTestId("tc-referral-patient-email-panel").textContent ?? "";
    expect(panel).toMatch(/Only that email/);
    expect(panel).toMatch(/specialist's letter and its buttons follow the referral email switch/);
  });

  it("turning ON asks first, then shows the server's answer — and never touches the letter's switch", async () => {
    render(<TcReferralPatientEmailPanel />);
    fireEvent.click(await screen.findByTestId("tc-referral-patient-email-switch-roland"));
    expect(state.sets).toEqual([]);
    fireEvent.click(await screen.findByTestId("tc-referral-patient-email-confirm-on"));
    await waitFor(() => expect(state.sets).toEqual([["roland", true]]));
    await waitFor(() =>
      expect(screen.getByTestId("tc-referral-patient-email-switch-roland").getAttribute("aria-checked")).toBe("true"),
    );
    expect(state.letterCalls).toBe(0);
  });

  it("turning OFF is instant — no confirmation", async () => {
    render(<TcReferralPatientEmailPanel />);
    fireEvent.click(await screen.findByTestId("tc-referral-patient-email-switch-valley"));
    await waitFor(() => expect(state.sets).toEqual([["valley", false]]));
    expect(screen.queryByTestId("tc-referral-patient-email-confirm-on")).toBeNull();
  });

  it("an env break-glass forcing an office off is said out loud", async () => {
    state.view = { ...(state.view as TcReferralsSwitchState), offices: [office("roland", false, "env")] };
    render(<TcReferralPatientEmailPanel />);
    expect((await screen.findByTestId("tc-referral-patient-email-office-roland")).textContent).toMatch(
      /TC_REFERRAL_PATIENT_EMAIL_ENABLED_ROLAND=false is forcing this office OFF/,
    );
  });

  it("the Platform page draws it in the TC referrals tab, right after the referral email switch", () => {
    const src = readFileSync(resolve(__dirname, "../client/src/pages/Platform.tsx"), "utf8");
    const email = src.indexOf("<TcReferralEmailPanel />");
    const patient = src.indexOf("<TcReferralPatientEmailPanel />");
    expect(email).toBeGreaterThan(-1);
    expect(patient).toBeGreaterThan(email);
    expect(src.slice(email, patient)).not.toMatch(/<\/TabsContent>/);
  });
});
