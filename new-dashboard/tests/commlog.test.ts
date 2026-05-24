/**
 * Tests for the OpenDentalCommlogWriter interface and MockCommlogWriter.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockCommlogWriter, createCommlogWriter } from "../server/lib/commlog.js";
import type { CommlogWriteInput } from "../server/lib/types.js";

function makeInput(overrides: Partial<CommlogWriteInput> = {}): CommlogWriteInput {
  return {
    callId: "call_test_001",
    callerName: "Jane Doe",
    callerNumber: "+16025550100",
    office: "Downtown Dental",
    startedAt: "2026-05-10T10:00:00.000Z",
    durationSeconds: 120,
    summary: "Patient called to schedule an appointment.",
    tag: "appointment_scheduled",
    outcome: "Appointment scheduled",
    ...overrides,
  };
}

describe("MockCommlogWriter", () => {
  let writer: MockCommlogWriter;

  beforeEach(() => {
    writer = new MockCommlogWriter();
  });

  it("succeeds by default", async () => {
    const result = await writer.write(makeInput());
    expect(result.success).toBe(true);
    expect(result.commlogId).toBeDefined();
    expect(result.commlogId!.startsWith("cl_")).toBe(true);
  });

  it("records every write attempt", async () => {
    await writer.write(makeInput({ callId: "call_001" }));
    await writer.write(makeInput({ callId: "call_002" }));
    expect(writer.writes).toHaveLength(2);
    expect(writer.writes[0]!.callId).toBe("call_001");
    expect(writer.writes[1]!.callId).toBe("call_002");
  });

  it("returns unique commlogIds for each write", async () => {
    const r1 = await writer.write(makeInput());
    const r2 = await writer.write(makeInput());
    expect(r1.commlogId).not.toBe(r2.commlogId);
  });

  it("fails when behavior is 'failure'", async () => {
    const w = new MockCommlogWriter({ behavior: "failure" });
    const result = await w.write(makeInput());
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it("throws when behavior is 'network_error'", async () => {
    const w = new MockCommlogWriter({ behavior: "network_error" });
    await expect(w.write(makeInput())).rejects.toThrow();
  });

  it("applies per-callId behavior overrides", async () => {
    const w = new MockCommlogWriter({
      behavior: "success",
      overrides: { "call_bad": "failure" },
    });

    const good = await w.write(makeInput({ callId: "call_good" }));
    const bad = await w.write(makeInput({ callId: "call_bad" }));

    expect(good.success).toBe(true);
    expect(bad.success).toBe(false);
  });

  it("records write input even when behavior is failure", async () => {
    const w = new MockCommlogWriter({ behavior: "failure" });
    await w.write(makeInput({ callId: "call_fail" }));
    expect(w.writes).toHaveLength(1);
    expect(w.writes[0]!.callId).toBe("call_fail");
  });

  it("simulates delay when delayMs is set", async () => {
    const w = new MockCommlogWriter({ delayMs: 10 });
    const start = Date.now();
    await w.write(makeInput());
    expect(Date.now() - start).toBeGreaterThanOrEqual(10);
  });

  it("includes all input fields in the write record", async () => {
    const input = makeInput();
    await writer.write(input);
    const recorded = writer.writes[0]!;
    expect(recorded.callerName).toBe(input.callerName);
    expect(recorded.callerNumber).toBe(input.callerNumber);
    expect(recorded.office).toBe(input.office);
    expect(recorded.summary).toBe(input.summary);
    expect(recorded.tag).toBe(input.tag);
    expect(recorded.outcome).toBe(input.outcome);
  });
});

describe("createCommlogWriter", () => {
  it("returns a MockCommlogWriter when OPENDENTAL_API_URL is not set", () => {
    const w = createCommlogWriter();
    expect(w).toBeInstanceOf(MockCommlogWriter);
  });

  it("the returned writer writes successfully", async () => {
    const w = createCommlogWriter({ behavior: "success" });
    const result = await w.write(makeInput());
    expect(result.success).toBe(true);
  });
});
