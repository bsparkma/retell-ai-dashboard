/**
 * TC Guide — static coaching content, ported verbatim from DentaFlow
 * (TC-app client/src/lib/seedData.ts DISCOVERY_QUESTIONS / OBJECTION_RESPONSES /
 * EDUCATION_LIBRARY, plus the inline playbook copy from pages/TCGuide.tsx).
 *
 * This is scripts/coaching copy only — no patient data. The cadence-tier
 * dollar thresholds below are static educational copy that duplicates the
 * office cadence config in the Library; they are intentionally ported as-is.
 */

// ── Discovery ───────────────────────────────────────────────────────────────

export interface GuideDiscoveryQuestion {
  question: string;
  purpose: string;
}

export const DISCOVERY_QUESTIONS: readonly GuideDiscoveryQuestion[] = [
  {
    question: "What brings you in today, and how long has this been bothering you?",
    purpose: "Understand the chief complaint and urgency level",
  },
  {
    question: "If we could fix one thing about your smile or oral health today, what would it be?",
    purpose: "Identify the patient's primary motivator",
  },
  {
    question: "How has this been affecting your day-to-day life — eating, speaking, confidence?",
    purpose: "Quantify the emotional and functional impact",
  },
  {
    question: "Is there an upcoming event or reason you'd like to have this resolved by a certain date?",
    purpose: "Create timeline urgency and emotional connection",
  },
  {
    question: "What would it mean to you to have a healthy, beautiful smile?",
    purpose: "Anchor the value of treatment to their personal goals",
  },
  {
    question: "Have you had dental work done before? How was that experience?",
    purpose: "Identify fear, past trauma, or positive anchors",
  },
  {
    question: "Are there any financial concerns I should be aware of so we can find the best solution for you?",
    purpose: "Open the financing conversation proactively and without shame",
  },
  {
    question: "What's most important to you — getting this done quickly, keeping costs down, or having the absolute best result?",
    purpose: "Prioritize what matters most to guide the treatment presentation",
  },
];

/** The 8-step consult flow shown under the discovery questions. */
export const CONSULT_FLOW_STEPS: readonly string[] = [
  "Build rapport — 2-3 minutes of genuine connection",
  "Discovery — ask 3-4 questions, listen actively",
  "Present diagnosis — translate clinical to patient-friendly",
  "Show treatment options — ideal, phased, and budget-conscious",
  "Present financing — show monthly payment first",
  "Handle objections — validate, then guide",
  "Ask for the commitment — 'What would you like to do?'",
  "Set next steps — schedule or set follow-up date",
];

// ── Objection handling ──────────────────────────────────────────────────────

export interface GuideObjectionResponse {
  title: string;
  scripts: string[];
  inChair: string[];
  onPhone: string[];
  textTemplates: string[];
  tips: string[];
}

