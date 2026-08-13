import { describe, it, expect } from "vitest";
import { officeHealthDisplay, elapsedLabel } from "../client/src/lib/odHealth";
import type { OdOfficeHealth } from "../client/src/lib/api";

/**
 * The office picker's Open Dental indicator.
 *
 * The thing being pinned is honesty, not pixels: "we have not asked yet" must
 * never render as healthy, a configuration gap must never render as an outage,
 * and an outage must never quietly change whether the office counts as
 * connected (the action buttons read `odConnected`, and a network blip taking
 * away a practice's ability to file chart notes would be a far worse failure
 * than a missing warning icon).
 */

const NOW = Date.parse("2026-08-13T18:00:00.000Z");

function health(overrides: Partial<OdOfficeHealth> = {}): OdOfficeHealth {
  return {
    officeKey: "roland",
    officeName: "Roland",
    status: "up",
    eligible: true,
    ineligibleReason: null,
    lastCheckedAt: "2026-08-13T17:58:00.000Z",
    lastOkAt: "2026-08-13T17:58:00.000Z",
    lastTransitionAt: "2026-08-13T09:00:00.000Z",
    consecutiveFailures: 0,
    lastFailureKind: null,
    lastFailureDetail: null,
    lastLatencyMs: 120,
    probes: 96,
    serverVersion: "25.4.48.0",
    ...overrides,
  };
}

describe("officeHealthDisplay", () => {
  it("renders a reachable office quietly, with the check age in the tooltip", () => {
    const display = officeHealthDisplay({ odConnected: true, odHealth: health() }, NOW);
    expect(display.tone).toBe("ok");
    expect(display.warn).toBe(false);
    expect(display.title).toBe("Open Dental: reachable (checked 2m ago)");
  });

  it("never renders an unprobed office as up", () => {
    const unknown = officeHealthDisplay(
      { odConnected: true, odHealth: health({ status: "unknown", lastCheckedAt: null }) },
      NOW,
    );
    expect(unknown.tone).toBe("unknown");
    expect(unknown.title).toBe("Open Dental: not checked yet");

    // An older backend, or a payload built before the health check shipped,
    // omits the field entirely. That is "we don't know", not "it's fine".
    const missing = officeHealthDisplay({ odConnected: true }, NOW);
    expect(missing.tone).toBe("unknown");

    // Neither shows a warning glyph — a badge for "we haven't asked yet" would
    // cry wolf on every single deploy, which is how monitors get ignored.
    expect(unknown.warn).toBe(false);
    expect(missing.warn).toBe(false);
  });

  it("names the failure and how long it has been running", () => {
    const display = officeHealthDisplay(
      {
        odConnected: true,
        odHealth: health({
          status: "down",
          lastFailureKind: "timeout",
          lastTransitionAt: "2026-08-13T17:48:00.000Z",
        }),
      },
      NOW,
    );
    expect(display.tone).toBe("down");
    expect(display.warn).toBe(true);
    expect(display.title).toBe(
      "Open Dental is not responding — since 12m ago. Chart notes will not send until it is back.",
    );
  });

  it("distinguishes a rejected credential from a dead connector", () => {
    const auth = officeHealthDisplay(
      { odConnected: true, odHealth: health({ status: "down", lastFailureKind: "auth" }) },
      NOW,
    );
    expect(auth.title).toContain("rejecting our credentials");

    const server = officeHealthDisplay(
      { odConnected: true, odHealth: health({ status: "down", lastFailureKind: "server_error" }) },
      NOW,
    );
    expect(server.title).toContain("returning errors");
  });

  it("reports a configuration gap as a configuration gap, not an outage", () => {
    const display = officeHealthDisplay(
      {
        odConnected: false,
        odBlockedReason: "Open Dental credentials are not configured for Valley Fort Smith",
        // Even with a stale 'up' observation attached, configuration wins: an
        // office nobody switched on has no reachability worth reporting, and
        // "unreachable" would send someone to check a healthy network.
        odHealth: health({ status: "up" }),
      },
      NOW,
    );
    expect(display.tone).toBe("not_connected");
    expect(display.title).toBe("Open Dental credentials are not configured for Valley Fort Smith");
  });

  it("falls back to a readable sentence when the backend sends no blocked reason", () => {
    const display = officeHealthDisplay({ odConnected: false }, NOW);
    expect(display.tone).toBe("not_connected");
    expect(display.title).toBe("Open Dental is not connected for this office yet");
  });

  it("omits the elapsed clause rather than printing a bad one", () => {
    const display = officeHealthDisplay(
      {
        odConnected: true,
        odHealth: health({ status: "down", lastFailureKind: "timeout", lastTransitionAt: null }),
      },
      NOW,
    );
    expect(display.title).toBe(
      "Open Dental is not responding. Chart notes will not send until it is back.",
    );
  });
});

describe("elapsedLabel", () => {
  it("reads in the units a human would use", () => {
    expect(elapsedLabel("2026-08-13T17:59:40.000Z", NOW)).toBe("just now");
    expect(elapsedLabel("2026-08-13T17:45:00.000Z", NOW)).toBe("15m");
    expect(elapsedLabel("2026-08-13T14:00:00.000Z", NOW)).toBe("4h");
  });

  it("answers null for anything it cannot honestly label", () => {
    expect(elapsedLabel(null, NOW)).toBeNull();
    expect(elapsedLabel(undefined, NOW)).toBeNull();
    expect(elapsedLabel("not a date", NOW)).toBeNull();
    // A clock-skewed future timestamp: no clause beats "since -3m ago".
    expect(elapsedLabel("2026-08-13T18:03:00.000Z", NOW)).toBeNull();
  });
});
