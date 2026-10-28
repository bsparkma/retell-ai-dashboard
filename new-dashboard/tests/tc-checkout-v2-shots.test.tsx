/**
 * Screenshot DUMPS for checkout v2.
 *
 *   pnpm exec vite build
 *   TC_SHOTS=1 pnpm exec vitest run tests/tc-checkout-v2-shots.test.tsx
 *   node scripts/shoot-tc-checkout.mjs
 *
 *   tccheckout-v2-01-panel          the TC checkout sidebar: Collect payment first,
 *                                   the hygienist's notes, priority vs category,
 *                                   the records
 *   tccheckout-v2-02-preview        the hygiene tray's staged handoff: the words TC
 *                                   receives, and the medical-history reminder
 *   tccheckout-v2-03-preview-stale  the same handoff after the collect list changed
 *
 * NO NETWORK, NO BACKEND, NO PHI. Synthetic names; roland fixture PatNum.
 * Skipped unless TC_SHOTS=1.
 */
import * as React from "react";
import { afterEach, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { StagedWrite } from "@shared/hyg/contract";
import type { TcCheckoutHandoff } from "@shared/tc/checkout";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const HANDOFF: TcCheckoutHandoff = {
  handoffId: "5d2a7e10-0000-4000-8000-0000000000d1",
  officeId: "roland",
  odPatientId: 12827,
  patientName: "Test 2, Stedi",
  provider: "DOC1",
  providerSeen: "HYG1",
  operatory: "Hyg 1",
  visitDate: "2026-09-08",
  snapshot: {
    procedures: [
      { teeth: [30], code: "Crown", category: "Restorative", priority: "urgent", status: "proposed", surfaces: [], scheduleNext: true, note: "" },
      { teeth: [19], code: "Comp", category: "Restorative", priority: "preventative", status: "proposed", surfaces: ["O"], scheduleNext: false, note: "" },
    ],
    priority: "urgent",
    nextVisit: { type: "Prophy", intervalMonths: 6, lengthMin: 60, withDoctor: true, rtc: "6 mo recall" },
    notesPending: false,
    frontDeskNote: "Prefers afternoon appointments.",
    financialNote: "Asked for a written estimate for the crown.",
    collectAtCheckout: ["Sealant", "Fl2 toothpaste", "Floss picks"],
    records: [
      { record: "Pre-op PA", status: "taken_today" },
      { record: "Missing teeth note", status: "needed" },
      { record: "New/replacement noted", status: "needed" },
      { record: "Pre-op photo (anterior only)", status: "on_file" },
    ],
    existingTx: [
      {
        procNum: 5001, code: "D2391", description: "Composite", tooth: "14", surface: "O", dateTp: "2026-06-20",
        priorityName: null, scheduled: false, clinical: "no_change", patient: "cost_questions", waitTimeframe: null, note: null,
      },
    ],
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

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/features/tc/checkout/checkoutApi", () => ({
  getCheckoutHandoff: vi.fn(async () => HANDOFF),
  claimCheckout: vi.fn(),
  recordCheckoutOutcome: vi.fn(),
}));

import { CheckoutSidebar } from "@/features/tc/checkout/CheckoutSidebar";
import { StagedWritesTray } from "@/features/hyg/visit/StagedWritesTray";

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

/** The sample preview, exactly as the composer writes it for this visit (checkoutV2.test.js). */
const PREVIEW = [
  "Category: Restorative",
  "Treatment (2):",
  "  #30 - Crown - Urgent - Restorative - Dx D - proposed",
  "  #19 - Comp - O - Preventative - Restorative - Dx D - proposed",
  "Existing treatment (1):",
  "  #14 O D2391 Composite - planned 2026-06-20",
  "    Clinical: No change",
  "    Patient: Cost questions",
  "Records for the planned treatment:",
  "  Pre-op PA -- Taken today",
  "  Missing teeth note -- Needed",
  "  New/replacement noted -- Needed",
  "  Pre-op photo (anterior only) -- On file",
  "Collect at checkout:",
  "  Sealant",
  "  Fl2 toothpaste",
  "  Floss picks",
];

function handoffWrite(over: Partial<StagedWrite> = {}): StagedWrite {
  return {
    id: "staged-tc-handoff",
    kind: "tc-handoff",
    state: "Staged",
    title: "Hygiene handoff",
    summary: "2 items to the treatment coordinator (Restorative)",
    preview: PREVIEW,
    previewFingerprint: "fp-tc-handoff",
    errorMessage: null,
    writtenRef: null,
    stagedBy: "hygienist@carein.ai",
    stagedAt: "2026-09-08T14:40:00.000Z",
    sentBy: null,
    sentAt: null,
    updatedAt: "2026-09-08T14:40:00.000Z",
    existingTxStale: false,
    ...over,
  };
}

function tray(staged: StagedWrite[]) {
  render(
    <div style={{ width: 340, padding: 16 }}>
      <StagedWritesTray
        staged={staged}
        handoffCategory="Restorative"
        patientName="Test 2, Stedi"
        itemCount={2}
        collectCount={3}
        medicalHistoryRecorded={false}
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
      />
    </div>,
  );
}

const SHOTS = process.env.TC_SHOTS === "1";

describe.skipIf(!SHOTS)("checkout v2 shots", () => {
  afterEach(() => cleanup());

  it("tccheckout-v2-01-panel", async () => {
    const memory = memoryLocation({ path: "/tc/checkout" });
    render(
      <WouterRouter hook={memory.hook} searchHook={memory.searchHook}>
        <CheckoutSidebar office="roland" handoffId={HANDOFF.handoffId} onClose={() => {}} />
      </WouterRouter>,
    );
    await screen.findByTestId("checkout-collect");
    dump("tccheckout-v2-01-panel@1280x1700");
  });

  it("tccheckout-v2-02-preview", async () => {
    tray([handoffWrite()]);
    dump("tccheckout-v2-02-preview@1280x1300");
    // And the confirm, with the medical-history reminder.
    fireEvent.click(screen.getByTestId("hyg-send-all"));
    await screen.findByTestId("hyg-confirm-medical-history");
    dump("tccheckout-v2-04-confirm-reminder@1280x1300");
  });

  it("tccheckout-v2-03-preview-stale", () => {
    tray([handoffWrite({ existingTxStale: true, staleReason: "handoff" })]);
    dump("tccheckout-v2-03-preview-stale@1280x1300");
  });
});
