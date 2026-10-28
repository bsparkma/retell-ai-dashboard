/**
 * Screenshot DUMPS for the existing-treatment compact round.
 *
 * Same mechanism as hyg-checkout-shots.test.tsx: render into jsdom with the
 * synthetic 30-item plan, write the markup to `tests/.shots/hyg-*.html`, and
 * `scripts/shoot-hyg.mjs` photographs it in the app's real built CSS at the
 * iPad's 1180 width, light and dark. Each section is drawn at the visit's main
 * column width (768px beside the 340px tray).
 *
 *   hyg-etx-after-01-collapsed  30 items: the section closed, its header counts
 *   hyg-etx-after-02-default    opened: the default view, two iPad screens
 *   hyg-etx-after-03-row-open   #30's three procedures answered together
 *   hyg-etx-after-04-select     Select: three rows ticked, one answer to apply
 *   hyg-etx-after-05-hint       Treatment identified today, #30 picked
 *   hyg-etx-after-06-stale      the tray: a note staged before the answer changed
 *
 * NO NETWORK, NO BACKEND, NO PHI. Skipped unless HYG_SHOTS=1.
 */
import * as React from "react";
import { afterEach, describe, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { StagedWrite } from "@shared/hyg/contract";
import { ExistingTreatment } from "@/features/hyg/visit/ExistingTreatment";
import { StagedWritesTray } from "@/features/hyg/visit/StagedWritesTray";
import { TreatmentItems } from "@/features/hyg/visit/TreatmentItems";
import { thirtyItemPlan } from "./hyg-existing-tx-plan.fixture";

(globalThis as Record<string, unknown>).React = React;

const OUT = resolve(import.meta.dirname, ".shots");
function dump(name: string) {
  mkdirSync(dirname(resolve(OUT, `${name}.html`)), { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

/** The visit's main column at 1180: what the hygienist actually sees beside the tray. */
function Column({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-6">
      <div style={{ width: 768 }}>{children}</div>
    </div>
  );
}

function section() {
  return (
    <Column>
      <ExistingTreatment
        state={{
          status: "ready",
          data: {
            success: true,
            office: "roland",
            aptNum: 900001,
            frozen: false,
            readAt: "2026-09-08T13:00:00.000Z",
            items: thirtyItemPlan(),
          },
        }}
        saving={new Set()}
        rowErrors={{}}
        onStart={() => {}}
        onRetry={() => {}}
        onSave={() => {}}
        onSaveMany={() => {}}
        asOf="2026-09-08"
      />
    </Column>
  );
}

const SHOOT = process.env.HYG_SHOTS === "1";
afterEach(cleanup);

describe.skipIf(!SHOOT)("existing treatment compact screenshot dumps", () => {
  it("01 — 30 items, closed: the header counts them", () => {
    render(section());
    dump("hyg-etx-after-01-collapsed@1180x820");
  });

  it("02 — opened: the default view", () => {
    render(section());
    fireEvent.click(screen.getByTestId("hyg-existing-tx-collapse"));
    dump("hyg-etx-after-02-default@1180x820");
    dump("hyg-etx-after-02-default-two-screens@1180x1640");
  });

  it("03 — #30 open, answered together", () => {
    render(section());
    fireEvent.click(screen.getByTestId("hyg-existing-tx-collapse"));
    fireEvent.click(screen.getByTestId("hyg-existing-tx-toggle-30"));
    dump("hyg-etx-after-03-row-open@1180x1100");
  });

  it("04 — Select: rows ticked, one answer to apply", () => {
    render(section());
    fireEvent.click(screen.getByTestId("hyg-existing-tx-collapse"));
    fireEvent.click(screen.getByTestId("hyg-existing-tx-select-mode"));
    for (const k of ["8", "9", "12"]) fireEvent.click(screen.getByTestId(`hyg-existing-tx-toggle-${k}`));
    fireEvent.click(screen.getByTestId("hyg-existing-tx-bulk-patient-cost_questions"));
    dump("hyg-etx-after-04-select@1180x1640");
  });

  it("05 — Treatment identified today, #30 picked", () => {
    render(
      <Column>
        <TreatmentItems items={[]} busy={false} onAdd={() => {}} onPatch={() => {}} onRemove={() => {}} plannedInOd={thirtyItemPlan()} />
      </Column>,
    );
    fireEvent.click(screen.getByTestId("hyg-tooth-30"));
    dump("hyg-etx-after-05-hint@1180x820");
  });

  it("06 — the tray: the note is out of date", () => {
    const note: StagedWrite = {
      id: "staged-note",
      kind: "note",
      state: "Staged",
      title: "Visit note",
      summary: "The note for 8 Sep 2026",
      preview: [
        "Treatment identified today (1):",
        "  #3 - Crown - O - Urgent - Restorative - Dx D - proposed",
        "",
        "Existing treatment reviewed (1):",
        "  #30 D2740 Crown - porcelain/ceramic -- patient has cost questions.",
        "",
        "Sample Hygienist, RDH",
      ],
      previewFingerprint: "fp-note",
      errorMessage: null,
      writtenRef: null,
      stagedBy: "hygienist@carein.ai",
      stagedAt: "2026-09-08T13:10:00.000Z",
      sentBy: null,
      sentAt: null,
      updatedAt: "2026-09-08T13:10:00.000Z",
      existingTxStale: true,
    };
    render(
      <div className="p-6">
        <div style={{ width: 340 }}>
          <StagedWritesTray
            staged={[note]}
            handoffCategory="Restorative"
            patientName="this patient"
            itemCount={1}
            existingNotDiscussed={0}
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
        </div>
      </div>,
    );
    dump("hyg-etx-after-06-stale@1180x1100");
  });
});
