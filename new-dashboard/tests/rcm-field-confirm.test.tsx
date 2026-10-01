/**
 * THE CONFIRM SCREEN — the four states, and the rules that hold on each.
 *
 * The four are the ones the slice promised to show: a figure read off the scan,
 * one the document does not state, one a person corrected with its trail, and
 * the sum-to-check failure with the difference named in dollars.
 *
 * All synthetic: invented payer, invented patient, invented amounts. The figures
 * are the real case reduced — a $1,229.00 covered amount that the read once
 * promoted into paid, against a cheque for $184.00.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// Classic JSX runtime under vitest — the shim the other .tsx suites use.
(globalThis as Record<string, unknown>).React = React;

const CLAIM = "d1e2b359-a8d7-51a8-978c-7adf27bccc8d";
const LINE = "a02f3207-d73a-5cd7-ae2d-a0ffa4f69c90";
const BATCH = "8acb0e32-35ae-5cd8-9692-7b5e318a31c2";
const UPLOAD = "f4c1a0de-6b52-4a1e-9f77-2c6a0b9d4e31";

const S = vi.hoisted(() => ({
  /** The current server answer. Tests reshape it before rendering. */
  state: null as Record<string, unknown> | null,
  /** Every confirm request the screen sent. */
  sent: [] as Array<{ batchId: string; fields: unknown[] }>,
  confirmError: null as Error | null,
}));

vi.mock("@/contexts/OfficeContext", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/contexts/OfficeContext")>();
  return {
    ...real,
    OfficeProvider: ({ children }: { children: React.ReactNode }) => children,
    useOffice: () => ({
      office: "roland",
      offices: [],
      loading: false,
      error: null,
      setOffice: () => {},
    }),
  };
});

vi.mock("@/features/rcm/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/rcm/api")>();
  return {
    ...real,
    getFieldConfirm: vi.fn(async () => {
      if (!S.state) throw new Error("no such check");
      return S.state;
    }),
    confirmFields: vi.fn(async (_office: string, batchId: string, fields: unknown[]) => {
      S.sent.push({ batchId, fields });
      if (S.confirmError) throw S.confirmError;
      return { office: "roland", batchId, confirmed: [] };
    }),
  };
});

import FieldConfirm from "@/pages/rcm/FieldConfirm";
import { centsFromTyped } from "@/pages/rcm/FieldConfirm";

/** One field, unconfirmed and read off the scan, unless told otherwise. */
function field(over: Record<string, unknown> = {}) {
  return {
    field: "line_paid",
    cents: 5700,
    stated: true,
    source: "extracted",
    confirmed: false,
    extractedCents: 5700,
    confirmedBy: null,
    confirmedAt: null,
    ...over,
  };
}

/** The five line fields, overridable one at a time. */
function lineFields(over: Record<string, Record<string, unknown>> = {}) {
  return [
    field({ field: "line_paid", cents: null, stated: false, extractedCents: null, ...over.line_paid }),
    field({ field: "line_billed", cents: 131500, extractedCents: 131500, ...over.line_billed }),
    field({ field: "line_allowed", cents: 122900, extractedCents: 122900, ...over.line_allowed }),
    field({ field: "line_deductible", cents: 0, extractedCents: 0, ...over.line_deductible }),
    field({ field: "line_copay", cents: 0, extractedCents: 0, ...over.line_copay }),
  ];
}

function confirmState(over: Record<string, unknown> = {}) {
  return {
    office: "roland",
    batchId: BATCH,
    payer: "Meridian Mutual Dental",
    checkNumber: "SYN-000123",
    depositDate: "2026-09-15",
    checkTotal: field({ field: "check_total", cents: 18400, extractedCents: 18400 }),
    required: true,
    provenance: {
      uploadId: UPLOAD,
      textSource: "ocr",
      ocrPageCount: 1,
      ocrMeanConfidence: 0.991,
    },
    claims: [
      {
        claimId: CLAIM,
        patientName: "Synthetic, Patient A",
        claimNumber: "SYNCLM0001",
        serviceDate: "2026-09-15",
        totalPaid: field({ field: "claim_total_paid", cents: 18400, extractedCents: 18400 }),
        lines: [
          {
            lineId: LINE,
            position: 0,
            code: "D2750",
            description: "Crown - porcelain/ceramic",
            region: null,
            fields: lineFields(),
          },
        ],
      },
    ],
    outstanding: { ok: false, outstanding: 7, first: { claimId: null, lineId: null, field: "check_total" } },
    sums: {
      ok: true,
      comparable: true,
      checkTotalCents: 18400,
      claimsTotalCents: 18400,
      differenceCents: 0,
    },
    checkImage: null,
    ...over,
  };
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
  S.state = confirmState();
  S.sent = [];
  S.confirmError = null;
});
afterEach(() => cleanup());

