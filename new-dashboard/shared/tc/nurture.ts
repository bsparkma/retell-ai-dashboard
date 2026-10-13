/**
 * TC nurture campaigns v1 (queue item 47) — the shared, FROZEN definitions.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * RATIFIED DESIGN (Beau, 2026-10-13) — these are law for this slice
 * ═════════════════════════════════════════════════════════════════════════════
 *   - FOUR FIXED TRACKS. The team never builds a campaign. The track keys are
 *     frozen: they are stored in tc_nurture_enrollments.track_key and pinned by
 *     an inline CHECK in 1791100000000_tc_nurture.js.
 *   - ONE DIAL per office, per track: gentle | standard | assertive. The three
 *     schedules below are code constants; nothing anywhere edits a cadence.
 *   - HARD CAPS, not configurable: at most 3 touches in any rolling 7 days, at
 *     least 48 hours between touches, at most 12 touches per enrollment. Every
 *     preset is checked against them at boot (assertPresetsWithinCaps, called
 *     by backend/config/tcNurture.js) and the nightly generator enforces them
 *     again at run time.
 *   - DRAFTS ONLY. The generator writes tc_messages drafts. A human approves
 *     each one through the ordinary Send click (services/messaging
 *     sendMessage), which is still the only send path and still the only place
 *     consent and quiet hours are enforced.
 *
 * TOTALITY AT COMPILE TIME. `defineTrack` makes every preset name a touch the
 * track actually defines, and `NURTURE_TRACKS satisfies Record<NurtureTrackKey,
 * …>` with `presets: Record<NurtureIntensity, …>` makes a fifth track, or a
 * fourth intensity, without schedules a `tsc --noEmit` failure — the same
 * shape as the CaseStatus open/terminal partition in contract.ts.
 *
 * TEMPLATE COPY is Beau-approved (Appendix A of the item-47 spec) and frozen
 * here, not in tc_email_templates: that table is the team's editable library,
 * and a frozen campaign whose copy anybody can edit is not frozen. Merge
 * fields are exactly {{firstName}}, {{officeName}} and {{officePhone}}. No
 * SMS body names a procedure or a diagnosis (a test scans for it).
 *
 * Email copy is BODY COPY ONLY: the compliant shell (header, footer postal
 * address, unsubscribe link) is the email renderer's job (item 40) and is not
 * duplicated here.
 */
import { z } from "zod";
import {
  LibraryNurtureConfig,
  NURTURE_DEFAULT_INTENSITY,
  NurtureIntensity,
  NurtureTrackConfig,
  NurtureTrackKey,
  OfficeId,
  Uuid,
} from "./contract";
import { MessageChannel, TcMessage } from "./messaging";

const IsoTimestamp = z.string().datetime({ offset: true });

// ── Vocabularies (each mirrors an inline CHECK in 1791100000000_tc_nurture.js) ──

export { NurtureTrackKey, NurtureIntensity };

/**
 *   active     the generator drafts its touches as they come due
 *   paused     a human must look: the patient wrote back, or a TC paused it
 *   completed  every touch in the schedule was queued (no auto-chaining in v1)
 *   stopped    ended early: the case left TC work, the patient opted out, or a TC stopped it
 */
export const NurtureEnrollmentStatus = z.enum(["active", "paused", "completed", "stopped"]);
export type NurtureEnrollmentStatus = z.infer<typeof NurtureEnrollmentStatus>;

/**
 * stop_reason values the SYSTEM writes. A TC's manual stop stores the reason
 * the TC gave instead (free text, ≤ 200 chars), so this is not a closed set
 * on the column — but these two slugs are reserved for the system.
 */
export const NURTURE_STOP_CASE_TERMINAL = "case_terminal";
export const NURTURE_STOP_OPTED_OUT = "opted_out";

/**
 * The draft-time consent ADVISORY on a nurture draft (tc_messages
 * .consent_blocked_hint). Read from Postgres only — never Open Dental — so it
 * can be wrong in the permissive direction (it cannot see OD's TxtMsgOk) and
 * never in the other. Authoritative enforcement is the Send click.
 *   opted_out           tc_contact_consent says opted_out for this address
 *   email_unsubscribed  the case's nurture_unsubscribed flag (email only)
 *   no_address          the case has no usable address for the channel; the
 *                       draft cannot be sent until one is added and the
 *                       draft is re-made
 */
