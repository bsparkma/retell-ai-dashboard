/**
 * Referrals R5 (email send), in jsdom.
 *
 *  - Email OFF (or a server that does not say): no send UI anywhere — the hub
 *    and its panel read exactly as before.
 *  - Email ON: a Send row under an approved card (never inside the card
 *    button), and a send box in the panel naming where it goes.
 *  - The button is disabled, with the reason, when the directory row has no
 *    email (the PM's exact copy), when the office cannot send yet, and after
 *    a conflict (the email already went out). A failure offers a retry.
 *  - Only the server's answer is shown: sent once the server says so; a
 *    refusal shows its sentence and the re-read referral.
 *  - The doctor's approval says what an auto-send did.
 *  - The platform console's referral-email switch.
 *
 * With TC_SHOTS=1 it also dumps the hub and the panel (tccheckout-13 / -14).
 * NO NETWORK, NO BACKEND, NO PHI (test patients 12827 / 12828).
 */
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TcReferral, TcReferralDirectoryEntry } from "@shared/tc/referrals";
import type { TcReferralsSwitchState } from "@/lib/api";

(globalThis as Record<string, unknown>).React = React;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;

const { toastMock, ref, platform } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  ref: {
    getReferralsStatus: vi.fn(),
    listDirectory: vi.fn(),
    listHub: vi.fn(),
    getReferral: vi.fn(),
    listReferralAttachments: vi.fn(),
    openReferralAttachment: vi.fn(),
    editReferralFields: vi.fn(),
    reopenReferral: vi.fn(),
    markReferral: vi.fn(),
    sendReferralEmail: vi.fn(),
    listSignoffQueue: vi.fn(),
    getSignoffReferral: vi.fn(),
    approveReferral: vi.fn(),
    declineReferral: vi.fn(),
    listSignoffDirectory: vi.fn(),
    doctorEditReferral: vi.fn(),
    returnReferral: vi.fn(),
  },
  platform: { view: null as TcReferralsSwitchState | null, sets: [] as [string, boolean][] },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/tc/referrals/referralsApi", () => ref);
vi.mock("@/features/tc/components/TcShell", async (orig) => ({
  ...(await orig<typeof import("@/features/tc/components/TcShell")>()),
  useTcOffice: () => "roland",
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: {
      ...real.api,
      getTcReferralEmailOffices: vi.fn(async () => platform.view),
      setTcReferralEmailOfficeEnabled: vi.fn(async (o: string, enabled: boolean) => {
        platform.sets.push([o, enabled]);
        platform.view = {
          ...(platform.view as TcReferralsSwitchState),
          offices: (platform.view as TcReferralsSwitchState).offices.map((x) =>
            x.office === o ? { ...x, enabled, source: "db" as const } : x,
          ),
        };
        return platform.view;
      }),
    },
  };
});

import { HubInner } from "@/pages/tc/TcReferralsHub";
import { SignoffInner } from "@/pages/tc/TcReferralSignoff";
import { TcReferralEmailPanel } from "@/pages/platform/TcReferralsPanel";
import { referralEventLabel } from "@/features/tc/referrals/ReferralTimeline";
import { TcApiError } from "@/features/tc/api";
import { TcReferralsStatus, REFERRAL_NO_EMAIL_COPY } from "@shared/tc/referrals";

const NOW = new Date("2026-10-21T15:00:00.000Z");
const ENTRY = "5a1c2d3e-4f50-4a61-8b72-938495a6b7c8";
const id = (n: number) => `${n}b1c2d3e-4f50-4a61-8b72-938495a6b7c8`;
const EMAIL = "referrals@endo.example.test";

