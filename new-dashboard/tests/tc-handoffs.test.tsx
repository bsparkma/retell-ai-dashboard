/**
 * CareIN handoffs strip (PM ruling 3) — the strip must be layout parity ONLY.
 *
 * These tests are the guard rails against the legacy behaviour creeping back
 * in: the component may not fetch anything (the legacy one polled
 * /api/carein/handoffs every 30s), and it may not render a count, a badge, or
 * a patient row. If someone wires it to real data later they should delete
 * these tests deliberately, not have them quietly pass.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// Classic-runtime React global (see tests/tc-followups-queue.test.tsx).
(globalThis as Record<string, unknown>).React = React;

// Every TC API function is mocked so "was the network touched?" is assertable.
const apiMock = vi.hoisted(() => ({
  listCases: vi.fn(),
  followupsDue: vi.fn(),
  listFollowups: vi.fn(),
  createCase: vi.fn(),
  tcErrorMessage: vi.fn(() => "error"),
}));
vi.mock("@/features/tc/api", () => apiMock);

import { CareInHandoffsStrip } from "@/features/tc/handoffs/CareInHandoffsStrip";

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy.mockReset();
  (globalThis as { fetch: unknown }).fetch = fetchSpy;
});

afterEach(() => {
  cleanup();
});

describe("CareInHandoffsStrip", () => {
  it("renders the honest coming-soon state instead of handoff rows", () => {
    render(<CareInHandoffsStrip />);

    const strip = screen.getByRole("region", { name: "Voice handoffs" });
    expect(strip).toBeTruthy();
    expect(screen.getByText("Voice handoffs — coming soon")).toBeTruthy();
    // Explains WHY it's dark, and promises nothing fake.
    expect(strip.textContent).toContain("its own slice");
    expect(strip.textContent).toContain("no sample patients");

    // No claim affordance — there is nothing real to claim.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows no numeric counts anywhere in the strip", () => {
    render(<CareInHandoffsStrip />);
    const strip = screen.getByRole("region", { name: "Voice handoffs" });
    // Any digit would be an invented number — the legacy strip's "N new" badge.
    expect(strip.textContent ?? "").not.toMatch(/\d/);
  });

  it("makes no network call — no polling, no /api/carein/handoffs", () => {
    render(<CareInHandoffsStrip />);

    expect(fetchSpy).not.toHaveBeenCalled();
    for (const fn of Object.values(apiMock)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});
