/**
 * Background tabs stop polling, and being throttled is not being offline.
 *
 * THE INCIDENT (prod, 2026-08-12): every open tab polled on a timer regardless of
 * visibility. Together they exhausted the API rate limit inside the first couple of
 * minutes of each 15-minute window, and the dashboard rendered the resulting 429s as
 * "Backend is offline" — sending people to reload a backend that was answering fine.
 *
 * These pin the two client-side halves of the fix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePolling } from "../client/src/hooks/usePolling";
import { ApiError, isRateLimited } from "../client/src/lib/api";

/** Drive document.visibilityState, which is read-only in jsdom. */
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("usePolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs immediately and then on the interval while visible", () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 60_000));

    expect(fn).toHaveBeenCalledTimes(1);           // immediate catch-up
    act(() => { vi.advanceTimersByTime(180_000); });
    expect(fn).toHaveBeenCalledTimes(4);           // + three ticks
  });

  it("spends nothing while the tab is hidden — the whole point", () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 60_000));
    fn.mockClear();

    act(() => { setVisibility("hidden"); });
    act(() => { vi.advanceTimersByTime(600_000); });   // ten minutes in the background

    expect(fn).not.toHaveBeenCalled();
  });

  it("catches up once on return, then resumes the cadence", () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 60_000));
    act(() => { setVisibility("hidden"); });
    act(() => { vi.advanceTimersByTime(600_000); });
    fn.mockClear();

    act(() => { setVisibility("visible"); });
    expect(fn).toHaveBeenCalledTimes(1);           // one catch-up, NOT ten queued ticks

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops polling when unmounted", () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() => usePolling(fn, 60_000));
    fn.mockClear();

    unmount();
    act(() => { vi.advanceTimersByTime(300_000); });
    expect(fn).not.toHaveBeenCalled();
  });

  it("does nothing at all when the interval is null", () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, null));
    act(() => { vi.advanceTimersByTime(300_000); });
    expect(fn).not.toHaveBeenCalled();
  });

  it("a changing callback does not restart the timer", () => {
    // A caller passing an inline arrow re-renders constantly; if that reset the
    // interval the poll would never actually fire.
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ f }) => usePolling(f, 60_000), {
      initialProps: { f: first },
    });

    act(() => { vi.advanceTimersByTime(30_000); });
    rerender({ f: second });
    act(() => { vi.advanceTimersByTime(30_000); });

    // The tick at t=60s fires the LATEST callback, and the timer was never restarted.
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("isRateLimited", () => {
  it("identifies a 429 so the UI can say busy instead of offline", () => {
    expect(isRateLimited(new ApiError("Too many requests", 429, "RATE_LIMITED", 900))).toBe(true);
  });

  it("does not mistake a real outage or a permission refusal for throttling", () => {
    expect(isRateLimited(new ApiError("Service Unavailable", 503, null))).toBe(false);
    expect(isRateLimited(new ApiError("Forbidden", 403, null))).toBe(false);
    expect(isRateLimited(new Error("network down"))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
  });

  it("carries Retry-After through so a caller can back off by the server's number", () => {
    const err = new ApiError("Too many requests", 429, "RATE_LIMITED", 900);
    expect(err.retryAfter).toBe(900);
  });

  it("defaults retryAfter to null when the server did not say", () => {
    expect(new ApiError("boom", 500, null).retryAfter).toBeNull();
  });
});