function referral(over: Partial<TcReferral> = {}): TcReferral {
  return {
    referralId: id(3),
    officeId: "roland",
    odPatientId: 12827,
    patientName: "Test 2, Stedi",
    tcCaseId: null,
    sourceKind: "case",
    sourceRef: "",
    referringProvider: "DOC1",
    directoryEntryId: ENTRY,
    practiceName: "River Endodontics",
    specialty: "Endodontics",
    reason: "Possible cracked tooth",
    teeth: [3],
    urgency: "soon",
    narrative: "Sensitive to biting",
    status: "approved",
    statusChangedAt: "2026-10-20T15:00:00.000Z",
    statusChangedBy: "doctor@carein.ai",
    createdBy: "tc@carein.ai",
    createdAt: "2026-10-19T15:00:00.000Z",
    updatedAt: "2026-10-19T15:00:00.000Z",
    doctorNote: null,
    attachmentCount: 1,
    returned: null,
    specialistEmail: EMAIL,
    sendProblem: null,
    events: [],
    ...over,
  };
}

const entry: TcReferralDirectoryEntry = {
  entryId: ENTRY,
  officeId: "roland",
  practiceName: "River Endodontics",
  specialistName: "",
  specialty: "Endodontics",
  contactPerson: "",
  email: EMAIL,
  phone: "",
  fax: "",
  notes: "",
  preferredFormatNotes: "",
  active: true,
  createdBy: "tc@carein.ai",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedBy: "tc@carein.ai",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const EMAIL_ON = { enabled: true, unavailable: null };

function status(emailSend?: { enabled: boolean; unavailable: "switched_off" | "not_configured" | "office_not_configured" | null }) {
  return { success: true, office: "roland", enabled: true, ...(emailSend ? { emailSend } : {}) };
}

beforeEach(() => {
  vi.clearAllMocks();
  ref.getReferralsStatus.mockResolvedValue(status(EMAIL_ON));
  ref.listDirectory.mockResolvedValue([entry]);
  ref.listHub.mockResolvedValue([referral()]);
  ref.getReferral.mockResolvedValue(referral());
  ref.listReferralAttachments.mockResolvedValue([]);
});
afterEach(cleanup);

async function readyGroup() {
  return screen.findByTestId("tc-hub-group-ready");
}

describe("email OFF — nothing changes", () => {
  it("no emailSend from the server (an older one, or email off): no Send row, the old copy", async () => {
    ref.getReferralsStatus.mockResolvedValue(status());
    render(<HubInner office="roland" now={() => NOW} />);
    const ready = await readyGroup();
    await within(ready).findByTestId("tc-hub-card");
    expect(within(ready).queryByTestId("tc-hub-card-send")).toBeNull();
    expect(document.body.textContent).toContain("Nothing is sent from here — sending ships in a later update.");
    fireEvent.click(within(ready).getByTestId("tc-hub-card"));
    const panel = await screen.findByTestId("tc-hub-detail");
    await within(panel).findByText("Ready to send — sending ships in a later update.");
    expect(within(panel).queryByTestId("tc-hub-send")).toBeNull();
  });

  it("emailSend.enabled=false is off too", async () => {
    ref.getReferralsStatus.mockResolvedValue(status({ enabled: false, unavailable: null }));
    render(<HubInner office="roland" now={() => NOW} />);
    const ready = await readyGroup();
    await within(ready).findByTestId("tc-hub-card");
    expect(within(ready).queryByTestId("tc-hub-card-send")).toBeNull();
  });
});

describe("the hub card", () => {
  it("draws Send as a SIBLING of the card button, and sends only what the server confirms", async () => {
    ref.sendReferralEmail.mockResolvedValue({
      referral: referral({ status: "sent" }),
      outcome: { status: "sent", message: `Emailed to River Endodontics (${EMAIL}) — 1 file attached.`, code: null },
    });
    render(<HubInner office="roland" now={() => NOW} />);
    const ready = await readyGroup();
    const row = await within(ready).findByTestId("tc-hub-card-send");
    const card = within(ready).getByTestId("tc-hub-card");
    expect(card.contains(row)).toBe(false);
    expect(row.querySelector("button")?.closest('[data-testid="tc-hub-card"]')).toBeNull();
    expect(row.textContent).toContain(`to ${EMAIL}`);
    fireEvent.click(within(row).getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(ref.sendReferralEmail).toHaveBeenCalledWith("roland", id(3)));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining("Emailed to River Endodontics")));
    expect(ref.listHub.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("no email on file → disabled, with the PM's exact copy", async () => {
    ref.listHub.mockResolvedValue([referral({ specialistEmail: null })]);
    render(<HubInner office="roland" now={() => NOW} />);
    const row = await within(await readyGroup()).findByTestId("tc-hub-card-send");
    expect((within(row).getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    expect(within(row).getByTestId("tc-hub-card-send-blocked").textContent).toBe(
      "No email on file — add it in Settings → Referrals, or mark sent outside the app",
    );
    expect(REFERRAL_NO_EMAIL_COPY).toBe("No email on file — add it in Settings → Referrals, or mark sent outside the app");
  });

  it("a failed last attempt shows why and offers Retry send", async () => {
    ref.listHub.mockResolvedValue([
      referral({ sendProblem: { kind: "failed", note: "Not sent automatically: The email service refused the email (Busy).", actor: "doctor@carein.ai", at: NOW.toISOString() } }),
    ]);
    render(<HubInner office="roland" now={() => NOW} />);
    const row = await within(await readyGroup()).findByTestId("tc-hub-card-send");
    expect(within(row).getByRole("button", { name: /Retry send/ })).toBeTruthy();
    expect(within(row).getByTestId("tc-hub-card-send-failed").textContent).toContain("refused the email (Busy)");
  });

  it("a server refusal is shown as the server said it", async () => {
    ref.sendReferralEmail.mockRejectedValue(new TcApiError("Email sending is switched off for the practice right now. Nothing was sent.", 501, "FEATURE_DISABLED", null, []));
    render(<HubInner office="roland" now={() => NOW} />);
    const row = await within(await readyGroup()).findByTestId("tc-hub-card-send");
    fireEvent.click(within(row).getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(String(toastMock.error.mock.calls[0][0])).toContain("switched off");
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});

describe("the detail panel", () => {
  async function openPanel() {
    render(<HubInner office="roland" now={() => NOW} />);
    fireEvent.click(await within(await readyGroup()).findByTestId("tc-hub-card"));
    return screen.findByTestId("tc-hub-detail");
  }

  it("names the recipient; Send shows the server's referral once it says sent", async () => {
    ref.sendReferralEmail.mockResolvedValue({
      referral: referral({ status: "sent", events: [] }),
      outcome: { status: "sent", message: "Emailed to River Endodontics.", code: null },
    });
    const panel = await openPanel();
    const box = await within(panel).findByTestId("tc-hub-send");
    expect(box.textContent).toContain("Approved — ready to email to the specialist.");
    expect(within(box).getByTestId("tc-hub-send-to").textContent).toBe(`To: River Endodontics — ${EMAIL}`);
    fireEvent.click(within(box).getByTestId("tc-hub-send-button"));
    await waitFor(() => expect(within(panel).queryByTestId("tc-hub-send")).toBeNull());
    expect(within(panel).getByText("Sent")).toBeTruthy();
    expect(toastMock.success).toHaveBeenCalledWith("Emailed to River Endodontics.");
  });

  it("a refusal shows the sentence and the RE-READ referral (with its retry)", async () => {
    ref.sendReferralEmail.mockRejectedValue(new TcApiError("The email was not sent: refused (InvalidRecipient).", 502, "ACS_InvalidRecipient", null, []));
    ref.getReferral
      .mockResolvedValueOnce(referral())
      .mockResolvedValueOnce(referral({ sendProblem: { kind: "failed", note: "Not sent: refused (InvalidRecipient).", actor: "tc@carein.ai", at: NOW.toISOString() } }));
    const panel = await openPanel();
    fireEvent.click(await within(panel).findByTestId("tc-hub-send-button"));
    await within(panel).findByText("The email was not sent: refused (InvalidRecipient).");
    const failed = await within(panel).findByTestId("tc-hub-send-failed");
    expect(failed.textContent).toContain("Not sent: refused (InvalidRecipient).");
    expect(within(panel).getByTestId("tc-hub-send-button").textContent).toContain("Retry send");
  });

  it("after a conflict the button is disabled: the email already went out", async () => {
    ref.getReferral.mockResolvedValue(
      referral({ sendProblem: { kind: "conflict", note: "Emailed (accepted) but could not be marked sent.", actor: "tc@carein.ai", at: NOW.toISOString() } }),
    );
    const panel = await openPanel();
    const btn = (await within(panel).findByTestId("tc-hub-send-button")) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(within(panel).getByTestId("tc-hub-send-conflict").textContent).toContain("could not be marked sent");
    expect(within(panel).getByTestId("tc-hub-send-blocked").textContent).toMatch(/already emailed/);
    // The person can still record it.
    expect(within(panel).getByTestId("tc-hub-mark")).toBeTruthy();
  });

  it("an office that cannot send yet says why", async () => {
    ref.getReferralsStatus.mockResolvedValue(status({ enabled: true, unavailable: "office_not_configured" }));
    const panel = await openPanel();
    const btn = (await within(panel).findByTestId("tc-hub-send-button")) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(within(panel).getByTestId("tc-hub-send-blocked").textContent).toBe(
      "This office has no referral sending address set up yet.",
    );
  });
});

describe("the history and the contract", () => {
  it("labels the three new rows", () => {
    const e = { eventId: id(1), fromStatus: "approved" as const, toStatus: "sent" as const, actor: "a", at: NOW.toISOString(), note: "" };
    expect(referralEventLabel({ ...e, verb: "send" })).toBe("Emailed to the specialist");
    expect(referralEventLabel({ ...e, verb: "send_failed" })).toBe("Email not sent");
    expect(referralEventLabel({ ...e, verb: "send_conflict" })).toBe("Emailed — but could not be marked sent");
  });

  it("the status answer parses with and without emailSend", () => {
    expect(TcReferralsStatus.safeParse(status()).success).toBe(true);
    expect(TcReferralsStatus.safeParse(status(EMAIL_ON)).success).toBe(true);
    expect(TcReferralsStatus.safeParse(status({ enabled: true, unavailable: "nope" as never })).success).toBe(false);
  });
});

describe("the doctor's approval", () => {
  async function approveWith(answer: TcReferral) {
    const pending = referral({ status: "pending_signoff", specialistEmail: EMAIL });
    ref.listSignoffQueue.mockResolvedValueOnce([pending]).mockResolvedValue([]);
    ref.getSignoffReferral.mockResolvedValue({ ...pending, events: [] });
    ref.approveReferral.mockResolvedValue(answer);
    render(<SignoffInner office="roland" />);
    fireEvent.click(await screen.findByTestId("tc-signoff-row"));
    const detail = await screen.findByTestId("tc-signoff-detail");
    fireEvent.click(within(detail).getByRole("button", { name: /Approve/ }));
    return screen.findByTestId("tc-signoff-done");
  }

  it("auto-sent: says it was emailed", async () => {
    const done = await approveWith(referral({ status: "sent" }));
    expect(done.textContent).toContain("Emailed to River Endodontics.");
    expect(toastMock.success).toHaveBeenCalledWith("Approved and emailed to River Endodontics.");
  });

  it("auto-send failed: approved, and says the email did not go out", async () => {
    const done = await approveWith(
      referral({ sendProblem: { kind: "failed", note: "Not sent automatically: busy.", actor: "doctor@carein.ai", at: NOW.toISOString() } }),
    );
    expect(done.textContent).toContain("approved.");
    expect(done.textContent).toContain("The automatic email did not go out");
    expect(String(toastMock.error.mock.calls[0][0])).toMatch(/^Approved — but the automatic email did not go out\. Not sent automatically: busy\./);
  });
});

const SHOOT = process.env.TC_SHOTS === "1";
describe.skipIf(!SHOOT)("referrals R5 screenshot dumps", () => {
  const out = resolve(import.meta.dirname, ".shots");
  const FAILED = {
    kind: "failed" as const,
    note: "Not sent automatically: The email service did not answer the send request in time.",
    actor: "doctor@carein.ai",
    at: NOW.toISOString(),
  };
  const READY = [
    referral({ referralId: id(1) }),
    referral({ referralId: id(2), patientName: "Test, MangoTest", odPatientId: 12828, practiceName: "Valley Periodontics", specialistEmail: null }),
    referral({ referralId: id(4), practiceName: "Valley Oral Surgery", specialistEmail: "front@oralsurgery.example.test", sendProblem: FAILED }),
  ];

  it("13 — the hub with referral email on: send, no email on file, and a retry", async () => {
    ref.listHub.mockResolvedValue(READY);
    render(
      <div className="max-w-6xl">
        <HubInner office="roland" now={() => NOW} />
      </div>,
    );
    await waitFor(() => expect(screen.getAllByTestId("tc-hub-card-send")).toHaveLength(3));
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "tccheckout-13-referral-email-hub@1280x900.html"), document.body.innerHTML, "utf8");
  });

  it("14 — the panel after a failed auto-send: who it goes to, why it did not, and Retry", async () => {
    ref.listHub.mockResolvedValue([READY[2]]);
    ref.getReferral.mockResolvedValue({
      ...READY[2],
      events: [
        { eventId: id(5), fromStatus: "pending_signoff", toStatus: "approved", actor: "doctor@carein.ai", at: NOW.toISOString(), note: "", verb: "approve" },
        { eventId: id(6), fromStatus: "approved", toStatus: "approved", actor: "doctor@carein.ai", at: NOW.toISOString(), note: FAILED.note, verb: "send_failed" },
      ],
    });
    render(<HubInner office="roland" now={() => NOW} />);
    fireEvent.click(await within(await screen.findByTestId("tc-hub-group-ready")).findByTestId("tc-hub-card"));
    await screen.findByTestId("tc-hub-send-failed");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "tccheckout-14-referral-email-panel@1280x1100.html"), document.body.innerHTML, "utf8");
  });
});

describe("the platform console's referral-email switch", () => {
  function office(o: string, enabled: boolean, source: "env" | "db" | "default" = "db") {
    return {
      office: o,
      enabled,
      source,
      policyKnown: true,
      envValue: source === "env" ? false : null,
      settingKey: "tc_referral_email_enabled",
      envVar: `TC_REFERRAL_EMAIL_ENABLED_${o.toUpperCase()}`,
      updatedAt: null,
      updatedBy: null,
    };
  }

  beforeEach(() => {
    platform.view = {
      offices: [office("roland", false, "default"), office("valley", false, "env")],
      settingKey: "tc_referral_email_enabled",
      controlPlaneError: null,
    };
    platform.sets = [];
  });

  it("lists the offices with the layer that answered; ON asks first; the env break-glass is said out loud", async () => {
    render(<TcReferralEmailPanel />);
    const roland = await screen.findByTestId("tc-referral-email-office-roland");
    expect(roland.textContent).toMatch(/Default \(off\)/);
    expect(screen.getByTestId("tc-referral-email-office-valley").textContent).toContain(
      "TC_REFERRAL_EMAIL_ENABLED_VALLEY=false is forcing this office OFF",
    );
    fireEvent.click(screen.getByTestId("tc-referral-email-switch-roland"));
    expect(platform.sets).toEqual([]);
    fireEvent.click(await screen.findByTestId("tc-referral-email-confirm-on"));
    await waitFor(() => expect(platform.sets).toEqual([["roland", true]]));
    await waitFor(() =>
      expect(screen.getByTestId("tc-referral-email-switch-roland").getAttribute("aria-checked")).toBe("true"),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Referral email on for Roland");
  });
});
