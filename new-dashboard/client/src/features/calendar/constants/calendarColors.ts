/**
 * Single source for appointment card colors.
 * Priority: appointment colorOverride → appointment type color → provider color → status fallback.
 */

export const STATUS_FALLBACK_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  scheduled: { bg: "oklch(0.55 0.18 210 / 0.12)", border: "oklch(0.55 0.18 210)", text: "oklch(0.35 0.18 210)" },
  confirmed: { bg: "oklch(0.55 0.18 210 / 0.12)", border: "oklch(0.55 0.18 210)", text: "oklch(0.35 0.18 210)" },
  unconfirmed: { bg: "oklch(0.78 0.17 75 / 0.12)", border: "oklch(0.78 0.17 75)", text: "oklch(0.50 0.17 75)" },
  complete: { bg: "oklch(0.65 0.18 155 / 0.12)", border: "oklch(0.65 0.18 155)", text: "oklch(0.40 0.18 155)" },
  completed: { bg: "oklch(0.65 0.18 155 / 0.12)", border: "oklch(0.65 0.18 155)", text: "oklch(0.40 0.18 155)" },
  cancelled: { bg: "oklch(0.62 0.22 25 / 0.12)", border: "oklch(0.62 0.22 25)", text: "oklch(0.45 0.22 25)" },
  broken: { bg: "oklch(0.65 0.2 25 / 0.15)", border: "oklch(0.65 0.2 25)", text: "oklch(0.45 0.2 25)" },
  asap: { bg: "oklch(0.75 0.15 45 / 0.15)", border: "oklch(0.65 0.15 45)", text: "oklch(0.45 0.15 45)" },
  planned: { bg: "oklch(0.7 0.12 280 / 0.12)", border: "oklch(0.55 0.12 280)", text: "oklch(0.4 0.12 280)" },
  unschedList: { bg: "oklch(0.75 0.02 240 / 0.12)", border: "oklch(0.5 0.02 240)", text: "oklch(0.4 0.02 240)" },
};

const DEFAULT_COLOR = { bg: "oklch(0.55 0.18 210 / 0.12)", border: "oklch(0.55 0.18 210)", text: "oklch(0.35 0.18 210)" };

export function getAppointmentCardColor(
  appointment: { colorOverride?: string; status?: string },
  _appointmentTypeColor?: string,
  _providerColor?: string
): { bg: string; border: string; text: string } {
  if (appointment.colorOverride) {
    const hex = appointment.colorOverride.replace(/^#/, "");
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      const bg = `rgb(${r * 255} ${g * 255} ${b * 255} / 0.15)`;
      const border = appointment.colorOverride;
      const text = `rgb(${r * 0.4 * 255} ${g * 0.4 * 255} ${b * 0.4 * 255})`;
      return { bg, border, text };
    }
  }
  const status = (appointment.status ?? "scheduled").toLowerCase().replace(/\s/g, "");
  return STATUS_FALLBACK_COLORS[status] ?? STATUS_FALLBACK_COLORS.scheduled ?? DEFAULT_COLOR;
}
