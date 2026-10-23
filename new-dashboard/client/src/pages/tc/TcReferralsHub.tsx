/**
 * /tc/referrals — the Referrals hub (queue item 56, R6).
 *
 * Every referral for the office, grouped by where it stands: Drafts, Awaiting
 * sign-off, Ready to send, Sent, Patient seen, and a collapsed Closed /
 * declined / cancelled group. Filters: status, specialist, where it started,
 * how long it has sat. Open one for its history, its files (each view
 * audited), the edit form, and its next step.
 *
 * NEXT STEPS (R6.1). The panel offers exactly the moves the shared transition
 * table allows from the referral's status (features/tc/referrals/hubActions):
 * a draft can be submitted, edited or cancelled; one awaiting sign-off can be
 * withdrawn or cancelled. They go through the same routes the case panel uses.
 * The doctor's moves stay on Awaiting sign-off (approving can email it), so
 * the hub names where to act instead of drawing them.
 *
 * tc.full (a doctor never gets here — their surface is /tc/referrals/signoff)
 * and dark while referrals is off for the office; the server enforces both.
 *
 * SENDING (R5). Where the office has referral email switched on, an approved
 * referral can be EMAILED to its specialist: a Send button under its card
 * and in its panel, enabled only when the directory row has an email. It
 * reads as sent only once the server says ACS accepted it; a failure leaves
 * it approved with the reason and a retry. Where email is off, nothing here
 * sends, exactly as before: an approved referral goes out by hand, and the
 * marks — "Mark sent outside the app", "Specialist acknowledged", "Patient
 * seen" — are a person RECORDING that it happened. They email, fax and
 * trigger nothing, and they say so.
 *
 * Every state shown is the server's answer: nothing reads as saved, moved,
 * marked or sent before the server confirms it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Loader2, Mail, Paperclip, Pencil, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/contexts/AuthContext";
import { can } from "@/lib/permissions";
import { TcApiError, tcErrorMessage } from "@/features/tc/api";
import { TcOfficeGate, TcPageHeader, useTcOffice } from "@/features/tc/components/TcShell";
import {
  editReferralFields,
  getReferral,
  getReferralSettings,
  getReferralsStatus,
  listDirectory,
  listHub,
  listReferralAttachments,
  markReferral,
  openReferralAttachment,
  referralVerb,
  reopenReferral,
  sendReferralEmail,
  uploadReferralAttachment,
  type ReferralMark,
} from "@/features/tc/referrals/referralsApi";
import {
  HUB_MARK_VERBS,
  hubActionLabel,
  hubActionPlan,
  type HubViewer,
} from "@/features/tc/referrals/hubActions";
import {
  AttachmentList,
  ReferralResponseSignals,
  ReferralStatusBadge,
  teethLabel,
  viewAttachment,
} from "@/features/tc/referrals/ReferralsPanel";
import { AddAttachments } from "@/features/tc/referrals/AddAttachments";
import { NewHubReferral } from "@/features/tc/referrals/NewHubReferral";
import { ReferralFieldsForm, type ReferralFieldsChange } from "@/features/tc/referrals/ReferralFieldsForm";
import { ReferralTimeline } from "@/features/tc/referrals/ReferralTimeline";
import type { OfficeId } from "@shared/tc/contract";
import {
  REFERRAL_FIELD_EDITABLE_STATUSES,
  REFERRAL_MARK_LABELS,
  REFERRAL_READY_TO_EMAIL_COPY,
  REFERRAL_READY_TO_SEND_COPY,
  TC_REFERRAL_HUB_GROUPS,
  TC_REFERRAL_STATUS_LABELS,
  TC_REFERRAL_URGENCY_LABELS,
  TcReferralSourceKind,
  TcReferralStatus,
  referralDateLabel,
  referralHubGroup,
  referralNextStatus,
  referralResponseBadges,
  referralReturnedLine,
  referralSendBlocker,
  referralStatusAge,
  type TcReferral,
  type TcReferralAttachment,
  type TcReferralDirectoryEntry,
  type TcReferralHubQuery,
  type TcReferralSendOutcome,
  type TcReferralsStatus,
} from "@shared/tc/referrals";

/** R5: the office's referral-email state, as GET /status answered it (absent = off). */
export type ReferralEmailState = NonNullable<TcReferralsStatus["emailSend"]>;

