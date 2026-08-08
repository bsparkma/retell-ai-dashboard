/**
 * "Send to TC" — the voice side of the cross-module handoff (Mango slice M6).
 *
 * Two layers are pinned here:
 *
 *   1. The pure rules (lib/sendToTc.ts) — the visibility matrix and the exact
 *      copy. These are what a PM reviews and what must not drift between the two
 *      surfaces the button appears on.
 *   2. The component (SendToTcButton) in jsdom — that a failure never reads as
 *      success, that "created" and "added to an existing case" are distinguishable
 *      to the person reading the toast, and that a sent call stops offering a send.
 *
 * No PHI: the patient names here are the synthetic staging fixtures.
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Vitest compiles .tsx with esbuild's classic JSX transform, while the app's Vite build
// uses the automatic runtime — so component modules never import React themselves.
(globalThis as Record<string, unknown>).React = React;

interface CapturedToast {
  kind: string;
  text: string;
  action?: { label: string; onClick: () => void };
}
const toasts = vi.hoisted(() => ({ calls: [] as CapturedToast[] }));
vi.mock("sonner", () => ({
  toast: {
    success: (text: string, opts?: { action?: { label: string; onClick: () => void } }) =>
      toasts.calls.push({ kind: "success", text, action: opts?.action }),
    info: (text: string) => toasts.calls.push({ kind: "info", text }),
    error: (text: string) => toasts.calls.push({ kind: "error", text }),
  },
}));

const navigated = vi.hoisted(() => ({ to: [] as string[] }));
vi.mock("wouter", () => ({
  useLocation: () => ["/calls", (to: string) => navigated.to.push(to)],
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

const authMock = vi.hoisted(() => ({ modules: ["voice", "tc"] as string[] | undefined }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: { name: "Sarah Front", email: "sarah@carein.ai", tenantId: "t1", tenant: { slug: "carein", displayName: "CareIN", modules: authMock.modules } },
  }),
}));

const apiMock = vi.hoisted(() => ({ sendCallToTc: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, ...apiMock } };
});

import { ApiError, type UnifiedCall } from "@/lib/api";
import {
  sendToTcState, tcErrorMessage, tcSuccessMessage, type SendToTcCall,
} from "@/lib/sendToTc";
import { hasModule } from "@/lib/modules";
import { SendToTcButton } from "@/pages/calls/SendToTcButton";

/** A matched, sendable Roland call — only the fields this feature reads. */
function sendableCall(over: Partial<UnifiedCall> = {}): UnifiedCall {
  return {
    id: "call_m6_1",
    officeId: "roland",
    odPatientId: 7115,
    odPatientName: "Stedi TestValley",
    tcCaseId: null,
    tcCaseUrl: null,
    ...over,
  } as UnifiedCall;
}

beforeEach(() => {
  toasts.calls.length = 0;
  navigated.to.length = 0;
  authMock.modules = ["voice", "tc"];
  apiMock.sendCallToTc.mockReset();
});

afterEach(cleanup);

// ---------------------------------------------------------------------------