export const NurtureConsentHint = z.enum(["opted_out", "email_unsubscribed", "no_address"]);
export type NurtureConsentHint = z.infer<typeof NurtureConsentHint>;

// ── Hard caps ───────────────────────────────────────────────────────────────

export const NURTURE_CAPS = Object.freeze({
  /** At most this many touches in any rolling 7-day window. */
  maxTouchesPer7Days: 3,
  /** At least this many hours between two touches of one enrollment. */
  minHoursBetweenTouches: 48,
  /** At most this many touches in one enrollment, ever. */
  maxTouchesPerEnrollment: 12,
});

/** The suffix the first SMS a patient receives from an enrollment must carry. */
export const NURTURE_SMS_STOP_SUFFIX = "Reply STOP to opt out.";

// ── Track definitions ───────────────────────────────────────────────────────

export type NurtureSmsTouch = { channel: "sms"; body: string };
export type NurtureEmailTouch = { channel: "email"; subject: string; body: string; cta: string };
export type NurtureTouch = NurtureSmsTouch | NurtureEmailTouch;

/** One scheduled step: which touch, on which day after enrollment (day 0 = enrollment day). */
export type NurtureStep<K extends string = string> = { readonly touch: K; readonly day: number };

export type NurtureTrackDefinition<K extends string = string> = {
  readonly label: string;
  readonly goal: string;
  /** Track 1 is manual-only in v1 (no-show detection from OD is item 49). */
  readonly enrollment: "manual";
  readonly touches: Readonly<Record<K, NurtureTouch>>;
  readonly presets: Readonly<Record<NurtureIntensity, readonly NurtureStep<K>[]>>;
};

/** Binds every preset step to a touch the track defines — a typo is a tsc error. */
function defineTrack<const K extends string>(def: NurtureTrackDefinition<K>): NurtureTrackDefinition<K> {
  return def;
}

const S = "sms" as const;
const E = "email" as const;

