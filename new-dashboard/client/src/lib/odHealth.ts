import type { OdOfficeHealth, OfficeConfig } from "./api";

/**
 * How the office picker should render one office's Open Dental state.
 *
 * Pure, and separated from the component, because the interesting decisions
 * here are about honesty rather than about layout:
 *
 *  - "connected" and "reachable" are DIFFERENT questions. An office can be
 *    switched on with its key present (connected) and still be unreachable
 *    because the practice's on-premises eConnector died. The picker must be
 *    able to say the second thing without implying the first changed — the
 *    action buttons are gated on `odConnected`, and a five-minute network blip
 *    must not take a practice's ability to file chart notes away.
 *  - "we have not asked yet" is not "it is fine". Before the first probe lands
 *    — and for the whole life of a process whose checker failed to start — the
 *    state is `unknown`, and it renders as unknown.
 */
export type OdHealthTone = "ok" | "down" | "unknown" | "not_connected";

export interface OfficeHealthDisplay {
  tone: OdHealthTone;
  /** Show a visible warning glyph? Reserved for states someone must act on. */
  warn: boolean;
  /** Full sentence for the row's tooltip. Always states health honestly. */
  title: string;
}

/** Failure kinds in the words an office manager would use. */
const FAILURE_LABEL: Record<string, string> = {
  timeout: "not responding",
  network: "unreachable",
  auth: "rejecting our credentials",
  rate_limited: "rate-limiting us",
  server_error: "returning errors",
  unexpected_response: "answering unexpectedly",
  not_configured: "not configured",
};

/**
 * "12m" / "3h" / "just now" from an ISO timestamp. Returns null when the
 * timestamp is missing or unparseable, so a caller can omit the clause rather
 * than print "since NaN".
 */
export function elapsedLabel(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const minutes = Math.round((now - then) / 60000);
  if (minutes < 0) return null;
  if (minutes < 1) return "just now";
  if (minutes < 90) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

/**
 * Decide what the picker shows for one office.
 *
 * @param office the roster entry, with its optional health observation
 * @param now injected so the elapsed clause is testable
 */
export function officeHealthDisplay(
  office: Pick<OfficeConfig, "odConnected" | "odBlockedReason" | "odHealth">,
  now: number = Date.now(),
): OfficeHealthDisplay {
  // Configuration first. An office that is not connected has no reachability to
  // report, and saying "unreachable" about an office nobody switched on would
  // send somebody to check a network that is working fine.
  if (!office.odConnected) {
    return {
      tone: "not_connected",
      warn: true,
      title: office.odBlockedReason || "Open Dental is not connected for this office yet",
    };
  }

  const health: OdOfficeHealth | null | undefined = office.odHealth;
  if (!health || health.status === "unknown") {
    return {
      tone: "unknown",
      warn: false,
      title: "Open Dental: not checked yet",
    };
  }

  if (health.status === "down") {
    const reason = FAILURE_LABEL[health.lastFailureKind ?? ""] ?? "unreachable";
    const since = elapsedLabel(health.lastTransitionAt, now);
    return {
      tone: "down",
      warn: true,
      title:
        `Open Dental is ${reason}` +
        (since ? ` — since ${since} ago` : "") +
        ". Chart notes will not send until it is back.",
    };
  }

  const checked = elapsedLabel(health.lastCheckedAt, now);
  return {
    tone: "ok",
    warn: false,
    title: `Open Dental: reachable${checked ? ` (checked ${checked} ago)` : ""}`,
  };
}
