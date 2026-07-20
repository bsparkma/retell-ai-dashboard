/**
 * OfficeContext — one global office selection for the whole app.
 *
 * The office selector lives in the app shell (sidebar). Pages consume this
 * context instead of owning their own dropdown, so the Calls worklist, the
 * dashboard home, analytics, etc. all scope to the same office. Selection is
 * remembered per-browser in localStorage; default is "all" (all offices).
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type OfficeConfig } from "@/lib/api";

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
}

const OfficeContext = createContext<OfficeContextValue | null>(null);

export function OfficeProvider({ children }: { children: ReactNode }) {
  const [offices, setOffices] = useState<OfficeConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [office, setOfficeState] = useState<string>(() => {
    try { return localStorage.getItem(OFFICE_STORAGE_KEY) || ALL_OFFICES; } catch { return ALL_OFFICES; }
  });

  useEffect(() => {
    let cancelled = false;
    api.getOffices()
      .then((roster) => { if (!cancelled) setOffices(roster); })
      .catch(() => { if (!cancelled) setOffices([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const setOffice = (officeId: string) => {
    setOfficeState(officeId);
    try { localStorage.setItem(OFFICE_STORAGE_KEY, officeId); } catch { /* ignore */ }
  };

  const selected = office === ALL_OFFICES ? null : (offices.find((o) => o.officeId === office) ?? null);

  return (
    <OfficeContext.Provider value={{ offices, office, setOffice, selected, loading }}>
      {children}
    </OfficeContext.Provider>
  );
}

export function useOffice(): OfficeContextValue {
  const ctx = useContext(OfficeContext);
  if (!ctx) throw new Error("useOffice must be used within an OfficeProvider");
  return ctx;
}