export const SOURCE_LABELS: Record<TcReferralSourceKind, string> = {
  case: "TC case",
  checkout: "Checkout",
  hyg_visit: "Hygiene visit",
  call: "Call",
  // R6.2: started by hand on this page ("started from referrals hub").
  manual: "Referrals hub",
};

const AGE_OPTIONS = [
  { value: "", label: "Any age" },
  { value: "1", label: "1+ days" },
  { value: "3", label: "3+ days" },
  { value: "7", label: "7+ days" },
  { value: "14", label: "14+ days" },
];

/**
 * The next manual mark for a status, if any. Pure: the shared transition table
 * decides (no mark depends on the sign-off policy).
 */
export function nextMark(status: TcReferralStatus): ReferralMark | null {
  return HUB_MARK_VERBS.find((m) => referralNextStatus(status, m, { signoffRequired: true }) !== null) ?? null;
}

/**
 * Who is looking, for the detail panel's buttons. UX only — every move is
 * re-checked by the server. This page renders only behind the /tc route's
 * tc.full gate (lib/permissions ROUTE_PERMISSIONS), so until /auth/me has
 * answered, tc.full is what the route already established; sign-off is never
 * assumed.
 */
export function useHubViewer(): HubViewer {
  const auth = useAuth();
  if (auth.status !== "authenticated") return { tcFull: true, signoff: false };
  const { isSuperAdmin, permissions } = auth.user;
  return {
    tcFull: isSuperAdmin || can(permissions, "tc.full"),
    signoff: isSuperAdmin || can(permissions, "tc.referral_signoff"),
  };
}

/** Referrals → the hub's groups, in page order, each newest status change first. Pure. */
export function groupForHub(referrals: readonly TcReferral[]) {
  return TC_REFERRAL_HUB_GROUPS.map((g) => ({
    ...g,
    referrals: referrals
      .filter((r) => referralHubGroup(r.status) === g.key)
      .sort((a, b) => (a.statusChangedAt < b.statusChangedAt ? 1 : -1)),
  }));
}

export default function TcReferralsHub() {
  const office = useTcOffice();
  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }
  return <HubInner key={office} office={office} />;
}

