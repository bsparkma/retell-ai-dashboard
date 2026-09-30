/**
 * THE CONFIRM STEP IN THE FLOW — the four defects from the owner working real
 * checks, as tests.
 *
 *   1. the confirm step is the tail end of BRING IN, not an island
 *   2. one scroll per page
 *   3. the EOB opens IN PLACE, through one viewer everywhere
 *   4. a viewer that cannot show the document says what to do next
 *
 * All synthetic: invented payer, invented patient, invented amounts.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

(globalThis as Record<string, unknown>).React = React;

import { remittanceFlow } from "@/features/rcm/flow";
import type { Remittance, RemittanceClaim } from "@/features/rcm/api";

const BATCH = "8acb0e32-35ae-5cd8-9692-7b5e318a31c2";
const CLAIM = "d1e2b359-a8d7-51a8-978c-7adf27bccc8d";

// ═════════════════════════════════════════════════════════════════════════════
// 1 · THE CONFIRM STEP IS THE TAIL END OF BRING IN
// ═════════════════════════════════════════════════════════════════════════════

function remittance(over: Partial<Remittance> = {}): Remittance {
  return {
    batchId: BATCH,
    officeId: "roland",
    payer: "Meridian Mutual Dental",
    checkNumber: "SYN-000123",
    source: "eob",
    createdAt: "2026-09-30T02:30:00.000Z",
    balance: { balanced: true, differenceCents: 0 },
    attentionReasons: [],
    attentionObservations: [],
    ...(over as Record<string, unknown>),
  } as unknown as Remittance;
}

function claimRow(over: Partial<RemittanceClaim> = {}): RemittanceClaim {
  return {
    claimId: CLAIM,
    odMatchStatus: "not_run",
    reviewedAt: null,
    postingQueueId: null,
    ...(over as Record<string, unknown>),
  } as unknown as RemittanceClaim;
}

const stepOf = (flow: ReturnType<typeof remittanceFlow>, key: string) =>
  flow.steps.find((s) => s.step === key)!;

describe("the confirm step is the tail end of bringing the check in", () => {
  it("keeps Bring-in CURRENT while a scanned figure is unchecked, and says how many", () => {
    /*
     * PLACEMENT RULING. Reading a picture of a document is half of taking that
     * document in; the other half is a person agreeing that what was read is
     * what is printed. So the step is not done until it is.
     */
    const flow = remittanceFlow(remittance(), [claimRow()], {
      fieldConfirm: { required: true, ok: false, outstanding: 7 },
    });

    const upload = stepOf(flow, "upload");
    expect(upload.state).toBe("current");
    expect(upload.detail).toContain("Read from the scan");
    expect(upload.detail).toContain("7 figures not yet checked against the page");
    expect(upload.href).toBe(`/rcm/remittances/${BATCH}/confirm`);
  });

  it("says ONE figure, not 1 figures", () => {
    const flow = remittanceFlow(remittance(), [claimRow()], {
      fieldConfirm: { required: true, ok: false, outstanding: 1 },
    });
    expect(stepOf(flow, "upload").detail).toContain("1 figure not yet checked");
  });

  it("makes MATCH wait — a claim is not tied to a chart on figures nobody has read", () => {
    const flow = remittanceFlow(remittance(), [claimRow()], {
      fieldConfirm: { required: true, ok: false, outstanding: 7 },
    });
    // `oneCurrent` demotes it: there is exactly one current step, and it is ours.
    expect(stepOf(flow, "match").state).toBe("todo");
    expect(flow.steps.filter((s) => s.state === "current")).toHaveLength(1);
  });

  it("points the check page's ONE primary at the confirm screen", () => {
    // `ctaFor` takes the first current or blocked step — one rule, not a second
    // CTA override that has to be kept in step with the rail.
    const flow = remittanceFlow(remittance(), [claimRow()], {
      fieldConfirm: { required: true, ok: false, outstanding: 7 },
    });
    expect(flow.cta?.href).toBe(`/rcm/remittances/${BATCH}/confirm`);
  });

  it("hands the flow back the moment the figures are checked", () => {
    const flow = remittanceFlow(remittance(), [claimRow()], {
      fieldConfirm: { required: true, ok: true, outstanding: 0 },
    });
    expect(stepOf(flow, "upload").state).toBe("done");
    expect(stepOf(flow, "upload").detail).toContain("EOB PDF read");
    expect(stepOf(flow, "match").state).toBe("current");
  });

  it("leaves an 835 COMPLETELY untouched", () => {
    /*
     * An 835 was parsed, not read off a picture. There is nothing for a person
     * to squint at, and a confirm step on one would be ceremony — which is how
     * billers learn that a review step can be clicked through.
     */
    for (const ctx of [
      {},
      { fieldConfirm: null },
      { fieldConfirm: { required: false, ok: true, outstanding: 0 } },
    ]) {
      const flow = remittanceFlow(remittance({ source: "835" }), [claimRow()], ctx);
      expect(stepOf(flow, "upload").state).toBe("done");
      expect(stepOf(flow, "upload").detail).toContain("835 file read");
      expect(stepOf(flow, "match").state).toBe("current");
      // Null (the match CTA fires an action) or a claim href — never the
      // confirm screen, which an 835 has no business on.
      expect(flow.cta?.href ?? "").not.toContain("/confirm");
      expect(flow.cta?.step).not.toBe("upload");
    }
  });

  it("`required: false` wins even when the server also reports work outstanding", () => {
    /*
     * The two fields are independent on the wire, and only `required` decides
     * whether this check has a confirm step at all. Reading `!ok` alone would
     * drag an 835 into the step the moment anything set a non-zero count on it —
     * which is exactly the shape of accident that puts a screen in front of a
     * biller who has no way to clear it.
     */
    const flow = remittanceFlow(remittance({ source: "835" }), [claimRow()], {
      fieldConfirm: { required: false, ok: false, outstanding: 7 },
    });
    expect(stepOf(flow, "upload").state).toBe("done");
    expect(stepOf(flow, "match").state).toBe("current");
  });

  it("a server that predates the field draws the rail exactly as before", () => {
    // `fieldConfirm` absent is not "there is work outstanding" — it is "this
    // server does not say", and guessing would put every check into a step it
    // may not need.
    const flow = remittanceFlow(remittance(), [claimRow()], {});
    expect(stepOf(flow, "upload").state).toBe("done");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 · ONE SCROLL PER PAGE
// ═════════════════════════════════════════════════════════════════════════════

describe("one scroll per page", () => {
  /**
   * Every RCM page and component source, as { path, text }.
   */
  function rcmSources() {
    const root = resolve(__dirname, "..", "client", "src");
    const out: { rel: string; text: string }[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(name)) continue;
        out.push({
          rel: relative(root, full).replace(/\\/g, "/"),
          text: readFileSync(full, "utf8"),
        });
      }
    };
    walk(join(root, "pages", "rcm"));
    walk(join(root, "components", "rcm"));
    return out;
  }

  it("no RCM screen opens a second full-height scroll container", () => {
    /*
     * THE PAGE SCROLLS ONCE. `DashboardLayout` owns it — the shell is
     * `h-screen overflow-hidden` with `<main className="flex-1 overflow-y-auto">`
     * — and a panel with its own `overflow-y-auto` puts a second scrollbar beside
     * the first. A biller then has to discover which one moves the thing she is
     * reading, and the answer changes depending on where her cursor is.
     *
     * The ONE exception is the page image itself, which has to scroll to be
     * usable and is an `<iframe>` — the browser gives that its own scrollbar
     * inside a fixed box, which is not a second scrollbar over the page.
     *
     * This is a SOURCE scan, so it catches the class coming back rather than one
     * instance of it. The screenshots at two viewport heights are the visual
     * half of the same proof.
     */
    const offenders = rcmSources()
      .filter(({ text }) =>
        // A class attribute — not the word in a comment, which is how this rule
        // gets explained.
        /className=[^\n]*\boverflow-(y-)?(auto|scroll)\b/.test(text),
      )
      .map((f) => f.rel);

    expect(
      offenders,
      `these RCM screens open their own scroll container: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("no RCM screen pins itself to the viewport height", () => {
    // `h-screen` inside the shell's own `h-screen` is how a page ends up taller
    // than the box it lives in, which is the other way to get two scrollbars.
    const offenders = rcmSources()
      .filter(({ text }) => /className=[^\n]*\b(h-screen|min-h-screen)\b/.test(text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3 & 4 · THE EOB OPENS IN PLACE, AND SAYS SO WHEN IT CANNOT
// ═════════════════════════════════════════════════════════════════════════════

import EobViewer, { EobViewerPanel } from "@/components/rcm/EobViewer";

const HREF = "/api/rcm/uploads/f4c1a0de-6b52-4a1e-9f77-2c6a0b9d4e31/document?office=roland";

function renderViewer(ui: React.ReactElement) {
  const memory = memoryLocation({ path: "/rcm", record: true });
  return render(<WouterRouter hook={memory.hook}>{ui}</WouterRouter>);
}

afterEach(() => cleanup());

describe("the EOB opens in place", () => {
  it("renders the document in the page, not as a link to a new tab", () => {
    renderViewer(<EobViewer href={HREF} />);
    const frame = screen.getByTestId("eob-viewer-frame") as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toContain("/document");
  });

  it("keeps a new-tab escape INSIDE the viewer, for a second monitor", () => {
    // An escape, not the default. Taking it away would trade one complaint for
    // another.
    renderViewer(<EobViewer href={HREF} />);
    const escape = screen.getByTestId("eob-viewer-new-tab");
    expect(escape.getAttribute("target")).toBe("_blank");
    expect(escape.getAttribute("href")).toContain("/document");
  });

  it("opens at a page when the caller knows which one, and remounts to move", () => {
    // A PDF viewer does not re-navigate on a fragment change alone, so the key
    // has to change with the page or the panel silently stays on page 1.
    const { rerender } = renderViewer(<EobViewer href={HREF} page={3} />);
    expect(screen.getByTestId("eob-viewer-frame").getAttribute("src")).toContain("#page=3");
    rerender(<EobViewer href={HREF} page={5} />);
    expect(screen.getByTestId("eob-viewer-frame").getAttribute("src")).toContain("#page=5");
  });

  it("says plainly when there is no document, rather than showing an empty frame", () => {
    // An 835 was parsed, not scanned. That is an answer, not a failure.
    renderViewer(<EobViewer href={null} />);
    expect(screen.getByTestId("eob-viewer-none").textContent).toContain(
      "the computer read directly",
    );
    expect(screen.queryByTestId("eob-viewer-frame")).toBeNull();
  });

  it("the drawer opens BESIDE the figures and can be closed", () => {
    const onClose = vi.fn();
    renderViewer(<EobViewerPanel href={HREF} open onClose={onClose} />);
    expect(screen.getByTestId("eob-panel")).toBeTruthy();
    fireEvent.click(screen.getByTestId("eob-panel-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing at all when closed", () => {
    renderViewer(<EobViewerPanel href={HREF} open={false} onClose={() => {}} />);
    expect(screen.queryByTestId("eob-panel")).toBeNull();
  });
});

describe("a viewer that cannot show the document", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not sit on a spinner forever — silence is not success", async () => {
    /*
     * ROOT CAUSE OF DEFECT 4, structurally.
     *
     * An `<iframe>` that 404s, 401s or is blocked fires NO error event: the
     * browser renders the failure inside the frame and tells the page nothing.
     * In a new tab even that was invisible — which is why the prod logs carry no
     * record of the attempt that failed. A deadline is the only honest signal.
     */
    renderViewer(<EobViewer href={HREF} />);
    expect(screen.getByTestId("eob-viewer-loading")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    const failed = screen.getByTestId("eob-viewer-failed");
    // It names what to do next, never a bare failure.
    expect(failed.textContent).toContain("Open it in a new tab instead");
    expect(failed.textContent).toContain("check the figures against your own copy");
    expect(screen.getByTestId("eob-viewer-failed-new-tab").getAttribute("target")).toBe("_blank");
  });

  it("clears the spinner when the document does come up", async () => {
    renderViewer(<EobViewer href={HREF} />);
    fireEvent.load(screen.getByTestId("eob-viewer-frame"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(screen.queryByTestId("eob-viewer-failed")).toBeNull();
    expect(screen.queryByTestId("eob-viewer-loading")).toBeNull();
  });
});
