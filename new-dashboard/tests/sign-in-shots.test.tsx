/**
 * Screenshot DUMP for the sign-in screen (S2b), with and without the external
 * door. Same shape as `dev-console-users-shots.test.tsx`: renders into jsdom
 * and writes `tests/.shots/signin-*.html`, which
 * `scripts/shoot-sign-in.mjs` wraps in the real built CSS and photographs.
 *
 *   signin-01-microsoft-only   /auth/providers says external:false (today)
 *   signin-02-with-external    /auth/providers says external:true
 *
 * NO NETWORK, NO BACKEND. Skipped unless SIGNIN_SHOTS=1.
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

(globalThis as Record<string, unknown>).React = React;

import SignIn from "@/pages/SignIn";

const OUT = resolve(import.meta.dirname, ".shots");
const SHOOT = process.env.SIGNIN_SHOTS === "1";
const realFetch = globalThis.fetch;

function dump(name: string) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `${name}.html`), document.body.innerHTML, "utf8");
}

function providers(external: boolean) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ microsoft: true, external }),
  })) as unknown as typeof fetch;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe.skipIf(!SHOOT)("sign-in — shots", () => {
  it("01 — Microsoft only (the external door is dark)", async () => {
    providers(false);
    render(<SignIn />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    dump("signin-01-microsoft-only");
  });

  it("02 — with the Google / email-code button", async () => {
    providers(true);
    render(<SignIn />);
    await screen.findByTestId("sign-in-external");
    dump("signin-02-with-external");
  });
});