// ─── The anchor ──────────────────────────────────────────────────────────────

describe("the check is the anchor", () => {
  it("puts the check total at the top, as the screen's first figure", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId("rcm-confirm-anchor")).toBeTruthy());
    expect(screen.getByTestId("rcm-confirm-check-total").textContent).toBe("$184.00");
  });

  it("makes the check total confirmable and correctable like any other figure", async () => {
    // The biller holds the physical cheque, so this field is hers to correct too.
    renderConfirm();
    const address = "||check_total";
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-yes-${address}`)).toBeTruthy());
    expect(screen.getByTestId(`rcm-confirm-edit-${address}`)).toBeTruthy();
  });

  it("reserves the snapshot slot without rendering an empty frame", async () => {
    // Addendum item 2: the slot renders NOTHING until a check image exists.
    // An empty frame inviting an upload that does not exist is a dead end.
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId("rcm-confirm-anchor")).toBeTruthy());
    expect(screen.queryByTestId("rcm-confirm-check-image")).toBeNull();

    cleanup();
    S.state = confirmState({ checkImage: { url: "/api/rcm/uploads/x/document?office=roland" } });
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId("rcm-confirm-check-image")).toBeTruthy());
  });
});

// ─── STATE 1: a figure read off the scan ─────────────────────────────────────

describe("a figure read off the scan", () => {
  it("shows the amount, says where it came from, and offers both answers", async () => {
    renderConfirm();
    const address = `${CLAIM}|${LINE}|line_billed`;
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-field-${address}`)).toBeTruthy());

    const row = screen.getByTestId(`rcm-confirm-field-${address}`);
    expect(row.textContent).toContain("$1,315.00");
    expect(screen.getByTestId(`rcm-confirm-state-${address}`).textContent).toBe("From the scan");
    expect(screen.getByTestId(`rcm-confirm-yes-${address}`)).toBeTruthy();
    expect(screen.getByTestId(`rcm-confirm-edit-${address}`)).toBeTruthy();
  });

  it("NEVER prints a confidence score, because there is no per-field confidence", async () => {
    /*
     * The reader gives one mean word confidence for a whole document and the
     * model gives a per-LINE confidence; neither is a score for an individual
     * amount. "92%" beside a figure would be a number this product made up about
     * a number a payer printed.
     */
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId("rcm-confirm-page")).toBeTruthy());
    const text = screen.getByTestId("rcm-confirm-page").textContent ?? "";
    expect(text).not.toMatch(/\d+\s?%/);
    expect(text).not.toMatch(/confidence/i);
    /*
     * The honest framing instead. "read off a picture" now lives on the RAIL's
     * current step rather than in the caveat — saying it in both places cost
     * this screen seventeen words and told a biller nothing twice — so what is
     * pinned here is the part that is this screen's own.
     */
    expect(text).toContain("needs a person's eye");
  });

  it("confirming AS READ sends the figure the screen showed", async () => {
    renderConfirm();
    const address = `${CLAIM}|${LINE}|line_billed`;
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-yes-${address}`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`rcm-confirm-yes-${address}`));
    await waitFor(() => expect(S.sent.length).toBe(1));
    expect(S.sent[0].fields).toEqual([
      { claimId: CLAIM, lineId: LINE, field: "line_billed", confirmedCents: 131500 },
    ]);
  });
});

// ─── STATE 2: a figure the document does not state ───────────────────────────

describe("a figure the document does not state", () => {
  it("says NOT STATED, never a zero and never a blank", async () => {
    renderConfirm();
    const address = `${CLAIM}|${LINE}|line_paid`;
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-field-${address}`)).toBeTruthy());

    const row = screen.getByTestId(`rcm-confirm-field-${address}`);
    expect(row.textContent).toContain("Not stated");
    expect(row.textContent).not.toContain("$0.00");
  });

  it("does not let the COVERED amount appear as the payment", async () => {
    // The fabrication, by value: $1,229.00 was the covered figure that once
    // reached the screen as paid.
    renderConfirm();
    const paid = `${CLAIM}|${LINE}|line_paid`;
    const allowed = `${CLAIM}|${LINE}|line_allowed`;
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-field-${paid}`)).toBeTruthy());

    expect(screen.getByTestId(`rcm-confirm-field-${paid}`).textContent).not.toContain("$1,229.00");
    expect(screen.getByTestId(`rcm-confirm-field-${allowed}`).textContent).toContain("$1,229.00");
  });

  it("confirming it sends NULL — a real answer, not a typed zero", async () => {
    renderConfirm();
    const address = `${CLAIM}|${LINE}|line_paid`;
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-yes-${address}`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`rcm-confirm-yes-${address}`));
    await waitFor(() => expect(S.sent.length).toBe(1));
    expect(S.sent[0].fields).toEqual([
      { claimId: CLAIM, lineId: LINE, field: "line_paid", confirmedCents: null },
    ]);
  });

  it("once confirmed, reads as NOT ON THE PAGE rather than as a checked amount", async () => {
    S.state = confirmState({
      claims: [
        {
          ...confirmState().claims[0],
          lines: [
            {
              ...confirmState().claims[0].lines[0],
              fields: lineFields({
                line_paid: { confirmed: true, source: "confirmed", confirmedBy: "Jo Biller" },
              }),
            },
          ],
        },
      ],
    });
    renderConfirm();
    const address = `${CLAIM}|${LINE}|line_paid`;
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-state-${address}`)).toBeTruthy());
    expect(screen.getByTestId(`rcm-confirm-state-${address}`).textContent).toBe("Not on the page");
    expect(screen.getByTestId(`rcm-confirm-by-${address}`).textContent).toContain("Jo Biller");
  });
});

// ─── STATE 3: a corrected figure, with its trail ─────────────────────────────

describe("a corrected figure", () => {
  it("says who corrected it, from where, and what the scan had said", async () => {
    S.state = confirmState({
      claims: [
        {
          ...confirmState().claims[0],
          totalPaid: field({
            field: "claim_total_paid",
            cents: 18400,
            extractedCents: 122900,
            confirmed: true,
            source: "corrected",
            confirmedBy: "Jo Biller",
            confirmedAt: "2026-09-30T01:00:00.000Z",
          }),
        },
      ],
    });
    renderConfirm();
    const address = `${CLAIM}||claim_total_paid`;
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-by-${address}`)).toBeTruthy());

    expect(screen.getByTestId(`rcm-confirm-state-${address}`).textContent).toBe("Corrected");
    const trail = screen.getByTestId(`rcm-confirm-by-${address}`).textContent ?? "";
    expect(trail).toContain("corrected by Jo Biller from the page image");
    // What the machine had said is part of the sentence, not lost.
    expect(trail).toContain("$1,229.00");
    // And the figure shown is the corrected one.
    expect(screen.getByTestId(`rcm-confirm-field-${address}`).textContent).toContain("$184.00");
  });

  it("a correction over a figure the scan did not state says so in words", async () => {
    S.state = confirmState({
      checkTotal: field({
        field: "check_total",
        cents: 18400,
        extractedCents: null,
        confirmed: true,
        source: "corrected",
        confirmedBy: "Jo Biller",
      }),
    });
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId("rcm-confirm-by-||check_total")).toBeTruthy());
    expect(screen.getByTestId("rcm-confirm-by-||check_total").textContent).toContain(
      "the scan showed nothing here",
    );
  });

  it("a confirmed figure offers no buttons — the decision is made", async () => {
    S.state = confirmState({
      checkTotal: field({
        field: "check_total",
        cents: 18400,
        extractedCents: 18400,
        confirmed: true,
        source: "confirmed",
        confirmedBy: "Jo Biller",
      }),
    });
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId("rcm-confirm-by-||check_total")).toBeTruthy());
    expect(screen.queryByTestId("rcm-confirm-yes-||check_total")).toBeNull();
    expect(screen.queryByTestId("rcm-confirm-edit-||check_total")).toBeNull();
  });
});