export const NURTURE_TRACKS = {
  no_show_recovery: defineTrack({
    label: "No-Show Recovery",
    goal: "Reschedule. Warm, zero guilt.",
    enrollment: "manual",
    touches: {
      ns1: {
        channel: S,
        body: "Hi {{firstName}}, we missed you at {{officeName}}! Life happens — reply here or call {{officePhone}} and we'll find a time that works better. Reply STOP to opt out.",
      },
      ns2: {
        channel: E,
        subject: "Let's find you a new time",
        body: "Hi {{firstName}}, we missed seeing you! No worries at all — these things happen. Your spot on our schedule matters to us, so let's get you a new time that actually fits your week. Call {{officePhone}} or just reply to this email and we'll take care of it. — The team at {{officeName}}",
        cta: "Reschedule my visit",
      },
      ns3: {
        channel: S,
        body: "Hi {{firstName}}, still want to get you back on the books at {{officeName}}. Do mornings or afternoons work better for you? Just reply and we'll handle the rest.",
      },
      ns4: {
        channel: E,
        subject: "The door's still open",
        body: "Hi {{firstName}}, we haven't been able to reconnect since your missed visit, so this is our last nudge for a while — we don't want to crowd your inbox. Whenever you're ready, one call to {{officePhone}} gets you right back in. We'll be here. — {{officeName}}",
        cta: "Pick a new time",
      },
    },
    presets: {
      gentle: [
        { touch: "ns2", day: 2 },
        { touch: "ns4", day: 9 },
      ],
      standard: [
        { touch: "ns1", day: 1 },
        { touch: "ns2", day: 4 },
        { touch: "ns3", day: 10 },
      ],
      assertive: [
        { touch: "ns1", day: 1 },
        { touch: "ns2", day: 3 },
        { touch: "ns3", day: 6 },
        { touch: "ns4", day: 10 },
      ],
    },
  }),

  warm_followup: defineTrack({
    label: "Warm Follow-Up",
    goal: "Schedule presented treatment while it's fresh.",
    enrollment: "manual",
    touches: {
      wf1: {
        channel: S,
        body: "Hi {{firstName}}, thanks for coming in to {{officeName}}! If any questions came up after your visit, just reply — we're happy to help. Reply STOP to opt out.",
      },
      wf2: {
        channel: E,
        subject: "Your plan, in plain English",
        body: "Hi {{firstName}}, it was great seeing you. We know a treatment plan can feel like a lot to take in at the chair, so if anything we discussed deserves a second explanation — what it involves, why we recommended it, what happens if we wait — just reply or call {{officePhone}}. No pressure, just answers. — {{officeName}}",
        cta: "Ask us anything",
      },
      wf3: {
        channel: S,
        body: "Hi {{firstName}}, ready to get your next visit scheduled at {{officeName}}? Do mornings or afternoons usually work better? Reply and we'll find you two options.",
      },
      wf4: {
        channel: E,
        subject: "Why sooner beats later",
        body: "Hi {{firstName}}, one thing we see every week: small issues are quick, comfortable, and affordable to handle — and the same issues, left a year, rarely stay small. Taking care of your plan now usually means less time in the chair and less out of pocket overall. When you're ready, {{officePhone}} is all it takes. — {{officeName}}",
        cta: "Schedule my visit",
      },
      wf5: {
        channel: E,
        subject: "Let's make it fit your budget",
        body: "Hi {{firstName}}, if cost is part of what's giving you pause, you're not alone — and we have options. Flexible payment plans, financing, and ways to phase treatment so it works for your budget. Five minutes with our team and you'll know exactly what's possible. — {{officeName}}",
        cta: "See my options",
      },
      wf6: {
        channel: S,
        body: "Hi {{firstName}}, your plan is still ready and waiting at {{officeName}}. Want us to pull up a couple of times for you? Just reply yes.",
      },
      wf7: {
        channel: E,
        subject: "You're in good company",
        body: "Hi {{firstName}}, most of the patients we see felt the same hesitation before getting started — and the thing we hear most afterward is \"I wish I'd done this sooner.\" Our team's job is to make the whole thing easier than you're expecting. Ready when you are: {{officePhone}}. — {{officeName}}",
        cta: "Get started",
      },
      wf8: {
        channel: S,
        body: "Hi {{firstName}}, quick check-in from {{officeName}} — still thinking it over, or any questions we can answer? Reply anytime.",
      },
      wf9: {
        channel: E,
        subject: "A note from our team",
        body: "Hi {{firstName}}, no sales pitch today — just a reminder that we genuinely care about getting you healthy and keeping you that way. Whatever the holdup is (schedule, cost, nerves — all normal), tell us and we'll work with it. — Your team at {{officeName}}",
        cta: "Reply to the team",
      },
      wf10: {
        channel: E,
        subject: "We'll quiet down now",
        body: "Hi {{firstName}}, we've sent a few notes about your treatment plan, and we don't want to be a pest — so we'll check in much less often from here. Your plan stays on file, and whenever you're ready, one call to {{officePhone}} picks it right back up. — {{officeName}}",
        cta: "I'm ready now",
      },
    },
    presets: {
      gentle: [
        { touch: "wf2", day: 3 },
        { touch: "wf3", day: 10 },
        { touch: "wf5", day: 24 },
        { touch: "wf8", day: 45 },
      ],
      standard: [
        { touch: "wf1", day: 2 },
        { touch: "wf2", day: 5 },
        { touch: "wf3", day: 9 },
        { touch: "wf5", day: 16 },
        { touch: "wf7", day: 30 },
        { touch: "wf8", day: 49 },
      ],
      assertive: [
        { touch: "wf1", day: 1 },
        { touch: "wf2", day: 3 },
        { touch: "wf3", day: 5 },
        { touch: "wf4", day: 8 },
        { touch: "wf6", day: 12 },
        { touch: "wf5", day: 19 },
        { touch: "wf8", day: 26 },
        { touch: "wf7", day: 33 },
        { touch: "wf9", day: 47 },
        { touch: "wf10", day: 56 },
      ],
    },
  }),

  reactivation: defineTrack({
    label: "Reactivation Drip",
    goal: "Re-engage aging plans. Slow, benefit-led.",
    enrollment: "manual",
    touches: {
      ra1: {
        channel: E,
        subject: "Your exam findings are still on file",
        body: "Hi {{firstName}}, it's been a while since we put together your treatment plan, and we wanted you to know it hasn't gone anywhere — your exam findings are on file and ready whenever you are. One call to {{officePhone}} and we'll pick up right where we left off. — {{officeName}}",
        cta: "Pick it back up",
      },
      ra2: {
        channel: S,
        body: "Hi {{firstName}}, {{officeName}} here — your treatment plan is still on file with us. Want to pick it back up? Reply or call {{officePhone}}. Reply STOP to opt out.",
      },
      ra3: {
        channel: E,
        subject: "Small things don't stay small",
        body: "Hi {{firstName}}, the honest truth about dental care: time is the one thing that makes everything harder to fix. What we found at your last exam was manageable then — and the sooner we look again, the more likely it still is. A quick visit tells us exactly where things stand. — {{officeName}}",
        cta: "Book a quick check",
      },
      ra4: {
        channel: E,
        subject: "Don't leave your benefits on the table",
        body: "Hi {{firstName}}, if you have dental insurance, unused benefits typically reset at the end of the year — money you've already paid for through your premiums. Finishing your treatment plan is one of the smartest ways to actually use them. We're happy to check what you have left: {{officePhone}}. — {{officeName}}",
        cta: "Check my benefits",
      },
      ra5: {
        channel: S,
        body: "Hi {{firstName}}, we'd love to see you back at {{officeName}}. Getting restarted is one quick call: {{officePhone}}.",
      },
      ra6: {
        channel: E,
        subject: "Should we keep your plan active?",
        body: "Hi {{firstName}}, we still have your treatment plan on file, but it's been long enough that some of it may need a fresh look. If you'd like, we'll have the doctor review it and schedule a short visit to update anything that's changed — so when you start, you're starting from today, not from last year. — {{officeName}}",
        cta: "Update my plan",
      },
      ra7: {
        channel: E,
        subject: "A lot has gotten easier",
        body: "Hi {{firstName}}, dentistry keeps getting more comfortable — and so do we. Faster visits, better options, and a team that will meet you wherever you left off, no judgment, no lecture. Come see the difference. — {{officeName}}",
        cta: "Come back in",
      },
      ra8: {
        channel: E,
        subject: "We'll keep the light on",
        body: "Hi {{firstName}}, this is our last regular note about your treatment plan — we don't believe in nagging. You'll stay on our books as our patient, and the day you're ready, we're one call away: {{officePhone}}. Take care of yourself. — {{officeName}}",
        cta: "I'm ready",
      },
    },
    presets: {
      // Beau, 2026-10-13: Appendix A listed ra2@67 (E) and ra5@127 (E), but
      // ra2 and ra5 exist only as SMS copy, and as SMS they stack two texts
      // back to back. Ruling: keep gentle all-email on the same four days,
      // using the approved email touches ra3 and ra4.
      gentle: [
        { touch: "ra1", day: 7 },
        { touch: "ra3", day: 67 },
        { touch: "ra4", day: 127 },
        { touch: "ra6", day: 187 },
      ],
      standard: [
        { touch: "ra1", day: 7 },
        { touch: "ra2", day: 37 },
        { touch: "ra3", day: 67 },
        { touch: "ra4", day: 97 },
        { touch: "ra5", day: 127 },
        { touch: "ra6", day: 157 },
      ],
      assertive: [
        { touch: "ra1", day: 3 },
        { touch: "ra2", day: 17 },
        { touch: "ra3", day: 31 },
        { touch: "ra4", day: 61 },
        { touch: "ra5", day: 91 },
        { touch: "ra7", day: 121 },
        { touch: "ra6", day: 151 },
        { touch: "ra8", day: 181 },
      ],
    },
  }),

  large_case: defineTrack({
    label: "Large Case / Financing",
    goal: "Convert big presented cases. Fewer, higher-touch, value-first.",
    enrollment: "manual",
    touches: {
      lc1: {
        channel: E,
        subject: "The smile you talked about, step by step",
        body: "Hi {{firstName}}, big decisions deserve clear information, so here's the short version of what we discussed: what we'd be doing, in what order, and what it gets you — function, comfort, and a result you'll see every day in the mirror. If you'd like us to walk through any part again (or all of it), we'll make the time. — {{officeName}}",
        cta: "Walk me through it",
      },
      lc2: {
        channel: E,
        subject: "Making the investment manageable",
        body: "Hi {{firstName}}, almost no one pays for comprehensive treatment all at once — and you don't have to either. Between phasing the work, payment plans, and third-party financing, there's usually a monthly number that feels very doable. Let us run the options for your plan specifically: {{officePhone}}. — {{officeName}}",
        cta: "Show me my options",
      },
      lc3: {
        channel: E,
        subject: "A personal note from Dr. Sparkman",
        body: "Hi {{firstName}}, I wanted to reach out myself. The plan we put together for you is one I'm confident in, and I don't take recommendations of this size lightly — I recommend what I'd want for my own family. If you have doubts or questions, I'd rather hear them than have you sit with them. Call the office and they'll get us time to talk. — Dr. Beau Sparkman, {{officeName}}",
        cta: "Set up a time to talk",
      },
      lc4: {
        channel: E,
        subject: "What a finished case looks like",
        body: "Hi {{firstName}}, it's hard to picture the end result from a treatment plan on paper. Patients who've completed treatment like yours tell us the change in how they eat, speak, and smile was worth every step. We'd love to show you what's possible — come in for a no-pressure conversation. — {{officeName}}",
        cta: "Show me",
      },
      lc5: {
        channel: E,
        subject: "No rush — but let's stay in touch",
        body: "Hi {{firstName}}, a plan like yours is a real decision, and we respect that it takes time. We'll stop checking in so often, but your plan stays on file and our door stays open. When you want to talk — about the treatment, the timing, or the money — we're at {{officePhone}}. — {{officeName}}",
        cta: "Let's talk",
      },
      lc6: {
        channel: S,
        body: "Hi {{firstName}}, {{officeName}} here — happy to answer any questions about your treatment plan or go over payment options. Just reply. Reply STOP to opt out.",
      },
      lc7: {
        channel: S,
        body: "Hi {{firstName}}, checking in from {{officeName}} — want us to set up a quick, no-pressure chat about your plan? Reply yes and we'll arrange it.",
      },
    },
    presets: {
      gentle: [
        { touch: "lc1", day: 5 },
        { touch: "lc2", day: 21 },
        { touch: "lc5", day: 49 },
      ],
      standard: [
        { touch: "lc1", day: 3 },
        { touch: "lc2", day: 10 },
        { touch: "lc3", day: 21 },
        { touch: "lc6", day: 35 },
        { touch: "lc5", day: 56 },
      ],
      assertive: [
        { touch: "lc1", day: 2 },
        { touch: "lc2", day: 6 },
        { touch: "lc3", day: 12 },
        { touch: "lc6", day: 21 },
        { touch: "lc4", day: 30 },
        { touch: "lc7", day: 42 },
        { touch: "lc5", day: 56 },
      ],
    },
  }),
} as const satisfies Record<NurtureTrackKey, NurtureTrackDefinition>;

