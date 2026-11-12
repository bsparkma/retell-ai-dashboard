/**
 * /tc/followups — every open case's next touch, and the daily queue.
 *
 * Thin page shell: office scope + header + two tabs. "Next touch" (the
 * default) is NextTouchView: one row per OPEN case, its earliest pending
 * follow-up, Overdue → Due today → Upcoming, with the pinned "No next step"
 * section for open cases that have none. "All due items" is the original
 * FollowupQueue: every pending item due by a horizon date, several per case
 * if a case has several. Behaviour lives in the feature components so tests
 * can drive them with props. On "All Offices" each is handed every office in
 * scope and fans out.
 */
import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TcOfficeGate, TcPageHeader } from "@/features/tc/components/TcShell";
import { officeScopeKey, useTcOfficeScope } from "@/features/tc/officeScope";
import { FollowupQueue } from "@/features/tc/followups/FollowupQueue";
import { NextTouchView } from "@/features/tc/followups/NextTouchView";

export default function TcFollowups() {
  const scope = useTcOfficeScope();
  const [tab, setTab] = useState<"next" | "due">("next");
  if (scope.offices.length === 0) {
    return (
      <div className="p-6">
        <TcOfficeGate loading={scope.loading} />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <TcPageHeader
        title="Follow-ups"
        subtitle={
          scope.showOfficeBadges
            ? "Every open case's next touch across every office: work top to bottom, and leave none without a next step"
            : "Every open case's next touch: work top to bottom, and leave none without a next step"
        }
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as "next" | "due")}>
        <TabsList className="mb-4">
          <TabsTrigger value="next">Next touch</TabsTrigger>
          <TabsTrigger value="due">All due items</TabsTrigger>
        </TabsList>
        <TabsContent value="next">
          <NextTouchView key={officeScopeKey(scope.offices)} office={scope.offices} />
        </TabsContent>
        <TabsContent value="due">
          <FollowupQueue key={officeScopeKey(scope.offices)} office={scope.offices} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
