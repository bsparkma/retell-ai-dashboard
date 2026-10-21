/**
 * /tc/referrals — the Referrals hub (queue item 56, R6).
 *
 * Every referral for the office, grouped by where it stands: Drafts, Awaiting
 * sign-off, Ready to send, Sent, Patient seen, and a collapsed Closed /
 * declined / cancelled group. Filters: status, specialist, where it started,
 * how long it has sat. Open one for its history, its files (each view
 * audited), the edit form, and its next step.
 *
 * tc.full (a doctor never gets here — their surface is /tc/referrals/signoff)
 * and dark while referrals is off for the office; the server enforces both.
 *
 * NOTHING SENDS. Sending ships later (R5). Until then an approved referral
 * goes out by hand, and the three marks here — "Mark sent outside the app",
 * "Specialist acknowledged", "Patient seen" — are a person RECORDING that it
 * happened. They email, fax and trigger nothing, and they say so.
 *
 * Every state shown is the server's answer: nothing reads as saved, moved or
 * marked before the server confirms it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Loader2, Paperclip, Pencil, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { tcErrorMessage } from "@/features/tc/api";
import { TcOfficeGate, TcPageHeader, useTcOffice } from "@/features/tc/components/TcShell";
import {
  editReferralFields,
  getReferral,
  getReferralsStatus,
  listDirectory,
  listHub,
  listReferralAttachments,
  markReferral,
  openReferralAttachment,
  reopenReferral,
  type ReferralMark,
} from "@/features/tc/referrals/referralsApi";
import { AttachmentList, ReferralStatusBadge, teethLabel, viewAttachment } from "@/features/tc/referrals/ReferralsPanel";
import { ReferralFieldsForm, type ReferralFieldsChange } from "@/features/tc/referrals/ReferralFieldsForm";
import { ReferralTimeline } from "@/features/tc/referrals/ReferralTimeline";
import type { OfficeId } from "@shared/tc/contract";
import {
  REFERRAL_FIELD_EDITABLE_STATUSES,
  REFERRAL_MARK_LABELS,
  REFERRAL_READY_TO_SEND_COPY,
  TC_REFERRAL_HUB_GROUPS,
  TC_REFERRAL_STATUS_LABELS,
  TC_REFERRAL_URGENCY_LABELS,
  TcReferralSourceKind,
  TcReferralStatus,
  referralHubGroup,
  referralReturnedLine,
  referralStatusAge,
  type TcReferral,
  type TcReferralAttachment,
  type TcReferralDirectoryEntry,
  type TcReferralHubQuery,
} from "@shared/tc/referrals";

export const SOURCE_LABELS: Record<TcReferralSourceKind, string> = {
  case: "TC case",
  checkout: "Checkout",
  hyg_visit: "Hygiene visit",
  call: "Call",
};

const AGE_OPTIONS = [
  { value: "", label: "Any age" },
  { value: "1", label: "1+ days" },
  { value: "3", label: "3+ days" },
  { value: "7", label: "7+ days" },
  { value: "14", label: "14+ days" },
];

/**
 * The next manual mark for a status, if any — the pre-R5 world only. Pure.
 * (The shared transition table still decides; this only picks the button.)
 */
export function nextMark(status: TcReferralStatus): ReferralMark | null {
  switch (status) {
    case "approved":
      return "mark_sent";
    case "sent":
      return "mark_acknowledged";
    case "acknowledged":
      return "mark_patient_seen";
    case "patient_seen":
      return "close";
    default:
      return null;
  }
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
  const [referrals, setReferrals] = useState<TcReferral[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<TcReferralDirectoryEntry[]>([]);
  const [filter, setFilter] = useState<TcReferralHubQuery>({});
  const [showDone, setShowDone] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

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
        if (!cancelled) setEnabled(s.enabled);
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
        subtitle="Every referral for this office. Nothing is sent from here — sending ships in a later update."
        actions={
          <Button variant="outline" size="sm" onClick={load} aria-label="Refresh">
            <RefreshCw className="w-4 h-4" />
          </Button>
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
                    <HubCard key={r.referralId} referral={r} now={at} onOpen={() => setOpenId(r.referralId)} />
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
      />
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
      </div>
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
}: {
  office: OfficeId;
  referralId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [r, setR] = useState<TcReferral | null>(null);
  const [files, setFiles] = useState<TcReferralAttachment[]>([]);
  const [entries, setEntries] = useState<TcReferralDirectoryEntry[]>([]);
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [markText, setMarkText] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setR(null);
    setFiles([]);
    setEditing(null);
    setServerError(null);
    setMarkText("");
    setLoadError(null);
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

  function startEdit(kind: Exclude<Editing, null>) {
    setServerError(null);
    setEditing(kind);
    listDirectory(office, false)
      .then(setEntries)
      .catch(() => setEntries([]));
  }

  /** Run a change; show only what the server answered. */
  async function act(run: () => Promise<TcReferral>, ok: string) {
    setBusy(true);
    setServerError(null);
    try {
      const next = await run();
      setR(next);
      setEditing(null);
      setMarkText("");
      toast.success(ok);
    } catch (e) {
      setServerError(tcErrorMessage(e));
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

  const mark = r ? nextMark(r.status) : null;
  const editable = r ? REFERRAL_FIELD_EDITABLE_STATUSES.includes(r.status) : false;
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
            </dl>

            <AttachmentList
              attachments={files}
              onView={(a) => void viewAttachment(() => openReferralAttachment(office, r.referralId, a.attachmentId))}
            />

            {editing ? (
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
            ) : (
              <div className="space-y-3" data-testid="tc-hub-actions">
                {editable && (
                  <Button size="sm" variant="outline" className="gap-1" onClick={() => startEdit("fields")}>
                    <Pencil className="w-3.5 h-3.5" /> Edit
                  </Button>
                )}
                {r.status === "approved" && (
                  <>
                    <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{REFERRAL_READY_TO_SEND_COPY}</p>
                    <Button size="sm" variant="outline" className="gap-1" onClick={() => startEdit("reopen")}>
                      <Pencil className="w-3.5 h-3.5" /> Edit (re-approval needed)
                    </Button>
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
