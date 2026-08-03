/**
 * FloatingCalc — the always-available COB calculator FAB for TC routes.
 * The app shell mounts this on TC pages (wired in App.tsx by the platform).
 *
 * All calculator state lives HERE, not inside the sheet: Radix unmounts sheet
 * content on close, so lifting the state is what preserves the TC's inputs
 * across open/close. State resets only via the calculator's explicit Clear.
 */
import { useState } from "react";
import { Calculator } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  CobCalculator,
  defaultCobCalcState,
  type CobCalcState,
} from "./CobCalculator";

export default function FloatingCalc() {
  const [open, setOpen] = useState(false);
  const [calcState, setCalcState] = useState<CobCalcState>(defaultCobCalcState);

  return (
    <>
      <Button
        size="icon"
        aria-label="Open COB calculator"
        title="COB Calculator"
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 h-14 w-14 rounded-full shadow-lg hover:scale-105 active:scale-95 transition-transform"
      >
        <Calculator className="w-6 h-6" />
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto gap-0">
          <SheetHeader className="pb-2">
            <SheetTitle>COB Calculator</SheetTitle>
            <SheetDescription>
              Dual-insurance out-of-pocket scratchpad — inputs stick around until
              you clear them.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            <CobCalculator compact state={calcState} onStateChange={setCalcState} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