describe("visibility matrix", () => {
  const base: SendToTcCall = {
    officeId: "roland",
    odPatientId: 7115,
    odPatientName: "Stedi TestValley",
    tcCaseId: null,
  };

  it("is ready when the tenant has tc, the patient is matched, and the office is known", () => {
    expect(sendToTcState(base, true)).toEqual({ kind: "ready" });
  });

  it("is hidden for a voice-only tenant — no door into a product they don't have", () => {
    expect(sendToTcState(base, false)).toEqual({ kind: "hidden" });
  });

  it("is hidden when no patient is matched", () => {
    expect(sendToTcState({ ...base, odPatientId: null }, true)).toEqual({ kind: "hidden" });
    expect(sendToTcState({ ...base, odPatientId: "" }, true)).toEqual({ kind: "hidden" });
  });

  it("is hidden when the office is unknown or absent — a case needs a practice", () => {
    expect(sendToTcState({ ...base, officeId: "unknown" }, true)).toEqual({ kind: "hidden" });
    expect(sendToTcState({ ...base, officeId: null }, true)).toEqual({ kind: "hidden" });
  });

  it("is ready for either real office", () => {
    expect(sendToTcState({ ...base, officeId: "valley" }, true).kind).toBe("ready");
    expect(sendToTcState({ ...base, officeId: "roland" }, true).kind).toBe("ready");
  });

  it("is disabled — not hidden — when the matched patient has no stored name", () => {
    // Recoverable (re-match the call), and the contract REQUIRES patient_name, so
    // the honest move is to show why rather than silently offer nothing.
    expect(sendToTcState({ ...base, odPatientName: null }, true))
      .toEqual({ kind: "disabled", reason: "patient name unavailable" });
    expect(sendToTcState({ ...base, odPatientName: "   " }, true).kind).toBe("disabled");
  });

  it("becomes a passive 'sent' link once the call is on a case", () => {
    expect(sendToTcState({ ...base, tcCaseId: "case_1", tcCaseUrl: "/tc/cases/case_1" }, true))
      .toEqual({ kind: "sent", caseUrl: "/tc/cases/case_1" });
  });

  it("still reports 'sent' when the stored case url is missing", () => {
    expect(sendToTcState({ ...base, tcCaseId: "case_1", tcCaseUrl: null }, true))
      .toEqual({ kind: "sent", caseUrl: null });
  });

  it("entitlement fails closed when /auth/me carried no module list", () => {
    expect(hasModule(undefined, "tc")).toBe(false);
    expect(hasModule([], "tc")).toBe(false);
    expect(hasModule(["voice"], "tc")).toBe(false);
    expect(hasModule(["voice", "tc"], "tc")).toBe(true);
  });
});

describe("copy", () => {
  it("distinguishes a new case from one the call was added to", () => {
    expect(tcSuccessMessage("Stedi TestValley", false)).toBe("Case created in TC for Stedi TestValley");
    expect(tcSuccessMessage("Stedi TestValley", true)).toBe("Added to Stedi TestValley's existing TC case");
    expect(tcSuccessMessage("Stedi TestValley", null)).toBe("Stedi TestValley is already in TC");
  });

  it("never claims something was sent when it wasn't", () => {
    expect(tcErrorMessage(403, "MODULE_NOT_ENTITLED")).toBe("The TC module isn't enabled.");
    expect(tcErrorMessage(502, "TC_UNREACHABLE")).toBe("Couldn't reach the TC app — nothing was sent. Try again.");
    expect(tcErrorMessage(502, "TC_ENDPOINT_MISSING")).toBe("Couldn't reach the TC app — nothing was sent. Try again.");
    expect(tcErrorMessage(500, null)).toBe("Couldn't reach the TC app — nothing was sent. Try again.");
    expect(tcErrorMessage(409, "OFFICE_MISMATCH")).toContain("nothing was sent");
    expect(tcErrorMessage(409, "NO_MATCHED_PATIENT")).toContain("nothing was sent");
  });
});

