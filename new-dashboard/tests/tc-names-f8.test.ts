/**
 * Pre-IA fix F8 (docs/reports/feature-tc-incoming-work-ia.md §4 W1-W3 and
 * D8, §7, §8 decision 5): one name per thing.
 *
 *   "TC Inbox"          the async queue (was also "Hygiene Inbox", "TC inbox")
 *   "Checkout"          everywhere, including the hygiene side's "Alert
 *                       checkout" (was also "front desk", "checkout handoff")
 *   "Hygiene handoff"   P1 (the visit's staged write) and P8 (the Intake form)
 *                       (was "Treatment handoff", "Hygiene Handoff", "Intake")
 *   "New from hygiene"  the hygiene_review status (was "Hygiene Review",
 *                       "New from Hygiene")
 *
 * Plus the two stale copies: the Dashboard's "Voice handoffs — coming soon"
 * strip, and the Platform "TC referrals" switch that said it only showed a
 * Settings section.
 *
 * Source reads, like rcm-shell's: the strings are what is being pinned.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { CASE_STATUSES } from "@/features/tc/status";
import { DEFAULT_STAGES } from "@/features/tc/library/defaults";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("F8: one name per thing", () => {
  it('the hygiene_review status reads "New from hygiene", in the badge and the default stage', () => {
    expect(CASE_STATUSES.hygiene_review.label).toBe("New from hygiene");
    expect(DEFAULT_STAGES.find((s) => s.key === "hygiene_review")?.label).toBe("New from hygiene");
  });

  it('the async queue is "TC Inbox" wherever it is named', () => {
    for (const file of [
      "client/src/pages/tc/TcHygieneInbox.tsx",
      // RULING (CO-2): the Intake page and its form are deleted, so they leave
      // this list; the two files that remain still carry the one name.
      "client/src/components/DashboardLayout.tsx",
    ]) {
      const s = src(file);
      expect(s, file).not.toMatch(/Hygiene Inbox|TC inbox/);
    }
    expect(src("client/src/pages/tc/TcHygieneInbox.tsx")).toContain('title="TC Inbox"');
    expect(src("client/src/components/DashboardLayout.tsx")).toContain('{ path: "/tc/inbox", label: "TC Inbox", icon: Inbox }');
  });

  // RULING (CO-2): the TC app's "Hygiene handoff" nav item and Intake page are
  // removed (the hygiene app replaces them), so the name is pinned where it
  // still lives — the visit tray and its server title — and the old nav item
  // is pinned as gone.
  it('the handoff is "Hygiene handoff": the visit tray and its server title (CO-2: no TC nav item)', () => {
    expect(src("client/src/components/DashboardLayout.tsx")).not.toContain('label: "Hygiene handoff"');
    expect(src("client/src/features/hyg/visit/StagedWritesTray.tsx")).toContain('"tc-handoff": "Hygiene handoff"');
    expect(src("../backend/services/hyg/stagedWriteComposer.js")).toContain("title: 'Hygiene handoff'");
    for (const file of [
      "client/src/features/hyg/visit/StagedWritesTray.tsx",
      "../backend/services/hyg/stagedWriteComposer.js",
    ]) {
      expect(src(file), file).not.toContain("Treatment handoff");
    }
  });

  it('the hygienist sends to "Checkout", not "the front desk"', () => {
    const alert = src("client/src/features/hyg/visit/CheckoutAlert.tsx");
    expect(alert).toContain("Alert checkout");
    expect(alert).toContain("Tell Checkout this patient is on the way");
    expect(alert).toContain("Send to Checkout again");
    expect(alert).not.toMatch(/>[^<]*front desk/);
    expect(src("client/src/pages/hyg/HygVisit.tsx")).toContain("Checkout still did not get your final notes");
  });

  it('the Platform switch is "TC Checkout", not "checkout handoff"', () => {
    const panel = src("client/src/pages/platform/TcCheckoutPanel.tsx");
    expect(panel).toContain("TC Checkout");
    expect(panel).not.toMatch(/TC checkout handoff|Checkout handoff for/);
  });
});

describe("F8: stale copy", () => {
  it("the Dashboard strip no longer promises a handoff that already shipped", () => {
    const strip = src("client/src/features/tc/handoffs/CareInHandoffsStrip.tsx");
    expect(strip).not.toContain("coming soon\n");
    expect(strip).not.toContain("Voice handoffs — coming soon");
    expect(strip).toContain("Send to TC");
  });

  it("the Platform referrals switch names what it gates, not only a Settings section", () => {
    const panel = src("client/src/pages/platform/TcReferralsPanel.tsx");
    expect(panel).not.toContain("TC Settings shows the Referrals section");
    expect(panel).not.toContain("Nothing is sent yet.");
    for (const surface of ["Referrals hub", "panel on a case", "hygiene visit", "a call", "checkout", "Awaiting sign-off"]) {
      expect(panel, surface).toContain(surface);
    }
  });
});
