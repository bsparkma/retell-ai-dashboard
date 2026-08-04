/**
 * /tc/nurture — long-term nurture campaign workspace.
 *
 * Thin page shell: office gate + container; all behaviour lives in
 * features/tc/nurture/NurtureWorkspace so tests can drive it with props
 * (office + pinned today), mirroring the TcFollowups pattern.
 */
import { TcOfficeGate, useTcOffice } from "@/features/tc/components/TcShell";
import { NurtureWorkspace } from "@/features/tc/nurture/NurtureWorkspace";

export default function TcNurture() {
  const office = useTcOffice();
  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <NurtureWorkspace key={office} office={office} />
    </div>
  );
}
