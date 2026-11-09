/**
 * fix/referral-note-scroll: a very long note never strands the buttons.
 *
 * The shared Textarea grows with its content and the referral dialog had no
 * max-height, so a long note pushed the dialog past the bottom of the screen
 * and nothing scrolled. jsdom does no layout, so these pin the STRUCTURE that
 * makes it work in a browser:
 *
 *   1. The referral create/edit dialog is capped to the viewport, scrolls its
 *      body, and keeps the action row OUTSIDE that scroll region — with a note
 *      at the 8000-character limit, Save draft / Save & submit are still there
 *      and still save the whole note.
 *   2. Log correspondence: a note at its 2000-character limit scrolls inside
 *      the field, and "Log it" still logs the whole note. Who/How stack on a
 *      phone.
 *   3. Every note field in the referral surfaces carries the long-text class,
 *      so a new one cannot quietly bring the bug back.
 *
 * No PHI: the patient is the synthetic Roland fixture (12827).
 */
import * as React from "react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

(globalThis as Record<string, unknown>).React = React;

const { toastMock, ref } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  ref: {
    logReferralCorrespondence: vi.fn(),
    uploadReferralAttachment: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/referrals/referralsApi", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...ref,
}));

import { ReferralDialog } from "@/features/tc/referrals/ReferralsPanel";
import { LogCorrespondence } from "@/features/tc/referrals/LogCorrespondence";
import { REFERRAL_LONG_TEXT_CLASS } from "@/features/tc/referrals/longText";
import {
  TC_REFERRAL_CORRESPONDENCE_NOTE_MAX,
  TcReferral as TcReferralSchema,
  type TcReferral,
} from "@shared/tc/referrals";

const RID = "9b1c2d3e-4f50-4a61-8b72-938495a6b7c8";
const CASE_ID = "1b1c2d3e-4f50-4a61-8b72-938495a6b7c8";
/** The referral schema's narrative limit. */
const NARRATIVE_MAX = 8000;

function referral(over: Partial<TcReferral> = {}): TcReferral {
  return TcReferralSchema.parse({
    referralId: RID,
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    tcCaseId: CASE_ID,
    sourceKind: "case",
    sourceRef: CASE_ID,
    referringProvider: "",
    directoryEntryId: null,
    practiceName: "River Endodontics",
    specialty: "Endodontics",
    reason: "Possible cracked tooth",
    teeth: [3],
    urgency: "soon",
    narrative: "",
    status: "sent",
    statusChangedAt: "2026-10-20T15:00:00.000Z",
    statusChangedBy: "tc@carein.ai",
    createdBy: "tc@carein.ai",
    createdAt: "2026-10-20T14:00:00.000Z",
    updatedAt: "2026-10-20T15:00:00.000Z",
    events: [],
    ...over,
  });
}

/** A long, multi-line note of exactly `length` characters. */
function longNote(length: number): string {
  const line = "Patient reports intermittent pain on biting, worse with cold; see attached PA.\n";
  return line.repeat(Math.ceil(length / line.length)).slice(0, length);
}

