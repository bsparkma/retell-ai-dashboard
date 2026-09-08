import { useState } from "react"
import { MicIcon } from "lucide-react"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface MicTextareaProps {
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Scripted phrase to append when the mic is tapped (simulated dictation for the demo). */
  dictationSample?: string
  className?: string
}

/**
 * Textarea with a mic affordance. Tapping the mic simulates a short dictation
 * pass and appends a scripted sample phrase — no real speech capture in this prototype.
 */
export function MicTextarea({ id, value, onChange, placeholder, dictationSample, className }: MicTextareaProps) {
  const [listening, setListening] = useState(false)

  function handleMicTap() {
    if (!dictationSample || listening) return
    setListening(true)
    setTimeout(() => {
      onChange(value ? `${value} ${dictationSample}` : dictationSample)
      setListening(false)
    }, 900)
  }

  return (
    <div className="relative">
      <Textarea
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn("pr-12", className)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={listening ? "Listening" : "Dictate"}
        onClick={handleMicTap}
        className={cn(
          "absolute right-1.5 top-1.5 size-8 rounded-full",
          listening && "bg-destructive/10 text-destructive",
        )}
      >
        <MicIcon className={cn("size-4", listening && "animate-pulse")} />
      </Button>
    </div>
  )
}
