"use client"

import { useState, type ReactNode } from "react"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface CollapsibleSectionProps {
  title: string
  description?: string
  notAssessed: boolean
  onNotAssessedChange: (value: boolean) => void
  defaultOpen?: boolean
  children: ReactNode
}

/**
 * Section wrapper for the Ortho Workup (A-D). Each section can be marked
 * "Not assessed" — which greys out and disables its body without discarding
 * data already entered — and independently collapsed/expanded.
 */
export function CollapsibleSection({
  title,
  description,
  notAssessed,
  onNotAssessedChange,
  defaultOpen = true,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? (
            <ChevronUpIcon className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-semibold text-foreground">{title}</span>
            {description && <span className="text-xs text-muted-foreground">{description}</span>}
          </div>
        </button>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Not assessed</span>
          <Switch
            checked={notAssessed}
            onCheckedChange={onNotAssessedChange}
            aria-label={`${title} not assessed`}
          />
        </div>
      </CardHeader>
      {open && (
        <CardContent
          className={cn(
            "flex flex-col gap-5 pt-0 transition-opacity",
            notAssessed && "pointer-events-none opacity-40",
          )}
          aria-disabled={notAssessed}
        >
          {children}
        </CardContent>
      )}
    </Card>
  )
}
