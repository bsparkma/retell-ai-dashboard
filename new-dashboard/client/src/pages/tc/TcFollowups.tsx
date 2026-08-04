/**
 * /tc/followups — the TC's daily "what's due" queue.
 *
 * Thin page shell: office scope + header; all behaviour lives in
 * features/tc/followups/FollowupQueue so tests can drive it with props. On
 * "All Offices" the queue is handed every office in scope and fans out.
 */
import { TcOfficeGate, TcPageHeader } from "@/features/tc/components/TcShell";
import { officeScopeKey, useTcOfficeScope } from "@/features/tc/officeScope";
import { FollowupQueue } from "@/features/tc/followups/FollowupQueue";

export default function TcFollowups() {
  const scope = useTcOfficeScope();
  if (scope.offices.length === 0) {
    return (
      <div className="p-6">
        <TcOfficeGate loading={scope.loading} />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <TcPageHeader
        title="Follow-ups"
        subtitle={
          scope.showOfficeBadges
            ? "Overdue and due-today patient touches across every office — work top to bottom"
            : "Overdue and due-today patient touches — work top to bottom"
        }
      />
      <FollowupQueue key={officeScopeKey(scope.offices)} office={scope.offices} />
    </div>
  );
}