// ─── Typing a figure from the page ───────────────────────────────────────────

describe("typing what the page says", () => {
  it("parses dollars into cents without touching a float", async () => {
    // `1229.00 * 100` is 122899.99999999999 in JavaScript, and a cent lost here
    // is a cent the anchor then refuses to reconcile.
    expect(centsFromTyped("1229.00")).toBe(122900);
    expect(centsFromTyped("$1,229.00")).toBe(122900);
    expect(centsFromTyped("184")).toBe(18400);
    expect(centsFromTyped("184.5")).toBe(18450);
    expect(centsFromTyped("0")).toBe(0);
    expect(centsFromTyped(" 18.40 ")).toBe(1840);
  });

  it("refuses anything that is not a figure, rather than guessing at one", async () => {
    for (const bad of ["", "   ", "abc", "-100", "1.234", "1,2,3.456", "18.40.1"]) {
      expect(centsFromTyped(bad), `${bad} must not parse`).toBeUndefined();
    }
  });

  it("sends the typed figure, and the Save button is dead until it is one", async () => {
    renderConfirm();
    const address = `${CLAIM}||claim_total_paid`;
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-edit-${address}`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`rcm-confirm-edit-${address}`));

    const input = await waitFor(() => screen.getByTestId(`rcm-confirm-input-${address}`));
    const save = screen.getByTestId(`rcm-confirm-save-${address}`) as HTMLButtonElement;
    // Empty is not a figure, so there is nothing to save yet.
    expect(save.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "1,229.00" } });
    expect((screen.getByTestId(`rcm-confirm-save-${address}`) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId(`rcm-confirm-save-${address}`));
    await waitFor(() => expect(S.sent.length).toBe(1));
    expect(S.sent[0].fields).toEqual([
      { claimId: CLAIM, lineId: null, field: "claim_total_paid", confirmedCents: 122900 },
    ]);
  });

  it("surfaces a refusal from the server instead of pretending it saved", async () => {
    S.confirmError = new Error("That is more than 200 fields in one request.");
    renderConfirm();
    const address = `${CLAIM}||claim_total_paid`;
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-yes-${address}`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`rcm-confirm-yes-${address}`));
    await waitFor(() => expect(screen.getByTestId("rcm-confirm-save-error")).toBeTruthy());
    expect(screen.getByTestId("rcm-confirm-save-error").textContent).toContain("200 fields");
  });
});

