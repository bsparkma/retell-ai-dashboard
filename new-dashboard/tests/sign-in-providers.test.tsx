/**
 * Sign-in screen — the second door (S2b).
 *
 * The Google / email-code button is drawn ONLY when /auth/providers says the
 * server has that door switched on, and the probe fails toward fewer buttons:
 * a broken or odd answer must never put a button on screen that leads to a
 * 404. The Microsoft button never depends on the probe.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

const calls = vi.hoisted(() => ({ login: 0, loginExternal: 0 }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    login: vi.fn(() => {
      calls.login += 1;
    }),
    loginExternal: vi.fn(() => {
      calls.loginExternal += 1;
    }),
  };
});

import SignIn from "@/pages/SignIn";
import { fetchProviders } from "@/lib/auth";

const realFetch = globalThis.fetch;

function answer(body: unknown, ok = true) {
  globalThis.fetch = vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

beforeEach(() => {
  calls.login = 0;
  calls.loginExternal = 0;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

describe("sign-in screen", () => {
  it("shows ONLY the Microsoft button while the external door is dark", async () => {
    answer({ microsoft: true, external: false });
    render(<SignIn />);

    expect(screen.getByRole("button", { name: "Sign in with Microsoft" })).toBeTruthy();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("sign-in-external")).toBeNull();
  });

  it("adds the Google / email-code button when the server says external:true", async () => {
    answer({ microsoft: true, external: true });
    render(<SignIn />);

    const ext = await screen.findByTestId("sign-in-external");
    expect(ext.textContent).toBe("Sign in with Google or email code");
    // The Microsoft button is untouched.
    expect(screen.getByRole("button", { name: "Sign in with Microsoft" })).toBeTruthy();

    fireEvent.click(ext);
    expect(calls.loginExternal).toBe(1);
    expect(calls.login).toBe(0);
  });

  it("the Microsoft button still goes to the staff door", async () => {
    answer({ microsoft: true, external: true });
    render(<SignIn />);
    await screen.findByTestId("sign-in-external");

    fireEvent.click(screen.getByRole("button", { name: "Sign in with Microsoft" }));
    expect(calls.login).toBe(1);
    expect(calls.loginExternal).toBe(0);
  });
});

describe("fetchProviders fails toward fewer buttons", () => {
  it.each([
    ["a network error", () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch;
    }],
    ["a non-2xx answer", () => answer({ external: true }, false)],
    ["a truthy non-boolean", () => answer({ external: "true" })],
    ["a non-object body", () => answer(null)],
  ])("%s → external:false", async (_label, arrange) => {
    arrange();
    expect(await fetchProviders()).toEqual({ microsoft: true, external: false });
  });
});
