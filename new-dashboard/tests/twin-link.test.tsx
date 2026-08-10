/**
 * Mango↔Retell twin linkage in the worklist (slice M7).
 *
 * The correlation itself is the backend's job and is tested there. What is pinned HERE is
 * everything a user can actually observe:
 *
 *   - the AI-answered duplicate leg drops out of "Needs attention" — and is NOT deleted,
 *     so it is still reachable;
 *   - a TRANSFERRED leg is not treated as a duplicate: its recording is the human half of
 *     the conversation, so it keeps demanding attention;
 *   - clicking Transcribe on a duplicate leg asks first, says the two true things, and
 *     offers a way to the row that already has the transcript;
 *   - that confirmation is a gate, not a lockout — "Transcribe anyway" still spends.
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Vitest compiles .tsx with esbuild's classic JSX transform, while the app's Vite build
// uses the automatic runtime — so component modules never import React themselves.
(globalThis as Record<string, unknown>).React = React;

vi.mock("sonner", () => ({
  toast: { success: () => {}, info: () => {}, error: () => {} },
}));

const transcribeMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, transcribeMangoCall: transcribeMock.fn } };
});

// wouter's <Link> needs a router in context; the dialog only uses it for the jump-link.
vi.mock("wouter", () => ({
  Link: ({ href, children, onClick }: { href: string; children: React.ReactNode; onClick?: () => void }) => (
    <a href={href} onClick={onClick}>{children}</a>
  ),
}));

import { normalizeUnifiedCall, type BackendUnifiedCall, type UnifiedCall } from "@/lib/api";
import { callNeedsAttention, isAiDuplicateLeg, hasLinkedTwin } from "@/lib/worklist";
import {
  needsDuplicateLegConfirm, needsRebillConfirm,
  DUPLICATE_LEG_CONFIRM_BODY, DUPLICATE_LEG_CONFIRM_ACCEPT, DUPLICATE_LEG_CONFIRM_CANCEL,
  DUPLICATE_LEG_JUMP_LABEL, REBILL_CONFIRM_BODY,
} from "@/lib/transcribe";
import { useTranscribeCall } from "@/hooks/useTranscribeCall";
import { TranscribeRebillDialog } from "@/components/calls/TranscribeRebillDialog";

afterEach(() => {
  cleanup();
  transcribeMock.fn.mockReset();
});

/** A stored call as the backend serves it, mapped through the real normalizer. */
const call = (over: Partial<BackendUnifiedCall> = {}): UnifiedCall =>
  normalizeUnifiedCall({
    id: "mango_call_1",
    source: "mango",
    caller_number: "(918) 555-0142",
    call_date: "2026-08-01T15:00:00.000Z",
    duration_seconds: 244,
    triage_status: "new",
    ...over,
  } as BackendUnifiedCall);

describe("field mapping", () => {
  it("carries the twin linkage through normalizeUnifiedCall", () => {
    const c = call({ linked_call_id: "call_abc", link_role: "duplicate_leg" });
    expect(c.linkedCallId).toBe("call_abc");
    expect(c.linkRole).toBe("duplicate_leg");
    expect(isAiDuplicateLeg(c)).toBe(true);
    expect(hasLinkedTwin(c)).toBe(true);
  });

  it("leaves an unlinked call untouched", () => {
    const c = call();
    expect(c.linkedCallId).toBeNull();
    expect(c.linkRole).toBeNull();
    expect(isAiDuplicateLeg(c)).toBe(false);
    expect(hasLinkedTwin(c)).toBe(false);
  });
});

describe("worklist attention", () => {
  it("hides the Mango leg of an AI-completed call from the default view", () => {
    const duplicate = call({ linked_call_id: "call_abc", link_role: "duplicate_leg" });
    expect(callNeedsAttention(duplicate, "all")).toBe(false);
  });

  it("KEEPS a transferred leg in the worklist — it holds the human half of the call", () => {
    const transferred = call({ linked_call_id: "call_abc", link_role: "transferred_leg" });
    expect(isAiDuplicateLeg(transferred)).toBe(false);
    expect(callNeedsAttention(transferred, "all")).toBe(true);
  });

  it("keeps the Retell primary in the worklist — it is the real call", () => {
    const primary = call({
      id: "call_abc", source: "retell", linked_call_id: "mango_call_1", link_role: "primary",
    });
    expect(callNeedsAttention(primary, "all")).toBe(true);
  });

  it("leaves an unlinked staff call exactly as it was", () => {
    expect(callNeedsAttention(call(), "all")).toBe(true);
  });

  it("still respects triage and close-out ahead of everything else", () => {
    const done = call({ link_role: "transferred_leg", triage_status: "done" });
    expect(callNeedsAttention(done, "all")).toBe(false);
  });
});

