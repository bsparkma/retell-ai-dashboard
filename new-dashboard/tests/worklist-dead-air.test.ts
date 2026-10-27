/**
 * "Dropped by Karen" on the worklist: the server-derived flag survives normalization, and
 * unworked flagged calls sort to the top in either date order.
 */
import { describe, it, expect } from "vitest";
import { isUnworkedDeadAir, sortWorklist } from "@/lib/worklist";
import { normalizeUnifiedCall, type BackendUnifiedCall, type UnifiedCall } from "@/lib/api";

function call(overrides: Partial<UnifiedCall>): UnifiedCall {
  return {
    id: "x",
    source: "retell",
    date: "2026-10-20T15:00:00.000Z",
    triageStatus: "new",
    notAPatient: false,
    disposition: null,
    linkRole: null,
    isPruned: false,
    agentDeadAir: false,
    ...overrides,
  } as UnifiedCall;
}

describe("normalizeUnifiedCall → agentDeadAir", () => {
  const base = { id: "call_test", source: "retell" } as BackendUnifiedCall;
  it("is true only for a literal true from the server", () => {
    expect(normalizeUnifiedCall({ ...base, agent_dead_air: true }).agentDeadAir).toBe(true);
    expect(normalizeUnifiedCall({ ...base, agent_dead_air: false }).agentDeadAir).toBe(false);
    expect(normalizeUnifiedCall({ ...base, agent_dead_air: null }).agentDeadAir).toBe(false);
    expect(normalizeUnifiedCall(base).agentDeadAir).toBe(false);
  });
});

describe("isUnworkedDeadAir", () => {
  it("is the flag AND still needing attention", () => {
    expect(isUnworkedDeadAir(call({ agentDeadAir: true }), "all")).toBe(true);
    expect(isUnworkedDeadAir(call({ agentDeadAir: false }), "all")).toBe(false);
    expect(isUnworkedDeadAir(call({ agentDeadAir: true, triageStatus: "done" }), "all")).toBe(false);
    expect(isUnworkedDeadAir(call({ agentDeadAir: true, disposition: "vendor" as UnifiedCall["disposition"] }), "all")).toBe(false);
  });
});

describe("sortWorklist", () => {
  const older = call({ id: "older", date: "2026-10-18T15:00:00.000Z" });
  const newer = call({ id: "newer", date: "2026-10-22T15:00:00.000Z" });
  const droppedOld = call({ id: "dropped-old", date: "2026-10-10T15:00:00.000Z", agentDeadAir: true });
  const droppedWorked = call({ id: "dropped-worked", date: "2026-10-25T15:00:00.000Z", agentDeadAir: true, triageStatus: "done" });

  it("puts unworked dropped calls first in newest-first order", () => {
    const ids = sortWorklist([older, newer, droppedOld, droppedWorked], "newest", "all").map((c) => c.id);
    expect(ids).toEqual(["dropped-old", "dropped-worked", "newer", "older"]);
  });

  it("puts unworked dropped calls first in oldest-first order too", () => {
    const ids = sortWorklist([newer, droppedWorked, older, droppedOld], "oldest", "all").map((c) => c.id);
    expect(ids).toEqual(["dropped-old", "older", "newer", "dropped-worked"]);
  });

  it("does not mutate its input", () => {
    const input = [older, droppedOld];
    sortWorklist(input, "newest", "all");
    expect(input.map((c) => c.id)).toEqual(["older", "dropped-old"]);
  });
});
