/**
 * /tc/nurture — long-term nurture campaign workspace.
 *
 * Thin page shell: office scope + container; all behaviour lives in
 * features/tc/nurture/NurtureWorkspace so tests can drive it with props
 * (office + pinned today), mirroring the TcFollowups pattern. On "All
 * Offices" the workspace receives every office in scope and fans out.
 */
import { TcOfficeGate } from "@/features/tc/components/TcShell";
import { officeScopeKey, useTcOfficeScope } from "@/features/tc/officeScope";
import { NurtureWorkspace } from "@/features/tc/nurture/NurtureWorkspace";

export default function TcNurture() {
  const scope = useTcOfficeScope();
  if (scope.offices.length === 0) {
    return (
      <div className="p-6">
        <TcOfficeGate loading={scope.loading} />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <NurtureWorkspace key={officeScopeKey(scope.offices)} office={scope.offices} />
    </div>
  );
}
