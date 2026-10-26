/**
 * One practice's people — add, change role / home office, disable, re-enable.
 *
 * The same editor as /admin/users (components/users/TenantUserEditor), through
 * the Developer Console's door: /api/platform/practices/:tenantId/users. Both
 * doors run ONE server-side rule set (backend/services/tenantUsers.js) — the
 * last-admin guard, platform-admin protection, self-change refusal and tenant
 * scope are enforced there, not here. A refusal is shown inline, in the
 * server's words.
 *
 * Differences from the practice's own page, and why:
 *   - a home office can be chosen when adding: the operator is usually setting
 *     up a practice they do not work in, so "add, then edit" is a wasted trip;
 *   - no sign-in-domain warning: the operator's own domain says nothing about
 *     what this practice's staff addresses look like.
 */
import { useMemo } from "react";

import { TenantUserEditor, type UserDoor } from "@/components/users/TenantUserEditor";
import { api } from "@/lib/api";
import type { Practice } from "@/lib/api";

export default function PracticeUsersPanel({ practice }: { practice: Practice }) {
  const tenantId = practice.tenantId;

  // The practice is fixed by the URL the door calls; the server never reads
  // one from a body, so there is nothing here that could aim a write elsewhere.
  const door = useMemo<UserDoor>(
    () => ({
      list: () => api.listPracticeUsers(tenantId),
      create: (input) => api.createPracticeUser(tenantId, input),
      update: (email, patch) => api.updatePracticeUser(tenantId, email, patch),
    }),
    [tenantId],
  );

  return (
    <div className="space-y-3" data-testid="practice-users">
      <TenantUserEditor
        key={tenantId}
        door={door}
        offerHomeOfficeOnAdd
        placeholder="person@practice.com"
        emptyText={`Nobody has been added to ${practice.displayName} yet.`}
      />
    </div>
  );
}
