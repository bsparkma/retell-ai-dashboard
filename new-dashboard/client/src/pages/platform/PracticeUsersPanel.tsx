/**
 * One practice's roster — READ-ONLY.
 *
 * Deliberate scope call (Beau, 2026-08-13). Role, status and home-office changes
 * stay on /admin/users, where the last-admin guard, the platform-admin
 * protection and the self-change refusal already live and are already tested.
 * Two write paths into `app_user` would mean two places for those rules to be
 * enforced, and the second is where they would eventually not be.
 *
 * So this page shows no control that writes, and says where the writes are
 * instead — using the server's own `manageAt` rather than a hardcoded path.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ExternalLink, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import type { Practice, PracticeUsersResponse } from "@/lib/api";
import { loadError } from "../Platform";

function formatLastLogin(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Never";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function PracticeUsersPanel({ practice }: { practice: Practice }) {
  const [data, setData] = useState<PracticeUsersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    api
      .listPracticeUsers(practice.tenantId)
      .then((res) => live && setData(res))
      .catch((e) => live && setError(loadError(e)));
    return () => {
      live = false;
    };
  }, [practice.tenantId]);

  if (error) {
    return <p className="text-sm text-destructive" data-testid="users-error">{error}</p>;
  }
  if (data === null) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading people…
      </p>
    );
  }
  if (data.users.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="users-empty">
        Nobody has been added to {practice.displayName} yet.
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="practice-users">
      <div className="overflow-x-auto rounded-lg border border-border/70">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Home office</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Last sign-in</th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.email} className="border-b border-border/50 last:border-0">
                <td className="px-3 py-2 text-foreground">{u.email}</td>
                <td className="px-3 py-2">
                  <Badge variant="outline" className="font-mono text-[11px]">{u.role}</Badge>
                </td>
                <td className="px-3 py-2 text-muted-foreground" data-testid={`home-office-${u.email}`}>
                  {/* An empty home office is a real answer — shared accounts are
                      meant to have none — so it renders as an em dash, not blank. */}
                  {u.homeOffice ?? "—"}
                </td>
                <td className="px-3 py-2">
                  {u.status === "active" ? (
                    <span className="text-xs text-muted-foreground">active</span>
                  ) : (
                    <Badge variant="outline" className="text-[11px]">disabled</Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{formatLastLogin(u.lastLoginAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        This list is read-only. Roles, status and home office are changed on the practice&apos;s own{" "}
        <Link href={data.manageAt} className="inline-flex items-center gap-0.5 underline">
          Users page <ExternalLink className="h-3 w-3" />
        </Link>
        , where the last-admin and self-change guards live.
      </p>
    </div>
  );
}