describe("transcribe confirmation predicates", () => {
  it("asks for a duplicate leg only", () => {
    expect(needsDuplicateLegConfirm("duplicate_leg")).toBe(true);
    expect(needsDuplicateLegConfirm("transferred_leg")).toBe(false);
    expect(needsDuplicateLegConfirm("primary")).toBe(false);
    expect(needsDuplicateLegConfirm(null)).toBe(false);
    expect(needsDuplicateLegConfirm(undefined)).toBe(false);
  });

  it("says both true things: the AI answered it, and the transcript already exists", () => {
    expect(DUPLICATE_LEG_CONFIRM_BODY).toContain("answered by the AI agent");
    expect(DUPLICATE_LEG_CONFIRM_BODY).toContain("transcript already exists on the linked call");
  });
});

/** The smallest thing that behaves like a real row: the gate plus the shared dialog. */
function TranscribeRow({
  linkRole, lastOutcome, linkedCallId = "call_abc",
}: {
  linkRole?: string | null;
  lastOutcome?: string | null;
  linkedCallId?: string | null;
}) {
  const transcribe = useTranscribeCall();
  return (
    <>
      <button onClick={() => transcribe.request("mango_call_1", lastOutcome, linkRole)}>
        Transcribe
      </button>
      <TranscribeRebillDialog
        open={transcribe.pendingConfirm !== null}
        kind={transcribe.pendingConfirmKind}
        linkedCallId={linkedCallId}
        onConfirm={transcribe.confirm}
        onCancel={transcribe.cancelConfirm}
      />
    </>
  );
}

describe("transcribing a duplicate leg", () => {
  it("warns instead of spending, and links to the call that has the transcript", async () => {
    render(<TranscribeRow linkRole="duplicate_leg" />);
    fireEvent.click(screen.getByText("Transcribe"));

    await screen.findByText(DUPLICATE_LEG_CONFIRM_BODY);
    expect(transcribeMock.fn).not.toHaveBeenCalled();

    const jump = screen.getByText(DUPLICATE_LEG_JUMP_LABEL);
    expect(jump.getAttribute("href")).toBe("/calls/call_abc");
  });

  it("is a gate, not a lockout — confirming still transcribes", async () => {
    transcribeMock.fn.mockResolvedValue({ status: "completed" });
    render(<TranscribeRow linkRole="duplicate_leg" />);
    fireEvent.click(screen.getByText("Transcribe"));

    await screen.findByText(DUPLICATE_LEG_CONFIRM_BODY);
    fireEvent.click(screen.getByText(DUPLICATE_LEG_CONFIRM_ACCEPT));

    await waitFor(() => expect(transcribeMock.fn).toHaveBeenCalledWith("mango_call_1"));
  });

  it("cancelling spends nothing", async () => {
    render(<TranscribeRow linkRole="duplicate_leg" />);
    fireEvent.click(screen.getByText("Transcribe"));

    await screen.findByText(DUPLICATE_LEG_CONFIRM_BODY);
    fireEvent.click(screen.getByText(DUPLICATE_LEG_CONFIRM_CANCEL));

    await waitFor(() =>
      expect(screen.queryByText(DUPLICATE_LEG_CONFIRM_BODY)).toBeNull()
    );
    expect(transcribeMock.fn).not.toHaveBeenCalled();
  });

  it("an ordinary staff call still transcribes with no ceremony", async () => {
    transcribeMock.fn.mockResolvedValue({ status: "completed" });
    render(<TranscribeRow linkRole={null} />);
    fireEvent.click(screen.getByText("Transcribe"));

    await waitFor(() => expect(transcribeMock.fn).toHaveBeenCalledWith("mango_call_1"));
  });

  it("a TRANSFERRED leg transcribes with no ceremony — that recording is the human half", async () => {
    transcribeMock.fn.mockResolvedValue({ status: "completed" });
    render(<TranscribeRow linkRole="transferred_leg" />);
    fireEvent.click(screen.getByText("Transcribe"));

    await waitFor(() => expect(transcribeMock.fn).toHaveBeenCalledWith("mango_call_1"));
  });

  it("the duplicate warning wins over the re-bill warning when both apply", async () => {
    // Both gates would fire. The duplicate message is the one worth showing: it comes with
    // somewhere to go, where the re-bill message can only counsel caution.
    expect(needsRebillConfirm("no_speech")).toBe(true);
    render(<TranscribeRow linkRole="duplicate_leg" lastOutcome="no_speech" />);
    fireEvent.click(screen.getByText("Transcribe"));

    await screen.findByText(DUPLICATE_LEG_CONFIRM_BODY);
    expect(screen.queryByText(REBILL_CONFIRM_BODY)).toBeNull();
  });

  it("still shows the re-bill warning when that is the only reason to ask", async () => {
    render(<TranscribeRow linkRole={null} lastOutcome="no_speech" />);
    fireEvent.click(screen.getByText("Transcribe"));

    await screen.findByText(REBILL_CONFIRM_BODY);
    expect(screen.queryByText(DUPLICATE_LEG_CONFIRM_BODY)).toBeNull();
    expect(transcribeMock.fn).not.toHaveBeenCalled();
  });
});
