/**
 * THE PROOF BLOCK FOR A CHECK NOBODY JUST MEASURED — the check number, and the
 * one instruction that matters: do not enter the payment again by hand.
 *
 * Lifted out of `PostThisCheck.tsx` unchanged (W-21b) so the Posting history can
 * render the SAME block for a `blocked` plan whose check already landed, rather
 * than inventing a second presentation. The rules travel with it: a number and
 * no amount — the posted total on such a row is not a current measurement — and
 * no remediation, because nothing compared this chart with anything.
 */
export function EarlierCheckProof({ checkNum, testId }: { checkNum: number; testId: string }) {
  return (
    <div
      className="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-sm text-foreground"
      data-testid={testId}
    >
      An Open Dental check #{checkNum} from an earlier run exists. Do not enter
      this payment again by hand.
    </div>
  );
}
