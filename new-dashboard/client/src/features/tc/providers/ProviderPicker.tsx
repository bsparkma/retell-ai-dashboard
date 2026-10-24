/**
 * The provider pick — a referral's referring provider, a pre-auth's doctor.
 *
 * A dropdown of the office's ACTIVE providers (Settings → Providers) plus
 * "Other…", which keeps today's free text. The value is always TEXT: a pick
 * writes the provider's display name ("Jane Smith, DDS"), so the field it
 * fills and everything that reads it are unchanged.
 *
 *   - providers is a non-empty list → the dropdown. A value that is not one of
 *     them (typed before, or a provider since deactivated) opens as "Other…"
 *     with the text kept, never silently dropped.
 *   - providers is an empty list    → free text, with a line saying where to
 *     set the list up.
 *   - providers is null             → free text only (no list on this surface,
 *     or it could not be read; a missing list never blocks the form).
 *
 * NOTHING AUTO-SELECTS: an empty value shows "Choose…", even with one provider.
 */
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { providerDisplayName, type TcProviderEntry } from "@shared/tc/providers";

const OTHER = "__other__";

export const PROVIDER_SETUP_HINT = "No providers are set up for this office yet — add them in Settings → Providers to pick from a list.";

export interface ProviderPickerProps {
  /** The select's id (the caller's <Label htmlFor> points at it). */
  id: string;
  value: string;
  onChange: (value: string) => void;
  providers: readonly TcProviderEntry[] | null;
  disabled?: boolean;
  maxLength?: number;
  /** For the free-text box. */
  placeholder?: string;
}

export function ProviderPicker({
  id,
  value,
  onChange,
  providers,
  disabled = false,
  maxLength = 200,
  placeholder,
}: ProviderPickerProps) {
  // The value is the name, so two rows that print the same are one choice.
  const names = (providers ?? [])
    .map((p) => providerDisplayName(p))
    .filter((n, i, all) => all.indexOf(n) === i);
  const matches = names.includes(value);
  const [otherChosen, setOtherChosen] = useState(false);

  if (!providers || providers.length === 0) {
    return (
      <div className="space-y-1">
        <Input
          id={id}
          value={value}
          maxLength={maxLength}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {providers && <p className="text-xs text-muted-foreground">{PROVIDER_SETUP_HINT}</p>}
      </div>
    );
  }

  const showOther = otherChosen || (value.trim() !== "" && !matches);
  const selected = showOther ? OTHER : matches ? value : "";

  function pick(next: string) {
    if (next === OTHER) {
      setOtherChosen(true);
      return;
    }
    setOtherChosen(false);
    onChange(next);
  }

  return (
    <div className="space-y-1">
      <select
        id={id}
        className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
        value={selected}
        disabled={disabled}
        onChange={(e) => pick(e.target.value)}
      >
        <option value="">Choose…</option>
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
        <option value={OTHER}>Other…</option>
      </select>
      {showOther && (
        <Input
          id={`${id}-other`}
          aria-label="Other provider"
          value={value}
          maxLength={maxLength}
          disabled={disabled}
          placeholder={placeholder ?? "Type the provider's name"}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
