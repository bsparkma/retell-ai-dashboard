import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchCurrentUser, type AuthUser } from "@/lib/auth";

/** Auth state shared across the app (single `/auth/me` fetch on mount). */
export type AuthState =
  | { status: "loading" }
  | { status: "authenticated"; user: AuthUser }
  | { status: "anonymous" };

const AuthContext = createContext<AuthState>({ status: "loading" });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    fetchCurrentUser().then((user) => {
      if (!active) return;
      setState(user ? { status: "authenticated", user } : { status: "anonymous" });
    });
    return () => {
      active = false;
    };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

/** Read the current auth state (loading / authenticated+user / anonymous). */
export function useAuth(): AuthState {
  return useContext(AuthContext);
}
