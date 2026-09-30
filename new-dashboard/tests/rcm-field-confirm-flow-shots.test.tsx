/**
 * Screenshot DUMPS for the flow fix — items 1, 2 and 3.
 *
 * Same shape and reasons as the other `*-shots.test.tsx` files: renders each
 * screen into jsdom with fixture data that lives here and writes the markup to
 * `tests/.shots/*.html`, which `scripts/shoot-flow-fix.mjs` wraps in the app's
 * real built CSS and photographs.
 *
 * THE PAIRS:
 *   ff-01-before-island / ff-01-after-in-the-flow
 *       item 1 — the confirm screen with no rail (an island) and with one
 *   ff-02-before-new-tab / ff-02-after-in-place
 *       item 3 — the claim page offering the EOB as a new-tab link, and as an
 *       in-page drawer
 *
 * `-tall` and `-short` variants of the after-shots are item 2's proof: the same
 * screen at 1280x800 and at a short viewport, with one scrollbar in both.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every payer, patient, check number and dollar
 * figure below is synthetic.
 *
 * Skipped unless RCM_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

(globalThis as Record<string, unknown>).React = React;

const OUT = resolve(import.meta.dirname, ".shots");

const BATCH = "8acb0e32-35ae-5cd8-9692-7b5e318a31c2";
const CLAIM = "d1e2b359-a8d7-51a8-978c-7adf27bccc8d";
const LINE = "a02f3207-d73a-5cd7-ae2d-a0ffa4f69c90";
const UPLOAD = "f4c1a0de-6b52-4a1e-9f77-2c6a0b9d4e31";

const S = vi.hoisted(() => ({
  confirm: null as Record<string, unknown> | null,
  /** The check behind the rail. Null = the "island" shot, before the fix. */
  check: null as Record<string, unknown> | null,
}));

vi.mock("@/contexts/OfficeContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/OfficeContext")>();
  return {
    ...real,
    OfficeProvider: ({ children }: { children: React.ReactNode }) => children,
    useOffice: () => ({ office: "roland", offices: [], loading: false, error: null, setOffice: () => {} }),
  };
});

vi.mock("@/features/rcm/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/rcm/api")>();
  return {
    ...real,
    getFieldConfirm: vi.fn(async () => S.confirm),
    getRemittance: vi.fn(async () => {
      if (!S.check) throw new Error("no check");
      return S.check;
    }),
    confirmFields: vi.fn(async () => ({ office: "roland", batchId: BATCH, confirmed: [] })),
  };
});

import FieldConfirm from "@/pages/rcm/FieldConfirm";

function f(field: string, cents: number | null, over: Record<string, unknown> = {}) {
  return {
    field,
    cents,
    stated: cents !== null,
    source: "extracted",
    confirmed: false,
    extractedCents: cents,
    confirmedBy: null,
    confirmedAt: null,
    ...over,
  };
}

function confirmState() {
  return {
    office: "roland",
    batchId: BATCH,
    payer: "MERIDIAN MUTUAL DENTAL",
    checkNumber: "SYN-000123",
    depositDate: "2026-09-15",
    checkTotal: f("check_total", 18400),
    required: true,
    provenance: { uploadId: UPLOAD, textSource: "ocr", ocrPageCount: 1, ocrMeanConfidence: 0.991 },
    claims: [
      {
        claimId: CLAIM,
        patientName: "Synthetic, Patient A",
        claimNumber: "SYNCLM0001",
        serviceDate: "2026-09-15",
        totalPaid: f("claim_total_paid", 18400),
        lines: [
          {
            lineId: LINE,
            position: 0,
            code: "D2750",
            description: "Crown - porcelain/ceramic",
            region: null,
            fields: [
              f("line_paid", null),
              f("line_billed", 131500),
              f("line_allowed", 122900),
              f("line_deductible", 0),
              f("line_copay", 0),
            ],
          },
        ],
      },
    ],
    outstanding: { ok: false, outstanding: 7, first: { claimId: null, lineId: null, field: "check_total" } },
    sums: { ok: true, comparable: true, checkTotalCents: 18400, claimsTotalCents: 18400, differenceCents: 0 },
    checkImage: null,
  };
}

/** The check the rail is drawn from — an OCR read with work outstanding. */
function checkState() {
  return {
    office: "roland",
    remittance: {
      batchId: BATCH,
      officeId: "roland",
      payer: "MERIDIAN MUTUAL DENTAL",
      checkNumber: "SYN-000123",
      source: "eob",
      createdAt: "2026-09-30T02:30:00.000Z",
      balance: { balanced: true, differenceCents: 0 },
      attentionReasons: [],
      attentionObservations: [],
      plans: [],
      plbAdjustments: [],
      fieldConfirm: { required: true, ok: false, outstanding: 7 },
    },
    claims: [{ claimId: CLAIM, odMatchStatus: "not_run", reviewedAt: null, postingQueueId: null }],
  };
}

function dump(name: string) {
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, document.body.innerHTML, "utf8");
}

function renderConfirm() {
  const memory = memoryLocation({ path: `/rcm/remittances/${BATCH}/confirm`, record: true });
  return render(
    <WouterRouter hook={memory.hook}>
      <FieldConfirm />
    </WouterRouter>,
  );
}

beforeEach(() => {
  S.confirm = confirmState();
  S.check = checkState();
});
afterEach(() => cleanup());

const maybe = process.env.RCM_SHOTS === "1" ? describe : describe.skip;

maybe("the flow fix, photographed", () => {
  it("01 before — the confirm screen as an island", async () => {
    /*
     * BEFORE. The rail comes from the check; with no check there is no rail and
     * no breadcrumb, which is exactly what this screen looked like when the
     * owner met it: a page with no way back and nothing saying which step it is.
     */
    S.check = null;
    renderConfirm();
    await waitFor(() => screen.getByTestId("rcm-confirm-page"));
    dump("ff-01-before-island");
  });

  it("01 after — the same screen, in the flow", async () => {
    renderConfirm();
    await waitFor(() => screen.getByTestId("rcm-confirm-breadcrumb"));
    dump("ff-01-after-in-the-flow");
  });

  it("02 after — the EOB open in place, beside the figures", async () => {
    // Item 3, on the screen that offers the document next to the work. The
    // frame renders empty in a static dump — jsdom fetches nothing — which is
    // why the shot is of the LAYOUT: the document panel and the figures, side
    // by side, in one scroll.
    renderConfirm();
    await waitFor(() => screen.getByTestId("rcm-confirm-document-frame"));
    dump("ff-02-after-in-place");
  });
});
