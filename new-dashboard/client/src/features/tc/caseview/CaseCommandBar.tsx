/**
 * Case command bar — patient identity + money snapshot + status/urgency at the
 * top of the case view. Display only: the single mutation affordance here is
 * the "Change status" button, which opens the StatusTransitionDialog owned by
 * the page.
 */
import { Link } from "wouter";
import type { TcCase } from "@shared/tc/contract";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Gauge, Mail, Phone, Presentation, RefreshCcw, UserRound } from "lucide-react";
import { formatCents } from "../money";
import { CaseStatusBadge, UrgencyBadge } from "../components/TcShell";

export interface CaseCommandBarProps {
  tcCase: TcCase;
  onChangeStatus: () => void;
}

export function CaseCommandBar({ tcCase, onChangeStatus }: CaseCommandBarProps) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1
                className="text-xl font-bold text-foreground truncate"
                style={{ fontFamily: "Outfit, sans-serif" }}
              >
                {tcCase.patientName}
              </h1>
              {tcCase.patientAge !== null && (
                <span className="text-sm text-muted-foreground">Age {tcCase.patientAge}</span>
              )}
              <CaseStatusBadge status={tcCase.status} />
              <UrgencyBadge urgency={tcCase.urgency} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {tcCase.phone && (
                <span className="inline-flex items-center gap-1">
                  <Phone size={14} /> {tcCase.phone}
                </span>
              )}
              {tcCase.email && (
                <span className="inline-flex items-center gap-1">
                  <Mail size={14} /> {tcCase.email}
                </span>
              )}
              {tcCase.assignedTc && (
                <span className="inline-flex items-center gap-1">
                  <UserRound size={14} /> TC: {tcCase.assignedTc}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <Gauge size={14} /> Readiness {tcCase.readinessScore}/100
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="text-right">
              <div className="text-xs text-muted-foreground">Case value</div>
              <div
                className="text-xl font-bold text-foreground"
                style={{ fontFamily: "Outfit, sans-serif" }}
              >
                {formatCents(tcCase.caseValueCents)}
              </div>
            </div>
            <Button variant="outline" onClick={onChangeStatus}>
              <RefreshCcw size={14} />
              Change status
            </Button>
            <Button asChild>
              <Link href={`/tc/present/${tcCase.caseId}`}>
                <Presentation size={14} />
                Present
              </Link>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
