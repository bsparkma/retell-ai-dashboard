/**
 * THE PERIO GRID READS LIKE OPEN DENTAL'S CHART (item 18, part 1).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS ARE FOR
 * ═════════════════════════════════════════════════════════════════════════════
 * A hygienist lives in Open Dental's perio chart. Anything CareIN draws
 * differently she has to translate chairside, mid-probe, out loud. So the
 * orientation, the quadrant breaks, the site naming and the treatment of a
 * missing tooth are pinned here as claims about the DOM.
 *
 * Two of them pin behaviour that was ALREADY right before item 18 and must not
 * drift: the arch orientation, and the within-tooth site order. They are worth a
 * test precisely because nothing visible breaks when they go wrong — the grid
 * still looks like a grid, and the numbers land on the wrong teeth.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A MISSING TOOTH MUST NOT READ AS AN UNFINISHED ONE
 * ═════════════════════════════════════════════════════════════════════════════
 * An un-charted site is a faint `·` on a muted cell. If a skipped tooth were
 * drawn the same way it would read as "not done yet" on a chart whose whole
 * failure mode is understating disease by being incomplete. So the test below
 * asserts a skipped tooth is drawn DIFFERENTLY from an empty one, not merely
 * that it is drawn.
 *
 * NO PHI: one synthetic name, and 12827 is the designated roland fixture.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PERIO_LOWER_TEETH, PERIO_UPPER_TEETH, emptyPerioChart, normalizePerioChart, perioSite, perioTooth, screenSites, withPerioSite, withPerioSkipped, type PerioChart } from "@shared/hyg/perio";
import { quadrantOf } from "@/lib/hyg/dentition";
import { PerioGrid } from "@/features/hyg/perio/PerioGrid";

(globalThis as Record<string, unknown>).React = React;

afterEach(() => cleanup());

/** The grid on its own — no page, no network, so a failure names the grid. */
function renderGrid(chart: PerioChart, over: { prior?: PerioChart | null; failedTeeth?: number[] } = {}) {
  const onSelect = vi.fn();
  render(
    <PerioGrid
      chart={chart}
      prior={over.prior ?? null}
      cursor={{ tooth: 1, surface: "DB" }}
      lastEntered={null}
      onSelect={onSelect}
      onKeyDown={() => {}}
      failedTeeth={over.failedTeeth}
    />,
  );
  return { onSelect };
}

/**
 * The tooth numbers of one arch, in the order they appear on screen.
 *
 * Read off the rendered numbers ROW, not off `PERIO_UPPER_TEETH` — the constant
 * is the thing under test. Scoped to that row by testid rather than filtered out
 * of the whole arch, so it keeps meaning the same thing on a chart that has
 * readings in it (whose site cells also render digits).
 */
function numbersOnScreen(arch: "upper" | "lower"): number[] {
  const row = screen.getByTestId(`hyg-perio-numbers-${arch}`);
  return Array.from(row.children)
    .map((el) => (el.textContent ?? "").trim())
    .filter((t) => /^\d+$/.test(t))
    .map(Number);
}

