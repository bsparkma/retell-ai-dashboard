/**
 * useFinancingLibrary — settings reactivity for the calculators (PM ruling 6.2).
 *
 * The legacy DentaFlow calculator re-read localStorage on focus / storage / a
 * custom event. On the platform the settings are server-owned, so the honest
 * equivalent is a re-fetch on window focus (and on office change). These tests
 * pin that behavior plus the race/unmount handling: a stale response can never
 * overwrite a newer one, another office's data is never rendered, and no
 * listener survives unmount.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

const getLibrary = vi.fn();

vi.mock("@/features/tc/api", () => ({
  getLibrary: (...args: unknown[]) => getLibrary(...args),
  tcErrorMessage: (e: unknown) => (e instanceof Error ? e.message : "Request failed"),
}));

import { useFinancingLibrary } from "@/features/tc/calc/useFinancingLibrary";

/** A library with one enabled provider, tagged so we can tell offices apart. */
function libraryFor(label: string) {
  return {
    financing_providers: [
      {
        key: "cherry",
        label,
        logo: "CH",
        color: "var(--chart-2)",
        description: "",
        terms: [6, 12],
        promoTerms: [6],
        minAmountCents: 20_000,
        promoApr: 0,
        regularApr: 9.9,
        enabled: true,
      },
    ],
  };
}

/** A promise we resolve by hand, to control response ordering. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  getLibrary.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("useFinancingLibrary", () => {
  it("loads the office's library and adapts it into the calculator view", async () => {
    getLibrary.mockResolvedValue(libraryFor("Cherry"));

    const { result } = renderHook(() => useFinancingLibrary("roland"));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.library).not.toBeNull());
    expect(getLibrary).toHaveBeenCalledWith("roland");
    expect(result.current.loading).toBe(false);
    expect(result.current.view.configured).toBe(true);
    expect(result.current.view.providers.map((p) => p.name)).toEqual(["Cherry"]);
  });

  it("re-fetches when the window regains focus (Library → Financing edits)", async () => {
    getLibrary.mockResolvedValue(libraryFor("Cherry"));
    const { result } = renderHook(() => useFinancingLibrary("roland"));
    await waitFor(() => expect(result.current.library).not.toBeNull());
    expect(getLibrary).toHaveBeenCalledTimes(1);

    getLibrary.mockResolvedValue(libraryFor("Cherry (renamed in Library)"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() =>
      expect(result.current.view.providers[0]?.name).toBe("Cherry (renamed in Library)"),
    );
    expect(getLibrary).toHaveBeenCalledTimes(2);
  });

  it("re-fetches when the tab becomes visible again", async () => {
    getLibrary.mockResolvedValue(libraryFor("Cherry"));
    const { result } = renderHook(() => useFinancingLibrary("roland"));
    await waitFor(() => expect(result.current.library).not.toBeNull());

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // jsdom reports visibilityState "visible" by default.
    await waitFor(() => expect(getLibrary).toHaveBeenCalledTimes(2));
  });

  it("does not poll", async () => {
    vi.useFakeTimers();
    try {
      getLibrary.mockResolvedValue(libraryFor("Cherry"));
      renderHook(() => useFinancingLibrary("roland"));
      await act(async () => {
        vi.advanceTimersByTime(120_000);
      });
      expect(getLibrary).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never renders the previous office's library after a switch", async () => {
    const roland = deferred<unknown>();
    const valley = deferred<unknown>();
    getLibrary.mockImplementationOnce(() => roland.promise).mockImplementationOnce(() => valley.promise);

    const { result, rerender } = renderHook(
      ({ office }: { office: "roland" | "valley" }) => useFinancingLibrary(office),
      { initialProps: { office: "roland" as const } },
    );

    rerender({ office: "valley" as const });
    // Roland's response lands AFTER the switch — it must be discarded.
    await act(async () => {
      roland.resolve(libraryFor("Roland provider"));
    });
    expect(result.current.library).toBeNull();
    expect(result.current.view.providers).toEqual([]);

    await act(async () => {
      valley.resolve(libraryFor("Valley provider"));
    });
    await waitFor(() =>
      expect(result.current.view.providers[0]?.name).toBe("Valley provider"),
    );
  });

  it("discards a slow refresh that lands after a newer one", async () => {
    const slow = deferred<unknown>();
    const fast = deferred<unknown>();
    getLibrary.mockImplementationOnce(() => slow.promise).mockImplementationOnce(() => fast.promise);

    const { result } = renderHook(() => useFinancingLibrary("roland"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {
      fast.resolve(libraryFor("Newest"));
    });
    await waitFor(() => expect(result.current.view.providers[0]?.name).toBe("Newest"));

    await act(async () => {
      slow.resolve(libraryFor("Stale"));
    });
    expect(result.current.view.providers[0]?.name).toBe("Newest");
  });

  it("keeps the last-known library when a refresh fails, and reports the error", async () => {
    getLibrary.mockResolvedValueOnce(libraryFor("Cherry"));
    const { result } = renderHook(() => useFinancingLibrary("roland"));
    await waitFor(() => expect(result.current.library).not.toBeNull());

    getLibrary.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(result.current.error).toBe("offline"));
    // A failed refresh must not blank the calculator mid-consult.
    expect(result.current.view.providers[0]?.name).toBe("Cherry");
  });

  it("fetches nothing when disabled or when no office is selected", async () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useFinancingLibrary("roland", { enabled }),
      { initialProps: { enabled: false } },
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(getLibrary).not.toHaveBeenCalled();

    getLibrary.mockResolvedValue(libraryFor("Cherry"));
    rerender({ enabled: true });
    await waitFor(() => expect(getLibrary).toHaveBeenCalledTimes(1));

    renderHook(() => useFinancingLibrary(null));
    expect(getLibrary).toHaveBeenCalledTimes(1);
  });

  it("removes its listeners on unmount (no work after teardown)", async () => {
    getLibrary.mockResolvedValue(libraryFor("Cherry"));
    const { result, unmount } = renderHook(() => useFinancingLibrary("roland"));
    await waitFor(() => expect(result.current.library).not.toBeNull());

    unmount();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(getLibrary).toHaveBeenCalledTimes(1);
  });
});
