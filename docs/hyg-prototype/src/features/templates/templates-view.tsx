import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { SparklesIcon } from "lucide-react"
import { noteTemplates } from "@/mock/templates"
import type { NoteTemplate } from "@/mock/types"

export function TemplatesView() {
  const [selected, setSelected] = useState<NoteTemplate | null>(null)

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Note templates</h1>
        <p className="text-sm text-muted-foreground">
          Templates power the Notes tab in each visit. Fields with a sparkle autofill from Router, Perio, or Findings.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {noteTemplates.map((tpl) => (
          <Card key={tpl.id} className="cursor-pointer transition-colors hover:border-primary" onClick={() => setSelected(tpl)}>
            <CardHeader>
              <CardTitle className="text-sm">{tpl.name}</CardTitle>
              <CardDescription>{tpl.fields.length} fields</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1.5">
                {tpl.fields.map((f) => (
                  <Badge key={f.id} variant="secondary" className="gap-1">
                    {f.autofillSource && <SparklesIcon className="size-3" />}
                    {f.label}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{selected?.name}</DialogTitle>
            <DialogDescription>Narrative pattern and fields used to build the clinical note.</DialogDescription>
          </DialogHeader>
          {selected && (
            <div className="flex flex-col gap-4">
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Narrative pattern</p>
                <p className="rounded-md bg-secondary/50 p-3 text-sm text-foreground">{selected.narrativePattern}</p>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Fields</p>
                <ul className="flex flex-col gap-2">
                  {selected.fields.map((f) => (
                    <li key={f.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                      <span className="text-foreground">{f.label}</span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        {f.type}
                        {f.autofillSource && (
                          <Badge variant="secondary" className="gap-1">
                            <SparklesIcon className="size-3" />
                            {f.autofillSource}
                          </Badge>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
