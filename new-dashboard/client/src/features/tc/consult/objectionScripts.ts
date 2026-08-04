/**
 * Objection coaching copy — static content ported from the legacy DentaFlow
 * OBJECTION_RESPONSES library (TC-app lib/seedData.ts), trimmed to the fields
 * the consult flow renders (title + in-room scripts + tips).
 *
 * The 8 keys below are the post-consult objection grid. They are stored as the
 * TcObjection.category string on the platform (the contract's category is
 * free text, so no enum mapping was needed — legacy keys carry over 1:1).
 */

export interface ObjectionScript {
  /** Platform objection category string (legacy key, unchanged). */
  key: string;
  /** Button label in the post-consult grid. */
  label: string;
  /** Display title of the coaching card. */
  title: string;
  /** In-room response scripts (page shows the first 2). */
  scripts: string[];
  /** Coaching tips (page shows the first 2). */
  tips: string[];
}

export const OBJECTION_SCRIPTS: readonly ObjectionScript[] = [
  {
    key: "cost",
    label: "Cost / Budget",
    title: "It's Too Expensive",
    scripts: [
      "I completely understand — this is a significant investment. Can I ask, what were you expecting to invest in your smile today?",
      "What if I told you we could get started for about $X per month — less than a daily coffee? Would that change things?",
      "The cost of doing nothing is actually higher in the long run. That tooth that needs a crown today? If it breaks, we're looking at an implant — which is 3x the cost.",
      "Let's look at this as a monthly investment rather than a lump sum. Which option fits your budget best?",
    ],
    tips: [
      "Never apologize for the fee. Present it with confidence.",
      "Break it down to a daily or monthly cost to make it feel manageable.",
      "Anchor the cost against the cost of doing nothing.",
      "Find out their budget before presenting options — ask 'What were you expecting to invest?'",
      "Offer to phase treatment if the full plan is overwhelming.",
    ],
  },
  {
    key: "timing",
    label: "Not the Right Time",
    title: "Not the Right Time",
    scripts: [
      "I hear you — life is busy. Can I ask, what would need to change for the timing to feel right?",
      "The challenge with dental issues is they don't wait for a good time. That crack in your tooth is getting bigger every day.",
      "What if we started with just Phase 1 today? We could do the urgent work now and schedule the rest for when it works better for you.",
    ],
    tips: [
      "Identify the real reason — 'timing' is often a proxy for cost or fear.",
      "Offer a phased approach to reduce the immediate commitment.",
      "Create urgency around the clinical need without being alarmist.",
      "Connect the treatment to something they care about (event, travel, etc.).",
    ],
  },
  {
    key: "fear",
    label: "Fear / Anxiety",
    title: "Fear / Anxiety",
    scripts: [
      "I really appreciate you sharing that with me. A lot of our patients feel the same way before they come in. Can you tell me more about what specifically worries you?",
      "We offer nitrous oxide and oral sedation for patients who feel anxious. Many patients don't remember the appointment at all.",
      "Your comfort is our absolute priority. We won't do anything without your full understanding and consent. Would it help to meet with the doctor first to just talk through the process?",
    ],
    tips: [
      "Listen more than you talk — let them express their fear fully.",
      "Validate their feelings without dismissing them.",
      "Offer a 'no-obligation consultation' with the doctor to build trust.",
      "Share specific patient success stories (with permission).",
      "Discuss sedation options proactively.",
    ],
  },
  {
    key: "necessity",
    label: "Is This Necessary?",
    title: "Is This Really Necessary?",
    scripts: [
      "That's a great question, and I'm glad you asked it. The doctor wouldn't recommend anything that isn't clinically necessary. Would it help if I walked you through exactly why each item is on the plan?",
      "Let me show you the X-rays. This area — see this dark spot? That's where the decay has reached. Without treatment, this will become a much bigger problem.",
      "Think of it like a crack in your windshield. Right now it's small and fixable. If we wait, it spreads and the whole windshield needs replacing.",
    ],
    tips: [
      "Use visual aids — X-rays, photos, models.",
      "Explain the clinical rationale in patient-friendly language.",
      "Offer to prioritize — 'If we could only do one thing today, what would the doctor say is most important?'",
      "Never pressure — validate the question and educate.",
    ],
  },
  {
    key: "second_opinion",
    label: "Second Opinion",
    title: "I Want a Second Opinion",
    scripts: [
      "Absolutely — I think that's a smart thing to do for any significant dental investment. We want you to feel completely confident in your decision.",
      "Of course. We can put together a complete copy of your X-rays and treatment notes for you to take. Would you like that?",
      "Most patients who get a second opinion come back to us — not because we pressure them, but because they feel confident after seeing that the diagnosis is consistent.",
    ],
    tips: [
      "Never try to talk them out of a second opinion — it destroys trust.",
      "Offer to provide records proactively.",
      "Use it as an opportunity to address the underlying concern (usually cost or fear).",
      "Separate urgent from elective — ask to address urgent items now.",
    ],
  },
  {
    key: "spouse_family",
    label: "Need to Discuss with Family",
    title: "Need to Discuss with Spouse/Family",
    scripts: [
      "That makes total sense — this is a big decision and it's great that you want to include your family. What questions do you think they might have?",
      "Absolutely. Would it be helpful if I put together a written summary you can share with them? That way they have all the details.",
      "Of course. Would your spouse or family member like to come in for a free consultation? We'd be happy to walk them through everything.",
    ],
    tips: [
      "Offer a written summary the patient can take home — reduces miscommunication.",
      "Ask WHO specifically they need to discuss with and WHAT that person's concerns might be.",
      "Follow up in 3-4 days — enough time for the conversation but not so long they lose momentum.",
      "Offer a free consultation for the decision maker to come in and ask questions.",
      "Frame the treatment in terms the decision maker cares about (health, finances, quality of life).",
    ],
  },
  {
    key: "financing",
    label: "Financing / Can't Afford",
    title: "Financing / Can't Afford It",
    scripts: [
      "Let's figure this out together. What monthly payment would feel comfortable for you?",
      "We work with several financing partners specifically for healthcare. Most of our patients are surprised at how affordable the monthly payment is.",
      "What if we started with just the most urgent treatment today? We can phase the rest over time to keep the monthly payment manageable.",
    ],
    tips: [
      "Always present the monthly payment first, not the total.",
      "Have the financing application ready to go — reduce friction.",
      "Know your providers' approval rates and credit requirements.",
      "Offer in-house payment plans as a last resort.",
      "Never let cost be the reason someone doesn't get the care they need.",
    ],
  },
  {
    key: "not_ready",
    label: "Need to Think About It",
    title: "I Need to Think About It",
    scripts: [
      "Of course — this is an important decision. Can I ask, is there a specific concern I can help address before you leave today?",
      "What information would help you feel confident making a decision?",
      "Let's schedule a follow-up call for a specific date. That way you have time to think, and I can answer any questions that come up.",
    ],
    tips: [
      "'Think about it' usually means an unaddressed objection — dig deeper.",
      "Ask 'What specifically would you need to feel confident?'",
      "Set a specific follow-up date before they leave.",
      "Separate urgent from elective — address the urgent item now.",
      "Send a follow-up email with a summary and financing options.",
    ],
  },
] as const;

export function objectionScriptFor(key: string): ObjectionScript | null {
  return OBJECTION_SCRIPTS.find((s) => s.key === key) ?? null;
}

export function objectionLabel(key: string): string {
  return objectionScriptFor(key)?.label ?? key.replace(/_/g, " ");
}