function classesOf(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("1: the referral create/edit dialog", () => {
  it("caps itself to the viewport, scrolls the body, and keeps the actions outside it", async () => {
    const onSave = vi.fn();
    render(
      <ReferralDialog
        open
        editing={null}
        saving={false}
        onClose={vi.fn()}
        onSave={onSave}
        loadDirectory={async () => []}
        loadProviders={async () => []}
      />,
    );
    const dialog = await screen.findByTestId("tc-referral-dialog");
    const body = within(dialog).getByTestId("tc-referral-dialog-body");
    const actions = within(dialog).getByTestId("tc-referral-dialog-actions");

    // The dialog: never taller than the screen; header / body / actions in a column.
    const dc = classesOf(dialog);
    expect(dc).toEqual(expect.arrayContaining(["max-h-[calc(100dvh-2rem)]", "flex", "flex-col", "overflow-hidden"]));
    expect(dc).not.toContain("grid");
    // Phone width: the base dialog's side gutter survives the merge.
    expect(dc).toContain("max-w-[calc(100%-2rem)]");

    // The body scrolls, and can shrink below its content.
    expect(classesOf(body)).toEqual(expect.arrayContaining(["overflow-y-auto", "min-h-0", "flex-1"]));

    // The actions are NOT inside the scroll region, so no amount of text scrolls them away.
    expect(body.contains(actions)).toBe(false);
    expect(classesOf(actions)).toContain("shrink-0");

    // A note at the limit: the field scrolls inside itself, past its ceiling.
    const note = longNote(NARRATIVE_MAX);
    const field = within(body).getByLabelText("Notes for the specialist") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: note } });
    expect(field.value).toHaveLength(NARRATIVE_MAX);
    expect(classesOf(field)).toEqual(expect.arrayContaining(["max-h-[40dvh]", "overflow-y-auto"]));

    // …and the buttons still work and save ALL of it.
    fireEvent.change(within(body).getByLabelText("Reason *"), { target: { value: "Endo eval" } });
    const saveDraft = within(actions).getByRole("button", { name: /save draft/i }) as HTMLButtonElement;
    const submit = within(actions).getByRole("button", { name: /save & submit/i }) as HTMLButtonElement;
    expect(saveDraft.disabled).toBe(false);
    expect(submit.disabled).toBe(false);
    fireEvent.click(saveDraft);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].narrative).toBe(note.trim());
    expect(onSave.mock.calls[0][1]).toBe(false);
  });

  it("a refusal shows next to the actions, outside the scroll region", async () => {
    render(
      <ReferralDialog
        open
        editing={null}
        saving={false}
        onClose={vi.fn()}
        onSave={vi.fn()}
        loadDirectory={async () => []}
        loadProviders={async () => []}
      />,
    );
    const dialog = await screen.findByTestId("tc-referral-dialog");
    fireEvent.change(within(dialog).getByLabelText("Notes for the specialist"), {
      target: { value: longNote(NARRATIVE_MAX) },
    });
    // No reason: the form refuses.
    fireEvent.click(within(dialog).getByRole("button", { name: /save draft/i }));
    const body = within(dialog).getByTestId("tc-referral-dialog-body");
    const refusal = await waitFor(() => {
      const el = Array.from(dialog.querySelectorAll("p.text-destructive")).find((p) => !body.contains(p));
      if (!el) throw new Error("no refusal outside the body yet");
      return el;
    });
    expect(refusal.textContent).toBeTruthy();
  });
});

describe("2: Log correspondence", () => {
  it("a note at the limit scrolls in the field, and 'Log it' logs all of it", async () => {
    const r = referral();
    ref.logReferralCorrespondence.mockResolvedValue(r);
    const onLogged = vi.fn();
    render(<LogCorrespondence office="roland" referral={r} filesAttached={0} onLogged={onLogged} onFilesChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId("tc-hub-correspondence-open"));
    const form = screen.getByTestId("tc-hub-correspondence-form");

    // Who / How stack on a phone, side by side from sm up.
    const who = within(form).getByLabelText("Who");
    const grid = who.closest("div.grid");
    expect(grid).not.toBeNull();
    expect(classesOf(grid as Element)).toEqual(expect.arrayContaining(["grid-cols-1", "sm:grid-cols-2"]));

    const note = longNote(TC_REFERRAL_CORRESPONDENCE_NOTE_MAX);
    const field = within(form).getByLabelText(/What was said/) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: note } });
    expect(field.value).toHaveLength(TC_REFERRAL_CORRESPONDENCE_NOTE_MAX);
    expect(classesOf(field)).toEqual(expect.arrayContaining(["max-h-[40dvh]", "overflow-y-auto"]));
    expect(within(form).getByText("0 characters left")).toBeTruthy();

    // The action row is after the field, not inside it, and wraps on a narrow screen.
    const actions = within(form).getByTestId("tc-hub-correspondence-actions");
    expect(classesOf(actions)).toContain("flex-wrap");
    const save = within(actions).getByTestId("tc-hub-correspondence-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect(within(actions).getByRole("button", { name: "Cancel" })).toBeTruthy();

    fireEvent.click(save);
    await waitFor(() =>
      expect(ref.logReferralCorrespondence).toHaveBeenCalledWith("roland", RID, {
        direction: "from",
        party: "specialist",
        channel: "phone",
        note: note.trim(),
      }),
    );
    await waitFor(() => expect(onLogged).toHaveBeenCalledWith(r));
  });
});

describe("3: every referral note field carries the long-text class", () => {
  const dir = join(__dirname, "..", "client", "src", "features", "tc", "referrals");
  const files = readdirSync(dir).filter((f) => f.endsWith(".tsx"));

  it("the class is the bounded, scrolling one", () => {
    expect(REFERRAL_LONG_TEXT_CLASS.split(" ")).toEqual(expect.arrayContaining(["max-h-[40dvh]", "overflow-y-auto"]));
  });

  it.each(files)("%s: no unbounded <Textarea>", (file) => {
    const src = readFileSync(join(dir, file), "utf8");
    // Each <Textarea …> opening tag, up to its first unbraced `>` or `/>`.
    const tags = src.match(/<Textarea\b[\s\S]*?\/>/g) ?? [];
    for (const tag of tags) {
      expect(tag, `${file}: ${tag.slice(0, 80)}`).toContain("REFERRAL_LONG_TEXT_CLASS");
    }
  });
});
