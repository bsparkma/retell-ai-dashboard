/**
 * Screenshot DUMPS for the confirm step — the four states the slice promised.
 *
 * Same shape and same reasons as the other `*-shots.test.tsx` files: renders the
 * screen into jsdom with fixture data that lives in this file and writes the
 * markup to `tests/.shots/*.html`, which `scripts/shoot-field-confirm.mjs` wraps
 * in the app's real built CSS and photographs at 1280 wide, light and dark.
 *
 * THE FOUR:
 *   01  a figure read off the scan — the ordinary state, with both answers offered
 *   02  a figure the document does not state, and the covered amount beside it
 *   03  a corrected figure, with its trail underneath
 *   04  the sum-to-check failure, with the difference named in dollars
 *
 * On 02: what the brief calls an "uncertain" field renders as the HONEST FRAMING
 * rather than as a score, because there is no per-field confidence to show. The
 * reader reports one mean word confidence for a whole document and the
 * extraction model reports a per-LINE confidence; neither is a number about an
 * individual amount, and printing one would be this product inventing a figure
 * about a figure. So a field is "From the scan", "Not stated", "Checked" or
 * "Corrected", and the screen's own caveat says where they all came from.
 *
 * NO NETWORK, NO BACKEND, NO PHI. Every payer, patient, check number and dollar
 * figure below is synthetic. The amounts are the real case reduced: a $1,229.00
 * covered amount that the read once promoted into paid, against a cheque for
 * $184.00.
 *
 * Skipped unless RCM_SHOTS=1.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

(globalThis as Record<string, unknown>).React = React;

const OUT = resolve(import.meta.dirname, ".shots");

const BATCH = "8acb0e32-35ae-5cd8-9692-7b5e318a31c2";
const CLAIM = "d1e2b359-a8d7-51a8-978c-7adf27bccc8d";
const LINE = "a02f3207-d73a-5cd7-ae2d-a0ffa4f69c90";
const LINE2 = "512be448-fb43-554c-a21d-33b0f80f9323";
const UPLOAD = "f4c1a0de-6b52-4a1e-9f77-2c6a0b9d4e31";

const S = vi.hoisted(() => ({ state: null as Record<string, unknown> | null }));

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
    getFieldConfirm: vi.fn(async () => S.state),
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

/**
 * Two lines: a crown whose payment is not stated, and an exam that is.
 *
 * `allConfirmed` controls the crown's four stated figures as well as its
 * unstated payment, so a fixture can be INTERNALLY CONSISTENT — a screen that
 * claims nothing is outstanding while a line still offers "these 4 are right"
 * would be a screenshot of a state the server cannot produce.
 */
function lines(over: { paidConfirmed?: boolean; allConfirmed?: boolean } = {}) {
  const by = { confirmed: true, source: "confirmed", confirmedBy: "Jo Biller" };
  const rest = over.allConfirmed ? by : {};
  return [
    {
      lineId: LINE,
      position: 0,
      code: "D2750",
      description: "Crown - porcelain/ceramic",
      region: null,
      fields: [
        f("line_paid", null, over.paidConfirmed || over.allConfirmed ? by : {}),
        f("line_billed", 131500, rest),
        f("line_allowed", 122900, rest),
        f("line_deductible", 0, rest),
        f("line_copay", 0, rest),
      ],
    },
    {
      lineId: LINE2,
      position: 1,
      code: "D0120",
      description: "Periodic oral evaluation",
      region: null,
      fields: [
        f("line_paid", 5200, { confirmed: true, source: "confirmed", confirmedBy: "Jo Biller" }),
        f("line_billed", 6500, { confirmed: true, source: "confirmed", confirmedBy: "Jo Biller" }),
        f("line_allowed", 5200, { confirmed: true, source: "confirmed", confirmedBy: "Jo Biller" }),
        f("line_deductible", 0, { confirmed: true, source: "confirmed", confirmedBy: "Jo Biller" }),
        f("line_copay", 0, { confirmed: true, source: "confirmed", confirmedBy: "Jo Biller" }),
      ],
    },
  ];
}

function state(over: Record<string, unknown> = {}, claimOver: Record<string, unknown> = {}) {
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
        lines: lines(),
        ...claimOver,
      },
    ],
    outstanding: { ok: false, outstanding: 6, first: { claimId: null, lineId: null, field: "check_total" } },
    sums: { ok: true, comparable: true, checkTotalCents: 18400, claimsTotalCents: 18400, differenceCents: 0 },
    checkImage: null,
    ...over,
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
  S.state = state();
});
afterEach(() => cleanup());

const maybe = process.env.RCM_SHOTS === "1" ? describe : describe.skip;

maybe("the confirm step, photographed", () => {
  it("01 a figure read off the scan", async () => {
    renderConfirm();
    await waitFor(() => screen.getByTestId("rcm-confirm-page"));
    dump("fc-01-read-from-the-scan");
  });

  it("02 a figure the document does not state", async () => {
    // Confirmed as "not on the page" beside the covered amount that was once
    // promoted into it — the two facts the original bug conflated.
    S.state = state({}, { lines: lines({ paidConfirmed: true }) });
    renderConfirm();
    await waitFor(() => screen.getByTestId("rcm-confirm-page"));
    dump("fc-02-not-stated");
  });

  it("03 a corrected figure, with its trail", async () => {
    S.state = state(
      { outstanding: { ok: true, outstanding: 0, first: null } },
      {
        totalPaid: f("claim_total_paid", 18400, {
          confirmed: true,
          source: "corrected",
          confirmedBy: "Jo Biller",
          confirmedAt: "2026-09-30T01:00:00.000Z",
          extractedCents: 122900,
        }),
        lines: lines({ allConfirmed: true }),
      },
    );
    renderConfirm();
    await waitFor(() => screen.getByTestId("rcm-confirm-page"));
    dump("fc-03-corrected-with-trail");
  });

  it("04 the sum-to-check failure", async () => {
    S.state = state(
      {
        sums: {
          ok: false,
          comparable: true,
          checkTotalCents: 18400,
          claimsTotalCents: 122900,
          differenceCents: 104500,
        },
      },
      { totalPaid: f("claim_total_paid", 122900) },
    );
    renderConfirm();
    await waitFor(() => screen.getByTestId("rcm-confirm-sum-off"));
    dump("fc-04-does-not-add-up");
  });
});