/** Compile-time only: the track table covers the enum exactly (no extras either). */
type Assert<T extends true> = T;
type _TracksCoverEnum = Assert<
  [Exclude<NurtureTrackKey, keyof typeof NURTURE_TRACKS>] extends [never] ? true : false
>;
type _TracksHaveNoExtras = Assert<
  [Exclude<keyof typeof NURTURE_TRACKS, NurtureTrackKey>] extends [never] ? true : false
>;

/** The definition for a track, widened to the common shape. */
export function nurtureTrack(key: NurtureTrackKey): NurtureTrackDefinition {
  return NURTURE_TRACKS[key];
}

/** The ordered schedule for a track at an intensity. */
export function nurtureSchedule(key: NurtureTrackKey, intensity: NurtureIntensity): readonly NurtureStep[] {
  return nurtureTrack(key).presets[intensity];
}

/** The touch a schedule step names. Throws on a step the track does not define (unreachable by type). */
export function nurtureTouch(key: NurtureTrackKey, touchKey: string): NurtureTouch {
  const touches: Readonly<Record<string, NurtureTouch>> = nurtureTrack(key).touches;
  const t = touches[touchKey];
  if (!t) throw new Error(`nurture: track ${key} has no touch ${touchKey}`);
  return t;
}

/** tc_messages.template_id for a nurture touch: 'nurture.<track>.<touch>'. */
export function nurtureTemplateId(key: NurtureTrackKey, touchKey: string): string {
  return `nurture.${key}.${touchKey}`;
}

