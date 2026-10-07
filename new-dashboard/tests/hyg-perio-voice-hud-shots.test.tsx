/**
 * Screenshot DUMPS for the perio voice HUD (item 36). The harness below is item
 * 35's (hyg-perio-voice-shots.test.tsx), copied so that file stays untouched.
 *
 *   hyg-perio-voice-hud-01-listening   ARMED, nothing said yet
 *   hyg-perio-voice-hud-02-accepted    "three two three bleeding" — charted, moved on
 *   hyg-perio-voice-hud-03-rejected    "1010" refused — amber, nothing charted
 *   hyg-perio-voice-hud-04-lingual     on the lingual pass — the rows have swapped
 *
 * -- item 35's header --
 * Screenshot DUMPS for perio voice entry (item 35).
 *
 * Same machinery as `hyg-perio-shots.test.tsx`: render into jsdom with fixture
 * data from THIS file, write the markup to `tests/.shots/hyg-perio-voice-*.html`,
 * and let `scripts/shoot-hyg.mjs` — unchanged — photograph it at 1180 wide,
 * light and dark.
 *
 *   hyg-perio-voice-01-off        the sheet with voice available, DISARMED
 *   hyg-perio-voice-02-armed      ARMED, after "three two three bleeding"
 *   hyg-perio-voice-03-rejected   ARMED, "1010" refused — nothing charted
 *   hyg-perio-voice-04-budget     today's voice minutes spent, said honestly
 *
 * NO NETWORK, NO BACKEND, NO PHI. The one name is synthetic; 12827 is the
 * designated roland fixture. Skipped unless HYG_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { type HygAppointment } from "@shared/hyg/contract";
import { type PerioChart } from "@shared/hyg/perio";

(globalThis as Record<string, unknown>).React = React;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    fetchCurrentUser: vi.fn(async () => ({
      name: "Hyg User",
      email: "hygienist@carein.ai",
      tenantId: "tenant-1",
      tenant: { slug: "carein", displayName: "CareIN Dental", modules: ["hyg"] },
      role: "hygiene" as const,
      isSuperAdmin: false,
      permissions: ["hyg.read", "hyg.write"],
      homeOffice: null,
      voiceLab: false,
      hygVoice: true,
    })),
  };
});

const fixtures = vi.hoisted(() => ({ mintRefusal: false }));

const APPOINTMENT: HygAppointment = {
  aptNum: 900001,
  patNum: 12827,
  identity: "resolved",
  patientName: "Test, Voice",
  start: "2026-10-07 08:00:00",
  lengthMin: 60,
  opNum: 2,
  opName: "Hygiene 1",
  isHygiene: true,
  opIsHygiene: true,
  provNum: 1,
  provHyg: 7,
  providerName: "HYG1",
  apptTypeLabel: "Perio Maint",
  confirmedStatus: "Confirmed",
  aptStatus: "Scheduled",
  isNewPatient: false,
  flags: {
    premed: null,
    medicalAlerts: null,
    allergies: null,
    lastPerioDate: null,
    xraysDue: null,
    examNeeded: null,
    openTcCase: null,
  },
};

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  const perio = await import("@shared/hyg/perio");
  let chart: PerioChart = perio.emptyPerioChart();
  const response = () => ({
    success: true as const,
    office: "roland" as const,
    aptNum: 900001,
    visitStarted: true,
    chart,
    stagedWrite: null,
    counts: perio.countPerioChart(chart),
    chartStored: true,
  });
  return {
    ...real,
    fetchPerio: vi.fn(async () => {
      chart = perio.emptyPerioChart();
      return response();
    }),
    fetchPerioPrior: vi.fn(async () => ({
      success: true,
      office: "roland",
      aptNum: 900001,
      date: "2026-10-07",
      appointment: APPOINTMENT,
      prior: { status: "none" },
      drift: { status: "not_applicable" },
      preSkip: { status: "unavailable" },
    })),
    fetchPerioSend: vi.fn(async () => ({
      success: true,
      office: "roland",
      aptNum: 900001,
      stagedWrite: null,
      send: null,
      live: null,
      paused: null,
    })),
    openVisit: vi.fn(async () => ({}) as never),
    savePerio: vi.fn(async (_o: unknown, _a: unknown, next: PerioChart) => {
      chart = perio.normalizePerioChart(next);
      return response();
    }),
    mintHygVoiceToken: vi.fn(async () => {
      if (fixtures.mintRefusal) {
        throw new real.HygApiError(
          "Today's perio voice budget is used up (60 of 60 minutes reserved). It resets at midnight Central. Keep charting by keyboard; nothing already charted is affected.",
          429,
          "HYG_VOICE_BUDGET_EXHAUSTED",
        );
      }
      return { success: true, token: "tok", region: "southcentralus" };
    }),
  };
});

const speech = vi.hoisted(() => ({
  handlers: null as null | { onPartial: (r: unknown) => void; onFinal: (r: { text: string }) => void },
}));
vi.mock("@/lib/speech/speechSession", () => ({
  startSpeechSession: vi.fn(async (_t: string, _r: string, _p: readonly string[], handlers: typeof speech.handlers) => {
    speech.handlers = handlers;
    return { streamStartMs: 0, stop: async () => {} };
  }),
}));

import HygPerio from "@/pages/hyg/HygPerio";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthProvider } from "@/contexts/AuthContext";

const OUT = resolve(import.meta.dirname, ".shots");

function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

function renderPerio() {
  const memory = memoryLocation({ path: "/hyg/visit/900001/perio?office=roland&date=2026-10-07" });
  render(
    <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
      <ThemeProvider defaultTheme="light" switchable>
        <AuthProvider>
          <Route path="/hyg/visit/:aptNum/perio" component={HygPerio} />
        </AuthProvider>
      </ThemeProvider>
    </WouterRouter>,
  );
}

async function arm() {
  fireEvent.click(await screen.findByTestId("hyg-perio-voice-toggle"));
  await waitFor(() => {
    if (screen.getByTestId("hyg-perio-voice-state").dataset.armed !== "true") throw new Error("not armed");
  });
}

function say(text: string) {
  act(() => speech.handlers?.onFinal({ text }));
}

const SHOOT = process.env.HYG_SHOTS === "1";

beforeEach(() => {
  fixtures.mintRefusal = false;
  speech.handlers = null;
  localStorage.clear();
});
afterEach(cleanup);

describe.skipIf(!SHOOT)("perio voice HUD screenshot dumps", () => {
  it("01 - ARMED, listening", async () => {
    renderPerio();
    await arm();
    dump("hyg-perio-voice-hud-01-listening@1180x900");
  });

  it("02 - accepted: three two three bleeding", async () => {
    renderPerio();
    await arm();
    say("three two three bleeding");
    say("four three");
    dump("hyg-perio-voice-hud-02-accepted@1180x900");
  });

  it("03 - rejected: 1010, nothing charted", async () => {
    renderPerio();
    await arm();
    say("three two three bleeding");
    say("1010");
    dump("hyg-perio-voice-hud-03-rejected@1180x900");
  });

  it("04 - the lingual pass: rows swapped", async () => {
    renderPerio();
    await arm();
    say("three two three bleeding three three four two three three");
    say("go back to tooth three ML");
    say("four three");
    dump("hyg-perio-voice-hud-04-lingual@1180x900");
  });
});