export function HubInner({ office, now = () => new Date() }: { office: OfficeId; now?: () => Date }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [emailSend, setEmailSend] = useState<ReferralEmailState | null>(null);
  const [referrals, setReferrals] = useState<TcReferral[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<TcReferralDirectoryEntry[]>([]);
  const [filter, setFilter] = useState<TcReferralHubQuery>({});
  const [showDone, setShowDone] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  /** The office's sign-off policy, only to say where Submit leads; null = unread. */
  const [signoffRequired, setSignoffRequired] = useState<boolean | null>(null);
  const viewer = useHubViewer();

  const load = useCallback(() => {
    setError(null);
    listHub(office, filter)
      .then(setReferrals)
      .catch((e: unknown) => setError(tcErrorMessage(e)));
  }, [office, filter]);

  useEffect(() => {
    let cancelled = false;
    getReferralsStatus(office)
      .then((s) => {
        if (cancelled) return;
        setEnabled(s.enabled);
        setEmailSend(s.emailSend ?? null);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    // Every specialist, inactive too: a filter has to find old referrals.
    listDirectory(office, true)
      .then((e) => {
        if (!cancelled) setEntries(e);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [office]);

  useEffect(() => {
    if (enabled) load();
  }, [enabled, load]);

  // Only once referrals is on (the route 403s otherwise). A policy that cannot
  // be read leaves Submit's label generic; the server decides where it goes.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => getReferralSettings(office))
      .then((s) => {
        if (!cancelled) setSignoffRequired(s.signoffRequired.value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [office, enabled]);

  const groups = useMemo(() => groupForHub(referrals ?? []), [referrals]);
  const at = now();

  function setF<K extends keyof TcReferralHubQuery>(k: K, v: string) {
    setFilter((f) => ({ ...f, [k]: v === "" ? undefined : k === "minAgeDays" ? Number(v) : v }));
  }

  if (enabled === false) {
    return (
      <div className="p-6">
        <TcPageHeader title="Referrals" />
        <p className="text-sm text-muted-foreground" data-testid="tc-hub-off">
          Referrals are not switched on for this office.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <TcPageHeader
        title="Referrals"
        subtitle={
          emailSend?.enabled
            ? "Every referral for this office. Approved referrals can be emailed to their specialist from here."
            : "Every referral for this office. Nothing is sent from here — sending ships in a later update."
        }
        actions={
          <div className="flex items-center gap-2">
            {/* R6.2: start one by hand. tc.full, like every hub move; the server re-checks. */}
            {viewer.tcFull && (
              <NewHubReferral
                office={office}
                onCreated={(r) => {
                  load();
                  setOpenId(r.referralId);
                }}
              />
            )}
            <Button variant="outline" size="sm" onClick={load} aria-label="Refresh">
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-end gap-3" data-testid="tc-hub-filters">
        <FilterSelect
          id="hub-status"
          label="Status"
          value={filter.status ?? ""}
          onChange={(v) => setF("status", v)}
          options={[{ value: "", label: "Any status" }, ...TcReferralStatus.options.map((s) => ({ value: s, label: TC_REFERRAL_STATUS_LABELS[s] }))]}
        />
        <FilterSelect
          id="hub-specialist"
          label="Specialist"
          value={filter.directoryEntryId ?? ""}
          onChange={(v) => setF("directoryEntryId", v)}
          options={[{ value: "", label: "Any specialist" }, ...entries.map((e) => ({ value: e.entryId, label: e.practiceName }))]}
        />
        <FilterSelect
          id="hub-source"
          label="Started from"
          value={filter.sourceKind ?? ""}
          onChange={(v) => setF("sourceKind", v)}
          options={[{ value: "", label: "Anywhere" }, ...TcReferralSourceKind.options.map((s) => ({ value: s, label: SOURCE_LABELS[s] }))]}
        />
        <FilterSelect
          id="hub-age"
          label="Sat for"
          value={filter.minAgeDays === undefined ? "" : String(filter.minAgeDays)}
          onChange={(v) => setF("minAgeDays", v)}
          options={AGE_OPTIONS}
        />
      </div>

      {error ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="w-4 h-4 mr-1" /> Retry
          </Button>
        </div>
      ) : referrals === null ? (
        <div className="flex items-center gap-2 py-12 justify-center text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3" data-testid="tc-hub-groups">
          {groups.map((g) => {
            const collapsed = g.key === "done" && !showDone;
            return (
              <section key={g.key} className="space-y-2 rounded-xl border border-border bg-card p-3" data-testid={`tc-hub-group-${g.key}`}>
                <h2 className="flex items-center justify-between text-sm font-semibold text-foreground">
                  {g.key === "done" ? (
                    <button
                      type="button"
                      className="flex items-center gap-1"
                      onClick={() => setShowDone((x) => !x)}
                      aria-expanded={showDone}
                    >
                      {showDone ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      {g.label}
                    </button>
                  ) : (
                    <span>{g.label}</span>
                  )}
                  <span className="text-xs font-normal text-muted-foreground" data-testid="tc-hub-group-count">
                    {g.referrals.length}
                  </span>
                </h2>
                {!collapsed && g.referrals.length === 0 && <p className="text-xs text-muted-foreground">None</p>}
                {!collapsed &&
                  g.referrals.map((r) => (
                    <div key={r.referralId} className="space-y-1">
                      <HubCard referral={r} now={at} onOpen={() => setOpenId(r.referralId)} />
                      {/* A sibling of the card, never inside it: the card is itself a button. */}
                      {emailSend?.enabled && r.status === "approved" && (
                        <CardSend office={office} referral={r} email={emailSend} onDone={load} />
                      )}
                    </div>
                  ))}
              </section>
            );
          })}
        </div>
      )}

      <HubDetail
        office={office}
        referralId={openId}
        onClose={() => setOpenId(null)}
        onChanged={load}
        emailSend={emailSend}
        viewer={viewer}
        signoffRequired={signoffRequired}
      />
    </div>
  );
}

/**
 * R5: the send route's refusals are already a person's sentence naming the
 * cause ("…switched off…", "…unsubscribed…", "The email went out, but…"), so
 * show it as sent — the generic code mapping would hide which one it was.
 */
export function sendErrorMessage(e: unknown): string {
  return e instanceof TcApiError && e.message ? e.message : tcErrorMessage(e);
}

/** R5b: "Tue, Nov 3, 2026" for the 'YYYY-MM-DD' a link gave; the raw value if it does not parse. */
export function scheduledDateLabel(ymd: string): string {
  return referralDateLabel(ymd);
}

/**
 * R5b: the send's sentence, then what happened to the patient's email (sent,
 * skipped and why, or failed) — the server's words, both.
 */
export function sendOutcomeLine(outcome: TcReferralSendOutcome): string {
  return outcome.patientEmail ? `${outcome.message} ${outcome.patientEmail.message}` : outcome.message;
}

/**
 * R5: email it, and say what happened — only the server's answer. A refusal
 * or a conflict comes back as the server's own sentence.
 */
async function runSend(office: OfficeId, referralId: string): Promise<void> {
  try {
    const { outcome } = await sendReferralEmail(office, referralId);
    toast.success(sendOutcomeLine(outcome));
  } catch (e) {
    toast.error(sendErrorMessage(e));
  }
}

/** The send row under an approved card. */
export function CardSend({
  office,
  referral: r,
  email,
  onDone,
}: {
  office: OfficeId;
  referral: TcReferral;
  email: ReferralEmailState;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const blocker = referralSendBlocker(r, email);
  const failed = r.sendProblem?.kind === "failed" ? r.sendProblem : null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-1 text-xs" data-testid="tc-hub-card-send">
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1"
        disabled={busy || blocker !== null}
        title={blocker ?? (r.specialistEmail ? `Email it to ${r.specialistEmail}` : undefined)}
        onClick={async () => {
          setBusy(true);
          await runSend(office, r.referralId);
          setBusy(false);
          onDone();
        }}
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
        {failed ? "Retry send" : "Send"}
      </Button>
      {blocker ? (
        <span className="text-muted-foreground" data-testid="tc-hub-card-send-blocked">
          {blocker}
        </span>
      ) : failed ? (
        <span className="text-amber-800 dark:text-amber-300" data-testid="tc-hub-card-send-failed">
          Last email did not go out — {failed.note}
        </span>
      ) : (
        <span className="text-muted-foreground truncate">to {r.specialistEmail}</span>
      )}
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <select
        id={id}
        className="h-9 min-w-40 rounded-md border border-input bg-background px-2 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function HubCard({ referral: r, now, onOpen }: { referral: TcReferral; now: Date; onOpen: () => void }) {
  const returned = referralReturnedLine(r.returned);
  const patientEmailLine = referralResponseBadges(r).patientEmail;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left rounded-lg border border-border bg-background p-2.5 hover:bg-muted/50 space-y-1"
      data-testid="tc-hub-card"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground truncate">{r.patientName}</span>
        <span className="text-xs text-muted-foreground whitespace-nowrap" data-testid="tc-hub-age">
          {referralStatusAge(r.status, r.statusChangedAt, now)}
        </span>
      </div>
      <p className="text-sm text-muted-foreground truncate">{r.practiceName ?? "No specialist chosen yet"}</p>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge variant="outline" data-testid="tc-hub-source">
          {SOURCE_LABELS[r.sourceKind]}
        </Badge>
        {r.urgency !== "routine" && <Badge variant="outline">{TC_REFERRAL_URGENCY_LABELS[r.urgency]}</Badge>}
        <span className="flex items-center gap-0.5 text-muted-foreground" data-testid="tc-hub-attachments">
          <Paperclip className="w-3 h-3" /> {r.attachmentCount ?? 0}
        </span>
        {/* The responses we collect, without opening the card. */}
        <ReferralResponseSignals referral={r} withPatientEmail={false} />
      </div>
      {patientEmailLine && (
        <p className="text-xs text-muted-foreground truncate" title={patientEmailLine} data-testid="referral-response-patient-email">
          {patientEmailLine}
        </p>
      )}
      {returned && (
        <p className="text-xs font-medium text-amber-800 dark:text-amber-300" data-testid="tc-hub-returned">
          {returned}
        </p>
      )}
    </button>
  );
}

// ── The detail panel ────────────────────────────────────────────────────────

type Editing = null | "fields" | "reopen";

export function HubDetail({
  office,
  referralId,
  onClose,
  onChanged,
  emailSend = null,
  viewer = { tcFull: true, signoff: false },
  signoffRequired = null,
}: {
  office: OfficeId;
  referralId: string | null;
  onClose: () => void;
  onChanged: () => void;
  /** R5: the office's referral-email state; null / off = no send UI, as before. */
  emailSend?: ReferralEmailState | null;
  /** R6.1: who is looking (UX only; the server re-checks every move). */
  viewer?: HubViewer;
  /** R6.1: the office's sign-off policy, for Submit's label; null = unread. */
  signoffRequired?: boolean | null;
}) {
  const [r, setR] = useState<TcReferral | null>(null);
  const [files, setFiles] = useState<TcReferralAttachment[]>([]);
  const [entries, setEntries] = useState<TcReferralDirectoryEntry[]>([]);
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [markText, setMarkText] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    setR(null);
    setFiles([]);
    setEditing(null);
    setServerError(null);
    setMarkText("");
    setLoadError(null);
    setConfirmCancel(false);
    if (!referralId) return;
    let cancelled = false;
    getReferral(office, referralId)
      .then((x) => {
        if (!cancelled) setR(x);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(tcErrorMessage(e));
      });
    listReferralAttachments(office, referralId)
      .then((x) => {
        if (!cancelled) setFiles(x);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [office, referralId]);

  /** R6.2: re-read the stored files after an upload, so what shows is what landed. */
  function reloadFiles() {
    if (!referralId) return;
    listReferralAttachments(office, referralId)
      .then(setFiles)
      .catch(() => undefined);
  }

  function startEdit(kind: Exclude<Editing, null>) {
    setServerError(null);
    setEditing(kind);
    listDirectory(office, false)
      .then(setEntries)
      .catch(() => setEntries([]));
  }

  /** Run a change; show only what the server answered. */
  async function act(run: () => Promise<TcReferral>, ok: string | ((next: TcReferral) => string)) {
    setBusy(true);
    setServerError(null);
    setConfirmCancel(false);
    try {
      const next = await run();
      setR(next);
      setEditing(null);
      setMarkText("");
      toast.success(typeof ok === "string" ? ok : ok(next));
    } catch (e) {
      setServerError(tcErrorMessage(e));
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  /** R5: email it. Shows the server's answer; on a refusal, re-reads it so a send_failed / conflict row shows. */
  async function send() {
    if (!r) return;
    setBusy(true);
    setServerError(null);
    try {
      const { referral, outcome } = await sendReferralEmail(office, r.referralId);
      setR(referral);
      toast.success(sendOutcomeLine(outcome));
    } catch (e) {
      setServerError(sendErrorMessage(e));
      try {
        setR(await getReferral(office, r.referralId));
      } catch {
        // Keep what is shown; the error above already says it did not go.
      }
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  function save(change: ReferralFieldsChange) {
    if (!r) return;
    // Staff never write the doctor's note.
    const { doctorNote: _ignored, ...fields } = change;
    if (editing === "reopen") {
      void act(() => reopenReferral(office, r.referralId, fields), "Back with the doctor for re-approval");
    } else {
      void act(() => editReferralFields(office, r.referralId, fields), "Referral updated");
    }
  }

  /** submit / withdraw / cancel, through the same routes the case panel uses. */
  function move(verb: "submit" | "withdraw" | "cancel") {
    if (!r) return;
    void act(
      () => referralVerb(office, r.referralId, verb),
      (next) =>
        verb === "submit"
          ? next.status === "approved"
            ? "Referral approved (sign-off not required)"
            : "Sent for the doctor's sign-off"
          : verb === "withdraw"
            ? "Back to draft"
            : "Referral cancelled",
    );
  }

  const plan = r ? hubActionPlan(r.status, viewer, signoffRequired) : null;
  const offered = (verb: string) => plan?.actions.find((a) => a.verb === verb) ?? null;
  const mark = HUB_MARK_VERBS.find((m) => offered(m) !== null) ?? null;
  const submit = offered("submit");
  const withdraw = offered("withdraw");
  const cancel = offered("cancel");
  const reopen = offered("reopen");
  const editable = r ? viewer.tcFull && REFERRAL_FIELD_EDITABLE_STATUSES.includes(r.status) : false;
  const returned = r ? referralReturnedLine(r.returned) : null;

  return (
    <Sheet open={referralId !== null} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto" data-testid="tc-hub-detail">
        {loadError && <p className="p-4 text-sm text-destructive">{loadError}</p>}
        {!r && !loadError && (
          <div className="flex items-center gap-2 p-6 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        {r && (
          <div className="space-y-4 p-4">
            <SheetHeader className="p-0">
              <SheetTitle className="flex items-center gap-2">
                {r.patientName} <ReferralStatusBadge status={r.status} />
              </SheetTitle>
              <SheetDescription>
                Referral to {r.practiceName ?? "a specialist not yet chosen"}
                {r.specialty ? ` (${r.specialty})` : ""} · started from {SOURCE_LABELS[r.sourceKind].toLowerCase()}
              </SheetDescription>
            </SheetHeader>

            {returned && (
              <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200" data-testid="tc-hub-detail-returned">
                {returned}
              </p>
            )}

            <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Reason</dt>
              <dd>{r.reason}</dd>
              <dt className="text-muted-foreground">Teeth</dt>
              <dd>{teethLabel(r.teeth) || "—"}</dd>
              <dt className="text-muted-foreground">How soon</dt>
              <dd>{TC_REFERRAL_URGENCY_LABELS[r.urgency]}</dd>
              <dt className="text-muted-foreground">Referring</dt>
              <dd>{r.referringProvider || "—"}</dd>
              <dt className="text-muted-foreground">Notes</dt>
              <dd className="whitespace-pre-wrap">{r.narrative || "—"}</dd>
              {r.doctorNote && (
                <>
                  <dt className="text-muted-foreground">Doctor's note</dt>
                  <dd className="whitespace-pre-wrap">{r.doctorNote}</dd>
                </>
              )}
              {r.scheduledDate && (
                <>
                  <dt className="text-muted-foreground">Appointment</dt>
                  <dd data-testid="tc-hub-detail-scheduled">{scheduledDateLabel(r.scheduledDate)} (from the email link)</dd>
                </>
              )}
            </dl>

            <AttachmentList
              attachments={files}
              onView={(a) => void viewAttachment(() => openReferralAttachment(office, r.referralId, a.attachmentId))}
            />

            {editing ? (
              <>
                <ReferralFieldsForm
                  referral={r}
                  entries={entries}
                  saving={busy}
                  serverError={serverError}
                  saveLabel={editing === "reopen" ? "Save & send for re-approval" : "Save changes"}
                  hint={
                    editing === "reopen"
                      ? "This referral is approved. Saving sends it back to the doctor for sign-off first."
                      : undefined
                  }
                  onSave={save}
                  onCancel={() => {
                    setEditing(null);
                    setServerError(null);
                  }}
                />
                {/* R6.2: files only where staff may edit (draft / awaiting sign-off), never on a reopen. */}
                {editing === "fields" && editable && (
                  <AddAttachments
                    alreadyAttached={files.length}
                    upload={(f) => uploadReferralAttachment(office, r.referralId, f)}
                    onDone={reloadFiles}
                    disabled={busy}
                  />
                )}
              </>
            ) : (
              <div className="space-y-3" data-testid="tc-hub-actions">
                {(editable || submit || withdraw || cancel) && (
                  <div className="flex flex-wrap items-center gap-2" data-testid="tc-hub-moves">
                    {submit && (
                      <Button size="sm" onClick={() => move("submit")} disabled={busy} data-testid="tc-hub-submit">
                        {hubActionLabel(submit)}
                      </Button>
                    )}
                    {editable && (
                      <Button size="sm" variant="outline" className="gap-1" onClick={() => startEdit("fields")}>
                        <Pencil className="w-3.5 h-3.5" /> Edit
                      </Button>
                    )}
                    {withdraw && (
                      <Button size="sm" variant="outline" onClick={() => move("withdraw")} disabled={busy} data-testid="tc-hub-withdraw">
                        {hubActionLabel(withdraw)}
                      </Button>
                    )}
                    {cancel && !confirmCancel && (
                      <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(true)} disabled={busy} data-testid="tc-hub-cancel">
                        {hubActionLabel(cancel)}
                      </Button>
                    )}
                  </div>
                )}
                {cancel && confirmCancel && (
                  <div className="space-y-2 rounded-lg border border-border p-3" data-testid="tc-hub-cancel-confirm">
                    <p className="text-sm">Cancel this referral? It moves to Closed / declined / cancelled and cannot be reopened.</p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="destructive" onClick={() => move("cancel")} disabled={busy}>
                        {busy && <Loader2 className="w-4 h-4 animate-spin" />} Yes, cancel it
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirmCancel(false)} disabled={busy}>
                        Keep it
                      </Button>
                    </div>
                  </div>
                )}
                {plan && plan.notes.length > 0 && (
                  <div className="space-y-1 text-xs text-muted-foreground" data-testid="tc-hub-move-notes">
                    {plan.notes.map((n) => (
                      <p key={n}>{n}</p>
                    ))}
                    {plan.signoffLink && (
                      <Link href="/tc/referrals/signoff" className="font-medium text-primary underline" data-testid="tc-hub-signoff-link">
                        Open Awaiting sign-off
                      </Link>
                    )}
                  </div>
                )}
                {r.status === "approved" && (
                  <>
                    {emailSend?.enabled ? (
                      <SendBox referral={r} email={emailSend} busy={busy} onSend={() => void send()} />
                    ) : (
                      <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{REFERRAL_READY_TO_SEND_COPY}</p>
                    )}
                    {reopen && (
                      <Button size="sm" variant="outline" className="gap-1" onClick={() => startEdit("reopen")}>
                        <Pencil className="w-3.5 h-3.5" /> {hubActionLabel(reopen)}
                      </Button>
                    )}
                  </>
                )}
                {!editable && r.status !== "approved" && (
                  <p className="text-xs text-muted-foreground" data-testid="tc-hub-readonly">
                    {["declined", "cancelled", "closed"].includes(r.status)
                      ? "This referral is finished and can no longer be edited."
                      : "This referral has gone to the specialist, so it can no longer be edited."}
                  </p>
                )}
                {mark && (
                  <MarkBox
                    mark={mark}
                    text={markText}
                    onText={setMarkText}
                    busy={busy}
                    onMark={() =>
                      void act(() => markReferral(office, r.referralId, mark, markText.trim()), `${REFERRAL_MARK_LABELS[mark]}: recorded`)
                    }
                  />
                )}
                {serverError && <p className="text-sm text-destructive">{serverError}</p>}
              </div>
            )}

            <div className="space-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">History</h3>
              <ReferralTimeline events={r.events} />
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * R5: the detail panel's send box — who it goes to, the last attempt's
 * trouble, and the button (disabled, with the reason, when it cannot go).
 */
function SendBox({
  referral: r,
  email,
  busy,
  onSend,
}: {
  referral: TcReferral;
  email: ReferralEmailState;
  busy: boolean;
  onSend: () => void;
}) {
  const blocker = referralSendBlocker(r, email);
  const problem = r.sendProblem ?? null;
  return (
    <div className="space-y-2 rounded-lg border border-border p-3" data-testid="tc-hub-send">
      <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{REFERRAL_READY_TO_EMAIL_COPY}</p>
      {r.specialistEmail && (
        <p className="text-sm" data-testid="tc-hub-send-to">
          To: {r.practiceName ? `${r.practiceName} — ` : ""}
          {r.specialistEmail}
        </p>
      )}
      {problem?.kind === "failed" && (
        <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200" data-testid="tc-hub-send-failed">
          The last email did not go out — {problem.note} You can try again.
        </p>
      )}
      {problem?.kind === "conflict" && (
        <p className="rounded-md bg-red-50 p-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-200" data-testid="tc-hub-send-conflict">
          {problem.note}
        </p>
      )}
      <Button size="sm" className="gap-1" onClick={onSend} disabled={busy || blocker !== null} data-testid="tc-hub-send-button">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
        {problem?.kind === "failed" ? "Retry send" : "Send to specialist"}
      </Button>
      {blocker && (
        <p className="text-xs text-muted-foreground" data-testid="tc-hub-send-blocked">
          {blocker}
        </p>
      )}
    </div>
  );
}

const MARK_HINTS: Record<ReferralMark, string> = {
  mark_sent:
    "Only once it has actually gone — by fax, email or by hand, outside the app. This records it; it does not send anything.",
  mark_acknowledged: "The specialist's office confirmed they have it. This records it; it contacts no one.",
  mark_patient_seen: "The specialist has seen the patient. This records it; it contacts no one.",
  close: "Nothing more to do on this referral.",
};

function MarkBox({
  mark,
  text,
  onText,
  busy,
  onMark,
}: {
  mark: ReferralMark;
  text: string;
  onText: (v: string) => void;
  busy: boolean;
  onMark: () => void;
}) {
  const required = mark === "mark_sent";
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-border p-3" data-testid="tc-hub-mark">
      <p className="text-xs text-muted-foreground">{MARK_HINTS[mark]}</p>
      <div className="space-y-1">
        <Label htmlFor="hub-mark-text" className="text-xs">
          {required ? "How and where was it sent? *" : "Note (optional)"}
        </Label>
        <Input
          id="hub-mark-text"
          value={text}
          maxLength={300}
          onChange={(e) => onText(e.target.value)}
          placeholder={required ? "e.g. Faxed to their front desk" : ""}
          disabled={busy}
        />
      </div>
      <Button size="sm" onClick={onMark} disabled={busy || (required && !text.trim())}>
        {busy && <Loader2 className="w-4 h-4 animate-spin" />} {REFERRAL_MARK_LABELS[mark]}
      </Button>
    </div>
  );
}
