/**
 * TcGuide page tests (jsdom via the .tsx glob).
 *
 * The page is fully static coaching content — no API calls, no OfficeContext —
 * so it renders bare with no providers. Covers: all 4 tabs render, the
 * objection-handling flow (empty state → select an objection → its scripts and
 * tips appear), a known discovery question on the default tab, and known
 * playbook headings.
 */
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// Vitest compiles .tsx with esbuild's classic JSX transform (tsconfig has
// jsx: "preserve"), while the app's Vite build uses the automatic runtime —
// so component modules never import React. Provide the classic-runtime global
// so their JSX renders under vitest.
(globalThis as Record<string, unknown>).React = React;

import TcGuide from "@/pages/tc/TcGuide";

/**
 * Radix TabsTrigger activates on mousedown (not click), so fire both to
 * mirror a real pointer interaction.
 */
function selectTab(name: string): void {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
}

afterEach(() => {
  cleanup();
});

describe("TcGuide", () => {
  it("renders the header and all 4 tabs", () => {
    render(<TcGuide />);

    expect(screen.getByRole("heading", { name: "TC Guide" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Discovery Questions" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Objection Handling" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Education Library" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Follow-Up Playbook" })).toBeTruthy();
  });

  it("shows discovery questions and the consult flow on the default tab", () => {
    render(<TcGuide />);

    // Default tab is Discovery Questions.
    expect(
      screen.getByText(/What brings you in today, and how long has this been bothering you\?/),
    ).toBeTruthy();
    expect(screen.getByText("Purpose: Understand the chief complaint and urgency level")).toBeTruthy();
    expect(screen.getByText("TC CONSULT FLOW")).toBeTruthy();
    expect(screen.getByText("Build rapport — 2-3 minutes of genuine connection")).toBeTruthy();
  });

  it("selects an objection and shows its scripts and tips", () => {
    render(<TcGuide />);

    selectTab("Objection Handling");

    // Empty state until an objection is picked.
    expect(screen.getByText("Select an objection to see scripts and tips")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "It's Too Expensive" }));

    expect(screen.queryByText("Select an objection to see scripts and tips")).toBeNull();
    expect(screen.getByText("Response Scripts")).toBeTruthy();
    expect(
      screen.getByText(/what were you expecting to invest in your smile today\?/),
    ).toBeTruthy();
    expect(screen.getByText("TC Tips")).toBeTruthy();
    expect(screen.getByText("Never apologize for the fee. Present it with confidence.")).toBeTruthy();

    // Switching objections swaps the panel content.
    fireEvent.click(screen.getByRole("button", { name: "Fear / Anxiety" }));
    expect(screen.getByText("Discuss sedation options proactively.")).toBeTruthy();
    expect(
      screen.queryByText("Never apologize for the fee. Present it with confidence."),
    ).toBeNull();
  });

  it("renders the education library cards", () => {
    render(<TcGuide />);

    selectTab("Education Library");

    expect(screen.getByText("Root Canal Myths vs. Reality")).toBeTruthy();
    expect(screen.getByText("Dental Financing: Your Complete Guide")).toBeTruthy();
    // Category pill (two Implants items exist).
    expect(screen.getAllByText("Implants").length).toBe(2);
  });

  it("renders the follow-up playbook sections", () => {
    render(<TcGuide />);

    selectTab("Follow-Up Playbook");

    expect(screen.getByRole("heading", { name: "Adaptive Follow-Up System" })).toBeTruthy();

    // Cadence tiers with their static thresholds.
    expect(screen.getByRole("heading", { name: "Light Touch" })).toBeTruthy();
    expect(screen.getByText("Under $1,000")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Standard" })).toBeTruthy();
    expect(screen.getByText("$1,000 – $5,000")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "High Touch" })).toBeTruthy();
    expect(screen.getByText("Over $5,000")).toBeTruthy();

    expect(screen.getByRole("heading", { name: "How Objections Shape Follow-Up" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Long-Tail Nurture (No Abyss Rule)" })).toBeTruthy();
    expect(screen.getByText("Chose Another Provider")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Contact Method Best Practices" })).toBeTruthy();
    expect(screen.getByText("Call between 10am-12pm or 2pm-4pm")).toBeTruthy();
  });
});
