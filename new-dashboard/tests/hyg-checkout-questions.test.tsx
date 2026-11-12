/**
 * CO-7 — the front desk's questions in the hygiene day view.
 *
 *   - The badge says how many questions are OPEN on that visit's checkout card;
 *     a visit with no thread shows nothing.
 *   - Opening it reads the thread; the reply box shows only while something is
 *     open; a reply is the server's read-back and asks the day to recount.
 *   - The badges hook asks with the day's AptNums and date, keyed by AptNum,
 *     and a failed read says so (`failed`) rather than looking like "none".
 *
 * NO NETWORK, NO BACKEND. Synthetic names only.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { HygCheckoutQuestionBadge, TcCheckoutQuestionThread } from "@shared/tc/checkoutRouting";

(globalThis as Record<string, unknown>).React = React;

const HANDOFF_ID = "5d2a7e10-0000-4000-8000-0000000000d1";

const { state } = vi.hoisted(() => ({
  state: {
    badgeCalls: [] as unknown[][],
    badges: [] as HygCheckoutQuestionBadge[],
    badgeFail: false,
    thread: null as TcCheckoutQuestionThread | null,
    replies: [] as unknown[][],
  },
}));

vi.mock("@/features/hyg/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/hyg/api")>();
  return {
    ...real,
    fetchCheckoutQuestionBadges: vi.fn(async (office: string, date: string, aptNums: readonly number[]) => {
      state.badgeCalls.push([office, date, [...aptNums]]);
      if (state.badgeFail) throw new Error("down");
      return { enabled: true, badges: state.badges };
    }),
    fetchCheckoutThread: vi.fn(async () => state.thread),
    replyCheckoutQuestion: vi.fn(async (office: string, aptNum: number, body: string) => {
      state.replies.push([office, aptNum, body]);
      const prior = state.thread!;
      state.thread = {
        ...prior,
        messages: [
          ...prior.messages,
          {
            questionId: "7a000000-0000-4000-8000-0000000000f9",
            handoffId: HANDOFF_ID,
            authorEmail: "hygienist@carein.ai",
            authorRole: "hygienist",
            body,
            createdAt: "2026-11-11T16:05:00.000Z",
            resolvedAt: null,
          },
        ],
      };
      return state.thread;
    }),
  };
});

import { VisitCheckoutQuestions, useCheckoutQuestionBadges } from "@/features/hyg/checkoutQuestions";

const OPEN_THREAD: TcCheckoutQuestionThread = {
  handoffId: HANDOFF_ID,
  open: 1,
  messages: [
    {
      questionId: "7a000000-0000-4000-8000-0000000000f1",
      handoffId: HANDOFF_ID,
      authorEmail: "tc@carein.ai",
      authorRole: "tc",
      body: "Afternoons only?",
      createdAt: "2026-11-11T16:00:00.000Z",
      resolvedAt: null,
    },
  ],
};

beforeEach(() => {
  state.badgeCalls = [];
  state.badges = [];
  state.badgeFail = false;
  state.thread = OPEN_THREAD;
  state.replies = [];
});
afterEach(() => cleanup());

describe("VisitCheckoutQuestions (under a day card)", () => {
  it("no thread → nothing at all", () => {
    render(<VisitCheckoutQuestions office="roland" aptNum={900001} badge={null} onChanged={() => {}} />);
    expect(screen.queryByTestId("hyg-checkout-questions")).toBeNull();
  });

  it("the badge shows the OPEN count; opening it reads the thread; a reply is the read-back", async () => {
    const onChanged = vi.fn();
    render(
      <VisitCheckoutQuestions
        office="roland"
        aptNum={900001}
        badge={{ aptNum: 900001, handoffId: HANDOFF_ID, open: 1, total: 1 }}
        onChanged={onChanged}
      />,
    );
    const badge = screen.getByTestId("hyg-checkout-questions-badge");
    expect(badge.textContent).toBe("1 open question from the front desk");
    fireEvent.click(badge);
    expect((await screen.findByTestId("hyg-checkout-thread")).textContent).toContain("Afternoons only?");

    fireEvent.change(screen.getByTestId("hyg-checkout-reply-draft"), { target: { value: "  Yes, after 1pm  " } });
    fireEvent.click(screen.getByTestId("hyg-checkout-reply-send"));
    await waitFor(() => expect(state.replies).toEqual([["roland", 900001, "Yes, after 1pm"]]));
    await waitFor(() => expect(screen.getByTestId("hyg-checkout-thread").textContent).toContain("Yes, after 1pm"));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("an answered (resolved) thread has no reply box", async () => {
    state.thread = {
      ...OPEN_THREAD,
      open: 0,
      messages: OPEN_THREAD.messages.map((m) => ({ ...m, resolvedAt: "2026-11-11T17:00:00.000Z" })),
    };
    render(
      <VisitCheckoutQuestions
        office="roland"
        aptNum={900001}
        badge={{ aptNum: 900001, handoffId: HANDOFF_ID, open: 0, total: 1 }}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByTestId("hyg-checkout-questions-badge").textContent).toBe("Front desk questions answered");
    fireEvent.click(screen.getByTestId("hyg-checkout-questions-badge"));
    await screen.findByTestId("hyg-checkout-thread");
    expect(screen.queryByTestId("hyg-checkout-reply-draft")).toBeNull();
  });
});

function Probe({ aptNums }: { aptNums: number[] }) {
  const q = useCheckoutQuestionBadges("roland", "2026-11-11", aptNums);
  const b = q.badgeFor(900002);
  return <div data-testid="probe">{q.failed ? "failed" : b ? `${b.aptNum}:${b.open}/${b.total}` : "none"}</div>;
}

describe("useCheckoutQuestionBadges", () => {
  it("asks with the day's AptNums and date; answers per AptNum", async () => {
    state.badges = [{ aptNum: 900002, handoffId: HANDOFF_ID, open: 2, total: 3 }];
    render(<Probe aptNums={[900001, 900002]} />);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("900002:2/3"));
    expect(state.badgeCalls[0]).toEqual(["roland", "2026-11-11", [900001, 900002]]);
  });

  it("a failed read is `failed`, never 'no questions'", async () => {
    state.badgeFail = true;
    render(<Probe aptNums={[900002]} />);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("failed"));
  });

  it("no AptNums → nothing is asked", async () => {
    render(<Probe aptNums={[]} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(state.badgeCalls).toHaveLength(0);
    expect(screen.getByTestId("probe").textContent).toBe("none");
  });
});
