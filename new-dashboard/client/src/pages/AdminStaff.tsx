/**
 * /admin/staff — Practice staff: the hygienists whose names and licence numbers
 * print on a hygiene note, beside the Users page and behind the same gate.
 *
 * WHAT THE SERVER OWNS. Every rule this page appears to apply is the server's
 * (routes/hygStaff.js): who may edit (admin.all — a hygienist cannot), that a
 * sign-in belongs to one person per office, that a blank licence is "none on
 * file". The page shows the server's own words when it refuses, and shows a
 * row as saved only once the server has sent it back as read.
 *
 * THE OFFICE IS NEVER TYPED. It comes from the app's office picker
 * (OfficeContext). "All offices" shows one section per hygiene office; a
 * single office shows its own. Nothing here asks which office a person is in.
 *
 * Doctors are not here yet — they stay in config for now.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, IdCard, Loader2, Pencil, Plus, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, api } from "@/lib/api";
import { ALL_OFFICES, useOffice } from "@/contexts/OfficeContext";
import type { HygStaff, HygStaffInput } from "@shared/hyg/staff";

/** The offices hyg_staff knows. Mirrors the table's CHECK. */
const STAFF_OFFICES = ["roland", "valley"] as const;
type StaffOffice = (typeof STAFF_OFFICES)[number];

function isStaffOffice(value: string): value is StaffOffice {
  return (STAFF_OFFICES as readonly string[]).includes(value);
}

