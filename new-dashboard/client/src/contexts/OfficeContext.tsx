/**
 * OfficeContext — one global office selection for the whole app.
 *
 * The office selector lives in the app shell (sidebar). Pages consume this
 * context instead of owning their own dropdown, so the Calls worklist, the
 * dashboard home, analytics, the TC pages, etc. all scope to the same office.
 *
 * Where the selection comes from, in order:
 *   1. what this browser last chose (localStorage)
 *   2. the signed-in user's HOME OFFICE, if the roster has it
 *   3. "all offices"
 *
 * The home office is a DEFAULT, not a restriction (Beau's explicit decision —
 * staff float between locations). It seeds the selection and nothing else: the
 * picker keeps offering every office, no route or data is denied because of it,
 * and it is deliberately NOT written to localStorage, so an admin changing
 * somebody's home office takes effect on their next load instead of being
 * shadowed forever by a value we stamped in for them.
 *
 * `error` exists because an empty roster and a FAILED roster fetch are
 * different answers. They were conflated once — the roster 403'd for the
 * hygiene role and every hygiene page reported "No offices configured", which
 * reads as a setup problem and hid an authorization bug for weeks. Consumers
 * must be able to tell the two apart.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type OfficeConfig } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

const OFFICE_STORAGE_KEY = "carein.office";

/** Sentinel officeId meaning "no office scoping". */
export const ALL_OFFICES = "all";

interface OfficeContextValue {
  /** Real offices from the agent→office config (excludes the "all" sentinel). */
  offices: OfficeConfig[];
  /** Currently selected officeId, or "all". */
  office: string;
  setOffice: (officeId: string) => void;
  /** The selected office's config, or null when "all" / not yet loaded. */
  selected: OfficeConfig | null;
  loading: boolean;
  /**
   * Why the roster is empty, when it is empty because the fetch FAILED. null
   * means the roster loaded — including when it legitimately loaded empty.
   */
  error: string | null;
  /** Re-fetch the roster (the retry behind a failed load). */
  reload: () => void;
}

const OfficeContext = createContext<OfficeContextValue | null>(null);

function readStoredOffice(): string | null {
  try {
    return localStorage.getItem(OFFICE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function OfficeProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const homeOffice = auth.status === "authenticated" ? auth.user.homeOffice : null;

  const [offices, setOffices] = useState<OfficeConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** What this browser explicitly chose. null = never chosen here. */
  const [chosen, setChosen] = useState<string | null>(readStoredOffice);
  /** The home-office default, resolved once the roster confirms it exists. */
  const [defaulted, setDefaulted] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    let cancelled = false;
    api
      .getOffices()
      .then((roster) => {
        if (cancelled) return;
        setOffices(roster);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setOffices([]);
        setError(e instanceof Error ? e.message : "Could not load the office list");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  // Seed from the home office only once the roster can vouch for it. A stale
  // value (an office that was renamed or removed) must not strand the user on a
  // selection no page can resolve — it falls through to "all offices".
  useEffect(() => {
    if (chosen !== null) return;
    if (!homeOffice) return;
    if (!offices.some((o) => o.officeId === homeOffice)) return;
    setDefaulted(homeOffice);
  }, [chosen, homeOffice, offices]);

  const office = chosen ?? defaulted ?? ALL_OFFICES;

  const setOffice = (officeId: string) => {
    setChosen(officeId);
    try {
      localStorage.setItem(OFFICE_STORAGE_KEY, officeId);
    } catch {
      /* ignore */
    }
  };

  const selected = office === ALL_OFFICES ? null : (offices.find((o) => o.officeId === office) ?? null);

  return (
    <OfficeContext.Provider
      value={{ offices, office, setOffice, selected, loading, error, reload: load }}
    >
      {children}
    </OfficeContext.Provider>
  );
}

export function useOffice(): OfficeContextValue {
  const ctx = useContext(OfficeContext);
  if (!ctx) throw new Error("useOffice must be used within an OfficeProvider");
  return ctx;
}