// ── The cap check (boot assertion + tests) ──────────────────────────────────

/**
 * Every way one schedule breaks the hard caps or the channel rules, as
 * sentences. Empty ⇒ the schedule is lawful.
 *   - day offsets strictly increasing, ≥ 1
 *   - ≥ 48h between consecutive touches (2 whole days: the engine runs once a day)
 *   - ≤ 3 touches in any rolling 7 days
 *   - ≤ 12 touches
 *   - never two SMS touches back to back
 *   - every SMS / email touch has its copy (and an email its subject + CTA)
 */
/** A track table, as the cap check reads it (the frozen one, or a test's). */
export type NurtureTrackTable = Readonly<Record<NurtureTrackKey, NurtureTrackDefinition>>;

export function presetViolations(
  key: NurtureTrackKey,
  intensity: NurtureIntensity,
  tracks: NurtureTrackTable = NURTURE_TRACKS,
): string[] {
  const touchOf = (touchKey: string): NurtureTouch => {
    const touches: Readonly<Record<string, NurtureTouch>> = tracks[key].touches;
    const t = touches[touchKey];
    if (!t) throw new Error(`nurture: track ${key} has no touch ${touchKey}`);
    return t;
  };
  const steps = tracks[key].presets[intensity];
  const where = `${key}/${intensity}`;
  const out: string[] = [];
  const minDays = NURTURE_CAPS.minHoursBetweenTouches / 24;
  if (steps.length === 0) out.push(`${where}: no touches`);
  if (steps.length > NURTURE_CAPS.maxTouchesPerEnrollment) {
    out.push(`${where}: ${steps.length} touches > ${NURTURE_CAPS.maxTouchesPerEnrollment}`);
  }
  steps.forEach((s, i) => {
    if (!Number.isInteger(s.day) || s.day < 1) out.push(`${where}: step ${i} day ${s.day} is not a whole day ≥ 1`);
    let touch: NurtureTouch | null = null;
    try {
      touch = touchOf(s.touch);
    } catch {
      out.push(`${where}: step ${i} names unknown touch ${s.touch}`);
    }
    if (touch) {
      if (!touch.body.trim()) out.push(`${where}: ${s.touch} has no copy`);
      if (touch.channel === "email" && (!touch.subject.trim() || !touch.cta.trim())) {
        out.push(`${where}: ${s.touch} needs a subject and a CTA`);
      }
    }
    if (i > 0) {
      const prev = steps[i - 1];
      if (s.day - prev.day < minDays) {
        out.push(`${where}: ${prev.touch}@${prev.day} → ${s.touch}@${s.day} is under ${NURTURE_CAPS.minHoursBetweenTouches}h`);
      }
      let prevTouch: NurtureTouch | null = null;
      try {
        prevTouch = touchOf(prev.touch);
      } catch {
        prevTouch = null;
      }
      if (touch && prevTouch && touch.channel === "sms" && prevTouch.channel === "sms") {
        out.push(`${where}: ${prev.touch} → ${s.touch} stacks SMS back to back`);
      }
    }
    // Rolling 7 days: the window [day, day + 6].
    const inWindow = steps.filter((t) => t.day >= s.day && t.day <= s.day + 6).length;
    if (inWindow > NURTURE_CAPS.maxTouchesPer7Days) {
      out.push(`${where}: ${inWindow} touches in the 7 days from day ${s.day}`);
    }
  });
  return out;
}

