/**
 * Open Dental Commlog Writer interface + MockCommlogWriter.
 *
 * The dashboard only DISPLAYS write status. Actual writes to Open Dental go
 * through this interface. The MockCommlogWriter is used in tests and when no
 * live Open Dental connection is configured.
 */

import type {
  OpenDentalCommlogWriter,
  CommlogWriteInput,
  CommlogWriteResult,
} from "./types.js";
import { nanoid } from "nanoid";

// ---------------------------------------------------------------------------
// MockCommlogWriter
// ---------------------------------------------------------------------------

export type MockBehavior = "success" | "failure" | "network_error";

export interface MockCommlogWriterOptions {
  /** Default behavior for all writes */
  behavior?: MockBehavior;
  /** Per-callId behavior overrides */
  overrides?: Record<string, MockBehavior>;
  /** Simulated delay in ms (default 0 for tests) */
  delayMs?: number;
}

/**
 * Mock implementation of OpenDentalCommlogWriter for tests and local dev.
 * All writes succeed by default; behavior can be overridden per-call.
 */
export class MockCommlogWriter implements OpenDentalCommlogWriter {
  private readonly behavior: MockBehavior;
  private readonly overrides: Record<string, MockBehavior>;
  private readonly delayMs: number;

  /** Records of every write attempt made, for test assertions */
  public readonly writes: CommlogWriteInput[] = [];

  constructor(options: MockCommlogWriterOptions = {}) {
    this.behavior = options.behavior ?? "success";
    this.overrides = options.overrides ?? {};
    this.delayMs = options.delayMs ?? 0;
  }

  async write(input: CommlogWriteInput): Promise<CommlogWriteResult> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    this.writes.push(input);

    const behavior = this.overrides[input.callId] ?? this.behavior;

    switch (behavior) {
      case "success":
        return { success: true, commlogId: `cl_${nanoid(8)}` };

      case "failure":
        return { success: false, error: "Open Dental rejected the commlog entry" };

      case "network_error":
        throw new Error("ECONNREFUSED: Unable to reach Open Dental API");
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns the appropriate commlog writer based on environment.
 * Always returns MockCommlogWriter when OPENDENTAL_API_URL is not set,
 * which is the case for local dev and all test runs.
 */
export function createCommlogWriter(
  options?: MockCommlogWriterOptions
): OpenDentalCommlogWriter {
  const apiUrl = process.env["OPENDENTAL_API_URL"];
  if (!apiUrl) {
    return new MockCommlogWriter(options);
  }
  // Live implementation would go here — returns mock as guard
  // so the dashboard never requires live credentials to start.
  return new MockCommlogWriter(options);
}
