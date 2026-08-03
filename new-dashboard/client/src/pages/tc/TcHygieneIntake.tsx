/**
 * /tc/hygiene — the hygienist's chairside handoff form.
 *
 * Thin page shell: office gate + header + links into the hygiene trio; the
 * form itself lives in features/tc/hygiene/IntakeForm.
 */
import { Link } from "wouter";
import { Inbox, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TcOfficeGate, TcPageHeader, useTcOffice } from "@/features/tc/components/TcShell";
import { IntakeForm } from "@/features/tc/hygiene/IntakeForm";

export default function TcHygieneIntake() {
  const office = useTcOffice();
  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <TcPageHeader
        title="Hygiene Handoff"
        subtitle="~60-second chairside handoff — creates a case in the TC inbox"
        actions={
          <>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href="/tc/hygiene/submissions">
                <ListChecks className="w-4 h-4" /> My submissions
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href="/tc/hygiene/inbox">
                <Inbox className="w-4 h-4" /> TC inbox
              </Link>
            </Button>
          </>
        }
      />
      <IntakeForm office={office} />
    </div>
  );
}
