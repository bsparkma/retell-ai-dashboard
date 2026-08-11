/**
 * Icon-only row actions that still say what they are.
 *
 * The worklist row used to give every action a label, and five labeled buttons per row
 * left the patient's name a few characters wide. Only the call's next logical step keeps
 * a word now; the rest live here — square, uniform, and named on hover and to a screen
 * reader, so nothing is lost but the width.
 */
import type { ReactElement, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The shared action-button footprint. Every row control — labeled or not, button or
 * status chip — sits on this height so a row reads as one line instead of a ransom note.
 */
export const ACTION_HEIGHT = "h-8";
/** Square icon-button sizing, matched to ACTION_HEIGHT. */
export const ICON_ACTION_CLASS = "h-8 w-8 p-0 flex-shrink-0";

/**
 * Attach a hover/focus label to any control — used directly when the trigger has to be
 * something other than a plain button (the Done popover trigger, for instance).
 */
export function ActionTooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

interface IconActionProps {
  /** Tooltip text AND the accessible name — an icon button without one is a mystery. */
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "outline" | "secondary" | "default" | "ghost";
}

export function IconAction({ label, icon, onClick, disabled, variant = "outline" }: IconActionProps) {
  return (
    <ActionTooltip label={label}>
      <Button
        size="sm"
        variant={variant}
        className={ICON_ACTION_CLASS}
        disabled={disabled}
        onClick={onClick}
        aria-label={label}
      >
        {icon}
      </Button>
    </ActionTooltip>
  );
}