// ─── STATE 4: the sum-to-check failure ───────────────────────────────────────

describe("the sum-to-check failure", () => {
  it("names the difference in dollars, and says what to do about it", async () => {
    S.state = confirmState({
      sums: {
        ok: false,
        comparable: true,
        checkTotalCents: 18400,
        claimsTotalCents: 122900,
        differenceCents: 122900 - 18400,
      },
    });
    renderConfirm();
    const banner = await waitFor(() => screen.getByTestId("rcm-confirm-sum-off"));
    const text = banner.textContent ?? "";
    expect(text).toContain("$1,229.00");
    expect(text).toContain("$184.00");
    expect(text).toContain("$1,045.00 apart");
    /*
     * The banner names the gap and points at the figure. It does NOT repeat
     * "type what the page says" — that instruction lives on the row at the
     * bottom that says what is left, and saying it twice cost nine words the
     * screen's budget would rather spend once.
     */
    expect(text).toContain("disagrees with the page");
    expect(screen.queryByTestId("rcm-confirm-sum-ok")).toBeNull();
  });

  it("when nothing can be added up, it says so instead of naming a difference", async () => {
    S.state = confirmState({
      sums: {
        ok: false,
        comparable: false,
        checkTotalCents: null,
        claimsTotalCents: null,
        differenceCents: null,
      },
    });
    renderConfirm();
    const banner = await waitFor(() => screen.getByTestId("rcm-confirm-sum-off"));
    expect(banner.textContent).toContain("Nothing can be added up yet");
    // A difference we never computed must not be printed as $0.00.
    expect(banner.textContent).not.toContain("apart");
  });

  it("says it adds up when it does", async () => {
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId("rcm-confirm-sum-ok")).toBeTruthy());
    expect(screen.queryByTestId("rcm-confirm-sum-off")).toBeNull();
  });
});

// ─── The one primary, and no reason-less greyed button ───────────────────────

describe("the way out", () => {
  it("offers no dead button — it says what is left instead", async () => {
    renderConfirm();
    const left = await waitFor(() => screen.getByTestId("rcm-confirm-not-done"));
    expect(left.textContent).toContain("7 figures still to check");
    expect(screen.queryByTestId("rcm-confirm-done")).toBeNull();
    // Nothing on the screen is a disabled primary waiting to be clicked at.
    const disabled = document.querySelectorAll("button[disabled]");
    for (const el of Array.from(disabled)) {
      expect(el.textContent ?? "").not.toMatch(/back to the check/i);
    }
  });

  it("explains the OTHER reason it is not done — checked, but not adding up", async () => {
    S.state = confirmState({
      outstanding: { ok: true, outstanding: 0, first: null },
      sums: {
        ok: false,
        comparable: true,
        checkTotalCents: 18400,
        claimsTotalCents: 19900,
        differenceCents: 1500,
      },
    });
    renderConfirm();
    const left = await waitFor(() => screen.getByTestId("rcm-confirm-not-done"));
    expect(left.textContent).toContain("do not add up");
  });

  it("shows ONE primary once everything is checked and it adds up", async () => {
    S.state = confirmState({ outstanding: { ok: true, outstanding: 0, first: null } });
    renderConfirm();
    const done = await waitFor(() => screen.getByTestId("rcm-confirm-done"));
    expect(done.getAttribute("href")).toBe(`/rcm/remittances/${BATCH}`);
    expect(screen.queryByTestId("rcm-confirm-not-done")).toBeNull();
  });
});