export const OBJECTION_RESPONSES = {
  cost: {
    title: "It's Too Expensive",
    scripts: [
      "I completely understand — this is a significant investment. Can I ask, what were you expecting to invest in your smile today?",
      "What if I told you we could get started for about $X per month — less than a daily coffee? Would that change things?",
      "The cost of doing nothing is actually higher in the long run. That tooth that needs a crown today? If it breaks, we're looking at an implant — which is 3x the cost.",
      "Let's look at this as a monthly investment rather than a lump sum. Which option fits your budget best?",
    ],
    inChair: [
      "I completely understand — this is a significant investment. Can I ask, what were you expecting to invest in your smile today?",
      "What if I told you we could get started for about $X per month — less than a daily coffee? Would that change things?",
      "The cost of doing nothing is actually higher in the long run. That tooth that needs a crown today? If it breaks, we're looking at an implant — which is 3x the cost.",
      "Let's look at this as a monthly investment rather than a lump sum. Which option fits your budget best?",
    ],
    onPhone: [
      "Hi [name], I wanted to follow up on your treatment plan. I know the investment felt significant — have you had a chance to look at the financing options I sent over?",
      "I was thinking about your case and wanted to let you know we have a new 0% interest option that could bring your monthly payment down to around $X. Would that help?",
      "Just checking in — I know cost was a concern. What if we started with just Phase 1? That way we address the urgent items and keep the upfront cost manageable.",
    ],
    textTemplates: [
      "Hi [name]! Just following up on your treatment plan. I put together a quick financing comparison — would you like me to send it over? No pressure at all.",
      "Hi [name], quick note — we have a limited-time 0% financing offer that could work great for your plan. Want me to run the numbers for you?",
      "Hey [name]! Thinking of you. If the total cost felt overwhelming, we can absolutely phase things out. Want to chat about a plan that fits your budget?",
    ],
    tips: [
      "Never apologize for the fee. Present it with confidence.",
      "Break it down to a daily or monthly cost to make it feel manageable.",
      "Anchor the cost against the cost of doing nothing.",
      "Find out their budget before presenting options — ask 'What were you expecting to invest?'",
      "Offer to phase treatment if the full plan is overwhelming.",
    ],
  },
  timing: {
    title: "Not the Right Time",
    scripts: [
      "I hear you — life is busy. Can I ask, what would need to change for the timing to feel right?",
      "The challenge with dental issues is they don't wait for a good time. That crack in your tooth is getting bigger every day.",
      "What if we started with just Phase 1 today? We could do the urgent work now and schedule the rest for when it works better for you.",
      "I know it feels like bad timing, but your upcoming [event/vacation/etc.] is actually a great reason to get this done now — you'll feel so much better.",
    ],
    inChair: [
      "I hear you — life is busy. Can I ask, what would need to change for the timing to feel right?",
      "The challenge with dental issues is they don't wait for a good time. That crack in your tooth is getting bigger every day.",
      "What if we started with just Phase 1 today? We could do the urgent work now and schedule the rest for when it works better for you.",
    ],
    onPhone: [
      "Hi [name], I know the timing didn't feel right when we last talked. Has anything changed on your end? I'd love to help you find a window that works.",
      "Just a quick check-in — I wanted to make sure you know we can work around your schedule. We have early morning and late afternoon openings if that helps.",
      "Hi [name], I know life's been busy. Just wanted to gently mention that the longer we wait on [urgent item], the more complex it can get. Can we find even one appointment slot?",
    ],
    textTemplates: [
      "Hi [name]! Just checking in. I know timing was tough — we have some new availability that might work better for your schedule. Want me to send some options?",
      "Hey [name], no rush at all, but I wanted to let you know we opened up some weekend slots. Would any of those work for you?",
    ],
    tips: [
      "Identify the real reason — 'timing' is often a proxy for cost or fear.",
      "Offer a phased approach to reduce the immediate commitment.",
      "Create urgency around the clinical need without being alarmist.",
      "Connect the treatment to something they care about (event, travel, etc.).",
    ],
  },
  fear: {
    title: "Fear / Anxiety",
    scripts: [
      "I really appreciate you sharing that with me. A lot of our patients feel the same way before they come in. Can you tell me more about what specifically worries you?",
      "We have patients who were terrified of the dentist who now come in for their cleanings and say it was nothing like they expected. What would make you feel most comfortable?",
      "We offer nitrous oxide and oral sedation for patients who feel anxious. Many patients don't remember the appointment at all.",
      "Your comfort is our absolute priority. We won't do anything without your full understanding and consent. Would it help to meet with Dr. [Name] first to just talk through the process?",
    ],
    inChair: [
      "I really appreciate you sharing that with me. A lot of our patients feel the same way. Can you tell me more about what specifically worries you?",
      "We offer nitrous oxide and oral sedation for patients who feel anxious. Many patients don't remember the appointment at all.",
      "Your comfort is our absolute priority. Would it help to meet with Dr. [Name] first to just talk through the process?",
    ],
    onPhone: [
      "Hi [name], I just wanted to check in. I know dental anxiety is real, and I want you to know there's absolutely no judgment here. Would it help to come in just for a tour and to meet the team — no treatment, just a visit?",
      "I was thinking about our conversation and wanted to let you know about our sedation options. Many anxious patients tell us they wish they'd come in sooner. Can I answer any questions?",
    ],
    textTemplates: [
      "Hi [name]! Just wanted you to know we totally understand dental anxiety. We have sedation options that make it really comfortable. Want me to send you some info?",
      "Hey [name], one of our patients who was nervous just like you left us a review about how comfortable she felt. Want me to share it? No pressure at all!",
    ],
    tips: [
      "Listen more than you talk — let them express their fear fully.",
      "Validate their feelings without dismissing them.",
      "Offer a 'no-obligation consultation' with the doctor to build trust.",
      "Share specific patient success stories (with permission).",
      "Discuss sedation options proactively.",
    ],
  },
  necessity: {
    title: "Is This Really Necessary?",
    scripts: [
      "That's a great question, and I'm glad you asked it. Dr. [Name] wouldn't recommend anything that isn't clinically necessary. Would it help if I walked you through exactly why each item is on the plan?",
      "Let me show you the X-rays. This [tooth/area] — see this dark area? That's where the decay has reached. Without treatment, this will become a much bigger problem.",
      "Think of it like a crack in your windshield. Right now it's small and fixable. If we wait, it spreads and the whole windshield needs replacing.",
      "I completely understand the skepticism. You're right to ask. Let me show you exactly what Dr. [Name] found and why each item matters.",
    ],
    inChair: [
      "That's a great question. Dr. [Name] wouldn't recommend anything that isn't clinically necessary. Would it help if I walked you through exactly why each item is on the plan?",
      "Let me show you the X-rays. See this dark area? That's where the decay has reached. Without treatment, this will become a much bigger problem.",
      "Think of it like a crack in your windshield. Right now it's small and fixable. If we wait, it spreads and the whole thing needs replacing.",
    ],
    onPhone: [
      "Hi [name], I know you had some questions about whether everything on the plan is necessary. I'd love to walk through each item with you and explain exactly why Dr. [Name] recommended it. Do you have a few minutes?",
      "Just following up — I completely understand wanting to make sure every item is needed. Would it help if I sent you a summary of what each treatment prevents if we wait?",
    ],
    textTemplates: [
      "Hi [name]! I know you had questions about your treatment plan. I put together a quick summary of each item and why it matters. Want me to send it over?",
      "Hey [name], just checking in. Dr. [Name] wanted me to let you know we can absolutely prioritize — start with the most critical items first. Want to talk through it?",
    ],
    tips: [
      "Use visual aids — X-rays, photos, models.",
      "Explain the clinical rationale in patient-friendly language.",
      "Offer to prioritize — 'If we could only do one thing today, what would Dr. [Name] say is most important?'",
      "Never pressure — validate the question and educate.",
    ],
  },
  second_opinion: {
    title: "I Want a Second Opinion",
    scripts: [
      "Absolutely — I think that's a smart thing to do for any significant dental investment. We want you to feel completely confident in your decision.",
      "Of course. We can put together a complete copy of your X-rays and treatment notes for you to take. Would you like that?",
      "Most patients who get a second opinion come back to us — not because we pressure them, but because they feel confident after seeing that the diagnosis is consistent.",
      "While you're getting that second opinion, I do want to mention that the two urgent items — [X and Y] — are time-sensitive. Would you be open to addressing those while you consider the rest?",
    ],
    inChair: [
      "Absolutely — that's a smart thing to do. We want you to feel completely confident. We can put together your X-rays and treatment notes for you to take.",
      "Most patients who get a second opinion come back — they feel confident seeing the diagnosis is consistent.",
      "While you're getting that second opinion, the urgent items are time-sensitive. Would you be open to addressing those now?",
    ],
    onPhone: [
      "Hi [name], I just wanted to check in — were you able to get that second opinion? We're happy to answer any questions that came up.",
      "No rush at all — just wanted to make sure you have everything you need. Did the other office have any different findings? I'd love to help clarify anything.",
    ],
    textTemplates: [
      "Hi [name]! Just checking in — were you able to get that second opinion? We're here if you have any questions at all.",
      "Hey [name], hope you're doing well! Just wanted to make sure you had everything you needed for your second opinion. Let me know if I can help with anything.",
    ],
    tips: [
      "Never try to talk them out of a second opinion — it destroys trust.",
      "Offer to provide records proactively.",
      "Use it as an opportunity to address the underlying concern (usually cost or fear).",
      "Separate urgent from elective — ask to address urgent items now.",
    ],
  },
  financing: {
    title: "Financing / Can't Afford It",
    scripts: [
      "Let's figure this out together. What monthly payment would feel comfortable for you?",
      "We work with several financing partners specifically for healthcare. Most of our patients are surprised at how affordable the monthly payment is.",
      "With CareCredit, you could start treatment today with 0% interest for 24 months. That's [X] per month — about the same as a gym membership.",
      "What if we started with just the most urgent treatment today? We can phase the rest over time to keep the monthly payment manageable.",
    ],
    inChair: [
      "Let's figure this out together. What monthly payment would feel comfortable for you?",
      "We work with several financing partners specifically for healthcare. Most patients are surprised at how affordable it is.",
      "With CareCredit, you could start today with 0% interest for 24 months. That's about the same as a gym membership.",
    ],
    onPhone: [
      "Hi [name], I wanted to follow up on the financing side. Have you had a chance to look at CareCredit or Cherry? I can walk you through the application — it only takes a few minutes.",
      "Good news — I ran some numbers and with our longest-term option, your monthly payment would be around $X. Does that feel more manageable?",
      "Just checking in — if the financing application didn't work out, we also have in-house payment plans. Want me to put something together?",
    ],
    textTemplates: [
      "Hi [name]! Just wanted to let you know applying for CareCredit takes about 2 minutes and there's no impact on your credit score for the initial check. Want me to send the link?",
      "Hey [name], I put together a side-by-side comparison of our financing options for your plan. Want me to text it over?",
    ],
    tips: [
      "Always present the monthly payment first, not the total.",
      "Have the financing application ready to go — reduce friction.",
      "Know your providers' approval rates and credit requirements.",
      "Offer in-house payment plans as a last resort.",
      "Never let cost be the reason someone doesn't get the care they need.",
    ],
  },
  not_ready: {
    title: "I Need to Think About It",
    scripts: [
      "Of course — this is an important decision. Can I ask, is there a specific concern I can help address before you leave today?",
      "What information would help you feel confident making a decision?",
      "I totally understand. What I'd hate is for you to leave today and have that tooth fracture over the weekend. Can we at least take care of the most urgent piece?",
      "Let's schedule a follow-up call for [specific date]. That way you have time to think, and I can answer any questions that come up.",
    ],
    inChair: [
      "Of course — this is an important decision. Is there a specific concern I can help address before you leave today?",
      "What information would help you feel confident making a decision?",
      "What I'd hate is for that tooth to fracture over the weekend. Can we at least take care of the most urgent piece today?",
    ],
    onPhone: [
      "Hi [name], I just wanted to check in — you mentioned wanting to think things over. Have any questions come up that I can help with?",
      "No pressure at all — just wanted to make sure you have all the info you need. Is there anything specific that would help you feel more confident?",
      "Hi [name], I know it's a big decision. I just wanted to gently remind you that the urgent items are time-sensitive. Can we at least get those on the schedule?",
    ],
    textTemplates: [
      "Hi [name]! Just checking in. You mentioned wanting to think about your treatment plan — totally understandable! Is there anything I can help clarify?",
      "Hey [name], no rush at all. I just wanted to send a quick summary of your plan and the financing options in case it helps. Let me know if you have any questions!",
    ],
    tips: [
      "'Think about it' usually means an unaddressed objection — dig deeper.",
      "Ask 'What specifically would you need to feel confident?'",
      "Set a specific follow-up date before they leave.",
      "Separate urgent from elective — address the urgent item now.",
      "Send a follow-up email with a summary and financing options.",
    ],
  },
  spouse_family: {
    title: "Need to Discuss with Spouse/Family",
    scripts: [
      "That makes total sense — this is a big decision and it's great that you want to include your family. What questions do you think they might have?",
      "Absolutely. Would it be helpful if I put together a written summary you can share with them? That way they have all the details.",
      "Of course. Would your [spouse/family member] like to come in for a free consultation? We'd be happy to walk them through everything.",
    ],
    inChair: [
      "That makes total sense — it's great that you want to include your family. What questions do you think they might have?",
      "Would it be helpful if I put together a written summary you can share with them? That way they have all the details.",
      "Would your [spouse/family member] like to come in for a free consultation? We'd be happy to walk them through everything and answer their questions directly.",
    ],
    onPhone: [
      "Hi [name], I just wanted to follow up — did you get a chance to talk with your family about the treatment plan? I'm happy to answer any questions they might have.",
      "Just checking in — if your [spouse/family member] has any questions, I'd love to chat with them directly. Or I can send over a summary with all the details.",
      "Hi [name], how did the family conversation go? Sometimes it helps to have your family join a quick call with me so I can address their concerns directly.",
    ],
    textTemplates: [
      "Hi [name]! Just following up — did you get a chance to discuss your treatment plan with your family? Happy to answer any questions they might have!",
      "Hey [name], I put together a simple summary of your treatment plan that might help explain things to your family. Want me to send it over?",
      "Hi [name]! Just a thought — your [spouse/family member] is welcome to call or text me with any questions. Sometimes hearing it from us directly helps!",
    ],
    tips: [
      "Offer a written summary the patient can take home — reduces miscommunication.",
      "Ask WHO specifically they need to discuss with and WHAT that person's concerns might be.",
      "Follow up in 3-4 days — enough time for the conversation but not so long they lose momentum.",
      "Offer a free consultation for the decision maker to come in and ask questions.",
      "Frame the treatment in terms the decision maker cares about (health, finances, quality of life).",
    ],
  },
  insurance: {
    title: "Insurance Won't Cover It",
    scripts: [
      "Insurance is rarely the whole story — most plans cap at $1,500/year and exclude exactly what you actually need. Let me show you what your benefits do cover, then we'll look at financing for the rest.",
      "Your insurance is a small piece of the puzzle, not the whole picture. The good news is we have financing options that can keep your monthly payment lower than what insurance would have saved you anyway.",
      "I hear that a lot — 'if insurance doesn't cover it, I don't want to do it.' But waiting often means a bigger problem later that insurance covers even less of. Can I show you the math on doing this now vs. waiting?",
      "Let's separate two things — what insurance pays, and what your monthly payment will be. Most patients are surprised that with financing, the out-of-pocket monthly cost is very manageable, even with limited coverage.",
    ],
    inChair: [
      "Insurance is rarely the whole story — most plans cap at $1,500/year and exclude exactly what you actually need. Let me show you what your benefits do cover, then we'll look at financing for the rest.",
      "Let's separate two things — what insurance pays, and what your monthly payment will be. Most patients are surprised at how affordable the monthly cost is, even with limited coverage.",
      "Want me to run a benefits check while you're here? I can usually get you a real number in a few minutes so we're not guessing.",
    ],
    onPhone: [
      "Hi [name], I wanted to follow up on the insurance question. I went ahead and ran your benefits — you actually have more coverage than you thought. Want me to walk you through it?",
      "Just checking in — I know insurance was a concern. I have a side-by-side of what insurance covers vs. what financing would handle. Can I send it over?",
      "Hi [name], one quick thought — even with limited coverage, your monthly payment with CareCredit would be around $X. Want me to show you how that compares to waiting another year?",
    ],
    textTemplates: [
      "Hi [name]! Quick question on insurance — would you like me to run your benefits and send a written breakdown? Most patients find they have more coverage than they expected.",
      "Hey [name], just a thought — even if insurance doesn't cover the full plan, financing can make the monthly very manageable. Want me to send some numbers?",
    ],
    tips: [
      "Run a real benefits check — don't guess. Patients often have more coverage than they think.",
      "Reframe: it's not 'insurance vs. no treatment' — it's 'insurance + financing = a workable monthly payment.'",
      "Lead with what insurance DOES cover, then layer financing on the rest.",
      "Quantify the cost of waiting — small problems get bigger and insurance still won't cover those, either.",
      "Never let limited insurance be the reason a patient walks away from needed care.",
    ],
  },
} satisfies Record<string, GuideObjectionResponse>;

