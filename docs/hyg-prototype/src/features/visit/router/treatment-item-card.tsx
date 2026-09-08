import { useState } from "react"
import { ChevronDownIcon, ChevronUpIcon, ImageIcon, InfoIcon, Trash2Icon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Field, FieldLabel } from "@/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectLabel, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MicTextarea } from "@/components/mic-textarea"
import { cn } from "@/lib/utils"
import type { TreatmentItem } from "@/mock/types"
import { DX_LABELS, MOTIVATION_LABELS } from "@/mock/types"
import { DX_OPTIONS, MOTIVATION_OPTIONS, PRIORITY_OPTIONS, STATUS_OPTIONS, SURFACE_OPTIONS, TREATMENT_GROUPS, findTreatmentOption } from "@/mock/treatment-options"

interface TreatmentItemCardProps {
  item: TreatmentItem
  editingTeeth: boolean
  onStartEditTeeth: () => void
  onStopEditTeeth: () => void
  onRemoveTooth: (tooth: number) => void
  onUpdate: (patch: Partial<TreatmentItem>) => void
  onDelete: () => void
}

function toggleInArray<T>(arr: T[], value: T) {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]
}

const STATUS_BADGE_CLASS: Record<TreatmentItem["status"], string> = {
  confirmed: "bg-primary text-primary-foreground",
  scheduled: "bg-accent text-accent-foreground",
  watch: "bg-secondary text-secondary-foreground",
  proposed: "bg-warning text-warning-foreground",
}