/** Every violation across every track and intensity. */
export function allPresetViolations(tracks: NurtureTrackTable = NURTURE_TRACKS): string[] {
  const out: string[] = [];
  for (const key of NurtureTrackKey.options) {
    for (const intensity of NurtureIntensity.options) out.push(...presetViolations(key, intensity, tracks));
  }
  return out;
}

/** Throw (loudly, at boot) if any preset breaks a cap. */
export function assertPresetsWithinCaps(tracks: NurtureTrackTable = NURTURE_TRACKS): void {
  const v = allPresetViolations(tracks);
  if (v.length) {
    throw new Error(`[tcNurture] ${v.length} preset(s) break the hard caps:\n  ${v.join("\n  ")}`);
  }
}

// ── Merge fields ────────────────────────────────────────────────────────────

export type NurtureMergeValues = { firstName: string; officeName: string; officePhone: string };

/** Fill {{firstName}} / {{officeName}} / {{officePhone}}. An unknown token is left as-is (and a test forbids one). */
export function fillNurtureCopy(text: string, values: NurtureMergeValues): string {
  return text.replace(/\{\{(firstName|officeName|officePhone)\}\}/g, (_m, k: keyof NurtureMergeValues) => values[k]);
}

/** The merge tokens a piece of copy uses (any {{…}}, known or not). */
export function nurtureTokensIn(text: string): string[] {
  return Array.from(text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g), (m) => m[1]);
}

// ── Per-office config: tc_library_config section `nurture_config` ───────────

export { NurtureTrackConfig, LibraryNurtureConfig, NURTURE_DEFAULT_INTENSITY };

