import { Mic } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/store/app-store"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * Global mic affordance in the top bar. This reflects listening state only —
 * actual voice capture is scripted/simulated inside the Perio and Notes tabs.
 */
export function MicButton() {
  const micListening = useAppStore((s) => s.micListening)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-pressed={micListening}
          aria-label={micListening ? "Microphone listening" : "Microphone idle"}
          className={cn(
            "tap-target relative flex size-11 items-center justify-center rounded-full transition-colors",
            micListening
              ? "bg-destructive text-destructive-foreground"
              : "bg-secondary text-secondary-foreground hover:bg-muted",
          )}
        >
          {micListening && (
            <span className="absolute inset-0 animate-ping rounded-full bg-destructive/50" aria-hidden="true" />
          )}
          <Mic className="size-5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{micListening ? "Listening…" : "Voice dictation is available in Perio and Notes"}</TooltipContent>
    </Tooltip>
  )
}
