/**
 * /tc/cob — full-page COB calculator. Dollars-domain math, plus the Slice-5
 * "Pull from Open Dental" panel: the office gate is what makes that pull
 * possible (and is what refuses it for an office with no OD connection).
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
        <CobCalculator office={office} />
      </div>
    </div>
  );
}
