/**
 * ModuleContext — one global module selection for the whole app.
 *
 * Same shape as OfficeContext (Slice B): one context, sidebar-level control,
 * selection remembered per-browser in localStorage, pages consume a hook.
 * Entitled modules come from `/auth/me` (tenant.modules); the switcher only
 * offers modules the tenant has AND the SPA can render (see lib/modules.ts).
 *
 * Today tenant #1 is entitled to 'voice' only, so the shell shows no switcher
 * and nothing changes visually — this is the MECHANISM the second module (tc)
 * plugs into. UI hiding is convenience; the backend requireModule() 403 is the
 * source of truth.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
  MODULES,
  entitledModuleIds,
  resolveActiveModule,
  type ModuleDef,
  type ModuleId,
} from "@/lib/modules";

const MODULE_STORAGE_KEY = "carein.module";

interface ModuleContextValue {
  /** Modules this tenant is entitled to AND the SPA can render. */
  modules: ModuleDef[];
  /** The active module id (always resolves to something renderable). */
  module: ModuleId;
  setModule: (id: ModuleId) => void;
}

const ModuleContext = createContext<ModuleContextValue | null>(null);

export function ModuleProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [stored, setStored] = useState<string | null>(() => {
    try {
      return localStorage.getItem(MODULE_STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const entitled = useMemo(
    () =>
      entitledModuleIds(
        auth.status === "authenticated" ? auth.user.tenant?.modules : undefined,
      ),
    [auth],
  );

  // Renderable = entitled ∩ registered. Active selection is derived (not an
  // effect) so a revoked module can never stay selected.
  const modules = useMemo(
    () => entitled.map((id) => MODULES[id]).filter((m): m is ModuleDef => m !== undefined),
    [entitled],
  );
  const module = resolveActiveModule(
    stored,
    modules.map((m) => m.id),
  );

  const setModule = (id: ModuleId) => {
    if (!modules.some((m) => m.id === id)) return; // never select an unentitled module
    setStored(id);
    try {
      localStorage.setItem(MODULE_STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  };

  return (
    <ModuleContext.Provider value={{ modules, module, setModule }}>
      {children}
    </ModuleContext.Provider>
  );
}

export function useModule(): ModuleContextValue {
  const ctx = useContext(ModuleContext);
  if (!ctx) throw new Error("useModule must be used within a ModuleProvider");
  return ctx;
}
