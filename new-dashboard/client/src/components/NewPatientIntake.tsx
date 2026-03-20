/**
 * NewPatientIntake — Guided 5-step new patient registration modal
 * Design: Warm Clinic — deep navy sidebar, cream background, Outfit + Inter
 *
 * Steps:
 *  1. Source — how the patient reached us (AI call, walk-in, referral, etc.)
 *  2. Demographics — name, DOB, contact info
 *  3. Insurance — primary + secondary insurance details
 *  4. Medical History — allergies, conditions, medications, last dental visit
 *  5. Appointment — preferred provider, service type, date/time, notes
 *
 * Pre-fill: accepts optional `prefill` prop from a live Rover call
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  UserPlus, Phone, Bot, MapPin, Shield, Heart, Calendar,
  ChevronRight, ChevronLeft, CheckCircle2, Sparkles, AlertCircle,
  Stethoscope, Pill, ClipboardList, Clock, User
} from "lucide-react";
import { toast } from "sonner";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NewPatientPrefill {
  patientName?: string;
  fromNumber?: string;
  callId?: string;
  source?: "ai_call" | "staff_call";
  agentName?: string;
  intent?: string;
}

interface FormData {
  // Step 1 — Source
  intakeSource: string;
  referredBy: string;
  callId: string;

  // Step 2 — Demographics
  firstName: string;
  lastName: string;
  dob: string;
  gender: string;
  email: string;
  phone: string;
  altPhone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  preferredContact: string;
  preferredLanguage: string;

  // Step 3 — Insurance
  hasInsurance: string;
  primaryInsurer: string;
  primaryMemberId: string;
  primaryGroupNumber: string;
  primarySubscriberName: string;
  primarySubscriberDOB: string;
  primaryRelationship: string;
  hasSecondary: string;
  secondaryInsurer: string;
  secondaryMemberId: string;

  // Step 4 — Medical History
  primaryCarePhysician: string;
  lastDentalVisit: string;
  lastDentalOffice: string;
  allergies: string;
  medications: string;
  medicalConditions: string[];
  smokingStatus: string;
  pregnancyStatus: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  emergencyContactRelation: string;

  // Step 5 — Appointment
  preferredProvider: string;
  serviceType: string;
  preferredDate: string;
  preferredTime: string;
  appointmentNotes: string;
  howDidYouHear: string;
}

const INITIAL_FORM: FormData = {
  intakeSource: "",
  referredBy: "",
  callId: "",
  firstName: "",
  lastName: "",
  dob: "",
  gender: "",
  email: "",
  phone: "",
  altPhone: "",
  address: "",
  city: "",
  state: "",
  zip: "",
  preferredContact: "phone",
  preferredLanguage: "english",
  hasInsurance: "",
  primaryInsurer: "",
  primaryMemberId: "",
  primaryGroupNumber: "",
  primarySubscriberName: "",
  primarySubscriberDOB: "",
  primaryRelationship: "self",
  hasSecondary: "no",
  secondaryInsurer: "",
  secondaryMemberId: "",
  primaryCarePhysician: "",
  lastDentalVisit: "",
  lastDentalOffice: "",
  allergies: "",
  medications: "",
  medicalConditions: [],
  smokingStatus: "",
  pregnancyStatus: "na",
  emergencyContactName: "",
  emergencyContactPhone: "",
  emergencyContactRelation: "",
  preferredProvider: "",
  serviceType: "",
  preferredDate: "",
  preferredTime: "",
  appointmentNotes: "",
  howDidYouHear: "",
};

const MEDICAL_CONDITIONS = [
  "Diabetes", "Heart Disease", "High Blood Pressure", "Asthma",
  "Bleeding Disorder", "Arthritis", "Osteoporosis", "Cancer / Chemotherapy",
  "HIV / AIDS", "Kidney Disease", "Liver Disease", "Thyroid Disorder",
  "Anxiety / Depression", "Epilepsy / Seizures", "Stroke",
];

const STEPS = [
  { id: 1, label: "Source", icon: Bot },
  { id: 2, label: "Demographics", icon: User },
  { id: 3, label: "Insurance", icon: Shield },
  { id: 4, label: "Medical History", icon: Heart },
  { id: 5, label: "Appointment", icon: Calendar },
];

// ─── Helper: label + input row ────────────────────────────────────────────────

function Field({
  label, required, children, hint,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-foreground">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{children}</div>;
}

// ─── Step components ──────────────────────────────────────────────────────────

function StepSource({ form, set, prefill }: { form: FormData; set: (k: keyof FormData, v: string) => void; prefill?: NewPatientPrefill }) {
  const sources = [
    { id: "ai_call", label: "AI Call (Rover)", icon: "🤖", desc: "Patient called in and spoke with Rover" },
    { id: "staff_call", label: "Staff Call", icon: "📞", desc: "Patient spoke with a team member" },
    { id: "walk_in", label: "Walk-In", icon: "🚶", desc: "Patient arrived in person" },
    { id: "referral", label: "Referral", icon: "👥", desc: "Referred by another patient or provider" },
    { id: "online", label: "Online / Web", icon: "🌐", desc: "Booked or inquired through the website" },
    { id: "other", label: "Other", icon: "📋", desc: "Another source" },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
          How did this patient reach us?
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          This helps us track where new patients come from and improve our outreach.
        </p>
      </div>

      {prefill?.callId && (
        <div className="flex items-start gap-3 p-3 rounded-xl border border-primary/30 bg-primary/5">
          <Sparkles size={16} className="text-primary mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-foreground">Pre-filled from Rover call</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Call ID: {prefill.callId} · {prefill.fromNumber} · {prefill.intent}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {sources.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => set("intakeSource", s.id)}
            className={`p-3 rounded-xl border text-left transition-all duration-150 ${
              form.intakeSource === s.id
                ? "border-primary/50 bg-primary/8 ring-1 ring-primary/30"
                : "border-border bg-card hover:border-primary/30 hover:bg-muted/30"
            }`}
          >
            <div className="text-xl mb-1.5">{s.icon}</div>
            <div className="text-sm font-medium text-foreground leading-tight">{s.label}</div>
            <div className="text-xs text-muted-foreground mt-0.5 leading-tight">{s.desc}</div>
          </button>
        ))}
      </div>

      {form.intakeSource === "referral" && (
        <Field label="Referred by">
          <Input
            placeholder="Patient name or provider"
            value={form.referredBy}
            onChange={(e) => set("referredBy", e.target.value)}
          />
        </Field>
      )}

      {(form.intakeSource === "ai_call" || form.intakeSource === "staff_call") && (
        <Field label="Call ID" hint="Optional — links this record to the call log">
          <Input
            placeholder="e.g. call_001"
            value={form.callId}
            onChange={(e) => set("callId", e.target.value)}
          />
        </Field>
      )}
    </div>
  );
}

function StepDemographics({ form, set }: { form: FormData; set: (k: keyof FormData, v: string) => void }) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
          Patient demographics
        </h3>
        <p className="text-sm text-muted-foreground mt-1">Basic contact and identification information.</p>
      </div>

      <Row>
        <Field label="First Name" required>
          <Input placeholder="First name" value={form.firstName} onChange={(e) => set("firstName", e.target.value)} />
        </Field>
        <Field label="Last Name" required>
          <Input placeholder="Last name" value={form.lastName} onChange={(e) => set("lastName", e.target.value)} />
        </Field>
      </Row>

      <Row>
        <Field label="Date of Birth" required>
          <Input type="date" value={form.dob} onChange={(e) => set("dob", e.target.value)} />
        </Field>
        <Field label="Gender">
          <Select value={form.gender} onValueChange={(v) => set("gender", v)}>
            <SelectTrigger><SelectValue placeholder="Select gender" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="female">Female</SelectItem>
              <SelectItem value="male">Male</SelectItem>
              <SelectItem value="nonbinary">Non-binary</SelectItem>
              <SelectItem value="prefer_not">Prefer not to say</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </Row>

      <Row>
        <Field label="Phone" required>
          <div className="relative">
            <Phone size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9 font-mono"
              placeholder="+1 (602) 555-0000"
              value={form.phone}
              onChange={(e) => set("phone", e.target.value)}
            />
          </div>
        </Field>
        <Field label="Alternate Phone">
          <div className="relative">
            <Phone size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9 font-mono"
              placeholder="+1 (602) 555-0000"
              value={form.altPhone}
              onChange={(e) => set("altPhone", e.target.value)}
            />
          </div>
        </Field>
      </Row>

      <Field label="Email">
        <Input type="email" placeholder="patient@email.com" value={form.email} onChange={(e) => set("email", e.target.value)} />
      </Field>

      <Field label="Street Address">
        <div className="relative">
          <MapPin size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="123 Main St" value={form.address} onChange={(e) => set("address", e.target.value)} />
        </div>
      </Field>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="sm:col-span-2">
          <Field label="City">
            <Input placeholder="Phoenix" value={form.city} onChange={(e) => set("city", e.target.value)} />
          </Field>
        </div>
        <Field label="State">
          <Input placeholder="AZ" maxLength={2} value={form.state} onChange={(e) => set("state", e.target.value.toUpperCase())} />
        </Field>
        <Field label="ZIP">
          <Input placeholder="85001" maxLength={5} value={form.zip} onChange={(e) => set("zip", e.target.value)} />
        </Field>
      </div>

      <Row>
        <Field label="Preferred Contact Method">
          <Select value={form.preferredContact} onValueChange={(v) => set("preferredContact", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="phone">Phone</SelectItem>
              <SelectItem value="text">Text / SMS</SelectItem>
              <SelectItem value="email">Email</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Preferred Language">
          <Select value={form.preferredLanguage} onValueChange={(v) => set("preferredLanguage", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="english">English</SelectItem>
              <SelectItem value="spanish">Spanish</SelectItem>
              <SelectItem value="mandarin">Mandarin</SelectItem>
              <SelectItem value="tagalog">Tagalog</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </Row>

      <div className="border-t border-border pt-4 space-y-4">
        <p className="text-sm font-medium text-foreground">Emergency Contact</p>
        <Row>
          <Field label="Name">
            <Input placeholder="Contact name" value={form.emergencyContactName} onChange={(e) => set("emergencyContactName", e.target.value)} />
          </Field>
          <Field label="Relationship">
            <Input placeholder="Spouse, parent, etc." value={form.emergencyContactRelation} onChange={(e) => set("emergencyContactRelation", e.target.value)} />
          </Field>
        </Row>
        <Field label="Phone">
          <div className="relative">
            <Phone size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-9 font-mono" placeholder="+1 (602) 555-0000" value={form.emergencyContactPhone} onChange={(e) => set("emergencyContactPhone", e.target.value)} />
          </div>
        </Field>
      </div>
    </div>
  );
}

function StepInsurance({ form, set }: { form: FormData; set: (k: keyof FormData, v: string) => void }) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
          Insurance information
        </h3>
        <p className="text-sm text-muted-foreground mt-1">Dental insurance details for billing and eligibility verification.</p>
      </div>

      <Field label="Does the patient have dental insurance?" required>
        <div className="flex gap-3">
          {["yes", "no", "medicaid", "self_pay"].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => set("hasInsurance", v)}
              className={`flex-1 py-2.5 px-3 rounded-lg border text-sm font-medium transition-all ${
                form.hasInsurance === v
                  ? "border-primary/50 bg-primary/8 text-primary"
                  : "border-border bg-card hover:border-primary/30 text-foreground"
              }`}
            >
              {v === "yes" ? "Yes" : v === "no" ? "No" : v === "medicaid" ? "Medicaid" : "Self-Pay"}
            </button>
          ))}
        </div>
      </Field>

      {form.hasInsurance === "yes" && (
        <div className="space-y-4 p-4 rounded-xl border border-border bg-muted/20">
          <div className="flex items-center gap-2">
            <Shield size={14} className="text-primary" />
            <span className="text-sm font-semibold text-foreground">Primary Insurance</span>
          </div>

          <Row>
            <Field label="Insurance Company" required>
              <Input placeholder="Delta Dental, Cigna, Aetna..." value={form.primaryInsurer} onChange={(e) => set("primaryInsurer", e.target.value)} />
            </Field>
            <Field label="Member ID" required>
              <Input placeholder="Member / subscriber ID" value={form.primaryMemberId} onChange={(e) => set("primaryMemberId", e.target.value)} />
            </Field>
          </Row>

          <Row>
            <Field label="Group Number">
              <Input placeholder="Group / plan number" value={form.primaryGroupNumber} onChange={(e) => set("primaryGroupNumber", e.target.value)} />
            </Field>
            <Field label="Subscriber Relationship">
              <Select value={form.primaryRelationship} onValueChange={(v) => set("primaryRelationship", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="self">Self</SelectItem>
                  <SelectItem value="spouse">Spouse</SelectItem>
                  <SelectItem value="child">Child</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </Row>

          {form.primaryRelationship !== "self" && (
            <Row>
              <Field label="Subscriber Name">
                <Input placeholder="Policy holder's full name" value={form.primarySubscriberName} onChange={(e) => set("primarySubscriberName", e.target.value)} />
              </Field>
              <Field label="Subscriber DOB">
                <Input type="date" value={form.primarySubscriberDOB} onChange={(e) => set("primarySubscriberDOB", e.target.value)} />
              </Field>
            </Row>
          )}

          <div className="pt-2 border-t border-border">
            <Field label="Secondary Insurance?">
              <div className="flex gap-3">
                {["yes", "no"].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => set("hasSecondary", v)}
                    className={`px-4 py-2 rounded-lg border text-sm font-medium transition-all ${
                      form.hasSecondary === v
                        ? "border-primary/50 bg-primary/8 text-primary"
                        : "border-border bg-card hover:border-primary/30 text-foreground"
                    }`}
                  >
                    {v === "yes" ? "Yes" : "No"}
                  </button>
                ))}
              </div>
            </Field>
          </div>

          {form.hasSecondary === "yes" && (
            <Row>
              <Field label="Secondary Insurer">
                <Input placeholder="Insurance company name" value={form.secondaryInsurer} onChange={(e) => set("secondaryInsurer", e.target.value)} />
              </Field>
              <Field label="Secondary Member ID">
                <Input placeholder="Member ID" value={form.secondaryMemberId} onChange={(e) => set("secondaryMemberId", e.target.value)} />
              </Field>
            </Row>
          )}
        </div>
      )}

      {(form.hasInsurance === "no" || form.hasInsurance === "self_pay") && (
        <div className="flex items-start gap-3 p-3 rounded-xl border border-amber-500/30 bg-amber-500/5">
          <AlertCircle size={16} className="text-amber-600 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-foreground">Self-Pay Patient</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Discuss payment options and financial arrangements at check-in. Consider CareCredit or payment plans.
            </p>
          </div>
        </div>
      )}

      {form.hasInsurance === "medicaid" && (
        <div className="flex items-start gap-3 p-3 rounded-xl border border-blue-500/30 bg-blue-500/5">
          <Shield size={16} className="text-blue-600 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-foreground">Medicaid / AHCCCS</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Verify Medicaid eligibility before scheduling. Confirm the office accepts their plan.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function StepMedical({ form, set, setConditions }: {
  form: FormData;
  set: (k: keyof FormData, v: string) => void;
  setConditions: (conditions: string[]) => void;
}) {
  const toggleCondition = (c: string) => {
    if (form.medicalConditions.includes(c)) {
      setConditions(form.medicalConditions.filter((x) => x !== c));
    } else {
      setConditions([...form.medicalConditions, c]);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
          Medical history
        </h3>
        <p className="text-sm text-muted-foreground mt-1">Health background for safe treatment planning.</p>
      </div>

      <Row>
        <Field label="Last Dental Visit">
          <Select value={form.lastDentalVisit} onValueChange={(v) => set("lastDentalVisit", v)}>
            <SelectTrigger><SelectValue placeholder="Select timeframe" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="6mo">Within 6 months</SelectItem>
              <SelectItem value="1yr">6–12 months ago</SelectItem>
              <SelectItem value="2yr">1–2 years ago</SelectItem>
              <SelectItem value="3yr">2–3 years ago</SelectItem>
              <SelectItem value="3yr_plus">3+ years ago</SelectItem>
              <SelectItem value="never">Never</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Previous Dental Office">
          <Input placeholder="Office name (optional)" value={form.lastDentalOffice} onChange={(e) => set("lastDentalOffice", e.target.value)} />
        </Field>
      </Row>

      <Field label="Primary Care Physician">
        <div className="relative">
          <Stethoscope size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Dr. Name / Practice" value={form.primaryCarePhysician} onChange={(e) => set("primaryCarePhysician", e.target.value)} />
        </div>
      </Field>

      <Field label="Drug Allergies" hint="List all known drug or material allergies (e.g., penicillin, latex)">
        <div className="relative">
          <AlertCircle size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Penicillin, latex, codeine... or None" value={form.allergies} onChange={(e) => set("allergies", e.target.value)} />
        </div>
      </Field>

      <Field label="Current Medications" hint="Include dosage if known">
        <div className="relative">
          <Pill size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Lisinopril 10mg, Metformin... or None" value={form.medications} onChange={(e) => set("medications", e.target.value)} />
        </div>
      </Field>

      <Field label="Medical Conditions" hint="Select all that apply">
        <div className="flex flex-wrap gap-2 mt-1">
          {MEDICAL_CONDITIONS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => toggleCondition(c)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                form.medicalConditions.includes(c)
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border bg-card hover:border-primary/30 text-foreground"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </Field>

      <Row>
        <Field label="Smoking / Tobacco Status">
          <Select value={form.smokingStatus} onValueChange={(v) => set("smokingStatus", v)}>
            <SelectTrigger><SelectValue placeholder="Select status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="never">Never</SelectItem>
              <SelectItem value="former">Former smoker</SelectItem>
              <SelectItem value="current">Current smoker</SelectItem>
              <SelectItem value="vape">Vape / e-cigarette</SelectItem>
              <SelectItem value="chew">Chewing tobacco</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Pregnancy Status">
          <Select value={form.pregnancyStatus} onValueChange={(v) => set("pregnancyStatus", v)}>
            <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="na">N/A</SelectItem>
              <SelectItem value="pregnant">Currently pregnant</SelectItem>
              <SelectItem value="nursing">Nursing / breastfeeding</SelectItem>
              <SelectItem value="trying">Trying to conceive</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </Row>
    </div>
  );
}

function StepAppointment({ form, set }: { form: FormData; set: (k: keyof FormData, v: string) => void }) {
  const services = [
    { id: "new_patient_exam", label: "New Patient Exam", icon: "🦷", desc: "Comprehensive exam + X-rays" },
    { id: "cleaning", label: "Cleaning", icon: "✨", desc: "Routine prophylaxis" },
    { id: "emergency", label: "Emergency", icon: "🚨", desc: "Pain, broken tooth, urgent care" },
    { id: "consult", label: "Consultation", icon: "💬", desc: "Treatment plan discussion" },
    { id: "whitening", label: "Whitening", icon: "⭐", desc: "In-office whitening" },
    { id: "other", label: "Other", icon: "📋", desc: "Specify in notes" },
  ];

  const providers = [
    { id: "dr_johnson", label: "Dr. Johnson", specialty: "General Dentistry" },
    { id: "dr_smith", label: "Dr. Smith", specialty: "General + Cosmetic" },
    { id: "dr_lee", label: "Dr. Lee", specialty: "General Dentistry" },
    { id: "no_preference", label: "No Preference", specialty: "First available" },
  ];

  const timeSlots = [
    "8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM",
    "11:00 AM", "11:30 AM", "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM",
    "3:00 PM", "3:30 PM", "4:00 PM", "4:30 PM",
  ];

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
          Schedule first appointment
        </h3>
        <p className="text-sm text-muted-foreground mt-1">Book the patient's first visit or note their preferences.</p>
      </div>

      <Field label="Service Type" required>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {services.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => set("serviceType", s.id)}
              className={`p-3 rounded-xl border text-left transition-all duration-150 ${
                form.serviceType === s.id
                  ? "border-primary/50 bg-primary/8 ring-1 ring-primary/30"
                  : "border-border bg-card hover:border-primary/30 hover:bg-muted/30"
              }`}
            >
              <div className="text-lg mb-1">{s.icon}</div>
              <div className="text-xs font-semibold text-foreground leading-tight">{s.label}</div>
              <div className="text-xs text-muted-foreground mt-0.5 leading-tight">{s.desc}</div>
            </button>
          ))}
        </div>
      </Field>

      <Field label="Preferred Provider">
        <div className="grid grid-cols-2 gap-2">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => set("preferredProvider", p.id)}
              className={`p-3 rounded-lg border text-left transition-all ${
                form.preferredProvider === p.id
                  ? "border-primary/50 bg-primary/8 text-primary"
                  : "border-border bg-card hover:border-primary/30 text-foreground"
              }`}
            >
              <div className="text-sm font-medium">{p.label}</div>
              <div className="text-xs text-muted-foreground">{p.specialty}</div>
            </button>
          ))}
        </div>
      </Field>

      <Row>
        <Field label="Preferred Date">
          <div className="relative">
            <Calendar size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="date"
              className="pl-9"
              value={form.preferredDate}
              onChange={(e) => set("preferredDate", e.target.value)}
              min={new Date().toISOString().split("T")[0]}
            />
          </div>
        </Field>
        <Field label="Preferred Time">
          <Select value={form.preferredTime} onValueChange={(v) => set("preferredTime", v)}>
            <SelectTrigger>
              <Clock size={14} className="mr-2 text-muted-foreground" />
              <SelectValue placeholder="Select time" />
            </SelectTrigger>
            <SelectContent>
              {timeSlots.map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </Row>

      <Field label="How did you hear about us?">
        <Select value={form.howDidYouHear} onValueChange={(v) => set("howDidYouHear", v)}>
          <SelectTrigger><SelectValue placeholder="Select source" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="google">Google Search</SelectItem>
            <SelectItem value="yelp">Yelp</SelectItem>
            <SelectItem value="insurance">Insurance Directory</SelectItem>
            <SelectItem value="friend">Friend / Family Referral</SelectItem>
            <SelectItem value="doctor">Doctor Referral</SelectItem>
            <SelectItem value="social">Social Media</SelectItem>
            <SelectItem value="mailer">Direct Mail</SelectItem>
            <SelectItem value="other">Other</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label="Additional Notes">
        <textarea
          className="w-full min-h-[80px] px-3 py-2 text-sm rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
          placeholder="Any special requests, concerns, or notes for the team..."
          value={form.appointmentNotes}
          onChange={(e) => set("appointmentNotes", e.target.value)}
        />
      </Field>
    </div>
  );
}

// ─── Review summary ───────────────────────────────────────────────────────────

function ReviewRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-border/50 last:border-0">
      <span className="text-xs text-muted-foreground min-w-[120px]">{label}</span>
      <span className="text-xs text-foreground font-medium text-right">{value}</span>
    </div>
  );
}

// ─── Main modal ───────────────────────────────────────────────────────────────

interface NewPatientIntakeProps {
  open: boolean;
  onClose: () => void;
  prefill?: NewPatientPrefill;
}

export default function NewPatientIntake({ open, onClose, prefill }: NewPatientIntakeProps) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormData>(() => {
    const base = { ...INITIAL_FORM };
    if (prefill) {
      const parts = (prefill.patientName || "").split(" ");
      base.firstName = parts[0] || "";
      base.lastName = parts.slice(1).join(" ") || "";
      base.phone = prefill.fromNumber || "";
      base.callId = prefill.callId || "";
      base.intakeSource = prefill.source || "ai_call";
      if (prefill.intent?.toLowerCase().includes("new patient")) {
        base.serviceType = "new_patient_exam";
      }
    }
    return base;
  });
  const [submitting, setSubmitting] = useState(false);

  const setField = (k: keyof FormData, v: string) => {
    setForm((prev) => ({ ...prev, [k]: v }));
  };

  const setConditions = (conditions: string[]) => {
    setForm((prev) => ({ ...prev, medicalConditions: conditions }));
  };

  const canProceed = () => {
    if (step === 1) return !!form.intakeSource;
    if (step === 2) return !!(form.firstName && form.lastName);
    if (step === 3) return !!form.hasInsurance;
    return true;
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    await new Promise((r) => setTimeout(r, 1200));
    setSubmitting(false);
    toast.success(`New patient ${form.firstName} ${form.lastName} created in Open Dental`, {
      description: form.preferredDate
        ? `Appointment requested for ${form.preferredDate} at ${form.preferredTime}`
        : "No appointment scheduled yet",
    });
    onClose();
    setStep(1);
    setForm({ ...INITIAL_FORM });
  };

  const handleClose = () => {
    onClose();
    setTimeout(() => { setStep(1); setForm({ ...INITIAL_FORM }); }, 300);
  };

  const serviceLabels: Record<string, string> = {
    new_patient_exam: "New Patient Exam", cleaning: "Cleaning", emergency: "Emergency",
    consult: "Consultation", whitening: "Whitening", other: "Other",
  };
  const providerLabels: Record<string, string> = {
    dr_johnson: "Dr. Johnson", dr_smith: "Dr. Smith", dr_lee: "Dr. Lee", no_preference: "No Preference",
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden">
        {/* Header */}
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
              <UserPlus size={18} className="text-primary" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold" style={{ fontFamily: "Outfit, sans-serif" }}>
                New Patient Intake
              </DialogTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {prefill?.patientName
                  ? `Pre-filled from Rover call · ${prefill.patientName}`
                  : "Register a new patient and schedule their first visit"}
              </p>
            </div>
            {prefill?.callId && (
              <Badge variant="secondary" className="ml-auto text-xs gap-1">
                <Bot size={10} /> Rover
              </Badge>
            )}
          </div>

          {/* Step progress */}
          <div className="flex items-center gap-1 mt-4">
            {STEPS.map((s, i) => {
              const Icon = s.icon;
              const done = step > s.id;
              const active = step === s.id;
              return (
                <div key={s.id} className="flex items-center gap-1 flex-1">
                  <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all flex-1 justify-center ${
                    done
                      ? "bg-primary/10 text-primary"
                      : active
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}>
                    {done ? (
                      <CheckCircle2 size={12} />
                    ) : (
                      <Icon size={12} />
                    )}
                    <span className="hidden sm:inline">{s.label}</span>
                    <span className="sm:hidden">{s.id}</span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div className={`h-0.5 w-2 rounded-full flex-shrink-0 ${done ? "bg-primary/40" : "bg-border"}`} />
                  )}
                </div>
              );
            })}
          </div>
        </DialogHeader>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {step === 1 && <StepSource form={form} set={setField} prefill={prefill} />}
          {step === 2 && <StepDemographics form={form} set={setField} />}
          {step === 3 && <StepInsurance form={form} set={setField} />}
          {step === 4 && <StepMedical form={form} set={setField} setConditions={setConditions} />}
          {step === 5 && <StepAppointment form={form} set={setField} />}

          {/* Review panel on step 5 */}
          {step === 5 && form.firstName && (
            <div className="mt-5 p-4 rounded-xl border border-border bg-muted/20 space-y-1">
              <div className="flex items-center gap-2 mb-3">
                <ClipboardList size={14} className="text-primary" />
                <span className="text-sm font-semibold text-foreground">Summary</span>
              </div>
              <ReviewRow label="Patient" value={`${form.firstName} ${form.lastName}`} />
              <ReviewRow label="DOB" value={form.dob} />
              <ReviewRow label="Phone" value={form.phone} />
              <ReviewRow label="Insurance" value={
                form.hasInsurance === "yes" ? form.primaryInsurer || "Yes (insurer TBD)"
                : form.hasInsurance === "medicaid" ? "Medicaid"
                : form.hasInsurance === "self_pay" ? "Self-Pay"
                : form.hasInsurance === "no" ? "No insurance"
                : "—"
              } />
              <ReviewRow label="Service" value={serviceLabels[form.serviceType] || "—"} />
              <ReviewRow label="Provider" value={providerLabels[form.preferredProvider] || "—"} />
              <ReviewRow label="Date" value={form.preferredDate ? `${form.preferredDate} ${form.preferredTime}` : "—"} />
              {form.medicalConditions.length > 0 && (
                <ReviewRow label="Conditions" value={form.medicalConditions.join(", ")} />
              )}
              {form.allergies && <ReviewRow label="Allergies" value={form.allergies} />}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border flex items-center justify-between flex-shrink-0 bg-background">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => step > 1 ? setStep(step - 1) : handleClose()}
            className="gap-1.5"
          >
            <ChevronLeft size={14} />
            {step > 1 ? "Back" : "Cancel"}
          </Button>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Step {step} of {STEPS.length}</span>
            {step < STEPS.length ? (
              <Button
                size="sm"
                onClick={() => setStep(step + 1)}
                disabled={!canProceed()}
                className="gap-1.5"
              >
                Continue
                <ChevronRight size={14} />
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={submitting}
                className="gap-1.5 min-w-[140px]"
              >
                {submitting ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={14} />
                    Create Patient
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