// ─── The document panel is evidence, not a control ───────────────────────────

describe("the document panel", () => {
  it("renders the source document IN PLACE, through the audited proxy", async () => {
    /*
     * The frame is `EobViewer`'s now — one viewer everywhere the document is
     * offered, so it behaves identically on the confirm step, the claim page and
     * the workbench. It used to be a bare `<iframe>` written here.
     */
    renderConfirm();
    const frame = await waitFor(() => screen.getByTestId("rcm-confirm-document-frame"));
    const src = frame.getAttribute("src") ?? "";
    expect(src).toContain(`/uploads/${UPLOAD}/document`);
    expect(src).toContain("office=roland");
  });

  it("keeps a new-tab escape inside the viewer, never as the default", async () => {
    renderConfirm();
    const escape = await waitFor(() => screen.getByTestId("rcm-confirm-document-new-tab"));
    expect(escape.getAttribute("target")).toBe("_blank");
  });

  it("says so honestly when there is no document to compare against", async () => {
    S.state = confirmState({ provenance: null });
    renderConfirm();
    const note = await waitFor(() => screen.getByTestId("rcm-confirm-document-none"));
    expect(note.textContent).toContain("the computer read directly");
    expect(screen.queryByTestId("rcm-confirm-document-frame")).toBeNull();
  });

  it("selecting a line is how the page is navigated — the image is never the control", async () => {
    renderConfirm();
    const select = await waitFor(() => screen.getByTestId(`rcm-confirm-line-select-${LINE}`));
    fireEvent.click(select);
    // No crop exists, so the fallback is the whole page and nothing about the
    // figures changed by selecting a row.
    expect(screen.queryByTestId(`rcm-confirm-crop-${LINE}`)).toBeNull();
    expect(S.sent.length).toBe(0);
  });
});

// ─── Confirming a whole line ─────────────────────────────────────────────────

describe("confirming a line at once", () => {
  it("sends every unchecked figure on the line, with NOT STATED as null", async () => {
    renderConfirm();
    const button = await waitFor(() => screen.getByTestId(`rcm-confirm-line-all-${LINE}`));
    expect(button.textContent).toContain("These 5 are right");
    fireEvent.click(button);
    await waitFor(() => expect(S.sent.length).toBe(1));
    expect(S.sent[0].fields).toEqual([
      { claimId: CLAIM, lineId: LINE, field: "line_paid", confirmedCents: null },
      { claimId: CLAIM, lineId: LINE, field: "line_billed", confirmedCents: 131500 },
      { claimId: CLAIM, lineId: LINE, field: "line_allowed", confirmedCents: 122900 },
      { claimId: CLAIM, lineId: LINE, field: "line_deductible", confirmedCents: 0 },
      { claimId: CLAIM, lineId: LINE, field: "line_copay", confirmedCents: 0 },
    ]);
  });

  it("offers nothing once the line is done", async () => {
    S.state = confirmState({
      claims: [
        {
          ...confirmState().claims[0],
          lines: [
            {
              ...confirmState().claims[0].lines[0],
              fields: lineFields().map((f) => ({
                ...f,
                confirmed: true,
                source: "confirmed",
                confirmedBy: "Jo Biller",
              })),
            },
          ],
        },
      ],
    });
    renderConfirm();
    await waitFor(() => expect(screen.getByTestId(`rcm-confirm-line-${LINE}`)).toBeTruthy());
    expect(screen.queryByTestId(`rcm-confirm-line-all-${LINE}`)).toBeNull();
  });
});

// ─── An 835 gets a teaching dead end ─────────────────────────────────────────

describe("a check that needs no confirming", () => {
  it("teaches rather than rendering an empty list", async () => {
    S.state = confirmState({ required: false });
    renderConfirm();
    const panel = await waitFor(() => screen.getByTestId("rcm-confirm-not-needed"));
    expect(panel.textContent).toContain("Nothing to check by hand");
    expect(panel.textContent).toContain("the computer could read directly");
    expect(screen.getByTestId("rcm-confirm-back").getAttribute("href")).toBe(
      `/rcm/remittances/${BATCH}`,
    );
    // No confirm controls at all on this path.
    expect(screen.queryByTestId("rcm-confirm-anchor")).toBeNull();
  });
});