export type ObjectionKey = keyof typeof OBJECTION_RESPONSES;

/** Stable render order for the objection list buttons. */
export const OBJECTION_KEYS = Object.keys(OBJECTION_RESPONSES) as ObjectionKey[];

// ── Education library ───────────────────────────────────────────────────────

export interface GuideEducationItem {
  id: number;
  title: string;
  description: string;
  category: string;
}

export const EDUCATION_LIBRARY: readonly GuideEducationItem[] = [
  { id: 1, title: "Why Dental Implants Are Worth the Investment", description: "Patient-friendly explanation of implant longevity, bone preservation, and total cost of ownership vs. alternatives.", category: "Implants" },
  { id: 2, title: "Understanding Your Gum Disease Diagnosis", description: "What periodontal disease means, why it matters for your overall health, and what treatment looks like.", category: "Periodontal" },
  { id: 3, title: "Crowns vs. Fillings: When Do You Need a Crown?", description: "Clear explanation of when a filling is enough and when a crown is necessary to save the tooth.", category: "Restorative" },
  { id: 4, title: "How Invisalign Works: A Step-by-Step Guide", description: "The complete Invisalign process from scan to retainer, including what to expect at each stage.", category: "Orthodontics" },
  { id: 5, title: "Veneers: The Complete Patient Guide", description: "Everything patients need to know about porcelain veneers — the process, longevity, care, and what to expect.", category: "Cosmetic" },
  { id: 6, title: "The Link Between Oral Health and Overall Health", description: "Research-backed explanation of how gum disease affects heart disease, diabetes, and pregnancy.", category: "Health" },
  { id: 7, title: "Root Canal Myths vs. Reality", description: "Addressing the most common fears about root canals with facts and patient testimonials.", category: "Endodontics" },
  { id: 8, title: "All-on-4 vs. Traditional Dentures: A Comparison", description: "Side-by-side comparison of function, aesthetics, cost, and quality of life for full-arch options.", category: "Implants" },
  { id: 9, title: "Dental Financing: Your Complete Guide", description: "How CareCredit, Cherry, and other financing options work — written for patients.", category: "Financing" },
];