describe("arch orientation — unchanged by item 18, and pinned so it stays that way", () => {
  it("the upper arch reads #1 → #16 and the lower #32 → #17, left to right", () => {
    renderGrid(emptyPerioChart());

    // Patient's right on the screen's left, which is how Open Dental draws it.
    expect(numbersOnScreen("upper")).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    expect(numbersOnScreen("lower")).toEqual([
      32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17,
    ]);
    // And the constants the rest of the app shares say the same thing.
    expect([...PERIO_UPPER_TEETH]).toEqual(numbersOnScreen("upper"));
    expect([...PERIO_LOWER_TEETH]).toEqual(numbersOnScreen("lower"));
  });

  it("the two lingual rows meet in the middle, the way OD stacks facial over lingual", () => {
    renderGrid(emptyPerioChart());
    const order = Array.from(document.querySelectorAll('[data-testid^="hyg-perio-row-"]')).map(
      (el) => el.getAttribute("data-testid"),
    );
    expect(order).toEqual([
      "hyg-perio-row-upper-facial",
      "hyg-perio-row-upper-lingual",
      "hyg-perio-row-lower-lingual",
      "hyg-perio-row-lower-facial",
    ]);
  });

  it("within a tooth the distal site is outermost, so the cursor sweeps the arch", () => {
    // Patient-RIGHT teeth run DB→B→MB left to right; patient-LEFT teeth mirror.
    expect(screenSites(8, "facial")).toEqual(["DB", "B", "MB"]);
    expect(screenSites(9, "facial")).toEqual(["MB", "B", "DB"]);
    expect(screenSites(8, "lingual")).toEqual(["DL", "L", "ML"]);
    expect(screenSites(9, "lingual")).toEqual(["ML", "L", "DL"]);

    // And the DOM lays them out in that order, not just the function.
    renderGrid(emptyPerioChart());
    const row = screen.getByTestId("hyg-perio-row-upper-facial");
    const ids = Array.from(row.querySelectorAll("[data-testid^='hyg-perio-site-8-']")).map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(ids).toEqual([
      "hyg-perio-site-8-DB",
      "hyg-perio-site-8-B",
      "hyg-perio-site-8-MB",
    ]);
  });
});

describe("quadrant boundaries are marked (item 18)", () => {
  it("each arch names its two quadrants with their tooth ranges", () => {
    renderGrid(emptyPerioChart());
    expect(screen.getByTestId("hyg-perio-quadrants-upper").textContent).toBe("UR #1–8UL #9–16");
    expect(screen.getByTestId("hyg-perio-quadrants-lower").textContent).toBe("LR #32–25LL #24–17");
  });

  it("the midline rule falls between #8 and #9, and between #25 and #24", () => {
    renderGrid(emptyPerioChart());

    // The rule is a left border on the first tooth of the second half. Asserted
    // through `quadrantOf`, the app's one dentition function, so this test and
    // the grid cannot disagree about where a quadrant starts.
    expect(quadrantOf(8)).toBe("UR");
    expect(quadrantOf(9)).toBe("UL");
    expect(quadrantOf(25)).toBe("LR");
    expect(quadrantOf(24)).toBe("LL");

    const upper = screen.getByTestId("hyg-perio-row-upper-facial");
    const ruled = Array.from(upper.querySelectorAll(".border-l-2"));
    expect(ruled).toHaveLength(1);
    // That one ruled cell is #9's group: it holds #9's sites and no others.
    expect(ruled[0].querySelector("[data-testid='hyg-perio-site-9-MB']")).toBeTruthy();
    expect(ruled[0].querySelector("[data-testid='hyg-perio-site-8-DB']")).toBeNull();

    const lower = screen.getByTestId("hyg-perio-row-lower-facial");
    const ruledLower = Array.from(lower.querySelectorAll(".border-l-2"));
    expect(ruledLower).toHaveLength(1);
    expect(ruledLower[0].querySelector("[data-testid='hyg-perio-site-24-MB']")).toBeTruthy();
  });
});

describe("site labels use Open Dental's facial/lingual naming (item 18)", () => {
  it("the facial rows are labelled DB·B·MB and the lingual rows ML·L·DL", () => {
    renderGrid(emptyPerioChart());
    for (const arch of ["upper", "lower"] as const) {
      expect(screen.getByTestId(`hyg-perio-row-${arch}-facial`).textContent).toContain("Facial");
      expect(screen.getByTestId(`hyg-perio-row-${arch}-facial`).textContent).toContain("DB·B·MB");
      expect(screen.getByTestId(`hyg-perio-row-${arch}-lingual`).textContent).toContain("Lingual");
      expect(screen.getByTestId(`hyg-perio-row-${arch}-lingual`).textContent).toContain("ML·L·DL");
    }
  });

  it("every site still names itself and its reading to a screen reader", () => {
    let chart = withPerioSite(emptyPerioChart(), 3, "DB", { depth: 5 });
    chart = normalizePerioChart(chart);
    renderGrid(chart);
    expect(screen.getByTestId("hyg-perio-site-3-DB").getAttribute("aria-label")).toBe("#3 DB: 5 mm");
    expect(screen.getByTestId("hyg-perio-site-3-B").getAttribute("aria-label")).toBe(
      "#3 B: not charted",
    );
  });
});

