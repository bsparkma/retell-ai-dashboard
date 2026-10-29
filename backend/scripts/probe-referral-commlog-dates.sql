-- READ-ONLY. The referral history behind the chart notes on ONE fixture patient
-- (roland 12827), to match each note's CommDateTime to its own milestone event.
-- Companion to scripts/probe-referral-commlog-dates.js (PR #290).
--
-- One SELECT inside a READ ONLY transaction, which then rolls back.
-- Prints referral ids and event times, never patient identity.

BEGIN READ ONLY;

SELECT e.referral_id,
       e.verb,
       e.from_status,
       e.to_status,
       e.at,
       to_char(e.at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD HH24:MI:SS') AS at_central,
       e.chart_note_milestone,
       e.chart_note_commlog_num
FROM tc_referral_events e
WHERE e.office_id = 'roland'
  AND e.referral_id IN (
        SELECT r.referral_id
        FROM tc_referrals r
        WHERE r.office_id = 'roland' AND r.od_patient_id::text = '12827'
      )
  AND (e.verb IN ('send', 'mark_sent', 'patient_scheduled', 'chart_note_written') OR e.to_status = 'sent')
ORDER BY e.referral_id, e.at;

ROLLBACK;