// ── Follow-up playbook ──────────────────────────────────────────────────────

/**
 * NOTE: these dollar thresholds are static educational copy carried over from
 * DentaFlow. The live cadence engine is configured per office in the Library
 * (cadence_config) — this page does not read that config.
 */
export type CadenceAccent = "green" | "teal" | "coral";

export interface GuideCadenceTier {
  tier: string;
  range: string;
  touches: string;
  schedule: string[];
  accent: CadenceAccent;
}

export const CADENCE_TIERS: readonly GuideCadenceTier[] = [
  {
    tier: "Light Touch",
    range: "Under $1,000",
    touches: "3 touches over 3 weeks",
    schedule: ["Day 2: Initial follow-up call/text", "Week 1: Check-in text", "Week 3: Final outreach"],
    accent: "green",
  },
  {
    tier: "Standard",
    range: "$1,000 – $5,000",
    touches: "5 touches over 6 weeks",
    schedule: ["Day 2: Follow-up call", "Day 5: Text with financing info", "Week 2: Check-in call", "Week 4: Value reinforcement text", "Week 6: Final outreach call"],
    accent: "teal",
  },
  {
    tier: "High Touch",
    range: "Over $5,000",
    touches: "8+ touches over 3 months",
    schedule: ["Day 1: Same-day thank you text", "Day 3: Follow-up call", "Day 7: Financing options text", "Week 2: Check-in call", "Week 3: Educational content", "Week 4: Value reinforcement", "Week 6: Personal check-in call", "Week 8: Final active outreach", "Then: Every 2 weeks (long-tail)"],
    accent: "coral",
  },
];