/** The dial in force for a track, from a stored (or absent) section. */
export function intensityFor(config: LibraryNurtureConfig | null | undefined, key: NurtureTrackKey): NurtureIntensity {
  return config?.tracks?.[key]?.intensity ?? NURTURE_DEFAULT_INTENSITY;
}

// ── Entities + wire shapes ──────────────────────────────────────────────────

export const TcNurtureEnrollment = z.object({
  enrollmentId: Uuid,
  caseId: Uuid,
  officeId: OfficeId,
  trackKey: NurtureTrackKey,
  intensityAtEnroll: NurtureIntensity,
  status: NurtureEnrollmentStatus,
  stopReason: z.string().max(200).nullable(),
  nextTouchIndex: z.number().int().min(0),
  nextTouchDueAt: IsoTimestamp.nullable(),
  lastTouchAt: IsoTimestamp.nullable(),
  /** The touch the next draft will be, or null when the schedule is exhausted. */
  nextTouchKey: z.string().max(20).nullable(),
  touchCount: z.number().int().min(0),
  createdBy: z.string().max(320).nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type TcNurtureEnrollment = z.infer<typeof TcNurtureEnrollment>;

/** Why a track cannot be started on this case right now (the picker greys it with this). */
export const NurtureTrackUnavailableReason = z.enum([
  "switched_off",
  "case_terminal",
  "already_enrolled",
  "no_address",
]);
export type NurtureTrackUnavailableReason = z.infer<typeof NurtureTrackUnavailableReason>;

export const NurtureTrackAvailability = z.object({
  trackKey: NurtureTrackKey,
  label: z.string(),
  goal: z.string(),
  intensity: NurtureIntensity,
  touchCount: z.number().int().min(0),
  channels: z.array(MessageChannel),
  available: z.boolean(),
  reason: NurtureTrackUnavailableReason.nullable(),
});
export type NurtureTrackAvailability = z.infer<typeof NurtureTrackAvailability>;

/** GET /api/tc/nurture/enrollments?case_id= */
export const NurtureCaseResponse = z.object({
  enabled: z.boolean(),
  enrollments: z.array(TcNurtureEnrollment),
  tracks: z.array(NurtureTrackAvailability),
});
export type NurtureCaseResponse = z.infer<typeof NurtureCaseResponse>;

/** POST /api/tc/nurture/enrollments. NO office field: the office is the case's. */
export const NurtureEnrollBody = z.object({ case_id: Uuid, track_key: NurtureTrackKey }).strict();
export type NurtureEnrollBody = z.infer<typeof NurtureEnrollBody>;

export const NurtureStopBody = z.object({ reason: z.string().trim().min(1).max(200) }).strict();
export type NurtureStopBody = z.infer<typeof NurtureStopBody>;

/** One nurture draft as the outbox shows it. */
export const NurtureOutboxDraft = z.object({
  message: TcMessage,
  enrollmentId: Uuid,
  caseId: Uuid,
  patientName: z.string().max(200).nullable(), // PHI
  touchKey: z.string().max(20),
  consentBlockedHint: NurtureConsentHint.nullable(),
});
export type NurtureOutboxDraft = z.infer<typeof NurtureOutboxDraft>;

export const NurtureOutboxGroup = z.object({
  trackKey: NurtureTrackKey,
  label: z.string(),
  drafts: z.array(NurtureOutboxDraft),
});
export type NurtureOutboxGroup = z.infer<typeof NurtureOutboxGroup>;

export const NurtureChannelState = z.object({
  channel: MessageChannel,
  enabled: z.boolean(),
  reason: z.enum(["switched_off", "not_configured", "office_not_configured"]).nullable(),
});

/** GET /api/tc/nurture/outbox */
export const NurtureOutboxResponse = z.object({
  enabled: z.boolean(),
  channels: z.array(NurtureChannelState),
  groups: z.array(NurtureOutboxGroup),
});
export type NurtureOutboxResponse = z.infer<typeof NurtureOutboxResponse>;

/** GET/PUT /api/tc/nurture/config */
export const NurtureConfigResponse = z.object({
  enabled: z.boolean(),
  tracks: z.array(
    z.object({
      trackKey: NurtureTrackKey,
      label: z.string(),
      intensity: NurtureIntensity,
      stored: z.boolean(),
    }),
  ),
});
export type NurtureConfigResponse = z.infer<typeof NurtureConfigResponse>;
