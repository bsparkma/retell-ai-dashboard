import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field"
import { offices, hygienistsForOffice, operatoriesForOffice } from "@/mock/offices"
import { BuildingIcon, MicIcon, UserRoundIcon, ArmchairIcon } from "lucide-react"

export function SettingsView() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6 pb-16">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Practice directory and workspace preferences.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MicIcon className="size-4 text-muted-foreground" />
            Dictation
          </CardTitle>
          <CardDescription>Voice charting behavior during perio exams.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="auto-advance" className="font-normal">
                Auto-advance to next site after each reading
              </FieldLabel>
              <Switch id="auto-advance" defaultChecked />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="confirm-outliers" className="font-normal">
                Ask for confirmation on depths of 7mm or more
              </FieldLabel>
              <Switch id="confirm-outliers" defaultChecked />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="read-back" className="font-normal">
                Read back each value after capture
              </FieldLabel>
              <Switch id="read-back" />
              <FieldDescription>Plays a short audio confirmation through the room speaker.</FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      {offices.map((office) => (
        <Card key={office.id}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BuildingIcon className="size-4 text-muted-foreground" />
              {office.name}
            </CardTitle>
            <CardDescription>Hygienists and operatories at this location.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <UserRoundIcon className="size-3.5" />
                Hygienists
              </div>
              <div className="flex flex-col gap-2">
                {hygienistsForOffice(office.id).map((h) => (
                  <div key={h.id} className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2">
                    <span className="text-sm font-medium text-foreground">{h.name}</span>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{h.credential}</Badge>
                      <span className="text-xs text-muted-foreground">Lic. {h.license}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <Separator />

            <div>
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <ArmchairIcon className="size-3.5" />
                Operatories
              </div>
              <div className="flex flex-wrap gap-2">
                {operatoriesForOffice(office.id).map((op) => (
                  <Badge key={op.id} variant={op.isHygiene ? "default" : "outline"}>
                    {op.name}
                    {op.isHygiene ? " · Hygiene" : ""}
                  </Badge>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}

      <p className="text-center text-xs text-muted-foreground">CareIN Hygiene Workspace · prototype build</p>
    </div>
  )
}
