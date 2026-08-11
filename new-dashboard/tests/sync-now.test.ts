/**
 * "Sync now" copy — the per-source toast and the freshness caption.
 *
 * The whole point of the feature is that the button stops claiming a generic success, so
 * these tests pin the distinctions: off and already-running are NOT errors, a failure
 * names only the source that failed, and an empty pull says so plainly.
 */
import { describe, expect, it } from "vitest";
import { syncToast, syncCaption, SYNC_COOLDOWN_SECONDS } from "../client/src/lib/sync";
import type { SyncNowResponse } from "../client/src/lib/api";

const res = (over: Partial<SyncNowResponse>): SyncNowResponse => ({
  retell: { status: "ok", added: 0, fetched: 0 },
  mango: { status: "ok", found: 0, imported: 0 },
  lastSyncedAt: null,
  nextAutoSync: null,
  ...over,
});

describe("syncToast", () => {
  it("reports new calls per source, Mango first", () => {
    const t = syncToast(res({
      mango: { status: "ok", found: 12, imported: 3 },
      retell: { status: "ok", added: 1, fetched: 1000 },
    }));
    expect(t).toEqual({ kind: "success", message: "Mango: 3 new · Retell: 1 new" });
  });

  it("names only the source that actually brought something in", () => {
    const t = syncToast(res({ mango: { status: "ok", found: 4, imported: 2 } }));
    expect(t).toEqual({ kind: "success", message: "Mango: 2 new" });
  });

  it("says so plainly when both sources were healthy and empty", () => {
    expect(syncToast(res({}))).toEqual({ kind: "success", message: "Up to date — no new calls" });
  });

  it("treats an in-flight autosync as an answer, not a failure", () => {
    const t = syncToast(res({ mango: { status: "already_running" } }));
    expect(t.kind).toBe("success");
    expect(t.message).toContain("autosync already running");
  });

  it("says Mango ingestion is off rather than implying it pulled nothing", () => {
    const t = syncToast(res({ mango: { status: "off" }, retell: { status: "ok", added: 2, fetched: 50 } }));
    expect(t).toEqual({
      kind: "success",
      message: "Mango ingestion is off in this environment · Retell: 2 new",
    });
  });

  it("errors name only the failed source, with its reason", () => {
    const t = syncToast(res({
      retell: { status: "error", message: "Retell 503" },
      mango: { status: "ok", found: 1, imported: 1 },
    }));
    expect(t).toEqual({ kind: "error", message: "Retell sync failed: Retell 503" });
  });

  it("names both sources when both failed", () => {
    const t = syncToast(res({
      retell: { status: "error", message: "Retell 503" },
      mango: { status: "error", message: "token harvest failed" },
    }));
    expect(t.kind).toBe("error");
    expect(t.message).toBe("Mango sync failed: token harvest failed · Retell sync failed: Retell 503");
  });

  it("tolerates an error with no detail", () => {
    const t = syncToast(res({ retell: { status: "error" } }));
    expect(t).toEqual({ kind: "error", message: "Retell sync failed" });
  });
});

describe("syncCaption", () => {
  it("renders both clock times", () => {
    // Built from local-time Dates so the expectation holds in any CI timezone.
    const last = new Date(2026, 7, 11, 12, 19, 0);
    const next = new Date(2026, 7, 11, 13, 15, 0);
    const caption = syncCaption(last.toISOString(), next.toISOString());
    expect(caption).toBe(
      `Last synced ${last.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` +
      ` · next auto ${next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
    );
  });

  it("drops the half it does not know", () => {
    const next = new Date(2026, 7, 11, 13, 15, 0);
    expect(syncCaption(null, next.toISOString())).toMatch(/^next auto /);
    expect(syncCaption(null, null)).toBe("");
  });

  it("never renders an unparseable timestamp as a caption", () => {
    expect(syncCaption("not-a-date", null)).toBe("");
  });
});

describe("cooldown constant", () => {
  it("mirrors the backend's 60s manual-sync window", () => {
    expect(SYNC_COOLDOWN_SECONDS).toBe(60);
  });
});