describe("a skipped tooth is drawn ABSENT, the way OD blanks a missing tooth (item 18)", () => {
  /** #19 skipped, #18 charted — neighbours, so the two treatments sit side by side. */
  function withSkip(): PerioChart {
    let chart = withPerioSkipped(emptyPerioChart(), 19, true);
    chart = withPerioSite(chart, 18, "MB", { depth: 3 });
    return normalizePerioChart(chart);
  }

  it("its readings are suppressed entirely — no site cells at all", () => {
    renderGrid(withSkip());
    for (const surface of ["DB", "B", "MB", "DL", "L", "ML"]) {
      expect(screen.queryByTestId(`hyg-perio-site-19-${surface}`)).toBeNull();
    }
    // Both of its rows are blanked, not just one.
    expect(screen.getByTestId("hyg-perio-skipped-19-facial")).toBeTruthy();
    expect(screen.getByTestId("hyg-perio-skipped-19-lingual")).toBeTruthy();
    // The charted neighbour is untouched.
    expect(screen.getByTestId("hyg-perio-site-18-MB").textContent).toContain("3");
  });

  it("its number is greyed and struck through, so it reads as missing not as un-done", () => {
    renderGrid(withSkip());
    const num = screen.getByTestId("hyg-perio-skipped-number-19");
    expect(num.textContent).toBe("19");
    expect(num.className).toContain("line-through");
    // AND IT IS DRAWN DIFFERENTLY FROM AN EMPTY SITE. This is the whole point:
    // a muted dot would say "not charted yet" about a tooth that is not there.
    const blank = screen.getByTestId("hyg-perio-skipped-19-facial");
    const emptySite = screen.getByTestId("hyg-perio-site-18-DB");
    expect(emptySite.textContent).toContain("·");
    expect(blank.textContent).not.toContain("·");
    expect(blank.className).not.toEqual(emptySite.className);
  });

  it("a prior exam's numbers are suppressed under a skipped tooth too", () => {
    let prior = withPerioSite(emptyPerioChart(), 19, "MB", { depth: 4 });
    prior = normalizePerioChart(withPerioSite(prior, 18, "MB", { depth: 4 }));
    renderGrid(withSkip(), { prior });
    // #18's prior number shows; #19 has no cell to show one in.
    expect(screen.getByTestId("hyg-perio-prior-18-MB")).toBeTruthy();
    expect(screen.queryByTestId("hyg-perio-prior-19-MB")).toBeNull();
  });

  it("a skip is NEVER a lock: selecting it moves the cursor there so it can be un-skipped", () => {
    // Part 2's pre-skip is a default, and an implant gets probed. The grid must
    // keep a skipped tooth reachable for that to be possible at all.
    const { onSelect } = renderGrid(withSkip());
    const blank = screen.getByTestId("hyg-perio-skipped-19-facial");
    expect(blank.getAttribute("aria-label")).toContain("un-skip");
    fireEvent.click(blank);
    expect(onSelect).toHaveBeenCalledWith({ tooth: 19, surface: screenSites(19, "facial")[0] });
  });

  it("a failed tooth still shouts over a skipped one — the send's marking wins", () => {
    renderGrid(withSkip(), { failedTeeth: [19] });
    // An incomplete send naming #19 must not be hidden by the greyed treatment.
    expect(screen.getByTestId("hyg-perio-failed-tooth-19").textContent).toBe("19!");
    expect(screen.queryByTestId("hyg-perio-skipped-number-19")).toBeNull();
  });
});
