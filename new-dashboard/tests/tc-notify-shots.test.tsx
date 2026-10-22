/**
 * Screenshot DUMP for Settings → Notifications (queue item 51), photographed
 * by the checkout shooter (same prefix family):
 *
 *   pnpm exec vite build
 *   TC_SHOTS=1 pnpm exec vitest run tests/tc-notify-shots.test.tsx
 *   node scripts/shoot-tc-checkout.mjs
 *
 *   tccheckout-05-notifications   the section, as an admin (both columns live)
 *
 * NO NETWORK, NO BACKEND, NO PHI. Skipped unless TC_SHOTS=1.
 */
import * as React from "react";
import { afterEach, describe, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

(globalThis as Record<string, unknown>).React = React;

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/features/tc/notifications/notificationsApi", () => ({
  getNotificationPrefs: vi.fn(async () => ({
    success: true,
    office: "roland",
    canEditOffice: true,
    events: [
      { event: "checkout_handoff", level: "sound_banner", source: "user", mine: "sound_banner", officeDefault: "banner" },
      { event: "referral_signoff", level: "silent", source: "office", mine: null, officeDefault: "silent" },
    ],
  })),
  setMyNotificationLevel: vi.fn(),
  setOfficeNotificationLevel: vi.fn(),
}));

import { NotificationsSection } from "@/features/tc/settings/NotificationsSection";

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  // A controlled <select>'s value is a DOM property React sets, which
  // innerHTML does not serialize — the photo would show each first option.
  // Stamp `selected` so the dump shows what a browser shows.
  document.querySelectorAll("select").forEach((s) => {
    s.querySelectorAll("option").forEach((o) => {
      if (o.value === s.value) o.setAttribute("selected", "");
      else o.removeAttribute("selected");
    });
  });
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

const SHOOT = process.env.TC_SHOTS === "1";
afterEach(cleanup);

describe.skipIf(!SHOOT)("tc notifications screenshot dump", () => {
  it("05 — Settings → Notifications", async () => {
    render(
      <div className="p-6 max-w-4xl">
        <NotificationsSection office="roland" />
      </div>,
    );
    await screen.findByTestId("tc-notifications-section");
    dump("tccheckout-05-notifications@1280x600");
  });
});