export type ObjectionFollowupIcon = "dollar" | "users" | "heart" | "alert";

export interface GuideObjectionFollowup {
  objection: string;
  icon: ObjectionFollowupIcon;
  approach: string;
  firstTouch: string;
}

export const OBJECTION_FOLLOWUPS: readonly GuideObjectionFollowup[] = [
  {
    objection: "Cost / Budget",
    icon: "dollar",
    approach: "Lead with monthly payment, not total. Reference financing options. Ask about budget comfort level.",
    firstTouch: "\"Have you had a chance to look at the monthly payment options I sent over?\"",
  },
  {
    objection: "Spouse / Family Decision",
    icon: "users",
    approach: "Give them 3-4 days (time to discuss). Offer shareable summary. Invite decision-maker to consult.",
    firstTouch: "\"Were you able to discuss the treatment plan with your family? I'm happy to answer any questions they have.\"",
  },
  {
    objection: "Fear / Anxiety",
    icon: "heart",
    approach: "Softer, educational tone. Share patient stories. Mention sedation options proactively.",
    firstTouch: "\"I just wanted to check in — no pressure at all. If you have any questions about what to expect, I'm here.\"",
  },
  {
    objection: "Not Necessary / Skeptical",
    icon: "alert",
    approach: "Reference clinical urgency. Use visual analogies (crack in windshield). Offer to start with Phase 1 only.",
    firstTouch: "\"Dr. [Name] wanted me to follow up — the [urgent item] is time-sensitive. Can we at least address that piece?\"",
  },
];

