/**
 * /tc/followups — the TC's daily "what's due" queue.
 *
 * Thin page shell: office gate + header; all behaviour lives in
 * features/tc/followups/FollowupQueue so tests can drive it with props.
 */
import { TcOfficeGate, TcPageHeader, useTcOffice } from "@/features/tc/components/TcShell";
import { FollowupQueue } from "@/features/tc/followups/FollowupQueue";

export default function TcFollowups() {
  const office = useTcOffice();
  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <TcPageHeader
        title="Follow-ups"
        subtitle="Overdue and due-today patient touches — work top to bottom"
      />
      <FollowupQueue office={office} />
    </div>
  );
}
