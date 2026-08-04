/**
 * /tc/cob — full-page COB calculator. Pure dollars-domain math (no server
 * data), but stays behind the office gate for TC-module consistency.
 */
import { CobCalculator } from "@/features/tc/cob/CobCalculator";
import {
  TcOfficeGate,
  TcPageHeader,
  useTcOffice,
} from "@/features/tc/components/TcShell";

export default function TcCobCalculator() {
  const office = useTcOffice();
  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }

  return (
    <div className="p-6">
      <TcPageHeader
        title="COB Calculator"
        subtitle="Estimate a patient's out-of-pocket when two dental plans coordinate benefits"
      />
      <div className="max-w-4xl">
        <CobCalculator />
      </div>
    </div>
  );
}
