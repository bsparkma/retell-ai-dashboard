import { Building2 } from "lucide-react"
import { useAppStore } from "@/store/app-store"
import { offices, hygienistsForOffice } from "@/mock/offices"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export function OfficeSwitcher() {
  const officeId = useAppStore((s) => s.officeId)
  const setOfficeId = useAppStore((s) => s.setOfficeId)

  return (
    <Select value={officeId} onValueChange={(v) => setOfficeId(v as typeof officeId)}>
      <SelectTrigger className="h-11 w-[190px] gap-2 border-none bg-secondary font-medium">
        <Building2 className="text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {offices.map((office) => (
            <SelectItem key={office.id} value={office.id}>
              {office.name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

export function HygienistSwitcher() {
  const officeId = useAppStore((s) => s.officeId)
  const hygienistId = useAppStore((s) => s.hygienistId)
  const setHygienistId = useAppStore((s) => s.setHygienistId)
  const hygienists = hygienistsForOffice(officeId)

  return (
    <Select value={hygienistId} onValueChange={setHygienistId}>
      <SelectTrigger className="h-11 w-[150px] border-none bg-secondary font-medium">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="all">All hygienists</SelectItem>
          {hygienists.map((h) => (
            <SelectItem key={h.id} value={h.id}>
              {h.name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

export function DatePickerControl() {
  const date = useAppStore((s) => s.date)
  const setDate = useAppStore((s) => s.setDate)

  return (
    <input
      type="date"
      value={date}
      onChange={(e) => setDate(e.target.value)}
      className="tap-target h-11 rounded-md border-none bg-secondary px-3 text-sm font-medium text-secondary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="Selected date"
    />
  )
}