function messageOf(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

/** One sign-in per line, or separated by commas. */
function splitSignIns(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

interface Draft {
  fullName: string;
  license: string;
  signIns: string;
}

const EMPTY_DRAFT: Draft = { fullName: "", license: "", signIns: "" };

function draftOf(s: HygStaff): Draft {
  return { fullName: s.fullName, license: s.license ?? "", signIns: s.signInIds.join("\n") };
}

function inputOf(d: Draft): HygStaffInput {
  return { fullName: d.fullName, license: d.license.trim() === "" ? null : d.license, signInIds: splitSignIns(d.signIns) };
}

/** The add and edit form: the same three fields, the same words. */
function StaffForm({
  testId,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  testId: string;
  initial: Draft;
  submitLabel: string;
  onSubmit: (input: HygStaffInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(inputOf(draft));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3" data-testid={testId}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-foreground">
          Full name, as it prints on the note
          <Input
            className="mt-1"
            value={draft.fullName}
            onChange={(e) => setDraft({ ...draft, fullName: e.target.value })}
            data-testid={`${testId}-name`}
          />
        </label>
        <label className="block text-xs font-medium text-foreground">
          RDH licence number
          <Input
            className="mt-1"
            value={draft.license}
            onChange={(e) => setDraft({ ...draft, license: e.target.value })}
            data-testid={`${testId}-license`}
          />
          <span className="mt-1 block font-normal text-muted-foreground">
            Leave blank if none is on file. The note then prints the name alone.
          </span>
        </label>
      </div>
      <label className="block text-xs font-medium text-foreground">
        Sign-in emails or usernames — one per line
        <textarea
          className="mt-1 block min-h-[4.5rem] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={draft.signIns}
          onChange={(e) => setDraft({ ...draft, signIns: e.target.value })}
          data-testid={`${testId}-signins`}
        />
        <span className="mt-1 block font-normal text-muted-foreground">
          How CareIN knows it is this person who is signed in. At least one; each can belong to one
          person only.
        </span>
      </label>
      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-red-700 dark:text-red-300" data-testid={`${testId}-error`}>
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void submit()} disabled={busy} data-testid={`${testId}-save`}>
          {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          {busy ? "Saving…" : submitLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy} data-testid={`${testId}-cancel`}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function StaffRow({
  office,
  staff,
  onSaved,
}: {
  office: StaffOffice;
  staff: HygStaff;
  onSaved: (s: HygStaff) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const testId = `staff-row-${staff.id}`;

  if (editing) {
    return (
      <li className="py-3">
        <StaffForm
          testId={`staff-edit-${staff.id}`}
          initial={draftOf(staff)}
          submitLabel="Save changes"
          onCancel={() => setEditing(false)}
          onSubmit={async (input) => {
            const saved = await api.updateHygStaff(office, staff.id, input);
            onSaved(saved);
            setEditing(false);
          }}
        />
      </li>
    );
  }

  const toggle = async () => {
    setToggling(true);
    setError(null);
    try {
      onSaved(await api.setHygStaffActive(office, staff.id, !staff.active));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setToggling(false);
    }
  };

  return (
    <li className="py-3" data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={staff.active ? "font-medium text-foreground" : "font-medium text-muted-foreground line-through"}>
              {staff.fullName}
            </span>
            {staff.active ? (
              <Badge variant="secondary" className="text-[10px]" data-testid={`${testId}-status`}>
                Active
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]" data-testid={`${testId}-status`}>
                Inactive — not used on notes
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground" data-testid={`${testId}-license`}>
            Licence: {staff.license ? `RDH #${staff.license}` : "— none on file"}
          </p>
          <p className="text-sm text-muted-foreground" data-testid={`${testId}-signins`}>
            Signs in as: {staff.signInIds.join(", ")}
          </p>
          {error ? (
            <p role="alert" className="text-xs text-red-700 dark:text-red-300">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)} className="gap-1.5" data-testid={`${testId}-edit`}>
            <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
          </Button>
          <Button size="sm" variant="outline" onClick={() => void toggle()} disabled={toggling} data-testid={`${testId}-toggle`}>
            {toggling ? "Saving…" : staff.active ? "Deactivate" : "Reactivate"}
          </Button>
        </div>
      </div>
    </li>
  );
}

function OfficeStaffSection({ office, officeName }: { office: StaffOffice; officeName: string }) {
  const [staff, setStaff] = useState<HygStaff[] | null>(null);
  const [builtIn, setBuiltIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .listHygStaff(office)
      .then((r) => {
        setStaff(r.staff);
        setBuiltIn(r.usingBuiltInList);
      })
      .catch((e: unknown) => setError(messageOf(e)));
  }, [office]);

  useEffect(() => load(), [load]);

  const replace = (saved: HygStaff) => {
    setStaff((prev) => (prev ?? []).map((s) => (s.id === saved.id ? saved : s)));
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4" data-testid={`staff-office-${office}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">{officeName}</h2>
        {!adding ? (
          <Button size="sm" onClick={() => setAdding(true)} className="gap-1.5" data-testid={`staff-add-${office}`}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add hygienist
          </Button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300" data-testid={`staff-error-${office}`}>
          Could not load this office's staff: {error}
        </p>
      ) : staff === null ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
        </p>
      ) : (
        <>
          {builtIn ? (
            <p
              className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
              data-testid={`staff-builtin-${office}`}
            >
              No one is entered for this office yet, so hygiene notes still use the names CareIN was set
              up with. Once you add someone here, notes for this office use this list only.
            </p>
          ) : null}
          {adding ? (
            <div className="mt-3">
              <StaffForm
                testId={`staff-new-${office}`}
                initial={EMPTY_DRAFT}
                submitLabel="Add hygienist"
                onCancel={() => setAdding(false)}
                onSubmit={async (input) => {
                  const saved = await api.createHygStaff(office, input);
                  setStaff((prev) => [...(prev ?? []), saved]);
                  setBuiltIn(false);
                  setAdding(false);
                }}
              />
            </div>
          ) : null}
          {staff.length > 0 ? (
            <ul className="mt-2 divide-y divide-border" data-testid={`staff-list-${office}`}>
              {staff.map((s) => (
                <StaffRow key={s.id} office={office} staff={s} onSaved={replace} />
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}

export default function AdminStaff() {
  const { office, offices, loading, error } = useOffice();
  const [generation, setGeneration] = useState(0);

  const nameOf = (id: string) => offices.find((o) => o.officeId === id)?.officeName ?? id;
  const inScope: StaffOffice[] =
    office === ALL_OFFICES
      ? STAFF_OFFICES.filter((o) => offices.some((r) => r.officeId === o))
      : isStaffOffice(office)
        ? [office]
        : [];

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <IdCard className="h-5 w-5 text-muted-foreground" aria-hidden /> Practice staff
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            The hygienists whose name and licence number print at the end of a hygiene note, and the
            sign-ins that tell CareIN who is writing it. Doctors are not listed here yet.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setGeneration((n) => n + 1)} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading offices…</p>
      ) : error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          Could not load the office list: {error}
        </p>
      ) : inScope.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="staff-no-office">
          Practice staff is kept per hygiene office. Choose one of those offices, or All offices, in the
          office menu.
        </p>
      ) : (
        <div className="space-y-4" key={generation}>
          {inScope.map((o) => (
            <OfficeStaffSection key={o} office={o} officeName={nameOf(o)} />
          ))}
        </div>
      )}
    </div>
  );
}
