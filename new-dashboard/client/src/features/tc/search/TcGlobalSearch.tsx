/**
 * TC global search — a ⌘K command palette over the current office's cases.
 *
 * ENHANCEMENT, NOT PARITY (PM ruling 9). DentaFlow's header search
 * (components/GlobalSearch.tsx) was a click-only input over an in-memory mock
 * store: no keyboard shortcut, no loading state, no error state, and a silent
 * "No results" whether the data was empty or the lookup failed. This is the
 * platform version — a shadcn/cmdk palette on the real office-scoped API, with
 * a global ⌘K / Ctrl-K opener, a debounced search that drops stale responses,
 * and a visible error state that is never disguised as an empty result.
 *
 * Office scope: results come from listCases over the offices the TC office
 * scope covers (features/tc/officeScope.ts), so the palette can only ever show
 * cases the picker's selection already grants. On "All Offices" it fans out
 * exactly like the rest of the module and labels each row with its office.
 *
 * Mounting (see the slice report): <TcGlobalSearch /> is self-contained — it
 * renders its own header opener, its own dialog, and installs its own key
 * handler. Mount it once inside the TC chrome. Use TcGlobalSearchDialog +
 * useTcSearchHotkey directly if the opener needs to live somewhere else.
 */
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Search } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { CaseStatusBadge } from "../components/TcShell";
import { OfficeBadgeWhen } from "../components/OfficeBadge";
import { useTcOfficeScope } from "../officeScope";
import { formatCents } from "../money";
import { MIN_QUERY_LENGTH, normalizeQuery } from "./matchCases";
import { useTcCaseSearch } from "./useTcCaseSearch";

/** Fields where ⌘K must stay out of the way of ordinary typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

/**
 * Global ⌘K / Ctrl-K handler. Ignores the shortcut while the user is typing in
 * an input, textarea, select, or contenteditable so it can't hijack a form.
 */
export function useTcSearchHotkey(onOpen: () => void): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "k" && e.key !== "K") return;
      if (!e.metaKey && !e.ctrlKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      onOpen();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onOpen]);
}

/** Header affordance. Escape/close is handled by the dialog itself. */
export function TcGlobalSearchOpener({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Search cases"
      className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
    >
      <Search size={14} className="shrink-0" aria-hidden />
      <span className="hidden sm:inline">Search cases</span>
      <Kbd className="hidden sm:inline-flex">⌘K</Kbd>
    </button>
  );
}

export function TcGlobalSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { offices, showOfficeBadges } = useTcOfficeScope();
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const { results, loading, error, notice, searched } = useTcCaseSearch(offices, query, open);
  const inScope = offices.length > 0;

  // Each opening starts clean — a stale query would show stale results.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const select = useCallback(
    (caseId: string) => {
      onOpenChange(false);
      navigate(`/tc/cases/${caseId}`);
    },
    [navigate, onOpenChange],
  );

  const tooShort = normalizeQuery(query).length < MIN_QUERY_LENGTH;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="sr-only">
          <DialogTitle>Search cases</DialogTitle>
          <DialogDescription>
            Search this office's treatment cases by patient, doctor, coordinator,
            phone, or email.
          </DialogDescription>
        </DialogHeader>
        {/* shouldFilter=false: matching happens in matchCases.ts against the
            API rows, so cmdk must not re-filter (and hide) phone/email hits. */}
        <Command shouldFilter={false} className="rounded-lg">
          <CommandInput
            placeholder="Search cases by patient, doctor, phone…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {!inScope && (
              <div className="py-6 px-4 text-center text-sm text-muted-foreground">
                Pick an office to search its cases.
              </div>
            )}
            {inScope && tooShort && (
              <div className="py-6 px-4 text-center text-sm text-muted-foreground">
                Type at least {MIN_QUERY_LENGTH} characters to search cases.
              </div>
            )}
            {inScope && !tooShort && loading && (
              <div className="py-6 px-4 text-center text-sm text-muted-foreground">
                Searching…
              </div>
            )}
            {inScope && !tooShort && !loading && error && (
              <div
                role="alert"
                className="py-6 px-4 text-center text-sm text-red-600 dark:text-red-400"
              >
                {error}
              </div>
            )}
            {inScope && !tooShort && !loading && !error && notice && (
              <div className="px-4 py-2 text-xs text-amber-700 dark:text-amber-400">{notice}</div>
            )}
            {inScope && !tooShort && !loading && !error && searched && results.length === 0 && (
              <CommandEmpty className="text-muted-foreground">No matching cases</CommandEmpty>
            )}
            {results.length > 0 && !loading && !error && (
              <CommandGroup heading="Cases">
                {results.map((r) => (
                  <CommandItem
                    key={r.caseId}
                    value={r.caseId}
                    onSelect={() => select(r.caseId)}
                    className="gap-3"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        {r.patientName}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">{r.subtitle}</div>
                    </div>
                    <OfficeBadgeWhen show={showOfficeBadges} officeId={r.officeId} />
                    <span className="text-xs font-semibold text-foreground shrink-0">
                      {formatCents(r.caseValueCents)}
                    </span>
                    <CaseStatusBadge status={r.status} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/** Opener + dialog + ⌘K handler in one mount. */
export function TcGlobalSearch() {
  const [open, setOpen] = useState(false);
  const onOpen = useCallback(() => setOpen(true), []);
  useTcSearchHotkey(onOpen);
  return (
    <>
      <TcGlobalSearchOpener onOpen={onOpen} />
      <TcGlobalSearchDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
