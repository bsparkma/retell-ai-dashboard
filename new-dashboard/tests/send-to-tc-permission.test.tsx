/**
 * Pre-IA fix F2 (docs/reports/feature-tc-incoming-work-ia.md §4 D2, §7):
 * the call's Send to TC button honours voice.send_to_tc, and a 403 names the
 * real reason.
 *
 * Before: the button checked the TC module only, so a `tc` user (who holds no
 * voice.send_to_tc) saw it, clicked, got a 403 — and was told "The TC module
 * isn't enabled", which was not true.
 *
 * No PHI: the patient is the synthetic Roland fixture.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

const toasts = vi.hoisted(() => ({ calls: [] as { kind: string; text: string }[] }));
vi.mock("sonner", () => ({
  toast: {
    success: (text: string) => toasts.calls.push({ kind: "success", text }),
    info: (text: string) => toasts.calls.push({ kind: "info", text }),
    error: (text: string) => toasts.calls.push({ kind: "error", text }),
  },
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/calls", () => {}],
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

const authMock = vi.hoisted(() => ({ role: "tc", permissions: [] as string[] }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: {
      name: "Test Coordinator",
      email: "coordinator@carein.ai",
      tenantId: "t1",
      tenant: { slug: "carein", displayName: "CareIN", modules: ["voice", "tc"] },
      role: authMock.role,
      isSuperAdmin: false,
      permissions: authMock.permissions,
    },
  }),
}));

const apiMock = vi.hoisted(() => ({ sendCallToTc: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, ...apiMock } };
});

import { ApiError, type UnifiedCall } from "@/lib/api";
import { sendToTcState, tcErrorMessage, type SendToTcCall } from "@/lib/sendToTc";
import { SendToTcButton } from "@/pages/calls/SendToTcButton";

function sendableCall(): UnifiedCall {
  return {
    id: "call_f2_1",
    officeId: "roland",
    odPatientId: 12827,
    odPatientName: "Test 2, Stedi",
    tcCaseId: null,
    tcCaseUrl: null,
  } as UnifiedCall;
}

const PERMISSION_COPY = "Your role can't send calls to TC — nothing was sent. Ask an admin if you need to.";

beforeEach(() => {
  toasts.calls.length = 0;
  authMock.role = "tc";
  authMock.permissions = ["tc.full", "tc.hygiene"];
  apiMock.sendCallToTc.mockReset();
});
afterEach(cleanup);

describe("F2: the visibility rule reads the permission", () => {
  const base: SendToTcCall = { officeId: "roland", odPatientId: 12827, odPatientName: "Test 2, Stedi", tcCaseId: null };

  it("a user without voice.send_to_tc gets no button, even with the module", () => {
    expect(sendToTcState(base, true, false)).toEqual({ kind: "hidden" });
  });

  it("with the permission and the module it is ready", () => {
    expect(sendToTcState(base, true, true)).toEqual({ kind: "ready" });
  });

  it("the module still gates first", () => {
    expect(sendToTcState(base, false, true)).toEqual({ kind: "hidden" });
  });
});

describe("F2: a 403 names the real reason", () => {
  it("a permission refusal (FORBIDDEN) says the role can't, not that the module is off", () => {
    expect(tcErrorMessage(403, "FORBIDDEN")).toBe(PERMISSION_COPY);
    expect(tcErrorMessage(403, null)).toBe(PERMISSION_COPY);
  });

  it("a module refusal still says the module isn't enabled — from either side of the loopback", () => {
    expect(tcErrorMessage(403, "MODULE_NOT_ENTITLED")).toBe("The TC module isn't enabled.");
    expect(tcErrorMessage(502, "TC_MODULE_NOT_ENTITLED")).toBe("The TC module isn't enabled.");
  });
});

describe("F2: SendToTcButton", () => {
  it("a `tc` user (no voice.send_to_tc) sees no Send to TC — in the panel or the worklist icon", () => {
    const { container } = render(<SendToTcButton call={sendableCall()} onSent={() => {}} variant="panel" />);
    expect(container.innerHTML).toBe("");
    const icon = render(<SendToTcButton call={sendableCall()} onSent={() => {}} variant="icon" />);
    expect(icon.container.innerHTML).toBe("");
  });

  it("an office user (holds voice.send_to_tc) sees it and can send", async () => {
    authMock.role = "office";
    authMock.permissions = ["voice.send_to_tc", "tc.full"];
    apiMock.sendCallToTc.mockResolvedValue({ success: true, caseId: "case_1", url: "/tc/cases/case_1", attached: false });
    render(<SendToTcButton call={sendableCall()} onSent={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /send to tc/i }));
    await waitFor(() => expect(apiMock.sendCallToTc).toHaveBeenCalledTimes(1));
  });

  it("if the server still refuses on permission, the toast names the role, and nothing reads as sent", async () => {
    authMock.role = "office";
    authMock.permissions = ["voice.send_to_tc"];
    apiMock.sendCallToTc.mockRejectedValue(new ApiError("You do not have permission to do that", 403, "FORBIDDEN"));
    const onSent = vi.fn();
    render(<SendToTcButton call={sendableCall()} onSent={onSent} />);
    fireEvent.click(screen.getByRole("button", { name: /send to tc/i }));
    await waitFor(() => expect(toasts.calls).toHaveLength(1));
    expect(toasts.calls[0]).toEqual({ kind: "error", text: PERMISSION_COPY });
    expect(onSent).not.toHaveBeenCalled();
  });
});