export interface GuideLostReason {
  label: string;
  desc: string;
}

export const LOST_REASONS: readonly GuideLostReason[] = [
  { label: "Moved Away", desc: "Patient relocated" },
  { label: "Chose Another Provider", desc: "Went elsewhere" },
  { label: "Declined Permanently", desc: "Explicitly said no" },
  { label: "Unresponsive", desc: "No contact after multiple attempts" },
];

export type ContactMethodIcon = "phone" | "text" | "email";

export interface GuideContactMethod {
  method: string;
  icon: ContactMethodIcon;
  when: string;
  tips: string[];
}

export const CONTACT_METHODS: readonly GuideContactMethod[] = [
  {
    method: "Phone Call",
    icon: "phone",
    when: "First follow-up, complex discussions, high-value cases",
    tips: ["Call between 10am-12pm or 2pm-4pm", "Have the patient's case pulled up before dialing", "If voicemail: leave a warm, specific message — don't just say 'call us back'"],
  },
  {
    method: "Text Message",
    icon: "text",
    when: "Quick check-ins, sending financing info, younger patients",
    tips: ["Keep it under 160 characters when possible", "Use their first name", "Include one specific detail from their case", "End with a question to encourage response"],
  },
  {
    method: "Email",
    icon: "email",
    when: "Sending detailed info, financing comparisons, family decision-makers",
    tips: ["Subject line should mention their treatment specifically", "Include the monthly payment number in the first paragraph", "Attach or link to any take-home materials"],
  },
];
