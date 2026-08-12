/**
 * Global 401 handling (Roles PR B).
 *
 * The failure this kills: an 8-hour SSO session expires (or the container
 * restarts and drops the signing key), and every subsequent call turns into an
 * unexplained red toast while the page quietly stops working.
 *
 * The line that must NOT move: 403 is not 401. A 403 means we know exactly who
 * you are and the answer is no — signing someone out for it would be both wrong
 * and infuriating.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetUnauthorizedLatch, api, setUnauthorizedHandler } from "@/lib/api";

/** jsdom is not loaded for .ts tests; lib/api needs window.location.origin. */
(globalThis as Record<string, unknown>).window ??= { location: { origin: "http://localhost" } };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  } as Response;
}

let fired: number;

beforeEach(() => {
  fired = 0;
  _resetUnauthorizedLatch();
  setUnauthorizedHandler(() => {
    fired += 1;
  });
});

afterEach(() => {
  setUnauthorizedHandler(null);
  _resetUnauthorizedLatch();
  vi.unstubAllGlobals();
});

describe("401 handling", () => {
  it("fires the handler on a 401 from any API call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "Unauthorized" })));

    await expect(api.listUsers()).rejects.toThrow();
    expect(fired).toBe(1);
  });

  it("fires ONCE even when several parallel calls all 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "Unauthorized" })));

    // A page mounting six widgets against a dead session must produce one
    // sign-out, not six toasts and six redirects.
    await Promise.allSettled([api.listUsers(), api.listUsers(), api.listUsers()]);
    expect(fired).toBe(1);
  });

  it("does NOT fire on a 403 — that is a permission state, not a sign-out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { error: "Forbidden", code: "FORBIDDEN" })),
    );

    await expect(api.listUsers()).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(fired).toBe(0);
  });

  it("does not fire on 404, 409, 500, or a success", async () => {
    for (const status of [200, 404, 409, 500]) {
      _resetUnauthorizedLatch();
      fired = 0;
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(status, { users: [], roles: [], actor: "" })));
      await api.listUsers().catch(() => undefined);
      expect(fired, `status ${status}`).toBe(0);
    }
  });

  it("still rejects the caller — the interceptor observes, it does not swallow", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "Unauthorized" })));

    // Callers must still see the failure; a silently-resolved promise would
    // leave a page rendering an empty success state on its way out.
    await expect(api.listUsers()).rejects.toMatchObject({ status: 401 });
  });

  it("is a no-op when no handler is registered", async () => {
    setUnauthorizedHandler(null);
    _resetUnauthorizedLatch();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, {})));

    await expect(api.listUsers()).rejects.toThrow();
  });
});
