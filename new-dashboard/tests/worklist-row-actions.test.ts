/**
 * Which row action gets to wear a word.
 *
 * The worklist row offered up to five labeled buttons, and together they squeezed the
 * patient's name down to a few characters. `rowPrimaryAction` is the rule that lets
 * exactly one of them keep its label — these tests pin the rule, including the case that
 * makes ordering matter (a matched staff call with no transcript qualifies for both).
 *
 * No PHI: the names below are synthetic staging fixtures.
 */
import { describe, expect, it } from "vitest";
import { rowPrimaryAction } from "../client/src/lib/worklist";
import type { UnifiedCall } from "../client/src/lib/api";

const call = (over: Partial<UnifiedCall>): UnifiedCall => ({
  id: "c1",
  source: "retell",
  officeId: "valley",
  odPatientId: null,
  odPatientName: null,
  odSyncStatus: "needs_review",
  notAPatient: false,
  hasTranscript: true,
  triageStatus: "new",
  ...over,
} as unknown as UnifiedCall);

describe("rowPrimaryAction", () => {
  it("labels Send to chart for a matched call that has not been sent", () => {
    expect(rowPrimaryAction(call({ odPatientId: 7115, odPatientName: "Stedi TestValley" }), true))
      .toBe("send_to_chart");
  });

  it("labels Transcribe for a staff call with no transcript", () => {
    expect(rowPrimaryAction(call({ source: "mango", hasTranscript: false }), true))
      .toBe("transcribe");
  });

  it("prefers Send to chart when a matched staff call also needs transcribing", () => {
    // Both conditions hold. Filing the chart note is the step that closes the call out,
    // so it takes the label and Transcribe becomes an icon.
    const both = call({ source: "mango", hasTranscript: false, odPatientId: 7115 });
    expect(rowPrimaryAction(both, true)).toBe("send_to_chart");
  });

  it("offers no chart action when Open Dental is not connected for the call's office", () => {
    const c = call({ odPatientId: 7115 });
    expect(rowPrimaryAction(c, false)).toBe(null);
  });

  it("falls back to Transcribe when OD is disconnected but the call still needs reading", () => {
    const c = call({ source: "mango", hasTranscript: false, odPatientId: 7115 });
    expect(rowPrimaryAction(c, false)).toBe("transcribe");
  });

  it("offers nothing for a call closed out as not-a-patient", () => {
    expect(rowPrimaryAction(call({ odPatientId: 7115, notAPatient: true }), true)).toBe(null);
  });

  it("offers nothing once the note is on the chart", () => {
    expect(rowPrimaryAction(call({ odPatientId: 7115, odSyncStatus: "synced" }), true)).toBe(null);
  });

  it("offers nothing for a Retell call that is already matched and sent", () => {
    expect(rowPrimaryAction(call({ odSyncStatus: "synced", odPatientId: 7115 }), true)).toBe(null);
  });

  it("never offers Transcribe for a Retell call — those arrive with a transcript", () => {
    expect(rowPrimaryAction(call({ source: "retell", hasTranscript: false }), true)).toBe(null);
  });
});