export function TreatmentItemCard({
  item,
  editingTeeth,
  onStartEditTeeth,
  onStopEditTeeth,
  onRemoveTooth,
  onUpdate,
  onDelete,
}: TreatmentItemCardProps) {
  const [open, setOpen] = useState(true)
  const [showDxLegend, setShowDxLegend] = useState(false)
  const [showMotivationLegend, setShowMotivationLegend] = useState(false)
  const treatmentOption = findTreatmentOption(item.code)
  const showSurfaces = !!treatmentOption?.hasSurfaces
  const showCrownType = !!treatmentOption?.hasCrownType
  const showProsthesis = !!treatmentOption?.hasProsthesis
  const isMouthLevel = item.teeth === "mouth"
  const teethList = isMouthLevel ? [] : (item.teeth as number[])

  return (
    <Card className={cn(editingTeeth && "border-primary ring-1 ring-primary/40")}>
      <CardHeader
        className="flex flex-row items-center justify-between gap-3 space-y-0 cursor-pointer"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{treatmentOption?.label ?? item.code}</span>
          <div className="flex flex-wrap gap-1">
            {isMouthLevel ? (
              <Badge variant="secondary">Whole mouth</Badge>
            ) : (
              teethList.map((t) => (
                <Badge key={t} variant="secondary" className="font-mono">
                  #{t}
                </Badge>
              ))
            )}
          </div>
          <Badge variant="outline">P{item.priority}</Badge>
          <Badge className={cn("capitalize", STATUS_BADGE_CLASS[item.status])}>{item.status}</Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 text-muted-foreground hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            aria-label="Delete treatment item"
          >
            <Trash2Icon className="size-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="size-9" aria-label={open ? "Collapse" : "Expand"}>
            {open ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
          </Button>
        </div>
      </CardHeader>

      {open && (
        <CardContent className="flex flex-col gap-5 pt-0">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Teeth</FieldLabel>
              {isMouthLevel ? (
                <Badge variant="secondary">Whole mouth</Badge>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5">
                  {teethList.map((t) => (
                    <Badge key={t} variant="secondary" className="gap-1 font-mono">
                      #{t}
                      <button type="button" onClick={() => onRemoveTooth(t)} aria-label={`Remove tooth ${t}`}>
                        <XIcon className="size-3" />
                      </button>
                    </Badge>
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant={editingTeeth ? "default" : "outline"}
                    className="h-7 rounded-full text-xs"
                    onClick={editingTeeth ? onStopEditTeeth : onStartEditTeeth}
                  >
                    {editingTeeth ? "Done editing on chart" : "Edit on chart"}
                  </Button>
                </div>
              )}
            </Field>
            <Field>
              <FieldLabel>Treatment</FieldLabel>
              <Select
                value={item.code}
                onValueChange={(v) => {
                  const opt = findTreatmentOption(v)
                  onUpdate({ code: v, category: opt?.category ?? item.category, teeth: opt?.mouthLevel ? "mouth" : item.teeth })
                }}
              >
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TREATMENT_GROUPS.map((g) => (
                    <SelectGroup key={g.category}>
                      <SelectLabel>{g.category}</SelectLabel>
                      {g.treatments.map((t) => (
                        <SelectItem key={t.code} value={t.code}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          {showSurfaces && (
            <Field>
              <FieldLabel>Surfaces</FieldLabel>
              <div className="flex flex-wrap gap-2">
                {SURFACE_OPTIONS.map((s) => {
                  const active = (item.surfaces ?? []).includes(s)
                  return (
                    <Button
                      key={s}
                      type="button"
                      size="sm"
                      variant={active ? "default" : "outline"}
                      className="h-9 w-9 rounded-full p-0"
                      onClick={() => onUpdate({ surfaces: toggleInArray(item.surfaces ?? [], s) })}
                    >
                      {s}
                    </Button>
                  )
                })}
              </div>
            </Field>
          )}

          {showCrownType && (
            <Field>
              <FieldLabel>Crown type</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                value={item.crownType ?? ""}
                onValueChange={(v) => v && onUpdate({ crownType: v as TreatmentItem["crownType"] })}
              >
                <ToggleGroupItem value="initial" className="h-10 flex-1">
                  Initial
                </ToggleGroupItem>
                <ToggleGroupItem value="replacement" className="h-10 flex-1">
                  Replacement
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
          )}

          {showProsthesis && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>New or replacement</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={item.prosthesis?.newOrReplacement ?? ""}
                  onValueChange={(v) =>
                    v && onUpdate({ prosthesis: { newOrReplacement: v as "new" | "replacement", years: item.prosthesis?.years } })
                  }
                >
                  <ToggleGroupItem value="new" className="h-10 flex-1">
                    New
                  </ToggleGroupItem>
                  <ToggleGroupItem value="replacement" className="h-10 flex-1">
                    Replacement
                  </ToggleGroupItem>
                </ToggleGroup>
              </Field>
              {item.prosthesis?.newOrReplacement === "replacement" && (
                <Field>
                  <FieldLabel>Years in service</FieldLabel>
                  <Input
                    value={item.prosthesis?.years ?? ""}
                    onChange={(e) => onUpdate({ prosthesis: { newOrReplacement: "replacement", years: e.target.value } })}
                    placeholder="e.g. 8"
                  />
                </Field>
              )}
            </div>
          )}

          <Field>
            <FieldLabel className="flex items-center justify-between">
              <span>Dx (diagnosis codes)</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs text-muted-foreground"
                onClick={() => setShowDxLegend((v) => !v)}
              >
                <InfoIcon className="size-3.5" />
                {showDxLegend ? "Hide meanings" : "Show meanings"}
              </Button>
            </FieldLabel>
            <div className="flex flex-wrap gap-2">
              {DX_OPTIONS.map((d) => {
                const active = item.dx.includes(d)
                return (
                  <Button
                    key={d}
                    type="button"
                    size="sm"
                    variant={active ? "default" : "outline"}
                    className="h-9 rounded-full font-mono text-xs"
                    title={DX_LABELS[d]}
                    onClick={() => onUpdate({ dx: toggleInArray(item.dx, d) })}
                  >
                    {d}
                  </Button>
                )
              })}
            </div>
            {showDxLegend && (
              <div className="grid grid-cols-1 gap-1 rounded-md bg-secondary/40 p-3 text-xs text-muted-foreground sm:grid-cols-2">
                {DX_OPTIONS.map((d) => (
                  <div key={d}>
                    <span className="font-mono font-semibold text-foreground">{d}</span> — {DX_LABELS[d]}
                  </div>
                ))}
              </div>
            )}
            <MicTextarea
              value={item.dxNote ?? ""}
              onChange={(v) => onUpdate({ dxNote: v })}
              placeholder="Describe what you're seeing…"
              dictationSample="Visible fracture line extending to the distal marginal ridge."
              className="min-h-16"
            />
          </Field>

          <Field>
            <FieldLabel className="flex items-center justify-between">
              <span>Patient motivation (if identified)</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs text-muted-foreground"
                onClick={() => setShowMotivationLegend((v) => !v)}
              >
                <InfoIcon className="size-3.5" />
                {showMotivationLegend ? "Hide meanings" : "Show meanings"}
              </Button>
            </FieldLabel>
            <div className="flex flex-wrap gap-2">
              {MOTIVATION_OPTIONS.map((m) => {
                const active = item.motivation.includes(m)
                return (
                  <Button
                    key={m}
                    type="button"
                    size="sm"
                    variant={active ? "default" : "outline"}
                    className="h-9 rounded-full font-mono text-xs"
                    title={MOTIVATION_LABELS[m]}
                    onClick={() => onUpdate({ motivation: toggleInArray(item.motivation, m) })}
                  >
                    {m}
                  </Button>
                )
              })}
            </div>
            {showMotivationLegend && (
              <div className="grid grid-cols-1 gap-1 rounded-md bg-secondary/40 p-3 text-xs text-muted-foreground sm:grid-cols-2">
                {MOTIVATION_OPTIONS.map((m) => (
                  <div key={m}>
                    <span className="font-mono font-semibold text-foreground">{m}</span> — {MOTIVATION_LABELS[m]}
                  </div>
                ))}
              </div>
            )}
            <MicTextarea
              value={item.motivationNote ?? ""}
              onChange={(v) => onUpdate({ motivationNote: v })}
              placeholder="e.g. wants it fixed before daughter's wedding in October"
              dictationSample="Wants it fixed before her daughter's wedding in October."
              className="min-h-16"
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Priority</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                value={String(item.priority)}
                onValueChange={(v) => v && onUpdate({ priority: Number(v) as TreatmentItem["priority"] })}
              >
                {PRIORITY_OPTIONS.map((p) => (
                  <ToggleGroupItem key={p.id} value={String(p.id)} className="h-10 flex-1 text-xs">
                    {p.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
            <Field>
              <FieldLabel htmlFor={`status-${item.id}`}>Status</FieldLabel>
              <Select value={item.status} onValueChange={(v) => onUpdate({ status: v as TreatmentItem["status"] })}>
                <SelectTrigger id={`status-${item.id}`} className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {STATUS_OPTIONS.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id={`schedule-next-${item.id}`}
              checked={item.scheduleNext}
              onCheckedChange={(v) => onUpdate({ scheduleNext: v })}
            />
            <FieldLabel htmlFor={`schedule-next-${item.id}`} className="font-normal">
              Schedule at next restorative visit
            </FieldLabel>
          </div>

          <Field>
            <FieldLabel>Photos</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {item.photos.map((p, i) => (
                <div key={i} className="flex size-16 items-center justify-center rounded-md border border-border bg-secondary text-xs text-muted-foreground">
                  {p}
                </div>
              ))}
              <button
                type="button"
                onClick={() => onUpdate({ photos: [...item.photos, `Photo ${item.photos.length + 1}`] })}
                className="flex size-16 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-muted-foreground hover:bg-secondary"
              >
                <ImageIcon className="size-4" />
                <span className="text-[10px]">Attach</span>
              </button>
            </div>
          </Field>
        </CardContent>
      )}
    </Card>
  )
}
