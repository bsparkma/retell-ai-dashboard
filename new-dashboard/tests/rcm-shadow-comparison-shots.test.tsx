/**
 * Screenshot DUMPS for Stage C-2 — the shadow-mode comparison.
 *
 * Same shape and same reasons as `rcm-stage-c-shots.test.tsx`: renders the
 * screen into jsdom with fixture data that lives in this file and writes the
 * markup to `tests/.shots/c2-*.html`, which `scripts/shoot-shadow-comparison.mjs`
 * wraps in the app's real built CSS and photographs at 1280, light and dark.
 *
 * Three shots, and they are the three states a reviewer has to see:
 *
 *   c2-01-ask     the question, unanswered — one click either way
 *   c2-02-form    "something was off", open, inline, over the check
 *   c2-03-tally   an answer already given, with the running tally under it
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every payer, patient, check number and dollar
 * figure below is synthetic.
 *
 * Skipped unless RCM_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import CheckComparison from "@/components/rcm/CheckComparison";

(globalThis as Record<string, unknown>).React = React;

const OUT = resolve(import.meta.dirname, ".shots");

const TALLY = {
  office: "roland",
  compared: 18,
  same: 17,
  differed: 1,
  matchedRun: 6,
  latestDifference: { reason: "payment_amount", at: "2026-08-22T18:00:00.000Z" },
};

vi.mock("@/features/rcm/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/rcm/api")>();
  return {
    ...real,
    getComparisonTally: vi.fn(async () => TALLY),
    recordComparison: vi.fn(async () => ({
      batchId: "b-1",
      verdict: "same",
      reason: null,
      revision: 1,
      recorded: true,
    })),
  };
});

function dump(name: string) {
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, document.body.innerHTML, "utf8");
}

/** A frame the width of the check screen's content column, so the panel sits as it does live. */
function shoot(node: React.ReactElement) {
  return render(<div className="mx-auto max-w-5xl p-4">{node}</div>);
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

const enabled = process.env.RCM_SHOTS === "1";

describe.skipIf(!enabled)("Stage C-2 screenshots", () => {
  it("c2-01-ask — the question, unanswered", async () => {
    shoot(
      <CheckComparison
        office="roland"
        batchId="b-1"
        verdict={null}
        reason={null}
        note={null}
        answeredAt={null}
        answeredBy={null}
        revision={0}
      />,
    );
    await screen.findByTestId("comparison-tally");
    dump("c2-01-ask");
  });

  it("c2-02-form — “something was off”, inline", async () => {
    shoot(
      <CheckComparison
        office="roland"
        batchId="b-1"
        verdict={null}
        reason={null}
        note={null}
        answeredAt={null}
        answeredBy={null}
        revision={0}
      />,
    );
    fireEvent.click(await screen.findByTestId("comparison-differed"));
    fireEvent.click(await screen.findByTestId("comparison-reason-payment_amount"));
    fireEvent.change(screen.getByTestId("comparison-note-input"), {
      target: { value: "App had $150.00 on the crown; the carrier paid $142.30." },
    });
    /*
     * `innerHTML` SERIALISES ATTRIBUTES, AND REACT SETS PROPERTIES.
     *
     * A controlled radio's selected state lives on the DOM `checked` PROPERTY;
     * the attribute is never written, so a dump taken straight after the click
     * photographs a form with nothing selected — and a reviewer would be looking
     * at a picture of a state the app never shows. Same for the textarea's
     * value. Stamped here, in the shots harness only.
     */
    (screen.getByTestId("comparison-reason-payment_amount") as HTMLInputElement).setAttribute(
      "checked",
      "",
    );
    const box = screen.getByTestId("comparison-note-input") as HTMLTextAreaElement;
    box.textContent = box.value;
    dump("c2-02-form");
  });

  it("c2-03-answered — an answer given, and the running tally", async () => {
    shoot(
      <CheckComparison
        office="roland"
        batchId="b-1"
        verdict="differed"
        reason="write_off"
        note="The office absorbed $60.00 on the crown; the app had nothing."
        answeredAt="2026-08-22T23:40:00.000Z"
        answeredBy="Billing User"
        revision={2}
      />,
    );
    await screen.findByTestId("comparison-tally");
    dump("c2-03-answered");
  });
});