describe("SendToTcButton", () => {
  it("renders nothing for a voice-only tenant", () => {
    authMock.modules = ["voice"];
    const { container } = render(<SendToTcButton call={sendableCall()} onSent={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("renders nothing for a call whose office is unknown", () => {
    const { container } = render(
      <SendToTcButton call={sendableCall({ officeId: "unknown" })} onSent={() => {}} />,
    );
    expect(container.textContent).toBe("");
  });

  it("is disabled with a reason when the patient name is missing, and cannot fire", () => {
    render(<SendToTcButton call={sendableCall({ odPatientName: null })} onSent={() => {}} />);
    const button = screen.getByRole("button", { name: /send to tc/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe("patient name unavailable");
    fireEvent.click(button);
    expect(apiMock.sendCallToTc).not.toHaveBeenCalled();
  });

  it("sends the call and reports a NEW case, with an Open in TC action", async () => {
    apiMock.sendCallToTc.mockResolvedValue({
      success: true, caseId: "case_new", url: "/tc/cases/case_new", attached: false,
    });
    const onSent = vi.fn();
    render(<SendToTcButton call={sendableCall()} onSent={onSent} />);

    fireEvent.click(screen.getByRole("button", { name: /send to tc/i }));

    await waitFor(() => expect(toasts.calls).toHaveLength(1));
    expect(apiMock.sendCallToTc).toHaveBeenCalledWith("call_m6_1", { office_id: "roland" });
    expect(toasts.calls[0].kind).toBe("success");
    expect(toasts.calls[0].text).toBe("Case created in TC for Stedi TestValley");
    expect(toasts.calls[0].action?.label).toBe("Open in TC");
    expect(onSent).toHaveBeenCalledWith({ caseId: "case_new", caseUrl: "/tc/cases/case_new" });

    // The action navigates to the case the server named — not a guessed route.
    toasts.calls[0].action?.onClick();
    expect(navigated.to).toEqual(["/tc/cases/case_new"]);
  });

  it("reports an ATTACH distinctly from a create", async () => {
    apiMock.sendCallToTc.mockResolvedValue({
      success: true, caseId: "case_open", url: "/tc/cases/case_open", attached: true,
    });
    render(<SendToTcButton call={sendableCall()} onSent={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /send to tc/i }));

    await waitFor(() => expect(toasts.calls).toHaveLength(1));
    expect(toasts.calls[0].text).toBe("Added to Stedi TestValley's existing TC case");
  });

  it("shows 'Sending…' and disables the button while in flight", async () => {
    let release: (v: unknown) => void = () => {};
    apiMock.sendCallToTc.mockReturnValue(new Promise((r) => { release = r; }));
    render(<SendToTcButton call={sendableCall()} onSent={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /send to tc/i }));

    const sending = await screen.findByRole("button", { name: /sending/i }) as HTMLButtonElement;
    expect(sending.disabled).toBe(true);
    release({ success: true, caseId: "c", url: "/tc/cases/c", attached: false });
  });

  it("a failed send never claims success and never reports a case", async () => {
    apiMock.sendCallToTc.mockRejectedValue(new ApiError("boom", 502, "TC_UNREACHABLE"));
    const onSent = vi.fn();
    render(<SendToTcButton call={sendableCall()} onSent={onSent} />);

    fireEvent.click(screen.getByRole("button", { name: /send to tc/i }));

    await waitFor(() => expect(toasts.calls).toHaveLength(1));
    expect(toasts.calls[0].kind).toBe("error");
    expect(toasts.calls[0].text).toBe("Couldn't reach the TC app — nothing was sent. Try again.");
    expect(onSent).not.toHaveBeenCalled();
    // And the button is usable again — the failure is retryable.
    expect((screen.getByRole("button", { name: /send to tc/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a 403 says the module isn't enabled rather than blaming the network", async () => {
    apiMock.sendCallToTc.mockRejectedValue(new ApiError("nope", 403, "MODULE_NOT_ENTITLED"));
    render(<SendToTcButton call={sendableCall()} onSent={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /send to tc/i }));

    await waitFor(() => expect(toasts.calls).toHaveLength(1));
    expect(toasts.calls[0].text).toBe("The TC module isn't enabled.");
  });

  it("an already-sent call shows a passive 'In TC' link, not a send button", () => {
    render(
      <SendToTcButton
        call={sendableCall({ tcCaseId: "case_done", tcCaseUrl: "/tc/cases/case_done" })}
        onSent={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /send to tc/i })).toBeNull();
    const link = screen.getByRole("link", { name: /in tc/i });
    expect(link.getAttribute("href")).toBe("/tc/cases/case_done");
  });
});
