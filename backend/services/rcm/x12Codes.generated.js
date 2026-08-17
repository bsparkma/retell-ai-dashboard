'use strict';

/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * The published X12 Claim Adjustment Reason Codes and Remittance Advice Remark
 * Codes, ingested verbatim. Regenerate with:
 *
 *     node backend/scripts/fetch-x12-codes.mjs
 *
 * A hand edit fails `adjustmentCodes.test.js`, which pins the entry counts and
 * the content hash below. That is deliberate: Slice 6a shipped a hand-written
 * table whose entries for CARC 22, 50, 51, 54, 151, 234 and B15 carried the
 * WRONG meaning — including telling a biller that a coordination-of-benefits
 * adjustment had "already been paid". This data is machine-ingested so that
 * class of error cannot recur.
 *
 * Deactivated codes are retained with their status: an old denial being worked
 * today legitimately carries a code that has since been retired.
 *
 * Source:    https://x12.org/codes/claim-adjustment-reason-codes
 *            https://x12.org/codes/remittance-advice-remark-codes
 * Retrieved: 2026-08-17
 * Codes:     407 CARC · 1216 RARC
 * SHA-256:   de05e9d88c5cc0dc236033064e2f6adfa6ac5b4fabdb069333d4ad8c988e26ec
 */

/** @typedef {{ text: string, status: 'current'|'tobe'|'deactivated' }} X12Code */

const SOURCE = Object.freeze({
  carcUrl: "https://x12.org/codes/claim-adjustment-reason-codes",
  rarcUrl: "https://x12.org/codes/remittance-advice-remark-codes",
  retrievedAt: "2026-08-17",
  sha256: "de05e9d88c5cc0dc236033064e2f6adfa6ac5b4fabdb069333d4ad8c988e26ec",
});

/** @type {Readonly<Record<string, X12Code>>} */
const CARC = Object.freeze({
  "1": {
    "text": "Deductible Amount",
    "status": "current"
  },
  "2": {
    "text": "Coinsurance Amount",
    "status": "current"
  },
  "3": {
    "text": "Co-payment Amount",
    "status": "current"
  },
  "4": {
    "text": "The procedure code is inconsistent with the modifier used. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "5": {
    "text": "The procedure code/type of bill is inconsistent with the place of service. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "6": {
    "text": "The procedure/revenue code is inconsistent with the patient's age. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "7": {
    "text": "The procedure/revenue code is inconsistent with the patient's gender. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "8": {
    "text": "The procedure code is inconsistent with the provider type/specialty (taxonomy). Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "9": {
    "text": "The diagnosis is inconsistent with the patient's age. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "10": {
    "text": "The diagnosis is inconsistent with the patient's gender. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "11": {
    "text": "The diagnosis is inconsistent with the procedure. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "12": {
    "text": "The diagnosis is inconsistent with the provider type. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "13": {
    "text": "The date of death precedes the date of service.",
    "status": "current"
  },
  "14": {
    "text": "The date of birth follows the date of service.",
    "status": "current"
  },
  "15": {
    "text": "The authorization number is missing, invalid, or does not apply to the billed services or provider.",
    "status": "deactivated"
  },
  "16": {
    "text": "Claim/service lacks information or has submission/billing error(s). Usage: Do not use this code for claims attachment(s)/other documentation. At least one Remark Code must be provided (may be comprised of either the NCPDP Reject Reason Code, or Remittance Advice Remark Code that is not an ALERT.) Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "17": {
    "text": "Requested information was not provided or was insufficient/incomplete. At least one Remark Code must be provided (may be comprised of either the Remittance Advice Remark Code or NCPDP Reject Reason Code.)",
    "status": "deactivated"
  },
  "18": {
    "text": "Exact duplicate claim/service (Use only with Group Code OA except where state workers' compensation regulations requires CO)",
    "status": "current"
  },
  "19": {
    "text": "This is a work-related injury/illness and thus the liability of the Worker's Compensation Carrier.",
    "status": "current"
  },
  "20": {
    "text": "This injury/illness is covered by the liability carrier.",
    "status": "current"
  },
  "21": {
    "text": "This injury/illness is the liability of the no-fault carrier.",
    "status": "current"
  },
  "22": {
    "text": "This care may be covered by another payer per coordination of benefits.",
    "status": "current"
  },
  "23": {
    "text": "The impact of prior payer(s) adjudication including payments and/or adjustments. (Use only with Group Code OA)",
    "status": "current"
  },
  "24": {
    "text": "Charges are covered under a capitation agreement/managed care plan.",
    "status": "current"
  },
  "25": {
    "text": "Payment denied. Your Stop loss deductible has not been met.",
    "status": "deactivated"
  },
  "26": {
    "text": "Expenses incurred prior to coverage.",
    "status": "current"
  },
  "27": {
    "text": "Expenses incurred after coverage terminated.",
    "status": "current"
  },
  "28": {
    "text": "Coverage not in effect at the time the service was provided.",
    "status": "deactivated"
  },
  "29": {
    "text": "The time limit for filing has expired.",
    "status": "current"
  },
  "30": {
    "text": "Payment adjusted because the patient has not met the required eligibility, spend down, waiting, or residency requirements.",
    "status": "deactivated"
  },
  "31": {
    "text": "Patient cannot be identified as our insured.",
    "status": "current"
  },
  "32": {
    "text": "Our records indicate the patient is not an eligible dependent.",
    "status": "current"
  },
  "33": {
    "text": "Insured has no dependent coverage.",
    "status": "current"
  },
  "34": {
    "text": "Insured has no coverage for newborns.",
    "status": "current"
  },
  "35": {
    "text": "Lifetime benefit maximum has been reached.",
    "status": "current"
  },
  "36": {
    "text": "Balance does not exceed co-payment amount.",
    "status": "deactivated"
  },
  "37": {
    "text": "Balance does not exceed deductible.",
    "status": "deactivated"
  },
  "38": {
    "text": "Services not provided or authorized by designated (network/primary care) providers.",
    "status": "deactivated"
  },
  "39": {
    "text": "Services denied at the time authorization/pre-certification was requested.",
    "status": "current"
  },
  "40": {
    "text": "Charges do not meet qualifications for emergent/urgent care. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "41": {
    "text": "Discount agreed to in Preferred Provider contract.",
    "status": "deactivated"
  },
  "42": {
    "text": "Charges exceed our fee schedule or maximum allowable amount. (Use CARC 45)",
    "status": "deactivated"
  },
  "43": {
    "text": "Gramm-Rudman reduction.",
    "status": "deactivated"
  },
  "44": {
    "text": "Prompt-pay discount.",
    "status": "current"
  },
  "45": {
    "text": "Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement. Usage: This adjustment amount cannot equal the total service or claim charge amount; and must not duplicate provider adjustment amounts (payments and contractual reductions) that have resulted from prior payer(s) adjudication. (Use only with Group Codes PR or CO depending upon liability)",
    "status": "current"
  },
  "46": {
    "text": "This (these) service(s) is (are) not covered.",
    "status": "deactivated"
  },
  "47": {
    "text": "This (these) diagnosis(es) is (are) not covered, missing, or are invalid.",
    "status": "deactivated"
  },
  "48": {
    "text": "This (these) procedure(s) is (are) not covered.",
    "status": "deactivated"
  },
  "49": {
    "text": "This is a non-covered service because it is a routine/preventive exam or a diagnostic/screening procedure done in conjunction with a routine/preventive exam. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "50": {
    "text": "These are non-covered services because this is not deemed a 'medical necessity' by the payer. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "51": {
    "text": "These are non-covered services because this is a pre-existing condition. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "52": {
    "text": "The referring/prescribing/rendering provider is not eligible to refer/prescribe/order/perform the service billed.",
    "status": "deactivated"
  },
  "53": {
    "text": "Services by an immediate relative or a member of the same household are not covered.",
    "status": "current"
  },
  "54": {
    "text": "Multiple physicians/assistants are not covered in this case. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "55": {
    "text": "Procedure/treatment/drug is deemed experimental/investigational by the payer. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "56": {
    "text": "Procedure/treatment has not been deemed 'proven to be effective' by the payer. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "57": {
    "text": "Payment denied/reduced because the payer deems the information submitted does not support this level of service, this many services, this length of service, this dosage, or this day's supply.",
    "status": "deactivated"
  },
  "58": {
    "text": "Treatment was deemed by the payer to have been rendered in an inappropriate or invalid place of service. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "59": {
    "text": "Processed based on multiple or concurrent procedure rules. (For example multiple surgery or diagnostic imaging, concurrent anesthesia.) Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "60": {
    "text": "Charges for outpatient services are not covered when performed within a period of time prior to or after inpatient services.",
    "status": "current"
  },
  "61": {
    "text": "Adjusted for failure to obtain second surgical opinion",
    "status": "current"
  },
  "62": {
    "text": "Payment denied/reduced for absence of, or exceeded, pre-certification/authorization.",
    "status": "deactivated"
  },
  "63": {
    "text": "Correction to a prior claim.",
    "status": "deactivated"
  },
  "64": {
    "text": "Denial reversed per Medical Review.",
    "status": "deactivated"
  },
  "65": {
    "text": "Procedure code was incorrect. This payment reflects the correct code.",
    "status": "deactivated"
  },
  "66": {
    "text": "Blood Deductible.",
    "status": "current"
  },
  "67": {
    "text": "Lifetime reserve days. (Handled in QTY, QTY01=LA)",
    "status": "deactivated"
  },
  "68": {
    "text": "DRG weight. (Handled in CLP12)",
    "status": "deactivated"
  },
  "69": {
    "text": "Day outlier amount.",
    "status": "current"
  },
  "70": {
    "text": "Cost outlier - Adjustment to compensate for additional costs.",
    "status": "current"
  },
  "71": {
    "text": "Primary Payer amount.",
    "status": "deactivated"
  },
  "72": {
    "text": "Coinsurance day. (Handled in QTY, QTY01=CD)",
    "status": "deactivated"
  },
  "73": {
    "text": "Administrative days.",
    "status": "deactivated"
  },
  "74": {
    "text": "Indirect Medical Education Adjustment.",
    "status": "current"
  },
  "75": {
    "text": "Direct Medical Education Adjustment.",
    "status": "current"
  },
  "76": {
    "text": "Disproportionate Share Adjustment.",
    "status": "current"
  },
  "77": {
    "text": "Covered days. (Handled in QTY, QTY01=CA)",
    "status": "deactivated"
  },
  "78": {
    "text": "Non-Covered days/Room charge adjustment.",
    "status": "current"
  },
  "79": {
    "text": "Cost Report days. (Handled in MIA15)",
    "status": "deactivated"
  },
  "80": {
    "text": "Outlier days. (Handled in QTY, QTY01=OU)",
    "status": "deactivated"
  },
  "81": {
    "text": "Discharges.",
    "status": "deactivated"
  },
  "82": {
    "text": "PIP days.",
    "status": "deactivated"
  },
  "83": {
    "text": "Total visits.",
    "status": "deactivated"
  },
  "84": {
    "text": "Capital Adjustment. (Handled in MIA)",
    "status": "deactivated"
  },
  "85": {
    "text": "Patient Interest Adjustment (Use Only Group code PR)",
    "status": "current"
  },
  "86": {
    "text": "Statutory Adjustment.",
    "status": "deactivated"
  },
  "87": {
    "text": "Transfer amount.",
    "status": "deactivated"
  },
  "88": {
    "text": "Adjustment amount represents collection against receivable created in prior overpayment.",
    "status": "deactivated"
  },
  "89": {
    "text": "Professional fees removed from charges.",
    "status": "current"
  },
  "90": {
    "text": "Ingredient cost adjustment. Usage: To be used for pharmaceuticals only.",
    "status": "current"
  },
  "91": {
    "text": "Dispensing fee adjustment.",
    "status": "current"
  },
  "92": {
    "text": "Claim Paid in full.",
    "status": "deactivated"
  },
  "93": {
    "text": "No Claim level Adjustments.",
    "status": "deactivated"
  },
  "94": {
    "text": "Processed in Excess of charges.",
    "status": "current"
  },
  "95": {
    "text": "Plan procedures not followed.",
    "status": "current"
  },
  "96": {
    "text": "Non-covered charge(s). At least one Remark Code must be provided (may be comprised of either the NCPDP Reject Reason Code, or Remittance Advice Remark Code that is not an ALERT.) Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "97": {
    "text": "The benefit for this service is included in the payment/allowance for another service/procedure that has already been adjudicated. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "98": {
    "text": "The hospital must file the Medicare claim for this inpatient non-physician service.",
    "status": "deactivated"
  },
  "99": {
    "text": "Medicare Secondary Payer Adjustment Amount.",
    "status": "deactivated"
  },
  "100": {
    "text": "Payment made to patient/insured/responsible party.",
    "status": "current"
  },
  "101": {
    "text": "Predetermination: anticipated payment upon completion of services or claim adjudication.",
    "status": "current"
  },
  "102": {
    "text": "Major Medical Adjustment.",
    "status": "current"
  },
  "103": {
    "text": "Provider promotional discount (e.g., Senior citizen discount).",
    "status": "current"
  },
  "104": {
    "text": "Managed care withholding.",
    "status": "current"
  },
  "105": {
    "text": "Tax withholding.",
    "status": "current"
  },
  "106": {
    "text": "Patient payment option/election not in effect.",
    "status": "current"
  },
  "107": {
    "text": "The related or qualifying claim/service was not identified on this claim. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "108": {
    "text": "Rent/purchase guidelines were not met. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "109": {
    "text": "Claim/service not covered by this payer/contractor. You must send the claim/service to the correct payer/contractor.",
    "status": "current"
  },
  "110": {
    "text": "Billing date predates service date.",
    "status": "current"
  },
  "111": {
    "text": "Not covered unless the provider accepts assignment.",
    "status": "current"
  },
  "112": {
    "text": "Service not furnished directly to the patient and/or not documented.",
    "status": "current"
  },
  "113": {
    "text": "Payment denied because service/procedure was provided outside the United States or as a result of war.",
    "status": "deactivated"
  },
  "114": {
    "text": "Procedure/product not approved by the Food and Drug Administration.",
    "status": "current"
  },
  "115": {
    "text": "Procedure postponed, canceled, or delayed.",
    "status": "current"
  },
  "116": {
    "text": "The advance indemnification notice signed by the patient did not comply with requirements.",
    "status": "current"
  },
  "117": {
    "text": "Transportation is only covered to the closest facility that can provide the necessary care.",
    "status": "current"
  },
  "118": {
    "text": "ESRD network support adjustment.",
    "status": "current"
  },
  "119": {
    "text": "Benefit maximum for this time period or occurrence has been reached.",
    "status": "current"
  },
  "120": {
    "text": "Patient is covered by a managed care plan.",
    "status": "deactivated"
  },
  "121": {
    "text": "Indemnification adjustment - compensation for outstanding member responsibility.",
    "status": "current"
  },
  "122": {
    "text": "Psychiatric reduction.",
    "status": "current"
  },
  "123": {
    "text": "Payer refund due to overpayment.",
    "status": "deactivated"
  },
  "124": {
    "text": "Payer refund amount - not our patient.",
    "status": "deactivated"
  },
  "125": {
    "text": "Submission/billing error(s). At least one Remark Code must be provided (may be comprised of either the NCPDP Reject Reason Code, or Remittance Advice Remark Code that is not an ALERT.)",
    "status": "deactivated"
  },
  "126": {
    "text": "Deductible -- Major Medical",
    "status": "deactivated"
  },
  "127": {
    "text": "Coinsurance -- Major Medical",
    "status": "deactivated"
  },
  "128": {
    "text": "Newborn's services are covered in the mother's Allowance.",
    "status": "current"
  },
  "129": {
    "text": "Prior processing information appears incorrect. At least one Remark Code must be provided (may be comprised of either the NCPDP Reject Reason Code, or Remittance Advice Remark Code that is not an ALERT.)",
    "status": "current"
  },
  "130": {
    "text": "Claim submission fee.",
    "status": "current"
  },
  "131": {
    "text": "Claim specific negotiated discount.",
    "status": "current"
  },
  "132": {
    "text": "Prearranged demonstration project adjustment.",
    "status": "current"
  },
  "133": {
    "text": "The disposition of this service line is pending further review. (Use only with Group Code OA). Usage: Use of this code requires a reversal and correction when the service line is finalized (use only in Loop 2110 CAS segment of the 835 or Loop 2430 of the 837).",
    "status": "current"
  },
  "134": {
    "text": "Technical fees removed from charges.",
    "status": "current"
  },
  "135": {
    "text": "Interim bills cannot be processed.",
    "status": "current"
  },
  "136": {
    "text": "Failure to follow prior payer's coverage rules. (Use only with Group Code OA)",
    "status": "current"
  },
  "137": {
    "text": "Regulatory Surcharges, Assessments, Allowances or Health Related Taxes.",
    "status": "current"
  },
  "138": {
    "text": "Appeal procedures not followed or time limits not met.",
    "status": "deactivated"
  },
  "139": {
    "text": "Contracted funding agreement - Subscriber is employed by the provider of services. Use only with Group Code CO.",
    "status": "current"
  },
  "140": {
    "text": "Patient/Insured health identification number and name do not match.",
    "status": "current"
  },
  "141": {
    "text": "Claim spans eligible and ineligible periods of coverage.",
    "status": "deactivated"
  },
  "142": {
    "text": "Monthly Medicaid patient liability amount.",
    "status": "current"
  },
  "143": {
    "text": "Portion of payment deferred.",
    "status": "current"
  },
  "144": {
    "text": "Incentive adjustment, e.g. preferred product/service.",
    "status": "current"
  },
  "145": {
    "text": "Premium payment withholding",
    "status": "deactivated"
  },
  "146": {
    "text": "Diagnosis was invalid for the date(s) of service reported.",
    "status": "current"
  },
  "147": {
    "text": "Provider contracted/negotiated rate expired or not on file.",
    "status": "current"
  },
  "148": {
    "text": "Information from another provider was not provided or was insufficient/incomplete. At least one Remark Code must be provided (may be comprised of either the NCPDP Reject Reason Code, or Remittance Advice Remark Code that is not an ALERT.)",
    "status": "current"
  },
  "149": {
    "text": "Lifetime benefit maximum has been reached for this service/benefit category.",
    "status": "current"
  },
  "150": {
    "text": "Payer deems the information submitted does not support this level of service.",
    "status": "current"
  },
  "151": {
    "text": "Payment adjusted because the payer deems the information submitted does not support this many/frequency of services.",
    "status": "current"
  },
  "152": {
    "text": "Payer deems the information submitted does not support this length of service. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "153": {
    "text": "Payer deems the information submitted does not support this dosage.",
    "status": "current"
  },
  "154": {
    "text": "Payer deems the information submitted does not support this day's supply.",
    "status": "current"
  },
  "155": {
    "text": "Patient refused the service/procedure.",
    "status": "current"
  },
  "156": {
    "text": "Flexible spending account payments. Note: Use code 187.",
    "status": "deactivated"
  },
  "157": {
    "text": "Service/procedure was provided as a result of an act of war.",
    "status": "current"
  },
  "158": {
    "text": "Service/procedure was provided outside of the United States.",
    "status": "current"
  },
  "159": {
    "text": "Service/procedure was provided as a result of terrorism.",
    "status": "current"
  },
  "160": {
    "text": "Injury/illness was the result of an activity that is a benefit exclusion.",
    "status": "current"
  },
  "161": {
    "text": "Provider performance bonus",
    "status": "current"
  },
  "162": {
    "text": "State-mandated Requirement for Property and Casualty, see Claim Payment Remarks Code for specific explanation.",
    "status": "deactivated"
  },
  "163": {
    "text": "Attachment/other documentation referenced on the claim was not received.",
    "status": "current"
  },
  "164": {
    "text": "Attachment/other documentation referenced on the claim was not received in a timely fashion.",
    "status": "current"
  },
  "165": {
    "text": "Referral absent or exceeded.",
    "status": "deactivated"
  },
  "166": {
    "text": "These services were submitted after this payers responsibility for processing claims under this plan ended.",
    "status": "current"
  },
  "167": {
    "text": "This (these) diagnosis(es) is (are) not covered. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "168": {
    "text": "Service(s) have been considered under the patient's medical plan. Benefits are not available under this dental plan.",
    "status": "deactivated"
  },
  "169": {
    "text": "Alternate benefit has been provided.",
    "status": "current"
  },
  "170": {
    "text": "Payment is denied when performed/billed by this type of provider. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "171": {
    "text": "Payment is denied when performed/billed by this type of provider in this type of facility. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "172": {
    "text": "Payment is adjusted when performed/billed by a provider of this specialty. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "173": {
    "text": "Service/equipment was not prescribed by a physician.",
    "status": "current"
  },
  "174": {
    "text": "Service was not prescribed prior to delivery.",
    "status": "current"
  },
  "175": {
    "text": "Prescription is incomplete.",
    "status": "current"
  },
  "176": {
    "text": "Prescription is not current.",
    "status": "current"
  },
  "177": {
    "text": "Patient has not met the required eligibility requirements.",
    "status": "current"
  },
  "178": {
    "text": "Patient has not met the required spend down requirements.",
    "status": "current"
  },
  "179": {
    "text": "Patient has not met the required waiting requirements. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "180": {
    "text": "Patient has not met the required residency requirements.",
    "status": "current"
  },
  "181": {
    "text": "Procedure code was invalid on the date of service.",
    "status": "current"
  },
  "182": {
    "text": "Procedure modifier was invalid on the date of service.",
    "status": "current"
  },
  "183": {
    "text": "The referring provider is not eligible to refer the service billed. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "184": {
    "text": "The prescribing/ordering provider is not eligible to prescribe/order the service billed. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "185": {
    "text": "The rendering provider is not eligible to perform the service billed. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "186": {
    "text": "Level of care change adjustment.",
    "status": "current"
  },
  "187": {
    "text": "Consumer Spending Account payments (includes but is not limited to Flexible Spending Account, Health Savings Account, Health Reimbursement Account, etc.)",
    "status": "current"
  },
  "188": {
    "text": "This product/procedure is only covered when used according to FDA recommendations.",
    "status": "current"
  },
  "189": {
    "text": "'Not otherwise classified' or 'unlisted' procedure code (CPT/HCPCS) was billed when there is a specific procedure code for this procedure/service",
    "status": "current"
  },
  "190": {
    "text": "Payment is included in the allowance for a Skilled Nursing Facility (SNF) qualified stay.",
    "status": "current"
  },
  "191": {
    "text": "Not a work related injury/illness and thus not the liability of the workers' compensation carrier Note: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Insurance Policy Number Segment (Loop 2100 Other Claim Related Information REF qualifier 'IG') for the jurisdictional regulation. If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF)",
    "status": "deactivated"
  },
  "192": {
    "text": "Non standard adjustment code from paper remittance. Usage: This code is to be used by providers/payers providing Coordination of Benefits information to another payer in the 837 transaction only. This code is only used when the non-standard code cannot be reasonably mapped to an existing Claims Adjustment Reason Code, specifically Deductible, Coinsurance and Co-payment.",
    "status": "current"
  },
  "193": {
    "text": "Original payment decision is being maintained. Upon review, it was determined that this claim was processed properly.",
    "status": "current"
  },
  "194": {
    "text": "Anesthesia performed by the operating physician, the assistant surgeon or the attending physician.",
    "status": "current"
  },
  "195": {
    "text": "Refund issued to an erroneous priority payer for this claim/service.",
    "status": "current"
  },
  "196": {
    "text": "Claim/service denied based on prior payer's coverage determination.",
    "status": "deactivated"
  },
  "197": {
    "text": "Precertification/authorization/notification/pre-treatment absent.",
    "status": "current"
  },
  "198": {
    "text": "Precertification/notification/authorization/pre-treatment exceeded.",
    "status": "current"
  },
  "199": {
    "text": "Revenue code and Procedure code do not match.",
    "status": "current"
  },
  "200": {
    "text": "Expenses incurred during lapse in coverage",
    "status": "current"
  },
  "201": {
    "text": "Patient is responsible for amount of this claim/service through 'set aside arrangement' or other agreement. (Use only with Group Code PR) At least one Remark Code must be provided (may be comprised of either the NCPDP Reject Reason Code, or Remittance Advice Remark Code that is not an ALERT.)",
    "status": "current"
  },
  "202": {
    "text": "Non-covered personal comfort or convenience services.",
    "status": "current"
  },
  "203": {
    "text": "Discontinued or reduced service.",
    "status": "current"
  },
  "204": {
    "text": "This service/equipment/drug is not covered under the patient's current benefit plan",
    "status": "current"
  },
  "205": {
    "text": "Pharmacy discount card processing fee",
    "status": "current"
  },
  "206": {
    "text": "National Provider Identifier - missing.",
    "status": "current"
  },
  "207": {
    "text": "National Provider identifier - Invalid format",
    "status": "current"
  },
  "208": {
    "text": "National Provider Identifier - Not matched.",
    "status": "current"
  },
  "209": {
    "text": "Per regulatory or other agreement. The provider cannot collect this amount from the patient. However, this amount may be billed to subsequent payer. Refund to patient if collected. (Use only with Group code OA)",
    "status": "current"
  },
  "210": {
    "text": "Payment adjusted because pre-certification/authorization not received in a timely fashion",
    "status": "current"
  },
  "211": {
    "text": "National Drug Codes (NDC) not eligible for rebate, are not covered.",
    "status": "current"
  },
  "212": {
    "text": "Administrative surcharges are not covered",
    "status": "current"
  },
  "213": {
    "text": "Non-compliance with the physician self referral prohibition legislation or payer policy.",
    "status": "current"
  },
  "214": {
    "text": "Workers' Compensation claim adjudicated as non-compensable. This Payer not liable for claim or service/treatment. Note: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Insurance Policy Number Segment (Loop 2100 Other Claim Related Information REF qualifier 'IG') for the jurisdictional regulation. If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF). To be used for Workers' Compensation only",
    "status": "deactivated"
  },
  "215": {
    "text": "Based on subrogation of a third party settlement",
    "status": "current"
  },
  "216": {
    "text": "Based on the findings of a review organization or the payer's findings.",
    "status": "current"
  },
  "217": {
    "text": "Based on payer reasonable and customary fees. No maximum allowable defined by legislated fee arrangement. (Note: To be used for Property and Casualty only)",
    "status": "deactivated"
  },
  "218": {
    "text": "Based on entitlement to benefits. Note: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Insurance Policy Number Segment (Loop 2100 Other Claim Related Information REF qualifier 'IG') for the jurisdictional regulation. If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF). To be used for Workers' Compensation only",
    "status": "deactivated"
  },
  "219": {
    "text": "Based on extent of injury. Usage: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Insurance Policy Number Segment (Loop 2100 Other Claim Related Information REF qualifier 'IG') for the jurisdictional regulation. If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF).",
    "status": "current"
  },
  "220": {
    "text": "The applicable fee schedule/fee database does not contain the billed code. Please resubmit a bill with the appropriate fee schedule/fee database code(s) that best describe the service(s) provided and supporting documentation if required. (Note: To be used for Property and Casualty only)",
    "status": "deactivated"
  },
  "221": {
    "text": "Claim is under investigation. Note: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Insurance Policy Number Segment (Loop 2100 Other Claim Related Information REF qualifier 'IG') for the jurisdictional regulation. If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF). (Note: To be used by Property & Casualty only)",
    "status": "deactivated"
  },
  "222": {
    "text": "Exceeds the contracted maximum number of hours/days/units by this provider for this period. This is not patient specific. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "223": {
    "text": "Adjustment code for mandated federal, state or local law/regulation that is not already covered by another code and is mandated before a new code can be created.",
    "status": "current"
  },
  "224": {
    "text": "Patient identification compromised by identity theft. Identity verification required for processing this and future claims.",
    "status": "current"
  },
  "225": {
    "text": "Penalty or Interest Payment by Payer (Only used for plan to plan encounter reporting within the 837)",
    "status": "current"
  },
  "226": {
    "text": "Information requested from the Billing/Rendering Provider was not provided or not provided timely or was insufficient/incomplete. At least one Remark Code must be provided (may be comprised of either the NCPDP Reject Reason Code, or Remittance Advice Remark Code that is not an ALERT.)",
    "status": "current"
  },
  "227": {
    "text": "Information requested from the patient/insured/responsible party was not provided or was insufficient/incomplete. At least one Remark Code must be provided (may be comprised of either the NCPDP Reject Reason Code, or Remittance Advice Remark Code that is not an ALERT.)",
    "status": "current"
  },
  "228": {
    "text": "Denied for failure of this provider, another provider or the subscriber to supply requested information to a previous payer for their adjudication",
    "status": "current"
  },
  "229": {
    "text": "Partial charge amount not considered by Medicare due to the initial claim Type of Bill being 12X. Usage: This code can only be used in the 837 transaction to convey Coordination of Benefits information when the secondary payer's cost avoidance policy allows providers to bypass claim submission to a prior payer. (Use only with Group Code PR)",
    "status": "current"
  },
  "230": {
    "text": "No available or correlating CPT/HCPCS code to describe this service. Note: Used only by Property and Casualty.",
    "status": "deactivated"
  },
  "231": {
    "text": "Mutually exclusive procedures cannot be done in the same day/setting. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "232": {
    "text": "Institutional Transfer Amount. Usage: Applies to institutional claims only and explains the DRG amount difference when the patient care crosses multiple institutions.",
    "status": "current"
  },
  "233": {
    "text": "Services/charges related to the treatment of a hospital-acquired condition or preventable medical error.",
    "status": "current"
  },
  "234": {
    "text": "This procedure is not paid separately. At least one Remark Code must be provided (may be comprised of either the NCPDP Reject Reason Code, or Remittance Advice Remark Code that is not an ALERT.)",
    "status": "current"
  },
  "235": {
    "text": "Sales Tax",
    "status": "current"
  },
  "236": {
    "text": "This procedure or procedure/modifier combination is not compatible with another procedure or procedure/modifier combination provided on the same day according to the National Correct Coding Initiative or workers compensation state regulations/ fee schedule requirements.",
    "status": "current"
  },
  "237": {
    "text": "Legislated/Regulatory Penalty. At least one Remark Code must be provided (may be comprised of either the NCPDP Reject Reason Code, or Remittance Advice Remark Code that is not an ALERT.)",
    "status": "current"
  },
  "238": {
    "text": "Claim spans eligible and ineligible periods of coverage, this is the reduction for the ineligible period. (Use only with Group Code PR)",
    "status": "current"
  },
  "239": {
    "text": "Claim spans eligible and ineligible periods of coverage. Rebill separate claims.",
    "status": "current"
  },
  "240": {
    "text": "The diagnosis is inconsistent with the patient's birth weight. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "241": {
    "text": "Low Income Subsidy (LIS) Co-payment Amount",
    "status": "current"
  },
  "242": {
    "text": "Services not provided by network/primary care providers.",
    "status": "current"
  },
  "243": {
    "text": "Services not authorized by network/primary care providers.",
    "status": "current"
  },
  "244": {
    "text": "Payment reduced to zero due to litigation. Additional information will be sent following the conclusion of litigation. To be used for Property & Casualty only.",
    "status": "deactivated"
  },
  "245": {
    "text": "Provider performance program withhold.",
    "status": "current"
  },
  "246": {
    "text": "This non-payable code is for required reporting only.",
    "status": "current"
  },
  "247": {
    "text": "Deductible for Professional service rendered in an Institutional setting and billed on an Institutional claim.",
    "status": "current"
  },
  "248": {
    "text": "Coinsurance for Professional service rendered in an Institutional setting and billed on an Institutional claim.",
    "status": "current"
  },
  "249": {
    "text": "This claim has been identified as a readmission. (Use only with Group Code CO)",
    "status": "current"
  },
  "250": {
    "text": "The attachment/other documentation that was received was the incorrect attachment/document. The expected attachment/document is still missing. At least one Remark Code must be provided (may be comprised of either the NCPDP Reject Reason Code, or Remittance Advice Remark Code that is not an ALERT).",
    "status": "current"
  },
  "251": {
    "text": "The attachment/other documentation that was received was incomplete or deficient. The necessary information is still needed to process the claim. At least one Remark Code must be provided (may be comprised of either the NCPDP Reject Reason Code, or Remittance Advice Remark Code that is not an ALERT).",
    "status": "current"
  },
  "252": {
    "text": "An attachment/other documentation is required to adjudicate this claim/service. At least one Remark Code must be provided (may be comprised of either the NCPDP Reject Reason Code, or Remittance Advice Remark Code that is not an ALERT).",
    "status": "current"
  },
  "253": {
    "text": "Sequestration - reduction in federal payment",
    "status": "current"
  },
  "254": {
    "text": "Claim received by the dental plan, but benefits not available under this plan. Submit these services to the patient's medical plan for further consideration.",
    "status": "current"
  },
  "255": {
    "text": "The disposition of the related Property & Casualty claim (injury or illness) is pending due to litigation. (Use only with Group Code OA)",
    "status": "deactivated"
  },
  "256": {
    "text": "Service not payable per managed care contract.",
    "status": "current"
  },
  "257": {
    "text": "The disposition of the claim/service is undetermined during the premium payment grace period, per Health Insurance Exchange requirements. This claim/service will be reversed and corrected when the grace period ends (due to premium payment or lack of premium payment). (Use only with Group Code OA)",
    "status": "current"
  },
  "258": {
    "text": "Claim/service not covered when patient is in custody/incarcerated. Applicable federal, state or local authority may cover the claim/service.",
    "status": "current"
  },
  "259": {
    "text": "Additional payment for Dental/Vision service utilization.",
    "status": "current"
  },
  "260": {
    "text": "Processed under Medicaid ACA Enhanced Fee Schedule",
    "status": "current"
  },
  "261": {
    "text": "The procedure or service is inconsistent with the patient's history.",
    "status": "current"
  },
  "262": {
    "text": "Adjustment for delivery cost. Usage: To be used for pharmaceuticals only.",
    "status": "current"
  },
  "263": {
    "text": "Adjustment for shipping cost. Usage: To be used for pharmaceuticals only.",
    "status": "current"
  },
  "264": {
    "text": "Adjustment for postage cost. Usage: To be used for pharmaceuticals only.",
    "status": "current"
  },
  "265": {
    "text": "Adjustment for administrative cost. Usage: To be used for pharmaceuticals only.",
    "status": "current"
  },
  "266": {
    "text": "Adjustment for compound preparation cost. Usage: To be used for pharmaceuticals only.",
    "status": "current"
  },
  "267": {
    "text": "Claim/service spans multiple months. At least one Remark Code must be provided (may be comprised of either the NCPDP Reject Reason Code, or Remittance Advice Remark Code that is not an ALERT.)",
    "status": "current"
  },
  "268": {
    "text": "The Claim spans two calendar years. Please resubmit one claim per calendar year.",
    "status": "current"
  },
  "269": {
    "text": "Anesthesia not covered for this service/procedure. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "270": {
    "text": "Claim received by the medical plan, but benefits not available under this plan. Submit these services to the patient's dental plan for further consideration.",
    "status": "current"
  },
  "271": {
    "text": "Prior contractual reductions related to a current periodic payment as part of a contractual payment schedule when deferred amounts have been previously reported. (Use only with Group Code OA)",
    "status": "current"
  },
  "272": {
    "text": "Coverage/program guidelines were not met.",
    "status": "current"
  },
  "273": {
    "text": "Coverage/program guidelines were exceeded.",
    "status": "current"
  },
  "274": {
    "text": "Fee/Service not payable per patient Care Coordination arrangement.",
    "status": "current"
  },
  "275": {
    "text": "Prior payer's (or payers') patient responsibility (deductible, coinsurance, co-payment) not covered. (Use only with Group Code PR)",
    "status": "current"
  },
  "276": {
    "text": "Services denied by the prior payer(s) are not covered by this payer.",
    "status": "current"
  },
  "277": {
    "text": "The disposition of the claim/service is undetermined during the premium payment grace period, per Health Insurance SHOP Exchange requirements. This claim/service will be reversed and corrected when the grace period ends (due to premium payment or lack of premium payment). (Use only with Group Code OA)",
    "status": "current"
  },
  "278": {
    "text": "Performance program proficiency requirements not met. (Use only with Group Codes CO or PI) Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "279": {
    "text": "Services not provided by Preferred network providers. Usage: Use this code when there are member network limitations. For example, using contracted providers not in the member's 'narrow' network.",
    "status": "current"
  },
  "280": {
    "text": "Claim received by the medical plan, but benefits not available under this plan. Submit these services to the patient's Pharmacy plan for further consideration.",
    "status": "current"
  },
  "281": {
    "text": "Deductible waived per contractual agreement. Use only with Group Code CO.",
    "status": "current"
  },
  "282": {
    "text": "The procedure/revenue code is inconsistent with the type of bill. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "283": {
    "text": "Attending provider is not eligible to provide direction of care.",
    "status": "current"
  },
  "284": {
    "text": "Precertification/authorization/notification/pre-treatment number may be valid but does not apply to the billed services.",
    "status": "current"
  },
  "285": {
    "text": "Appeal procedures not followed",
    "status": "current"
  },
  "286": {
    "text": "Appeal time limits not met",
    "status": "current"
  },
  "287": {
    "text": "Referral exceeded",
    "status": "current"
  },
  "288": {
    "text": "Referral absent",
    "status": "current"
  },
  "289": {
    "text": "Services considered under the dental and medical plans, benefits not available.",
    "status": "current"
  },
  "290": {
    "text": "Claim received by the dental plan, but benefits not available under this plan. Claim has been forwarded to the patient's medical plan for further consideration.",
    "status": "current"
  },
  "291": {
    "text": "Claim received by the medical plan, but benefits not available under this plan. Claim has been forwarded to the patient's dental plan for further consideration.",
    "status": "current"
  },
  "292": {
    "text": "Claim received by the medical plan, but benefits not available under this plan. Claim has been forwarded to the patient's pharmacy plan for further consideration.",
    "status": "current"
  },
  "293": {
    "text": "Payment made to employer.",
    "status": "current"
  },
  "294": {
    "text": "Payment made to attorney.",
    "status": "current"
  },
  "295": {
    "text": "Pharmacy Direct/Indirect Remuneration (DIR)",
    "status": "current"
  },
  "296": {
    "text": "Precertification/authorization/notification/pre-treatment number may be valid but does not apply to the provider.",
    "status": "current"
  },
  "297": {
    "text": "Claim received by the medical plan, but benefits not available under this plan. Submit these services to the patient's vision plan for further consideration.",
    "status": "current"
  },
  "298": {
    "text": "Claim received by the medical plan, but benefits not available under this plan. Claim has been forwarded to the patient's vision plan for further consideration.",
    "status": "current"
  },
  "299": {
    "text": "The billing provider is not eligible to receive payment for the service billed.",
    "status": "current"
  },
  "300": {
    "text": "Claim received by the Medical Plan, but benefits not available under this plan. Claim has been forwarded to the patient's Behavioral Health Plan for further consideration.",
    "status": "current"
  },
  "301": {
    "text": "Claim received by the Medical Plan, but benefits not available under this plan. Submit these services to the patient's Behavioral Health Plan for further consideration.",
    "status": "current"
  },
  "302": {
    "text": "Precertification/notification/authorization/pre-treatment time limit has expired.",
    "status": "current"
  },
  "303": {
    "text": "Prior payer's (or payers') patient responsibility (deductible, coinsurance, co-payment) not covered for Qualified Medicare and Medicaid Beneficiaries. (Use only with Group Code CO)",
    "status": "current"
  },
  "304": {
    "text": "Claim received by the medical plan, but benefits not available under this plan. Submit these services to the patient's hearing plan for further consideration.",
    "status": "current"
  },
  "305": {
    "text": "Claim received by the medical plan, but benefits not available under this plan. Claim has been forwarded to the patient's hearing plan for further consideration.",
    "status": "current"
  },
  "306": {
    "text": "Type of bill is inconsistent with the patient status. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "307": {
    "text": "Medicare Maximum Fair Price Standard Default Refund Amount Adjustment. At least one Remark Code must be provided (may be comprised of either the NCPDP Reject Reason Code, or Remittance Advice Remark Code that is not an ALERT.) Usage: To be used only for the Medicare Drug Price Negotiation Program.",
    "status": "current"
  },
  "308": {
    "text": "Payment is adjusted due to contracted funding agreement between the payer and provider.",
    "status": "current"
  },
  "A0": {
    "text": "Patient refund amount.",
    "status": "current"
  },
  "A1": {
    "text": "Claim/Service denied. At least one Remark Code must be provided (may be comprised of either the NCPDP Reject Reason Code, or Remittance Advice Remark Code that is not an ALERT.) Usage: Use this code only when a more specific Claim Adjustment Reason Code is not available.",
    "status": "current"
  },
  "A2": {
    "text": "Contractual adjustment.",
    "status": "deactivated"
  },
  "A3": {
    "text": "Medicare Secondary Payer liability met.",
    "status": "deactivated"
  },
  "A4": {
    "text": "Medicare Claim PPS Capital Day Outlier Amount.",
    "status": "deactivated"
  },
  "A5": {
    "text": "Medicare Claim PPS Capital Cost Outlier Amount.",
    "status": "current"
  },
  "A6": {
    "text": "Prior hospitalization or 30 day transfer requirement not met.",
    "status": "current"
  },
  "A7": {
    "text": "Presumptive Payment Adjustment",
    "status": "deactivated"
  },
  "A8": {
    "text": "Ungroupable DRG.",
    "status": "current"
  },
  "B1": {
    "text": "Non-covered visits.",
    "status": "current"
  },
  "B10": {
    "text": "Allowed amount has been reduced because a component of the basic procedure/test was paid. The beneficiary is not liable for more than the charge limit for the basic procedure/test.",
    "status": "current"
  },
  "B11": {
    "text": "The claim/service has been transferred to the proper payer/processor for processing. Claim/service not covered by this payer/processor.",
    "status": "current"
  },
  "B12": {
    "text": "Services not documented in patient's medical records.",
    "status": "current"
  },
  "B13": {
    "text": "Previously paid. Payment for this claim/service may have been provided in a previous payment.",
    "status": "current"
  },
  "B14": {
    "text": "Only one visit or consultation per physician per day is covered.",
    "status": "current"
  },
  "B15": {
    "text": "This service/procedure requires that a qualifying service/procedure be received and covered. The qualifying other service/procedure has not been received/adjudicated. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "B16": {
    "text": "'New Patient' qualifications were not met.",
    "status": "current"
  },
  "B17": {
    "text": "Payment adjusted because this service was not prescribed by a physician, not prescribed prior to delivery, the prescription is incomplete, or the prescription is not current.",
    "status": "deactivated"
  },
  "B18": {
    "text": "This procedure code and modifier were invalid on the date of service.",
    "status": "deactivated"
  },
  "B19": {
    "text": "Claim/service adjusted because of the finding of a Review Organization.",
    "status": "deactivated"
  },
  "B2": {
    "text": "Covered visits.",
    "status": "deactivated"
  },
  "B20": {
    "text": "Procedure/service was partially or fully furnished by another provider.",
    "status": "current"
  },
  "B21": {
    "text": "The charges were reduced because the service/care was partially furnished by another physician.",
    "status": "deactivated"
  },
  "B22": {
    "text": "This payment is adjusted based on the diagnosis.",
    "status": "current"
  },
  "B23": {
    "text": "Procedure billed is not authorized per your Clinical Laboratory Improvement Amendment (CLIA) proficiency test.",
    "status": "current"
  },
  "B3": {
    "text": "Covered charges.",
    "status": "deactivated"
  },
  "B4": {
    "text": "Late filing penalty.",
    "status": "current"
  },
  "B5": {
    "text": "Coverage/program guidelines were not met or were exceeded.",
    "status": "deactivated"
  },
  "B6": {
    "text": "This payment is adjusted when performed/billed by this type of provider, by this type of provider in this type of facility, or by a provider of this specialty.",
    "status": "deactivated"
  },
  "B7": {
    "text": "This provider was not certified/eligible to be paid for this procedure/service on this date of service. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "B8": {
    "text": "Alternative services were available, and should have been utilized. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    "status": "current"
  },
  "B9": {
    "text": "Patient is enrolled in a Hospice.",
    "status": "current"
  },
  "D1": {
    "text": "Claim/service denied. Level of subluxation is missing or inadequate.",
    "status": "deactivated"
  },
  "D10": {
    "text": "Claim/service denied. Completed physician financial relationship form not on file.",
    "status": "deactivated"
  },
  "D11": {
    "text": "Claim lacks completed pacemaker registration form.",
    "status": "deactivated"
  },
  "D12": {
    "text": "Claim/service denied. Claim does not identify who performed the purchased diagnostic test or the amount you were charged for the test.",
    "status": "deactivated"
  },
  "D13": {
    "text": "Claim/service denied. Performed by a facility/supplier in which the ordering/referring physician has a financial interest.",
    "status": "deactivated"
  },
  "D14": {
    "text": "Claim lacks indication that plan of treatment is on file.",
    "status": "deactivated"
  },
  "D15": {
    "text": "Claim lacks indication that service was supervised or evaluated by a physician.",
    "status": "deactivated"
  },
  "D16": {
    "text": "Claim lacks prior payer payment information.",
    "status": "deactivated"
  },
  "D17": {
    "text": "Claim/Service has invalid non-covered days.",
    "status": "deactivated"
  },
  "D18": {
    "text": "Claim/Service has missing diagnosis information.",
    "status": "deactivated"
  },
  "D19": {
    "text": "Claim/Service lacks Physician/Operative or other supporting documentation",
    "status": "deactivated"
  },
  "D2": {
    "text": "Claim lacks the name, strength, or dosage of the drug furnished.",
    "status": "deactivated"
  },
  "D20": {
    "text": "Claim/Service missing service/product information.",
    "status": "deactivated"
  },
  "D21": {
    "text": "This (these) diagnosis(es) is (are) missing or are invalid",
    "status": "deactivated"
  },
  "D22": {
    "text": "Reimbursement was adjusted for the reasons to be provided in separate correspondence. (Note: To be used for Workers' Compensation only) - Temporary code to be added for timeframe only until 01/01/2009. Another code to be established and/or for 06/2008 meeting for a revised code to replace or strategy to use another existing code",
    "status": "deactivated"
  },
  "D23": {
    "text": "This dual eligible patient is covered by Medicare Part D per Medicare Retro-Eligibility. At least one Remark Code must be provided (may be comprised of either the NCPDP Reject Reason Code, or Remittance Advice Remark Code that is not an ALERT.)",
    "status": "deactivated"
  },
  "D3": {
    "text": "Claim/service denied because information to indicate if the patient owns the equipment that requires the part or supply was missing.",
    "status": "deactivated"
  },
  "D4": {
    "text": "Claim/service does not indicate the period of time for which this will be needed.",
    "status": "deactivated"
  },
  "D5": {
    "text": "Claim/service denied. Claim lacks individual lab codes included in the test.",
    "status": "deactivated"
  },
  "D6": {
    "text": "Claim/service denied. Claim did not include patient's medical record for the service.",
    "status": "deactivated"
  },
  "D7": {
    "text": "Claim/service denied. Claim lacks date of patient's most recent physician visit.",
    "status": "deactivated"
  },
  "D8": {
    "text": "Claim/service denied. Claim lacks indicator that 'x-ray is available for review.'",
    "status": "deactivated"
  },
  "D9": {
    "text": "Claim/service denied. Claim lacks invoice or statement certifying the actual cost of the lens, less discounts or the type of intraocular lens used.",
    "status": "deactivated"
  },
  "P1": {
    "text": "State-mandated Requirement for Property and Casualty, see Claim Payment Remarks Code for specific explanation. To be used for Property and Casualty only.",
    "status": "current"
  },
  "P10": {
    "text": "Payment reduced to zero due to litigation. Additional information will be sent following the conclusion of litigation. To be used for Property and Casualty only.",
    "status": "current"
  },
  "P11": {
    "text": "The disposition of the related Property & Casualty claim (injury or illness) is pending due to litigation. To be used for Property and Casualty only. (Use only with Group Code OA)",
    "status": "current"
  },
  "P12": {
    "text": "Workers' compensation jurisdictional fee schedule adjustment. Usage: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Class of Contract Code Identification Segment (Loop 2100 Other Claim Related Information REF). If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF) if the regulations apply. To be used for Workers' Compensation only.",
    "status": "current"
  },
  "P13": {
    "text": "Payment reduced or denied based on workers' compensation jurisdictional regulations or payment policies, use only if no other code is applicable. Usage: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Insurance Policy Number Segment (Loop 2100 Other Claim Related Information REF qualifier 'IG') if the jurisdictional regulation applies. If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF) if the regulations apply. To be used for Workers' Compensation only.",
    "status": "current"
  },
  "P14": {
    "text": "The Benefit for this Service is included in the payment/allowance for another service/procedure that has been performed on the same day. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present. To be used for Property and Casualty only.",
    "status": "current"
  },
  "P15": {
    "text": "Workers' Compensation Medical Treatment Guideline Adjustment. To be used for Workers' Compensation only.",
    "status": "current"
  },
  "P16": {
    "text": "Medical provider not authorized/certified to provide treatment to injured workers in this jurisdiction. To be used for Workers' Compensation only. (Use with Group Code CO or OA)",
    "status": "current"
  },
  "P17": {
    "text": "Referral not authorized by attending physician per regulatory requirement. To be used for Property and Casualty only.",
    "status": "current"
  },
  "P18": {
    "text": "Procedure is not listed in the jurisdiction fee schedule. An allowance has been made for a comparable service. To be used for Property and Casualty only.",
    "status": "current"
  },
  "P19": {
    "text": "Procedure has a relative value of zero in the jurisdiction fee schedule, therefore no payment is due. To be used for Property and Casualty only.",
    "status": "current"
  },
  "P2": {
    "text": "Not a work related injury/illness and thus not the liability of the workers' compensation carrier Usage: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Insurance Policy Number Segment (Loop 2100 Other Claim Related Information REF qualifier 'IG') for the jurisdictional regulation. If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF). To be used for Workers' Compensation only.",
    "status": "current"
  },
  "P20": {
    "text": "Service not paid under jurisdiction allowed outpatient facility fee schedule. To be used for Property and Casualty only.",
    "status": "current"
  },
  "P21": {
    "text": "Payment denied based on the Medical Payments Coverage (MPC) and/or Personal Injury Protection (PIP) Benefits jurisdictional regulations, or payment policies. Usage: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Insurance Policy Number Segment (Loop 2100 Other Claim Related Information REF qualifier 'IG') if the jurisdictional regulation applies. If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF) if the regulations apply. To be used for Property and Casualty Auto only.",
    "status": "current"
  },
  "P22": {
    "text": "Payment adjusted based on the Medical Payments Coverage (MPC) and/or Personal Injury Protection (PIP) Benefits jurisdictional regulations, or payment policies. Usage: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Insurance Policy Number Segment (Loop 2100 Other Claim Related Information REF qualifier 'IG') if the jurisdictional regulation applies. If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF) if the regulations apply. To be used for Property and Casualty Auto only.",
    "status": "current"
  },
  "P23": {
    "text": "Medical Payments Coverage (MPC) or Personal Injury Protection (PIP) Benefits jurisdictional fee schedule adjustment. Usage: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Class of Contract Code Identification Segment (Loop 2100 Other Claim Related Information REF). If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF) if the regulations apply. To be used for Property and Casualty Auto only.",
    "status": "current"
  },
  "P24": {
    "text": "Payment adjusted based on Preferred Provider Organization (PPO). Usage: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Class of Contract Code Identification Segment (Loop 2100 Other Claim Related Information REF). If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF) if the regulations apply. To be used for Property and Casualty only. Use only with Group Code CO.",
    "status": "current"
  },
  "P25": {
    "text": "Payment adjusted based on Medical Provider Network (MPN). Usage: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Class of Contract Code Identification Segment (Loop 2100 Other Claim Related Information REF). If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF) if the regulations apply. To be used for Property and Casualty only. (Use only with Group Code CO).",
    "status": "current"
  },
  "P26": {
    "text": "Payment adjusted based on Voluntary Provider network (VPN). Usage: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Class of Contract Code Identification Segment (Loop 2100 Other Claim Related Information REF). If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF) if the regulations apply. To be used for Property and Casualty only. (Use only with Group Code CO).",
    "status": "current"
  },
  "P27": {
    "text": "Payment denied based on the Liability Coverage Benefits jurisdictional regulations and/or payment policies. Usage: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Insurance Policy Number Segment (Loop 2100 Other Claim Related Information REF qualifier 'IG') if the jurisdictional regulation applies. If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF) if the regulations apply. To be used for Property and Casualty Auto only.",
    "status": "current"
  },
  "P28": {
    "text": "Payment adjusted based on the Liability Coverage Benefits jurisdictional regulations and/or payment policies. Usage: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Insurance Policy Number Segment (Loop 2100 Other Claim Related Information REF qualifier 'IG') if the jurisdictional regulation applies. If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF) if the regulations apply. To be used for Property and Casualty Auto only.",
    "status": "current"
  },
  "P29": {
    "text": "Liability Benefits jurisdictional fee schedule adjustment. Usage: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Class of Contract Code Identification Segment (Loop 2100 Other Claim Related Information REF). If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF) if the regulations apply. To be used for Property and Casualty Auto only.",
    "status": "current"
  },
  "P3": {
    "text": "Workers' Compensation case settled. Patient is responsible for amount of this claim/service through WC 'Medicare set aside arrangement' or other agreement. To be used for Workers' Compensation only. (Use only with Group Code PR)",
    "status": "current"
  },
  "P30": {
    "text": "Payment denied for exacerbation when supporting documentation was not complete. To be used for Property and Casualty only.",
    "status": "current"
  },
  "P31": {
    "text": "Payment denied for exacerbation when treatment exceeds time allowed. To be used for Property and Casualty only.",
    "status": "current"
  },
  "P32": {
    "text": "Payment adjusted due to Apportionment.",
    "status": "current"
  },
  "P4": {
    "text": "Workers' Compensation claim adjudicated as non-compensable. This Payer not liable for claim or service/treatment. Usage: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Insurance Policy Number Segment (Loop 2100 Other Claim Related Information REF qualifier 'IG') for the jurisdictional regulation. If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF). To be used for Workers' Compensation only",
    "status": "current"
  },
  "P5": {
    "text": "Based on payer reasonable and customary fees. No maximum allowable defined by legislated fee arrangement. To be used for Property and Casualty only.",
    "status": "current"
  },
  "P6": {
    "text": "Based on entitlement to benefits. Usage: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Insurance Policy Number Segment (Loop 2100 Other Claim Related Information REF qualifier 'IG') for the jurisdictional regulation. If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF). To be used for Property and Casualty only.",
    "status": "current"
  },
  "P7": {
    "text": "The applicable fee schedule/fee database does not contain the billed code. Please resubmit a bill with the appropriate fee schedule/fee database code(s) that best describe the service(s) provided and supporting documentation if required. To be used for Property and Casualty only.",
    "status": "current"
  },
  "P8": {
    "text": "Claim is under investigation. Usage: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Insurance Policy Number Segment (Loop 2100 Other Claim Related Information REF qualifier 'IG') for the jurisdictional regulation. If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF). To be used for Property and Casualty only.",
    "status": "current"
  },
  "P9": {
    "text": "No available or correlating CPT/HCPCS code to describe this service. To be used for Property and Casualty only.",
    "status": "current"
  },
  "W1": {
    "text": "Workers' compensation jurisdictional fee schedule adjustment. Note: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Class of Contract Code Identification Segment (Loop 2100 Other Claim Related Information REF). If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF) if the regulations apply.",
    "status": "deactivated"
  },
  "W2": {
    "text": "Payment reduced or denied based on workers' compensation jurisdictional regulations or payment policies, use only if no other code is applicable. Note: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Insurance Policy Number Segment (Loop 2100 Other Claim Related Information REF qualifier 'IG') if the jurisdictional regulation applies. If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF) if the regulations apply. To be used for Workers' Compensation only.",
    "status": "deactivated"
  },
  "W3": {
    "text": "The Benefit for this Service is included in the payment/allowance for another service/procedure that has been performed on the same day. Note: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present. For use by Property and Casualty only.",
    "status": "deactivated"
  },
  "W4": {
    "text": "Workers' Compensation Medical Treatment Guideline Adjustment.",
    "status": "deactivated"
  },
  "W5": {
    "text": "Medical provider not authorized/certified to provide treatment to injured workers in this jurisdiction. (Use with Group Code CO or OA)",
    "status": "deactivated"
  },
  "W6": {
    "text": "Referral not authorized by attending physician per regulatory requirement.",
    "status": "deactivated"
  },
  "W7": {
    "text": "Procedure is not listed in the jurisdiction fee schedule. An allowance has been made for a comparable service.",
    "status": "deactivated"
  },
  "W8": {
    "text": "Procedure has a relative value of zero in the jurisdiction fee schedule, therefore no payment is due.",
    "status": "deactivated"
  },
  "W9": {
    "text": "Service not paid under jurisdiction allowed outpatient facility fee schedule.",
    "status": "deactivated"
  },
  "Y1": {
    "text": "Payment denied based on Medical Payments Coverage (MPC) or Personal Injury Protection (PIP) Benefits jurisdictional regulations or payment policies, use only if no other code is applicable. Note: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Insurance Policy Number Segment (Loop 2100 Other Claim Related Information REF qualifier 'IG') if the jurisdictional regulation applies. If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF) if the regulations apply. To be used for P&C Auto only.",
    "status": "deactivated"
  },
  "Y2": {
    "text": "Payment adjusted based on Medical Payments Coverage (MPC) or Personal Injury Protection (PIP) Benefits jurisdictional regulations or payment policies, use only if no other code is applicable. Note: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Insurance Policy Number Segment (Loop 2100 Other Claim Related Information REF qualifier 'IG') if the jurisdictional regulation applies. If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF) if the regulations apply. To be used for P&C Auto only.",
    "status": "deactivated"
  },
  "Y3": {
    "text": "Medical Payments Coverage (MPC) or Personal Injury Protection (PIP) Benefits jurisdictional fee schedule adjustment. Note: If adjustment is at the Claim Level, the payer must send and the provider should refer to the 835 Class of Contract Code Identification Segment (Loop 2100 Other Claim Related Information REF). If adjustment is at the Line Level, the payer must send and the provider should refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment information REF) if the regulations apply. To be used for P&C Auto only.",
    "status": "deactivated"
  }
});

/** @type {Readonly<Record<string, X12Code>>} */
const RARC = Object.freeze({
  "M1": {
    "text": "X-ray not taken within the past 12 months or near enough to the start of treatment.",
    "status": "current"
  },
  "M10": {
    "text": "Equipment purchases are limited to the first or the tenth month of medical necessity.",
    "status": "current"
  },
  "M100": {
    "text": "We do not pay for an oral anti-emetic drug that is not administered for use immediately before, at, or within 48 hours of administration of a covered chemotherapy drug.",
    "status": "current"
  },
  "M101": {
    "text": "Begin to report a G1-G5 modifier with this HCPCS. We will soon begin to deny payment for this service if billed without a G1-G5 modifier.",
    "status": "deactivated"
  },
  "M102": {
    "text": "Service not performed on equipment approved by the FDA for this purpose.",
    "status": "current"
  },
  "M103": {
    "text": "Information supplied supports a break in therapy. However, the medical information we have for this patient does not support the need for this item as billed. We have approved payment for this item at a reduced level, and a new capped rental period will begin with the delivery of this equipment.",
    "status": "current"
  },
  "M104": {
    "text": "Information supplied supports a break in therapy. A new capped rental period will begin with delivery of the equipment. This is the maximum approved under the fee schedule for this item or service.",
    "status": "current"
  },
  "M105": {
    "text": "Information supplied does not support a break in therapy. The medical information we have for this patient does not support the need for this item as billed. We have approved payment for this item at a reduced level, and a new capped rental period will not begin.",
    "status": "current"
  },
  "M106": {
    "text": "Information supplied does not support a break in therapy. A new capped rental period will not begin. This is the maximum approved under the fee schedule for this item or service.",
    "status": "deactivated"
  },
  "M107": {
    "text": "Payment reduced as 90-day rolling average hematocrit for ESRD patient exceeded 36.5%.",
    "status": "current"
  },
  "M108": {
    "text": "Missing/incomplete/invalid provider identifier for the provider who interpreted the diagnostic test.",
    "status": "deactivated"
  },
  "M109": {
    "text": "We have provided you with a bundled payment for a teleconsultation. You must send 25 percent of the teleconsultation payment to the referring practitioner.",
    "status": "current"
  },
  "M11": {
    "text": "DME, orthotics and prosthetics must be billed to the DME carrier who services the patient's zip code.",
    "status": "current"
  },
  "M110": {
    "text": "Missing/incomplete/invalid provider identifier for the provider from whom you purchased interpretation services.",
    "status": "deactivated"
  },
  "M111": {
    "text": "We do not pay for chiropractic manipulative treatment when the patient refuses to have an x-ray taken.",
    "status": "current"
  },
  "M112": {
    "text": "Reimbursement for this item is based on the single payment amount required under the DMEPOS Competitive Bidding Program for the area where the patient resides.",
    "status": "current"
  },
  "M113": {
    "text": "Our records indicate that this patient began using this item/service prior to the current contract period for the DMEPOS Competitive Bidding Program.",
    "status": "current"
  },
  "M114": {
    "text": "This service was processed in accordance with rules and guidelines under the DMEPOS Competitive Bidding Program or a Demonstration Project. For more information regarding these projects, contact your local contractor.",
    "status": "current"
  },
  "M115": {
    "text": "This item is denied when provided to this patient by a non-contract or non-demonstration supplier.",
    "status": "current"
  },
  "M116": {
    "text": "Processed under a demonstration project or program. Project or program is ending and additional services may not be paid under this project or program.",
    "status": "current"
  },
  "M117": {
    "text": "Not covered unless submitted via electronic claim.",
    "status": "current"
  },
  "M118": {
    "text": "Letter to follow containing further information.",
    "status": "deactivated"
  },
  "M119": {
    "text": "Missing/incomplete/invalid/ deactivated/withdrawn National Drug Code (NDC).",
    "status": "current"
  },
  "M12": {
    "text": "Diagnostic tests performed by a physician must indicate whether purchased services are included on the claim.",
    "status": "current"
  },
  "M120": {
    "text": "Missing/incomplete/invalid provider identifier for the substituting physician who furnished the service(s) under a reciprocal billing or locum tenens arrangement.",
    "status": "deactivated"
  },
  "M121": {
    "text": "We pay for this service only when performed with a covered cryosurgical ablation.",
    "status": "current"
  },
  "M122": {
    "text": "Missing/incomplete/invalid level of subluxation.",
    "status": "current"
  },
  "M123": {
    "text": "Missing/incomplete/invalid name, strength, or dosage of the drug furnished.",
    "status": "current"
  },
  "M124": {
    "text": "Missing indication of whether the patient owns the equipment that requires the part or supply.",
    "status": "current"
  },
  "M125": {
    "text": "Missing/incomplete/invalid information on the period of time for which the service/supply/equipment will be needed.",
    "status": "current"
  },
  "M126": {
    "text": "Missing/incomplete/invalid individual lab codes included in the test.",
    "status": "current"
  },
  "M127": {
    "text": "Missing patient medical record for this service.",
    "status": "current"
  },
  "M128": {
    "text": "Missing/incomplete/invalid date of the patient's last physician visit.",
    "status": "deactivated"
  },
  "M129": {
    "text": "Missing/incomplete/invalid indicator of x-ray availability for review.",
    "status": "current"
  },
  "M13": {
    "text": "Only one initial visit is covered per specialty per medical group.",
    "status": "current"
  },
  "M130": {
    "text": "Missing invoice or statement certifying the actual cost of the lens, less discounts, and/or the type of intraocular lens used.",
    "status": "current"
  },
  "M131": {
    "text": "Missing physician financial relationship form.",
    "status": "current"
  },
  "M132": {
    "text": "Missing pacemaker registration form.",
    "status": "current"
  },
  "M133": {
    "text": "Claim did not identify who performed the purchased diagnostic test or the amount you were charged for the test.",
    "status": "current"
  },
  "M134": {
    "text": "Performed by a facility/supplier in which the provider has a financial interest.",
    "status": "current"
  },
  "M135": {
    "text": "Missing/incomplete/invalid plan of treatment.",
    "status": "current"
  },
  "M136": {
    "text": "Missing/incomplete/invalid indication that the service was supervised or evaluated by a physician.",
    "status": "current"
  },
  "M137": {
    "text": "Part B coinsurance under a demonstration project or pilot program.",
    "status": "current"
  },
  "M138": {
    "text": "Patient identified as a demonstration participant but the patient was not enrolled in the demonstration at the time services were rendered. Coverage is limited to demonstration participants.",
    "status": "current"
  },
  "M139": {
    "text": "Denied services exceed the coverage limit for the demonstration.",
    "status": "current"
  },
  "M14": {
    "text": "No separate payment for an injection administered during an office visit, and no payment for a full office visit if the patient only received an injection.",
    "status": "current"
  },
  "M140": {
    "text": "Service not covered until after the patient's 50th birthday, i.e., no coverage prior to the day after the 50th birthday",
    "status": "deactivated"
  },
  "M141": {
    "text": "Missing physician certified plan of care.",
    "status": "current"
  },
  "M142": {
    "text": "Missing American Diabetes Association Certificate of Recognition.",
    "status": "current"
  },
  "M143": {
    "text": "The provider must update license information with the payer.",
    "status": "current"
  },
  "M144": {
    "text": "Pre-/post-operative care payment is included in the allowance for the surgery/procedure.",
    "status": "current"
  },
  "M15": {
    "text": "Separately billed services/tests have been bundled as they are considered components of the same procedure. Separate payment is not allowed.",
    "status": "current"
  },
  "M16": {
    "text": "Alert: Please see our web site, mailings, or bulletins for more details concerning this policy/procedure/decision.",
    "status": "current"
  },
  "M17": {
    "text": "Alert: Payment approved as you did not know, and could not reasonably have been expected to know, that this would not normally have been covered for this patient. In the future, you will be liable for charges for the same service(s) under the same or similar conditions.",
    "status": "current"
  },
  "M18": {
    "text": "Certain services may be approved for home use. Neither a hospital nor a Skilled Nursing Facility (SNF) is considered to be a patient's home.",
    "status": "current"
  },
  "M19": {
    "text": "Missing oxygen certification/re-certification.",
    "status": "current"
  },
  "M2": {
    "text": "Not paid separately when the patient is an inpatient.",
    "status": "current"
  },
  "M20": {
    "text": "Missing/incomplete/invalid HCPCS.",
    "status": "current"
  },
  "M21": {
    "text": "Missing/incomplete/invalid place of residence for this service/item provided in a home.",
    "status": "current"
  },
  "M22": {
    "text": "Missing/incomplete/invalid number of miles traveled.",
    "status": "current"
  },
  "M23": {
    "text": "Missing invoice.",
    "status": "current"
  },
  "M24": {
    "text": "Missing/incomplete/invalid number of doses per vial.",
    "status": "current"
  },
  "M25": {
    "text": "The information furnished does not substantiate the need for this level of service. If you believe the service should have been fully covered as billed, or if you did not know and could not reasonably have been expected to know that we would not pay for this level of service, or if you notified the patient in writing in advance that we would not pay for this level of service and he/she agreed in writing to pay, ask us to review your claim within 120 days of the date of this notice. If you do not request an appeal, we will, upon application from the patient, reimburse him/her for the amount you have collected from him/her in excess of any deductible and coinsurance amounts. We will recover the reimbursement from you as an overpayment.",
    "status": "current"
  },
  "M26": {
    "text": "The information furnished does not substantiate the need for this level of service. If you have collected any amount from the patient for this level of service/any amount that exceeds the limiting charge for the less extensive service, the law requires you to refund that amount to the patient within 30 days of receiving this notice. The requirements for refund are in 1824(I) of the Social Security Act and 42CFR411.408. The section specifies that physicians who knowingly and willfully fail to make appropriate refunds may be subject to civil monetary penalties and/or exclusion from the program. If you have any questions about this notice, please contact this office.",
    "status": "current"
  },
  "M27": {
    "text": "Alert: The patient has been relieved of liability of payment of these items and services under the limitation of liability provision of the law. The provider is ultimately liable for the patient's waived charges, including any charges for coinsurance, since the items or services were not reasonable and necessary or constituted custodial care, and you knew or could reasonably have been expected to know, that they were not covered. You may appeal this determination. You may ask for an appeal regarding both the coverage determination and the issue of whether you exercised due care. The appeal request must be filed within 120 days of the date you receive this notice. You must make the request through this office.",
    "status": "current"
  },
  "M28": {
    "text": "This does not qualify for payment under Part B when Part A coverage is exhausted or not otherwise available.",
    "status": "current"
  },
  "M29": {
    "text": "Missing operative note/report.",
    "status": "current"
  },
  "M3": {
    "text": "Equipment is the same or similar to equipment already being used.",
    "status": "current"
  },
  "M30": {
    "text": "Missing pathology report.",
    "status": "current"
  },
  "M31": {
    "text": "Missing radiology report.",
    "status": "current"
  },
  "M32": {
    "text": "Alert: This is a conditional payment made pending a decision on this service by the patient's primary payer. This payment may be subject to refund upon your receipt of any additional payment for this service from another payer. You must contact this office immediately upon receipt of an additional payment for this service.",
    "status": "current"
  },
  "M33": {
    "text": "Missing/incomplete/invalid UPIN for the ordering/referring/performing provider.",
    "status": "deactivated"
  },
  "M34": {
    "text": "Claim lacks the CLIA certification number.",
    "status": "deactivated"
  },
  "M35": {
    "text": "Missing/incomplete/invalid pre-operative photos or visual field results.",
    "status": "deactivated"
  },
  "M36": {
    "text": "This is the 11th rental month. We cannot pay for this until you indicate that the patient has been given the option of changing the rental to a purchase.",
    "status": "current"
  },
  "M37": {
    "text": "Not covered when the patient is under age 35.",
    "status": "current"
  },
  "M38": {
    "text": "Alert: The patient is liable for the charges for this service as they were informed in writing before the service was furnished that we would not pay for it and the patient agreed to be responsible for the charges.",
    "status": "current"
  },
  "M39": {
    "text": "Alert: The patient is not liable for payment of this service as the advance notice of non-coverage you provided the patient did not comply with program requirements.",
    "status": "current"
  },
  "M4": {
    "text": "Alert: This is the last monthly installment payment for this durable medical equipment.",
    "status": "current"
  },
  "M40": {
    "text": "Claim must be assigned and must be filed by the practitioner's employer.",
    "status": "current"
  },
  "M41": {
    "text": "We do not pay for this as the patient has no legal obligation to pay for this.",
    "status": "current"
  },
  "M42": {
    "text": "The medical necessity form must be personally signed by the attending physician.",
    "status": "current"
  },
  "M43": {
    "text": "Payment for this service previously issued to you or another provider by another carrier/intermediary.",
    "status": "deactivated"
  },
  "M44": {
    "text": "Missing/incomplete/invalid condition code.",
    "status": "current"
  },
  "M45": {
    "text": "Missing/incomplete/invalid occurrence code(s).",
    "status": "current"
  },
  "M46": {
    "text": "Missing/incomplete/invalid occurrence span code(s).",
    "status": "current"
  },
  "M47": {
    "text": "Missing/incomplete/invalid Payer Claim Control Number. Other terms exist for this element including, but not limited to, Internal Control Number (ICN), Claim Control Number (CCN), Document Control Number (DCN).",
    "status": "current"
  },
  "M48": {
    "text": "Payment for services furnished to hospital inpatients (other than professional services of physicians) can only be made to the hospital. You must request payment from the hospital rather than the patient for this service.",
    "status": "deactivated"
  },
  "M49": {
    "text": "Missing/incomplete/invalid value code(s) or amount(s).",
    "status": "current"
  },
  "M5": {
    "text": "Monthly rental payments can continue until the earlier of the 15th month from the first rental month, or the month when the equipment is no longer needed.",
    "status": "current"
  },
  "M50": {
    "text": "Missing/incomplete/invalid revenue code(s).",
    "status": "current"
  },
  "M51": {
    "text": "Missing/incomplete/invalid procedure code(s).",
    "status": "current"
  },
  "M52": {
    "text": "Missing/incomplete/invalid 'from' date(s) of service.",
    "status": "current"
  },
  "M53": {
    "text": "Missing/incomplete/invalid days or units of service.",
    "status": "current"
  },
  "M54": {
    "text": "Missing/incomplete/invalid total charges.",
    "status": "current"
  },
  "M55": {
    "text": "We do not pay for self-administered anti-emetic drugs that are not administered with a covered oral anti-cancer drug.",
    "status": "current"
  },
  "M56": {
    "text": "Missing/incomplete/invalid payer identifier.",
    "status": "current"
  },
  "M57": {
    "text": "Missing/incomplete/invalid provider identifier.",
    "status": "deactivated"
  },
  "M58": {
    "text": "Missing/incomplete/invalid claim information. Resubmit claim after corrections.",
    "status": "deactivated"
  },
  "M59": {
    "text": "Missing/incomplete/invalid 'to' date(s) of service.",
    "status": "current"
  },
  "M6": {
    "text": "Alert: You must furnish and service this item for any period of medical need for the remainder of the reasonable useful lifetime of the equipment.",
    "status": "current"
  },
  "M60": {
    "text": "Missing Certificate of Medical Necessity.",
    "status": "current"
  },
  "M61": {
    "text": "We cannot pay for this as the approval period for the FDA clinical trial has expired.",
    "status": "current"
  },
  "M62": {
    "text": "Missing/incomplete/invalid treatment authorization code.",
    "status": "current"
  },
  "M63": {
    "text": "We do not pay for more than one of these on the same day.",
    "status": "deactivated"
  },
  "M64": {
    "text": "Missing/incomplete/invalid other diagnosis.",
    "status": "current"
  },
  "M65": {
    "text": "One interpreting physician charge can be submitted per claim when a purchased diagnostic test is indicated. Please submit a separate claim for each interpreting physician.",
    "status": "current"
  },
  "M66": {
    "text": "Our records indicate that you billed diagnostic tests subject to price limitations and the procedure code submitted includes a professional component. Only the technical component is subject to price limitations. Please submit the technical and professional components of this service as separate line items.",
    "status": "current"
  },
  "M67": {
    "text": "Missing/incomplete/invalid other procedure code(s).",
    "status": "current"
  },
  "M68": {
    "text": "Missing/incomplete/invalid attending, ordering, rendering, supervising or referring physician identification.",
    "status": "deactivated"
  },
  "M69": {
    "text": "Paid at the regular rate as you did not submit documentation to justify the modified procedure code.",
    "status": "current"
  },
  "M7": {
    "text": "No rental payments after the item is purchased, returned or after the total of issued rental payments equals the purchase price.",
    "status": "current"
  },
  "M70": {
    "text": "Alert: The NDC code submitted for this service was translated to a HCPCS code for processing, but please continue to submit the NDC on future claims for this item.",
    "status": "current"
  },
  "M71": {
    "text": "Total payment reduced due to overlap of tests billed.",
    "status": "current"
  },
  "M72": {
    "text": "Did not enter full 8-digit date (MM/DD/CCYY).",
    "status": "deactivated"
  },
  "M73": {
    "text": "The HPSA/Physician Scarcity bonus can only be paid on the professional component of this service. Rebill as separate professional and technical components.",
    "status": "current"
  },
  "M74": {
    "text": "This service does not qualify for a HPSA/Physician Scarcity bonus payment.",
    "status": "current"
  },
  "M75": {
    "text": "Multiple automated multichannel tests performed on the same day combined for payment.",
    "status": "current"
  },
  "M76": {
    "text": "Missing/incomplete/invalid diagnosis or condition.",
    "status": "current"
  },
  "M77": {
    "text": "Missing/incomplete/invalid/inappropriate place of service.",
    "status": "current"
  },
  "M78": {
    "text": "Missing/incomplete/invalid HCPCS modifier.",
    "status": "deactivated"
  },
  "M79": {
    "text": "Missing/incomplete/invalid charge.",
    "status": "current"
  },
  "M8": {
    "text": "We do not accept blood gas tests results when the test was conducted by a medical supplier or taken while the patient is on oxygen.",
    "status": "current"
  },
  "M80": {
    "text": "Not covered when performed during the same session/date as a previously processed service for the patient.",
    "status": "current"
  },
  "M81": {
    "text": "You are required to code to the highest level of specificity.",
    "status": "current"
  },
  "M82": {
    "text": "Service is not covered when patient is under age 50.",
    "status": "current"
  },
  "M83": {
    "text": "Service is not covered unless the patient is classified as at high risk.",
    "status": "current"
  },
  "M84": {
    "text": "Medical code sets used must be the codes in effect at the time of service.",
    "status": "current"
  },
  "M85": {
    "text": "Subjected to review of physician evaluation and management services.",
    "status": "current"
  },
  "M86": {
    "text": "Service denied because payment already made for same/similar procedure within set time frame.",
    "status": "current"
  },
  "M87": {
    "text": "Claim/service(s) subjected to CFO-CAP prepayment review.",
    "status": "current"
  },
  "M88": {
    "text": "We cannot pay for laboratory tests unless billed by the laboratory that did the work.",
    "status": "deactivated"
  },
  "M89": {
    "text": "Not covered more than once under age 40.",
    "status": "current"
  },
  "M9": {
    "text": "Alert: This is the tenth rental month. You must offer the patient the choice of changing the rental to a purchase agreement.",
    "status": "current"
  },
  "M90": {
    "text": "Not covered more than once in a 12 month period.",
    "status": "current"
  },
  "M91": {
    "text": "Lab procedures with different CLIA certification numbers must be billed on separate claims.",
    "status": "current"
  },
  "M92": {
    "text": "Services subjected to review under the Home Health Medical Review Initiative.",
    "status": "deactivated"
  },
  "M93": {
    "text": "Information supplied supports a break in therapy. A new capped rental period began with delivery of this equipment.",
    "status": "current"
  },
  "M94": {
    "text": "Information supplied does not support a break in therapy. A new capped rental period will not begin.",
    "status": "current"
  },
  "M95": {
    "text": "Services subjected to Home Health Initiative medical review/cost report audit.",
    "status": "current"
  },
  "M96": {
    "text": "The technical component of a service furnished to an inpatient may only be billed by that inpatient facility. You must contact the inpatient facility for technical component reimbursement. If not already billed, you should bill us for the professional component only.",
    "status": "current"
  },
  "M97": {
    "text": "Not paid to practitioner when provided to patient in this place of service. Payment included in the reimbursement issued the facility.",
    "status": "current"
  },
  "M98": {
    "text": "Begin to report the Universal Product Number on claims for items of this type. We will soon begin to deny payment for items of this type if billed without the correct UPN.",
    "status": "deactivated"
  },
  "M99": {
    "text": "Missing/incomplete/invalid Universal Product Number/Serial Number.",
    "status": "current"
  },
  "MA01": {
    "text": "Alert: If you do not agree with what we approved for these services, you may appeal our decision. To make sure that we are fair to you, we require another individual that did not process your initial claim to conduct the appeal. However, in order to be eligible for an appeal, you must write to us within 120 days of the date you received this notice, unless you have a good reason for being late.",
    "status": "current"
  },
  "MA02": {
    "text": "Alert: If you do not agree with this determination, you have the right to appeal. You must file a written request for an appeal within 180 days of the date you receive this notice.",
    "status": "current"
  },
  "MA03": {
    "text": "If you do not agree with the approved amounts and $100 or more is in dispute (less deductible and coinsurance), you may ask for a hearing within six months of the date of this notice. To meet the $100, you may combine amounts on other claims that have been denied, including reopened appeals if you received a revised decision. You must appeal each claim on time.",
    "status": "deactivated"
  },
  "MA04": {
    "text": "Secondary payment cannot be considered without the identity of or payment information from the primary payer. The information was either not reported or was illegible.",
    "status": "current"
  },
  "MA05": {
    "text": "Incorrect admission date patient status or type of bill entry on claim.",
    "status": "deactivated"
  },
  "MA06": {
    "text": "Missing/incomplete/invalid beginning and/or ending date(s).",
    "status": "deactivated"
  },
  "MA07": {
    "text": "Alert: The claim information has also been forwarded to Medicaid for review.",
    "status": "current"
  },
  "MA08": {
    "text": "Alert: Claim information was not forwarded because the supplemental coverage is not with a Medigap plan, or you do not participate in Medicare.",
    "status": "current"
  },
  "MA09": {
    "text": "Alert: Claim submitted as unassigned but processed as assigned in accordance with our current assignment/participation agreement.",
    "status": "current"
  },
  "MA10": {
    "text": "Alert: The patient's payment was in excess of the amount owed. You must refund the overpayment to the patient.",
    "status": "current"
  },
  "MA100": {
    "text": "Missing/incomplete/invalid date of current illness or symptoms.",
    "status": "current"
  },
  "MA101": {
    "text": "A Skilled Nursing Facility (SNF) is responsible for payment of outside providers who furnish these services/supplies to residents.",
    "status": "deactivated"
  },
  "MA102": {
    "text": "Missing/incomplete/invalid name or provider identifier for the rendering/referring/ ordering/ supervising provider.",
    "status": "deactivated"
  },
  "MA103": {
    "text": "Hemophilia Add On.",
    "status": "current"
  },
  "MA104": {
    "text": "Missing/incomplete/invalid date the patient was last seen or the provider identifier of the attending physician.",
    "status": "deactivated"
  },
  "MA105": {
    "text": "Missing/incomplete/invalid provider number for this place of service.",
    "status": "deactivated"
  },
  "MA106": {
    "text": "PIP (Periodic Interim Payment) claim.",
    "status": "current"
  },
  "MA107": {
    "text": "Paper claim contains more than three separate data items in field 19.",
    "status": "current"
  },
  "MA108": {
    "text": "Paper claim contains more than one data item in field 23.",
    "status": "current"
  },
  "MA109": {
    "text": "Claim processed in accordance with ambulatory surgical guidelines.",
    "status": "current"
  },
  "MA11": {
    "text": "Payment is being issued on a conditional basis. If no-fault insurance, liability insurance, Workers' Compensation, Department of Veterans Affairs, or a group health plan for employees and dependents also covers this claim, a refund may be due us. Please contact us if the patient is covered by any of these sources.",
    "status": "deactivated"
  },
  "MA110": {
    "text": "Missing/incomplete/invalid information on whether the diagnostic test(s) were performed by an outside entity or if no purchased tests are included on the claim.",
    "status": "current"
  },
  "MA111": {
    "text": "Missing/incomplete/invalid purchase price of the test(s) and/or the performing laboratory's name and address.",
    "status": "current"
  },
  "MA112": {
    "text": "Missing/incomplete/invalid group practice information.",
    "status": "current"
  },
  "MA113": {
    "text": "Incomplete/invalid taxpayer identification number (TIN) submitted by you per the Internal Revenue Service. Your claims cannot be processed without your correct TIN, and you may not bill the patient pending correction of your TIN. There are no appeal rights for unprocessable claims, but you may resubmit this claim after you have notified this office of your correct TIN.",
    "status": "current"
  },
  "MA114": {
    "text": "Missing/incomplete/invalid information on where the services were furnished.",
    "status": "current"
  },
  "MA115": {
    "text": "Missing/incomplete/invalid physical location (name and address, or PIN) where the service(s) were rendered in a Health Professional Shortage Area (HPSA).",
    "status": "current"
  },
  "MA116": {
    "text": "Did not complete the statement 'Homebound' on the claim to validate whether laboratory services were performed at home or in an institution.",
    "status": "current"
  },
  "MA117": {
    "text": "This claim has been assessed a $1.00 user fee.",
    "status": "current"
  },
  "MA118": {
    "text": "Alert: No Medicare payment issued for this claim for services or supplies furnished to a Medicare-eligible veteran through a facility of the Department of Veterans Affairs. Coinsurance and/or deductible are applicable.",
    "status": "current"
  },
  "MA119": {
    "text": "Provider level adjustment for late claim filing applies to this claim.",
    "status": "deactivated"
  },
  "MA12": {
    "text": "You have not established that you have the right under the law to bill for services furnished by the person(s) that furnished this (these) service(s).",
    "status": "current"
  },
  "MA120": {
    "text": "Missing/incomplete/invalid CLIA certification number.",
    "status": "current"
  },
  "MA121": {
    "text": "Missing/incomplete/invalid x-ray date.",
    "status": "current"
  },
  "MA122": {
    "text": "Missing/incomplete/invalid initial treatment date.",
    "status": "current"
  },
  "MA123": {
    "text": "Your center was not selected to participate in this study, therefore, we cannot pay for these services.",
    "status": "current"
  },
  "MA124": {
    "text": "Processed for IME only.",
    "status": "deactivated"
  },
  "MA125": {
    "text": "Per legislation governing this program, payment constitutes payment in full.",
    "status": "current"
  },
  "MA126": {
    "text": "Pancreas transplant not covered unless kidney transplant performed.",
    "status": "current"
  },
  "MA127": {
    "text": "Reserved for future use.",
    "status": "deactivated"
  },
  "MA128": {
    "text": "Missing/incomplete/invalid FDA approval number.",
    "status": "current"
  },
  "MA129": {
    "text": "This provider was not certified for this procedure on this date of service.",
    "status": "deactivated"
  },
  "MA13": {
    "text": "Alert: You may be subject to penalties if you bill the patient for amounts not reported with the PR (patient responsibility) group code.",
    "status": "current"
  },
  "MA130": {
    "text": "Your claim contains incomplete and/or invalid information, and no appeal rights are afforded because the claim is unprocessable. Please submit a new claim with the complete/correct information.",
    "status": "current"
  },
  "MA131": {
    "text": "Physician already paid for services in conjunction with this demonstration claim. You must have the physician withdraw that claim and refund the payment before we can process your claim.",
    "status": "current"
  },
  "MA132": {
    "text": "Adjustment to the pre-demonstration rate.",
    "status": "current"
  },
  "MA133": {
    "text": "Claim overlaps inpatient stay. Rebill only those services rendered outside the inpatient stay.",
    "status": "current"
  },
  "MA134": {
    "text": "Missing/incomplete/invalid provider number of the facility where the patient resides.",
    "status": "current"
  },
  "MA14": {
    "text": "Alert: The patient is a member of an employer-sponsored prepaid health plan. Services from outside that health plan are not covered. However, as you were not previously notified of this, we are paying this time. In the future, we will not pay you for non-plan services.",
    "status": "current"
  },
  "MA15": {
    "text": "Alert: Your claim has been separated to expedite handling. You will receive a separate notice for the other services reported.",
    "status": "current"
  },
  "MA16": {
    "text": "The patient is covered by the Black Lung Program. Send this claim to the Department of Labor, Federal Black Lung Program, P.O. Box 828, Lanham-Seabrook MD 20703.",
    "status": "current"
  },
  "MA17": {
    "text": "We are the primary payer and have paid at the primary rate. You must contact the patient's other insurer to refund any excess it may have paid due to its erroneous primary payment.",
    "status": "current"
  },
  "MA18": {
    "text": "Alert: The claim information is also being forwarded to the patient's supplemental insurer. Send any questions regarding supplemental benefits to them.",
    "status": "current"
  },
  "MA19": {
    "text": "Alert: Information was not sent to the Medigap insurer due to incorrect/invalid information you submitted concerning that insurer. Please verify your information and submit your secondary claim directly to that insurer.",
    "status": "current"
  },
  "MA20": {
    "text": "Skilled Nursing Facility (SNF) stay not covered when care is primarily related to the use of an urethral catheter for convenience or the control of incontinence.",
    "status": "current"
  },
  "MA21": {
    "text": "SSA records indicate mismatch with name and sex.",
    "status": "current"
  },
  "MA22": {
    "text": "Payment of less than $1.00 suppressed.",
    "status": "current"
  },
  "MA23": {
    "text": "Demand bill approved as result of medical review.",
    "status": "current"
  },
  "MA24": {
    "text": "Christian Science Sanitarium/ Skilled Nursing Facility (SNF) bill in the same benefit period.",
    "status": "current"
  },
  "MA25": {
    "text": "A patient may not elect to change a hospice provider more than once in a benefit period.",
    "status": "current"
  },
  "MA26": {
    "text": "Alert: Our records indicate that you were previously informed of this rule.",
    "status": "current"
  },
  "MA27": {
    "text": "Missing/incomplete/invalid entitlement number or name shown on the claim.",
    "status": "current"
  },
  "MA28": {
    "text": "Alert: Receipt of this notice by a physician or supplier who did not accept assignment is for information only and does not make the physician or supplier a party to the determination. No additional rights to appeal this decision, above those rights already provided for by regulation/instruction, are conferred by receipt of this notice.",
    "status": "current"
  },
  "MA29": {
    "text": "Missing/incomplete/invalid provider name, city, state, or zip code.",
    "status": "deactivated"
  },
  "MA30": {
    "text": "Missing/incomplete/invalid type of bill.",
    "status": "current"
  },
  "MA31": {
    "text": "Missing/incomplete/invalid beginning and ending dates of the period billed.",
    "status": "current"
  },
  "MA32": {
    "text": "Missing/incomplete/invalid number of covered days during the billing period.",
    "status": "current"
  },
  "MA33": {
    "text": "Missing/incomplete/invalid non-covered days during the billing period.",
    "status": "current"
  },
  "MA34": {
    "text": "Missing/incomplete/invalid number of coinsurance days during the billing period.",
    "status": "current"
  },
  "MA35": {
    "text": "Missing/incomplete/invalid number of lifetime reserve days.",
    "status": "current"
  },
  "MA36": {
    "text": "Missing/incomplete/invalid patient name.",
    "status": "current"
  },
  "MA37": {
    "text": "Missing/incomplete/invalid patient's address.",
    "status": "current"
  },
  "MA38": {
    "text": "Missing/incomplete/invalid birth date.",
    "status": "deactivated"
  },
  "MA39": {
    "text": "Missing/incomplete/invalid gender.",
    "status": "current"
  },
  "MA40": {
    "text": "Missing/incomplete/invalid admission date.",
    "status": "current"
  },
  "MA41": {
    "text": "Missing/incomplete/invalid admission type.",
    "status": "current"
  },
  "MA42": {
    "text": "Missing/incomplete/invalid admission source.",
    "status": "current"
  },
  "MA43": {
    "text": "Missing/incomplete/invalid patient status.",
    "status": "current"
  },
  "MA44": {
    "text": "Alert: No appeal rights. Adjudicative decision based on law.",
    "status": "current"
  },
  "MA45": {
    "text": "Alert: As previously advised, a portion or all of your payment is being held in a special account.",
    "status": "current"
  },
  "MA46": {
    "text": "Alert: The new information was considered but additional payment will not be issued.",
    "status": "current"
  },
  "MA47": {
    "text": "Our records show you have opted out of Medicare, agreeing with the patient not to bill Medicare for services/tests/supplies furnished. As result, we cannot pay this claim. The patient is responsible for payment.",
    "status": "current"
  },
  "MA48": {
    "text": "Missing/incomplete/invalid name or address of responsible party or primary payer.",
    "status": "current"
  },
  "MA49": {
    "text": "Missing/incomplete/invalid six-digit provider identifier for home health agency or hospice for physician(s) performing care plan oversight services.",
    "status": "deactivated"
  },
  "MA50": {
    "text": "Missing/incomplete/invalid Investigational Device Exemption number or Clinical Trial number.",
    "status": "current"
  },
  "MA51": {
    "text": "Missing/incomplete/invalid CLIA certification number for laboratory services billed by physician office laboratory.",
    "status": "deactivated"
  },
  "MA52": {
    "text": "Missing/incomplete/invalid date.",
    "status": "deactivated"
  },
  "MA53": {
    "text": "Missing/incomplete/invalid Competitive Bidding Demonstration Project identification.",
    "status": "current"
  },
  "MA54": {
    "text": "Physician certification or election consent for hospice care not received timely.",
    "status": "current"
  },
  "MA55": {
    "text": "Not covered as patient received medical health care services, automatically revoking his/her election to receive religious non-medical health care services.",
    "status": "current"
  },
  "MA56": {
    "text": "Our records show you have opted out of Medicare, agreeing with the patient not to bill Medicare for services/tests/supplies furnished. As result, we cannot pay this claim. The patient is responsible for payment, but under Federal law, you cannot charge the patient more than the limiting charge amount.",
    "status": "current"
  },
  "MA57": {
    "text": "Patient submitted written request to revoke his/her election for religious non-medical health care services.",
    "status": "current"
  },
  "MA58": {
    "text": "Missing/incomplete/invalid release of information indicator.",
    "status": "current"
  },
  "MA59": {
    "text": "Alert: The patient overpaid you for these services. You must issue the patient a refund within 30 days for the difference between his/her payment and the total amount shown as patient responsibility on this notice.",
    "status": "current"
  },
  "MA60": {
    "text": "Missing/incomplete/invalid patient relationship to insured.",
    "status": "current"
  },
  "MA61": {
    "text": "Missing/incomplete/invalid social security number.",
    "status": "current"
  },
  "MA62": {
    "text": "Alert: This is a telephone review decision.",
    "status": "current"
  },
  "MA63": {
    "text": "Missing/incomplete/invalid principal diagnosis.",
    "status": "current"
  },
  "MA64": {
    "text": "Our records indicate that we should be the third payer for this claim. We cannot process this claim until we have received payment information from the primary and secondary payers.",
    "status": "current"
  },
  "MA65": {
    "text": "Missing/incomplete/invalid admitting diagnosis.",
    "status": "current"
  },
  "MA66": {
    "text": "Missing/incomplete/invalid principal procedure code.",
    "status": "current"
  },
  "MA67": {
    "text": "Alert: Correction to a prior claim.",
    "status": "current"
  },
  "MA68": {
    "text": "Alert: We did not crossover this claim because the secondary insurance information on the claim was incomplete. Please supply complete information or use the PLANID of the insurer to assure correct and timely routing of the claim.",
    "status": "current"
  },
  "MA69": {
    "text": "Missing/incomplete/invalid remarks.",
    "status": "current"
  },
  "MA70": {
    "text": "Missing/incomplete/invalid provider representative signature.",
    "status": "current"
  },
  "MA71": {
    "text": "Missing/incomplete/invalid provider representative signature date.",
    "status": "current"
  },
  "MA72": {
    "text": "Alert: The patient overpaid you for these assigned services. You must issue the patient a refund within 30 days for the difference between his/her payment to you and the total of the amount shown as patient responsibility and as paid to the patient on this notice.",
    "status": "current"
  },
  "MA73": {
    "text": "Informational remittance associated with a Medicare demonstration. No payment issued under fee-for-service Medicare as patient has elected managed care.",
    "status": "current"
  },
  "MA74": {
    "text": "Alert: This payment replaces an earlier payment for this claim that was either lost, damaged or returned.",
    "status": "current"
  },
  "MA75": {
    "text": "Missing/incomplete/invalid patient or authorized representative signature.",
    "status": "current"
  },
  "MA76": {
    "text": "Missing/incomplete/invalid provider identifier for home health agency or hospice when physician is performing care plan oversight services.",
    "status": "current"
  },
  "MA77": {
    "text": "Alert: The patient overpaid you. You must issue the patient a refund within 30 days for the difference between the patient's payment less the total of our and other payer payments and the amount shown as patient responsibility on this notice.",
    "status": "current"
  },
  "MA78": {
    "text": "The patient overpaid you. You must issue the patient a refund within 30 days for the difference between our allowed amount total and the amount paid by the patient.",
    "status": "deactivated"
  },
  "MA79": {
    "text": "Billed in excess of interim rate.",
    "status": "current"
  },
  "MA80": {
    "text": "Informational notice. No payment issued for this claim with this notice. Payment issued to the hospital by its intermediary for all services for this encounter under a demonstration project.",
    "status": "current"
  },
  "MA81": {
    "text": "Missing/incomplete/invalid provider/supplier signature.",
    "status": "current"
  },
  "MA82": {
    "text": "Missing/incomplete/invalid provider/supplier billing number/identifier or billing name, address, city, state, zip code, or phone number.",
    "status": "deactivated"
  },
  "MA83": {
    "text": "Did not indicate whether we are the primary or secondary payer.",
    "status": "current"
  },
  "MA84": {
    "text": "Patient identified as participating in the National Emphysema Treatment Trial but our records indicate that this patient is either not a participant, or has not yet been approved for this phase of the study. Contact Johns Hopkins University, the study coordinator, to resolve if there was a discrepancy.",
    "status": "current"
  },
  "MA85": {
    "text": "Our records indicate that a primary payer exists (other than ourselves); however, you did not complete or enter accurately the insurance plan/group/program name or identification number. Enter the PlanID when effective.",
    "status": "deactivated"
  },
  "MA86": {
    "text": "Missing/incomplete/invalid group or policy number of the insured for the primary coverage.",
    "status": "deactivated"
  },
  "MA87": {
    "text": "Missing/incomplete/invalid insured's name for the primary payer.",
    "status": "deactivated"
  },
  "MA88": {
    "text": "Missing/incomplete/invalid insured's address and/or telephone number for the primary payer.",
    "status": "current"
  },
  "MA89": {
    "text": "Missing/incomplete/invalid patient's relationship to the insured for the primary payer.",
    "status": "current"
  },
  "MA90": {
    "text": "Missing/incomplete/invalid employment status code for the primary insured.",
    "status": "current"
  },
  "MA91": {
    "text": "Alert: This determination is the result of the appeal you filed.",
    "status": "current"
  },
  "MA92": {
    "text": "Missing plan information for other insurance.",
    "status": "current"
  },
  "MA93": {
    "text": "Non-PIP (Periodic Interim Payment) claim.",
    "status": "current"
  },
  "MA94": {
    "text": "Did not enter the statement 'Attending physician not hospice employee' on the claim form to certify that the rendering physician is not an employee of the hospice.",
    "status": "current"
  },
  "MA95": {
    "text": "A not otherwise classified or unlisted procedure code(s) was billed but a narrative description of the procedure was not entered on the claim. Refer to item 19 on the HCFA-1500.",
    "status": "deactivated"
  },
  "MA96": {
    "text": "Claim rejected. Coded as a Medicare Managed Care Demonstration but patient is not enrolled in a Medicare managed care plan.",
    "status": "current"
  },
  "MA97": {
    "text": "Missing/incomplete/invalid Medicare Managed Care Demonstration contract number or clinical trial registry number.",
    "status": "current"
  },
  "MA98": {
    "text": "Claim Rejected. Does not contain the correct Medicare Managed Care Demonstration contract number for this beneficiary.",
    "status": "deactivated"
  },
  "MA99": {
    "text": "Missing/incomplete/invalid Medigap information.",
    "status": "current"
  },
  "N1": {
    "text": "Alert: You may appeal this decision in writing within the required time limits following receipt of this notice by following the instructions included in your contract, plan benefit documents or jurisdiction statutes. Refer to the URL provided in the ERA for the payer website to access the appeals process guidelines.",
    "status": "current"
  },
  "N10": {
    "text": "Adjustment based on the findings of a review organization/professional consult/manual adjudication/medical advisor/dental advisor/peer review.",
    "status": "current"
  },
  "N100": {
    "text": "PPS (Prospect Payment System) code corrected during adjudication.",
    "status": "deactivated"
  },
  "N101": {
    "text": "Additional information is needed in order to process this claim. Please resubmit the claim with the identification number of the provider where this service took place. The Medicare number of the site of service provider should be preceded with the letters 'HSP' and entered into item #32 on the claim form. You may bill only one site of service provider number per claim.",
    "status": "deactivated"
  },
  "N102": {
    "text": "This claim has been denied without reviewing the medical/dental record because the requested records were not received or were not received timely.",
    "status": "deactivated"
  },
  "N103": {
    "text": "Records indicate this patient was a prisoner or in custody of a Federal, State, or local authority when the service was rendered. This payer does not cover items and services furnished to an individual while he or she is in custody under a penal statute or rule, unless under State or local law, the individual is personally liable for the cost of his or her health care while in custody and the State or local government pursues the collection of such debt in the same way and with the same vigor as the collection of its other debts. The provider can collect from the Federal/State/ Local Authority as appropriate.",
    "status": "current"
  },
  "N104": {
    "text": "This claim/service is not payable under our claims jurisdiction area. You can identify the correct Medicare contractor to process this claim/service through the CMS website at www.cms.gov.",
    "status": "current"
  },
  "N105": {
    "text": "This is a misdirected claim/service for an RRB beneficiary. Submit paper claims to the RRB carrier: Palmetto GBA, P.O. Box 10066, Augusta, GA 30999. Call 888-355-9165 for RRB EDI information for electronic claims processing.",
    "status": "current"
  },
  "N106": {
    "text": "Payment for services furnished to Skilled Nursing Facility (SNF) inpatients (except for excluded services) can only be made to the SNF. You must request payment from the SNF rather than the patient for this service.",
    "status": "current"
  },
  "N107": {
    "text": "Services furnished to Skilled Nursing Facility (SNF) inpatients must be billed on the inpatient claim. They cannot be billed separately as outpatient services.",
    "status": "current"
  },
  "N108": {
    "text": "Missing/incomplete/invalid upgrade information.",
    "status": "current"
  },
  "N109": {
    "text": "Alert: This claim/service was chosen for complex review.",
    "status": "current"
  },
  "N11": {
    "text": "Denial reversed because of medical review.",
    "status": "current"
  },
  "N110": {
    "text": "This facility is not certified for film mammography.",
    "status": "current"
  },
  "N111": {
    "text": "No appeal right except duplicate claim/service issue. This service was included in a claim that has been previously billed and adjudicated.",
    "status": "current"
  },
  "N112": {
    "text": "This claim is excluded from your electronic remittance advice.",
    "status": "current"
  },
  "N113": {
    "text": "Only one initial visit is covered per physician, group practice or provider.",
    "status": "current"
  },
  "N114": {
    "text": "During the transition to the Ambulance Fee Schedule, payment is based on the lesser of a blended amount calculated using a percentage of the reasonable charge/cost and fee schedule amounts, or the submitted charge for the service. You will be notified yearly what the percentages for the blended payment calculation will be.",
    "status": "current"
  },
  "N115": {
    "text": "This decision was based on a Local Coverage Determination (LCD). An LCD provides a guide to assist in determining whether a particular item or service is covered. A copy of this policy is available at www.cms.gov/mcd, or if you do not have web access, you may contact the contractor to request a copy of the LCD.",
    "status": "current"
  },
  "N116": {
    "text": "Alert: This payment is being made conditionally because the service was provided in the home, and it is possible that the patient is under a home health episode of care. When a patient is treated under a home health episode of care, consolidated billing requires that certain therapy services and supplies, such as this, be included in the home health agency's (HHA's) payment. This payment will need to be recouped from you if we establish that the patient is concurrently receiving treatment under an HHA episode of care.",
    "status": "current"
  },
  "N117": {
    "text": "This service is paid only once in a patient's lifetime.",
    "status": "current"
  },
  "N118": {
    "text": "This service is not paid if billed more than once every 28 days.",
    "status": "current"
  },
  "N119": {
    "text": "This service is not paid if billed once every 28 days, and the patient has spent 5 or more consecutive days in any inpatient or Skilled /nursing Facility (SNF) within those 28 days.",
    "status": "current"
  },
  "N12": {
    "text": "Policy provides coverage supplemental to Medicare. As the member does not appear to be enrolled in the applicable part of Medicare, the member is responsible for payment of the portion of the charge that would have been covered by Medicare.",
    "status": "current"
  },
  "N120": {
    "text": "Payment is subject to home health prospective payment system partial episode payment adjustment. Patient was transferred/discharged/readmitted during payment episode.",
    "status": "current"
  },
  "N121": {
    "text": "Medicare Part B does not pay for items or services provided by this type of practitioner for beneficiaries in a Medicare Part A covered Skilled Nursing Facility (SNF) stay.",
    "status": "current"
  },
  "N122": {
    "text": "Add-on code cannot be billed by itself.",
    "status": "current"
  },
  "N123": {
    "text": "Alert: This is a split service and represents a portion of the units from the originally submitted service.",
    "status": "current"
  },
  "N124": {
    "text": "Payment has been denied for the/made only for a less extensive service/item because the information furnished does not substantiate the need for the (more extensive) service/item. The patient is liable for the charges for this service/item as you informed the patient in writing before the service/item was furnished that we would not pay for it, and the patient agreed to pay.",
    "status": "current"
  },
  "N125": {
    "text": "Payment has been (denied for the/made only for a less extensive) service/item because the information furnished does not substantiate the need for the (more extensive) service/item. If you have collected any amount from the patient, you must refund that amount to the patient within 30 days of receiving this notice. The requirements for a refund are in §1834(a)(18) of the Social Security Act (and in §§1834(j)(4) and 1879(h) by cross-reference to §1834(a)(18)). Section 1834(a)(18)(B) specifies that suppliers which knowingly and willfully fail to make appropriate refunds may be subject to civil money penalties and/or exclusion from the Medicare program. If you have any questions about this notice, please contact this office.",
    "status": "current"
  },
  "N126": {
    "text": "Social Security Records indicate that this individual has been deported. This payer does not cover items and services furnished to individuals who have been deported.",
    "status": "current"
  },
  "N127": {
    "text": "This is a misdirected claim/service for a United Mine Workers of America (UMWA) beneficiary. Please submit claims to them.",
    "status": "current"
  },
  "N128": {
    "text": "This amount represents the prior to coverage portion of the allowance.",
    "status": "current"
  },
  "N129": {
    "text": "Not eligible due to the patient's age.",
    "status": "current"
  },
  "N13": {
    "text": "Payment based on professional/technical component modifier(s).",
    "status": "current"
  },
  "N130": {
    "text": "Consult plan benefit documents/guidelines for information about restrictions for this service.",
    "status": "current"
  },
  "N131": {
    "text": "Total payments under multiple contracts cannot exceed the allowance for this service.",
    "status": "current"
  },
  "N132": {
    "text": "Alert: Payments will cease for services rendered by this US Government debarred or excluded provider after the 30 day grace period as previously notified.",
    "status": "current"
  },
  "N133": {
    "text": "Alert: Services for predetermination and services requesting payment are being processed separately.",
    "status": "current"
  },
  "N134": {
    "text": "Alert: This represents your scheduled payment for this service. If treatment has been discontinued, please contact Customer Service.",
    "status": "current"
  },
  "N135": {
    "text": "Record fees are the patient's responsibility and limited to the specified co-payment.",
    "status": "current"
  },
  "N136": {
    "text": "Alert: To obtain information on the process to file an appeal in Arizona, call the Department's Consumer Assistance Office at (602) 912-8444 or (800) 325-2548.",
    "status": "current"
  },
  "N137": {
    "text": "Alert: The provider acting on the Member's behalf, may file an appeal with the Payer. The provider, acting on the Member's behalf, may file a complaint with the State Insurance Regulatory Authority without first filing an appeal, if the coverage decision involves an urgent condition for which care has not been rendered. The address may be obtained from the State Insurance Regulatory Authority.",
    "status": "current"
  },
  "N138": {
    "text": "Alert: In the event you disagree with the Dental Advisor's opinion and have additional information relative to the case, you may submit radiographs to the Dental Advisor Unit at the subscriber's dental insurance carrier for a second Independent Dental Advisor Review.",
    "status": "current"
  },
  "N139": {
    "text": "Alert: Under 32 CFR 199.13, a non-participating provider is not an appropriate appealing party. Therefore, if you disagree with the Dental Advisor's opinion, you may appeal the determination if appointed in writing, by the beneficiary, to act as his/her representative. Should you be appointed as a representative, submit a copy of this letter, a signed statement explaining the matter in which you disagree, and any radiographs and relevant information to the subscriber's Dental insurance carrier within 90 days from the date of this letter.",
    "status": "current"
  },
  "N14": {
    "text": "Payment based on a contractual amount or agreement, fee schedule, or maximum allowable amount.",
    "status": "deactivated"
  },
  "N140": {
    "text": "Alert: You have not been designated as an authorized OCONUS provider therefore are not considered an appropriate appealing party. If the beneficiary has appointed you, in writing, to act as his/her representative and you disagree with the Dental Advisor's opinion, you may appeal by submitting a copy of this letter, a signed statement explaining the matter in which you disagree, and any relevant information to the subscriber's Dental insurance carrier within 90 days from the date of this letter.",
    "status": "current"
  },
  "N141": {
    "text": "The patient was not residing in a long-term care facility during all or part of the service dates billed.",
    "status": "current"
  },
  "N142": {
    "text": "The original claim was denied. Resubmit a new claim, not a replacement claim.",
    "status": "current"
  },
  "N143": {
    "text": "The patient was not in a hospice program during all or part of the service dates billed.",
    "status": "current"
  },
  "N144": {
    "text": "The rate changed during the dates of service billed.",
    "status": "current"
  },
  "N145": {
    "text": "Missing/incomplete/invalid provider identifier for this place of service.",
    "status": "deactivated"
  },
  "N146": {
    "text": "Missing screening document.",
    "status": "current"
  },
  "N147": {
    "text": "Long term care case mix or per diem rate cannot be determined because the patient ID number is missing, incomplete, or invalid on the assignment request.",
    "status": "current"
  },
  "N148": {
    "text": "Missing/incomplete/invalid date of last menstrual period.",
    "status": "current"
  },
  "N149": {
    "text": "Rebill all applicable services on a single claim.",
    "status": "current"
  },
  "N15": {
    "text": "Services for a newborn must be billed separately.",
    "status": "current"
  },
  "N150": {
    "text": "Missing/incomplete/invalid model number.",
    "status": "current"
  },
  "N151": {
    "text": "Telephone contact services will not be paid until the face-to-face contact requirement has been met.",
    "status": "current"
  },
  "N152": {
    "text": "Missing/incomplete/invalid replacement claim information.",
    "status": "current"
  },
  "N153": {
    "text": "Missing/incomplete/invalid room and board rate.",
    "status": "current"
  },
  "N154": {
    "text": "Alert: This payment was delayed for correction of provider's mailing address.",
    "status": "current"
  },
  "N155": {
    "text": "Alert: Our records do not indicate that other insurance is on file. Please submit other insurance information for our records.",
    "status": "current"
  },
  "N156": {
    "text": "Alert: The patient is responsible for the difference between the approved treatment and the elective treatment.",
    "status": "current"
  },
  "N157": {
    "text": "Transportation to/from this destination is not covered.",
    "status": "current"
  },
  "N158": {
    "text": "Transportation in a vehicle other than an ambulance is not covered.",
    "status": "current"
  },
  "N159": {
    "text": "Payment denied/reduced because mileage is not covered when the patient is not in the ambulance.",
    "status": "current"
  },
  "N16": {
    "text": "Family/member Out-of-Pocket maximum has been met. Payment based on a higher percentage.",
    "status": "current"
  },
  "N160": {
    "text": "The patient must choose an option before a payment can be made for this procedure/ equipment/ supply/ service.",
    "status": "current"
  },
  "N161": {
    "text": "This drug/service/supply is covered only when the associated service is covered.",
    "status": "current"
  },
  "N162": {
    "text": "Alert: Although your claim was paid, you have billed for a test/specialty not included in your Laboratory Certification. Your failure to correct the laboratory certification information will result in a denial of payment in the near future.",
    "status": "current"
  },
  "N163": {
    "text": "Medical record does not support code billed per the code definition.",
    "status": "current"
  },
  "N164": {
    "text": "Transportation to/from this destination is not covered.",
    "status": "deactivated"
  },
  "N165": {
    "text": "Transportation in a vehicle other than an ambulance is not covered.",
    "status": "deactivated"
  },
  "N166": {
    "text": "Payment denied/reduced because mileage is not covered when the patient is not in the ambulance.",
    "status": "deactivated"
  },
  "N167": {
    "text": "Charges exceed the post-transplant coverage limit.",
    "status": "current"
  },
  "N168": {
    "text": "The patient must choose an option before a payment can be made for this procedure/ equipment/ supply/ service.",
    "status": "deactivated"
  },
  "N169": {
    "text": "This drug/service/supply is covered only when the associated service is covered.",
    "status": "deactivated"
  },
  "N17": {
    "text": "Per admission deductible.",
    "status": "deactivated"
  },
  "N170": {
    "text": "A new/revised/renewed certificate of medical necessity is needed.",
    "status": "current"
  },
  "N171": {
    "text": "Payment for repair or replacement is not covered or has exceeded the purchase price.",
    "status": "current"
  },
  "N172": {
    "text": "The patient is not liable for the denied/adjusted charge(s) for receiving any updated service/item.",
    "status": "current"
  },
  "N173": {
    "text": "No qualifying hospital stay dates were provided for this episode of care.",
    "status": "current"
  },
  "N174": {
    "text": "This is not a covered service/procedure/ equipment/bed, however patient liability is limited to amounts shown in the adjustments under group 'PR'.",
    "status": "current"
  },
  "N175": {
    "text": "Missing review organization approval.",
    "status": "current"
  },
  "N176": {
    "text": "Services provided aboard a ship are covered only when the ship is of United States registry and is in United States waters. In addition, a doctor licensed to practice in the United States must provide the service.",
    "status": "current"
  },
  "N177": {
    "text": "Alert: We did not send this claim to patient's other insurer. They have indicated no additional payment can be made.",
    "status": "current"
  },
  "N178": {
    "text": "Missing pre-operative images/visual field results.",
    "status": "current"
  },
  "N179": {
    "text": "Additional information has been requested from the member. The charges will be reconsidered upon receipt of that information.",
    "status": "current"
  },
  "N18": {
    "text": "Payment based on the Medicare allowed amount.",
    "status": "deactivated"
  },
  "N180": {
    "text": "This item or service does not meet the criteria for the category under which it was billed.",
    "status": "current"
  },
  "N181": {
    "text": "Additional information is required from another provider involved in this service.",
    "status": "current"
  },
  "N182": {
    "text": "This claim/service must be billed according to the schedule for this plan.",
    "status": "current"
  },
  "N183": {
    "text": "Alert: This is a predetermination advisory message, when this service is submitted for payment additional documentation as specified in plan documents will be required to process benefits.",
    "status": "current"
  },
  "N184": {
    "text": "Rebill technical and professional components separately.",
    "status": "current"
  },
  "N185": {
    "text": "Alert: Do not resubmit this claim/service.",
    "status": "current"
  },
  "N186": {
    "text": "Non-Availability Statement (NAS) required for this service. Contact the nearest Military Treatment Facility (MTF) for assistance.",
    "status": "current"
  },
  "N187": {
    "text": "Alert: You may request a review in writing within the required time limits following receipt of this notice by following the instructions included in your contract or plan benefit documents.",
    "status": "current"
  },
  "N188": {
    "text": "The approved level of care does not match the procedure code submitted.",
    "status": "current"
  },
  "N189": {
    "text": "Alert: This service has been paid as a one-time exception to the plan's benefit restrictions.",
    "status": "current"
  },
  "N19": {
    "text": "Procedure code incidental to primary procedure.",
    "status": "current"
  },
  "N190": {
    "text": "Missing contract indicator.",
    "status": "current"
  },
  "N191": {
    "text": "The provider must update insurance information directly with payer.",
    "status": "current"
  },
  "N192": {
    "text": "Alert: Patient is a Medicaid/Qualified Medicare Beneficiary.",
    "status": "current"
  },
  "N193": {
    "text": "Alert: Specific federal/state/local program may cover this service through another payer.",
    "status": "current"
  },
  "N194": {
    "text": "Technical component not paid if provider does not own the equipment used.",
    "status": "current"
  },
  "N195": {
    "text": "The technical component must be billed separately.",
    "status": "current"
  },
  "N196": {
    "text": "Alert: Patient eligible to apply for other coverage which may be primary.",
    "status": "current"
  },
  "N197": {
    "text": "The subscriber must update insurance information directly with payer.",
    "status": "current"
  },
  "N198": {
    "text": "Rendering provider must be affiliated with the pay-to provider.",
    "status": "current"
  },
  "N199": {
    "text": "Additional payment/recoupment approved based on payer-initiated review/audit.",
    "status": "current"
  },
  "N2": {
    "text": "This allowance has been made in accordance with the most appropriate course of treatment provision of the plan.",
    "status": "current"
  },
  "N20": {
    "text": "Service not payable with other service rendered on the same date.",
    "status": "current"
  },
  "N200": {
    "text": "The professional component must be billed separately.",
    "status": "current"
  },
  "N201": {
    "text": "A mental health facility is responsible for payment of outside providers who furnish these services/supplies to residents.",
    "status": "deactivated"
  },
  "N202": {
    "text": "Alert: Additional information/explanation will be sent separately.",
    "status": "current"
  },
  "N203": {
    "text": "Missing/incomplete/invalid anesthesia time/units.",
    "status": "current"
  },
  "N204": {
    "text": "Services under review for possible pre-existing condition. Send medical records for prior 12 months",
    "status": "current"
  },
  "N205": {
    "text": "Information provided was illegible.",
    "status": "current"
  },
  "N206": {
    "text": "The supporting documentation does not match the information sent on the claim.",
    "status": "current"
  },
  "N207": {
    "text": "Missing/incomplete/invalid weight.",
    "status": "current"
  },
  "N208": {
    "text": "Missing/incomplete/invalid DRG code.",
    "status": "current"
  },
  "N209": {
    "text": "Missing/incomplete/invalid taxpayer identification number (TIN).",
    "status": "current"
  },
  "N21": {
    "text": "Alert: Your line item has been separated into multiple lines to expedite handling.",
    "status": "current"
  },
  "N210": {
    "text": "Alert: You may appeal this decision.",
    "status": "current"
  },
  "N211": {
    "text": "Alert: You may not appeal this decision.",
    "status": "current"
  },
  "N212": {
    "text": "Charges processed under a Point of Service benefit.",
    "status": "current"
  },
  "N213": {
    "text": "Missing/incomplete/invalid facility/discrete unit DRG/DRG exempt status information.",
    "status": "current"
  },
  "N214": {
    "text": "Missing/incomplete/invalid history of the related initial surgical procedure(s).",
    "status": "current"
  },
  "N215": {
    "text": "Alert: A payer providing supplemental or secondary coverage shall not require a claims determination for this service from a primary payer as a condition of making its own claims determination.",
    "status": "current"
  },
  "N216": {
    "text": "We do not offer coverage for this type of service or the patient is not enrolled in this portion of our benefit package.",
    "status": "current"
  },
  "N217": {
    "text": "We pay only one site of service per provider per claim.",
    "status": "current"
  },
  "N218": {
    "text": "You must furnish and service this item for as long as the patient continues to need it. We can pay for maintenance and/or servicing for the time period specified in the contract or coverage manual.",
    "status": "current"
  },
  "N219": {
    "text": "Payment based on previous payer's allowed amount.",
    "status": "current"
  },
  "N22": {
    "text": "Alert: This procedure code was added/changed because it more accurately describes the services rendered.",
    "status": "current"
  },
  "N220": {
    "text": "Alert: See the payer's web site or contact the payer's Customer Service department to obtain forms and instructions for filing a provider dispute.",
    "status": "current"
  },
  "N221": {
    "text": "Missing Admitting History and Physical report.",
    "status": "current"
  },
  "N222": {
    "text": "Incomplete/invalid Admitting History and Physical report.",
    "status": "current"
  },
  "N223": {
    "text": "Missing documentation of benefit to the patient during initial treatment period.",
    "status": "current"
  },
  "N224": {
    "text": "Incomplete/invalid documentation of benefit to the patient during initial treatment period.",
    "status": "current"
  },
  "N225": {
    "text": "Incomplete/invalid documentation/orders/notes/summary/report/chart.",
    "status": "deactivated"
  },
  "N226": {
    "text": "Incomplete/invalid American Diabetes Association Certificate of Recognition.",
    "status": "current"
  },
  "N227": {
    "text": "Incomplete/invalid Certificate of Medical Necessity.",
    "status": "current"
  },
  "N228": {
    "text": "Incomplete/invalid consent form.",
    "status": "current"
  },
  "N229": {
    "text": "Incomplete/invalid contract indicator.",
    "status": "current"
  },
  "N23": {
    "text": "Alert: Patient liability may be affected due to coordination of benefits with other carriers and/or maximum benefit provisions.",
    "status": "current"
  },
  "N230": {
    "text": "Incomplete/invalid indication of whether the patient owns the equipment that requires the part or supply.",
    "status": "current"
  },
  "N231": {
    "text": "Incomplete/invalid invoice or statement certifying the actual cost of the lens, less discounts, and/or the type of intraocular lens used.",
    "status": "current"
  },
  "N232": {
    "text": "Incomplete/invalid itemized bill/statement.",
    "status": "current"
  },
  "N233": {
    "text": "Incomplete/invalid operative note/report.",
    "status": "current"
  },
  "N234": {
    "text": "Incomplete/invalid oxygen certification/re-certification.",
    "status": "current"
  },
  "N235": {
    "text": "Incomplete/invalid pacemaker registration form.",
    "status": "current"
  },
  "N236": {
    "text": "Incomplete/invalid pathology report.",
    "status": "current"
  },
  "N237": {
    "text": "Incomplete/invalid patient medical record for this service.",
    "status": "current"
  },
  "N238": {
    "text": "Incomplete/invalid physician certified plan of care.",
    "status": "current"
  },
  "N239": {
    "text": "Incomplete/invalid physician financial relationship form.",
    "status": "current"
  },
  "N24": {
    "text": "Missing/incomplete/invalid Electronic Funds Transfer (EFT) banking information.",
    "status": "current"
  },
  "N240": {
    "text": "Incomplete/invalid radiology report.",
    "status": "current"
  },
  "N241": {
    "text": "Incomplete/invalid review organization approval.",
    "status": "current"
  },
  "N242": {
    "text": "Incomplete/invalid radiology film(s)/image(s).",
    "status": "current"
  },
  "N243": {
    "text": "Incomplete/invalid/not approved screening document.",
    "status": "current"
  },
  "N244": {
    "text": "Incomplete/Invalid pre-operative images/visual field results.",
    "status": "current"
  },
  "N245": {
    "text": "Incomplete/invalid plan information for other insurance.",
    "status": "current"
  },
  "N246": {
    "text": "State regulated patient payment limitations apply to this service.",
    "status": "current"
  },
  "N247": {
    "text": "Missing/incomplete/invalid assistant surgeon taxonomy.",
    "status": "current"
  },
  "N248": {
    "text": "Missing/incomplete/invalid assistant surgeon name.",
    "status": "current"
  },
  "N249": {
    "text": "Missing/incomplete/invalid assistant surgeon primary identifier.",
    "status": "current"
  },
  "N25": {
    "text": "This company has been contracted by your benefit plan to provide administrative claims payment services only. This company does not assume financial risk or obligation with respect to claims processed on behalf of your benefit plan.",
    "status": "current"
  },
  "N250": {
    "text": "Missing/incomplete/invalid assistant surgeon secondary identifier.",
    "status": "current"
  },
  "N251": {
    "text": "Missing/incomplete/invalid attending provider taxonomy.",
    "status": "current"
  },
  "N252": {
    "text": "Missing/incomplete/invalid attending provider name.",
    "status": "current"
  },
  "N253": {
    "text": "Missing/incomplete/invalid attending provider primary identifier.",
    "status": "current"
  },
  "N254": {
    "text": "Missing/incomplete/invalid attending provider secondary identifier.",
    "status": "current"
  },
  "N255": {
    "text": "Missing/incomplete/invalid billing provider taxonomy.",
    "status": "current"
  },
  "N256": {
    "text": "Missing/incomplete/invalid billing provider/supplier name.",
    "status": "current"
  },
  "N257": {
    "text": "Missing/incomplete/invalid billing provider/supplier primary identifier.",
    "status": "current"
  },
  "N258": {
    "text": "Missing/incomplete/invalid billing provider/supplier address.",
    "status": "current"
  },
  "N259": {
    "text": "Missing/incomplete/invalid billing provider/supplier secondary identifier.",
    "status": "current"
  },
  "N26": {
    "text": "Missing itemized bill/statement.",
    "status": "current"
  },
  "N260": {
    "text": "Missing/incomplete/invalid billing provider/supplier contact information.",
    "status": "current"
  },
  "N261": {
    "text": "Missing/incomplete/invalid operating provider name.",
    "status": "current"
  },
  "N262": {
    "text": "Missing/incomplete/invalid operating provider primary identifier.",
    "status": "current"
  },
  "N263": {
    "text": "Missing/incomplete/invalid operating provider secondary identifier.",
    "status": "current"
  },
  "N264": {
    "text": "Missing/incomplete/invalid ordering provider name.",
    "status": "current"
  },
  "N265": {
    "text": "Missing/incomplete/invalid ordering provider primary identifier.",
    "status": "current"
  },
  "N266": {
    "text": "Missing/incomplete/invalid ordering provider address.",
    "status": "current"
  },
  "N267": {
    "text": "Missing/incomplete/invalid ordering provider secondary identifier.",
    "status": "current"
  },
  "N268": {
    "text": "Missing/incomplete/invalid ordering provider contact information.",
    "status": "current"
  },
  "N269": {
    "text": "Missing/incomplete/invalid other provider name.",
    "status": "current"
  },
  "N27": {
    "text": "Missing/incomplete/invalid treatment number.",
    "status": "current"
  },
  "N270": {
    "text": "Missing/incomplete/invalid other provider primary identifier.",
    "status": "current"
  },
  "N271": {
    "text": "Missing/incomplete/invalid other provider secondary identifier.",
    "status": "current"
  },
  "N272": {
    "text": "Missing/incomplete/invalid other payer attending provider identifier.",
    "status": "current"
  },
  "N273": {
    "text": "Missing/incomplete/invalid other payer operating provider identifier.",
    "status": "current"
  },
  "N274": {
    "text": "Missing/incomplete/invalid other payer other provider identifier.",
    "status": "current"
  },
  "N275": {
    "text": "Missing/incomplete/invalid other payer purchased service provider identifier.",
    "status": "current"
  },
  "N276": {
    "text": "Missing/incomplete/invalid other payer referring provider identifier.",
    "status": "current"
  },
  "N277": {
    "text": "Missing/incomplete/invalid other payer rendering provider identifier.",
    "status": "current"
  },
  "N278": {
    "text": "Missing/incomplete/invalid other payer service facility provider identifier.",
    "status": "current"
  },
  "N279": {
    "text": "Missing/incomplete/invalid pay-to provider name.",
    "status": "current"
  },
  "N28": {
    "text": "Consent form requirements not fulfilled.",
    "status": "current"
  },
  "N280": {
    "text": "Missing/incomplete/invalid pay-to provider primary identifier.",
    "status": "current"
  },
  "N281": {
    "text": "Missing/incomplete/invalid pay-to provider address.",
    "status": "current"
  },
  "N282": {
    "text": "Missing/incomplete/invalid pay-to provider secondary identifier.",
    "status": "current"
  },
  "N283": {
    "text": "Missing/incomplete/invalid purchased service provider identifier.",
    "status": "current"
  },
  "N284": {
    "text": "Missing/incomplete/invalid referring provider taxonomy.",
    "status": "current"
  },
  "N285": {
    "text": "Missing/incomplete/invalid referring provider name.",
    "status": "current"
  },
  "N286": {
    "text": "Missing/incomplete/invalid referring provider primary identifier.",
    "status": "current"
  },
  "N287": {
    "text": "Missing/incomplete/invalid referring provider secondary identifier.",
    "status": "current"
  },
  "N288": {
    "text": "Missing/incomplete/invalid rendering provider taxonomy.",
    "status": "current"
  },
  "N289": {
    "text": "Missing/incomplete/invalid rendering provider name.",
    "status": "current"
  },
  "N29": {
    "text": "Missing documentation/orders/notes/summary/report/chart.",
    "status": "deactivated"
  },
  "N290": {
    "text": "Missing/incomplete/invalid rendering provider primary identifier.",
    "status": "current"
  },
  "N291": {
    "text": "Missing/incomplete/invalid rendering provider secondary identifier.",
    "status": "current"
  },
  "N292": {
    "text": "Missing/incomplete/invalid service facility name.",
    "status": "current"
  },
  "N293": {
    "text": "Missing/incomplete/invalid service facility primary identifier.",
    "status": "current"
  },
  "N294": {
    "text": "Missing/incomplete/invalid service facility primary address.",
    "status": "current"
  },
  "N295": {
    "text": "Missing/incomplete/invalid service facility secondary identifier.",
    "status": "current"
  },
  "N296": {
    "text": "Missing/incomplete/invalid supervising provider name.",
    "status": "current"
  },
  "N297": {
    "text": "Missing/incomplete/invalid supervising provider primary identifier.",
    "status": "current"
  },
  "N298": {
    "text": "Missing/incomplete/invalid supervising provider secondary identifier.",
    "status": "current"
  },
  "N299": {
    "text": "Missing/incomplete/invalid occurrence date(s).",
    "status": "current"
  },
  "N3": {
    "text": "Missing consent form.",
    "status": "current"
  },
  "N30": {
    "text": "Patient ineligible for this service.",
    "status": "current"
  },
  "N300": {
    "text": "Missing/incomplete/invalid occurrence span date(s).",
    "status": "current"
  },
  "N301": {
    "text": "Missing/incomplete/invalid procedure date(s).",
    "status": "current"
  },
  "N302": {
    "text": "Missing/incomplete/invalid other procedure date(s).",
    "status": "current"
  },
  "N303": {
    "text": "Missing/incomplete/invalid principal procedure date.",
    "status": "current"
  },
  "N304": {
    "text": "Missing/incomplete/invalid dispensed date.",
    "status": "current"
  },
  "N305": {
    "text": "Missing/incomplete/invalid injury/accident date.",
    "status": "current"
  },
  "N306": {
    "text": "Missing/incomplete/invalid acute manifestation date.",
    "status": "current"
  },
  "N307": {
    "text": "Missing/incomplete/invalid adjudication or payment date.",
    "status": "current"
  },
  "N308": {
    "text": "Missing/incomplete/invalid appliance placement date.",
    "status": "current"
  },
  "N309": {
    "text": "Missing/incomplete/invalid assessment date.",
    "status": "current"
  },
  "N31": {
    "text": "Missing/incomplete/invalid prescribing provider identifier.",
    "status": "current"
  },
  "N310": {
    "text": "Missing/incomplete/invalid assumed or relinquished care date.",
    "status": "current"
  },
  "N311": {
    "text": "Missing/incomplete/invalid authorized to return to work date.",
    "status": "current"
  },
  "N312": {
    "text": "Missing/incomplete/invalid begin therapy date.",
    "status": "current"
  },
  "N313": {
    "text": "Missing/incomplete/invalid certification revision date.",
    "status": "current"
  },
  "N314": {
    "text": "Missing/incomplete/invalid diagnosis date.",
    "status": "current"
  },
  "N315": {
    "text": "Missing/incomplete/invalid disability from date.",
    "status": "current"
  },
  "N316": {
    "text": "Missing/incomplete/invalid disability to date.",
    "status": "current"
  },
  "N317": {
    "text": "Missing/incomplete/invalid discharge hour.",
    "status": "current"
  },
  "N318": {
    "text": "Missing/incomplete/invalid discharge or end of care date.",
    "status": "current"
  },
  "N319": {
    "text": "Missing/incomplete/invalid hearing or vision prescription date.",
    "status": "current"
  },
  "N32": {
    "text": "Claim must be submitted by the provider who rendered the service.",
    "status": "current"
  },
  "N320": {
    "text": "Missing/incomplete/invalid Home Health Certification Period.",
    "status": "current"
  },
  "N321": {
    "text": "Missing/incomplete/invalid last admission period.",
    "status": "current"
  },
  "N322": {
    "text": "Missing/incomplete/invalid last certification date.",
    "status": "current"
  },
  "N323": {
    "text": "Missing/incomplete/invalid last contact date.",
    "status": "current"
  },
  "N324": {
    "text": "Missing/incomplete/invalid last seen/visit date.",
    "status": "current"
  },
  "N325": {
    "text": "Missing/incomplete/invalid last worked date.",
    "status": "current"
  },
  "N326": {
    "text": "Missing/incomplete/invalid last x-ray date.",
    "status": "current"
  },
  "N327": {
    "text": "Missing/incomplete/invalid other insured birth date.",
    "status": "current"
  },
  "N328": {
    "text": "Missing/incomplete/invalid Oxygen Saturation Test date.",
    "status": "current"
  },
  "N329": {
    "text": "Missing/incomplete/invalid patient birth date.",
    "status": "current"
  },
  "N33": {
    "text": "No record of health check prior to initiation of treatment.",
    "status": "current"
  },
  "N330": {
    "text": "Missing/incomplete/invalid patient death date.",
    "status": "current"
  },
  "N331": {
    "text": "Missing/incomplete/invalid physician order date.",
    "status": "current"
  },
  "N332": {
    "text": "Missing/incomplete/invalid prior hospital discharge date.",
    "status": "current"
  },
  "N333": {
    "text": "Missing/incomplete/invalid prior placement date.",
    "status": "current"
  },
  "N334": {
    "text": "Missing/incomplete/invalid re-evaluation date.",
    "status": "current"
  },
  "N335": {
    "text": "Missing/incomplete/invalid referral date.",
    "status": "current"
  },
  "N336": {
    "text": "Missing/incomplete/invalid replacement date.",
    "status": "current"
  },
  "N337": {
    "text": "Missing/incomplete/invalid secondary diagnosis date.",
    "status": "current"
  },
  "N338": {
    "text": "Missing/incomplete/invalid shipped date.",
    "status": "current"
  },
  "N339": {
    "text": "Missing/incomplete/invalid similar illness or symptom date.",
    "status": "current"
  },
  "N34": {
    "text": "Incorrect claim form/format for this service.",
    "status": "current"
  },
  "N340": {
    "text": "Missing/incomplete/invalid subscriber birth date.",
    "status": "current"
  },
  "N341": {
    "text": "Missing/incomplete/invalid surgery date.",
    "status": "current"
  },
  "N342": {
    "text": "Missing/incomplete/invalid test performed date.",
    "status": "current"
  },
  "N343": {
    "text": "Missing/incomplete/invalid Transcutaneous Electrical Nerve Stimulator (TENS) trial start date.",
    "status": "current"
  },
  "N344": {
    "text": "Missing/incomplete/invalid Transcutaneous Electrical Nerve Stimulator (TENS) trial end date.",
    "status": "current"
  },
  "N345": {
    "text": "Date range not valid with units submitted.",
    "status": "current"
  },
  "N346": {
    "text": "Missing/incomplete/invalid oral cavity designation code.",
    "status": "current"
  },
  "N347": {
    "text": "Your claim for a referred or purchased service cannot be paid because payment has already been made for this same service to another provider by a payment contractor representing the payer.",
    "status": "current"
  },
  "N348": {
    "text": "You chose that this service/supply/drug would be rendered/supplied and billed by a different practitioner/supplier.",
    "status": "current"
  },
  "N349": {
    "text": "The administration method and drug must be reported to adjudicate this service.",
    "status": "current"
  },
  "N35": {
    "text": "Program integrity/utilization review decision.",
    "status": "current"
  },
  "N350": {
    "text": "Missing/incomplete/invalid description of service for a Not Otherwise Classified (NOC) code or for an Unlisted/By Report procedure.",
    "status": "current"
  },
  "N351": {
    "text": "Service date outside of the approved treatment plan service dates.",
    "status": "current"
  },
  "N352": {
    "text": "Alert: There are no scheduled payments for this service. Submit a claim for each patient visit.",
    "status": "current"
  },
  "N353": {
    "text": "Alert: Benefits have been estimated, when the actual services have been rendered, additional payment will be considered based on the submitted claim.",
    "status": "current"
  },
  "N354": {
    "text": "Incomplete/invalid invoice.",
    "status": "current"
  },
  "N355": {
    "text": "Alert: The law permits exceptions to the refund requirement in two cases: - If you did not know, and could not have reasonably been expected to know, that we would not pay for this service; or - If you notified the patient in writing before providing the service that you believed that we were likely to deny the service, and the patient signed a statement agreeing to pay for the service. If you come within either exception, or if you believe the carrier was wrong in its determination that we do not pay for this service, you should request appeal of this determination within 30 days of the date of this notice. Your request for review should include any additional information necessary to support your position. If you request an appeal within 30 days of receiving this notice, you may delay refunding the amount to the patient until you receive the results of the review. If the review decision is favorable to you, you do not need to make any refund. If, however, the review is unfavorable, the law specifies that you must make the refund within 15 days of receiving the unfavorable review decision. The law also permits you to request an appeal at any time within 120 days of the date you receive this notice. However, an appeal request that is received more than 30 days after the date of this notice, does not permit you to delay making the refund. Regardless of when a review is requested, the patient will be notified that you have requested one, and will receive a copy of the determination. The patient has received a separate notice of this denial decision. The notice advises that he/she may be entitled to a refund of any amounts paid, if you should have known that we would not pay and did not tell him/her. It also instructs the patient to contact our office if he/she does not hear anything about a refund within 30 days",
    "status": "current"
  },
  "N356": {
    "text": "Not covered when performed with, or subsequent to, a non-covered service.",
    "status": "current"
  },
  "N357": {
    "text": "Time frame requirements between this service/procedure/supply and a related service/procedure/supply have not been met.",
    "status": "current"
  },
  "N358": {
    "text": "Alert: This decision may be reviewed if additional documentation as described in the contract or plan benefit documents is submitted.",
    "status": "current"
  },
  "N359": {
    "text": "Missing/incomplete/invalid height.",
    "status": "current"
  },
  "N36": {
    "text": "Claim must meet primary payer's processing requirements before we can consider payment.",
    "status": "current"
  },
  "N360": {
    "text": "Alert: Coordination of benefits has not been calculated when estimating benefits for this pre-determination. Submit payment information from the primary payer with the secondary claim.",
    "status": "current"
  },
  "N361": {
    "text": "Payment adjusted based on multiple diagnostic imaging procedure rules",
    "status": "deactivated"
  },
  "N362": {
    "text": "The number of Days or Units of Service exceeds our acceptable maximum.",
    "status": "current"
  },
  "N363": {
    "text": "Alert: in the near future we are implementing new policies/procedures that would affect this determination.",
    "status": "current"
  },
  "N364": {
    "text": "Alert: According to our agreement, you must waive the deductible and/or coinsurance amounts.",
    "status": "current"
  },
  "N365": {
    "text": "This procedure code is not payable. It is for reporting/information purposes only.",
    "status": "deactivated"
  },
  "N366": {
    "text": "Requested information not provided. The claim will be reopened if the information previously requested is submitted within one year after the date of this denial notice.",
    "status": "current"
  },
  "N367": {
    "text": "Alert: The claim information has been forwarded to a Consumer Spending Account processor for review; for example, flexible spending account or health savings account.",
    "status": "current"
  },
  "N368": {
    "text": "You must appeal the determination of the previously adjudicated claim.",
    "status": "current"
  },
  "N369": {
    "text": "Alert: Although this claim has been processed, it is deficient according to state legislation/regulation.",
    "status": "current"
  },
  "N37": {
    "text": "Missing/incomplete/invalid tooth number/letter.",
    "status": "current"
  },
  "N370": {
    "text": "Billing exceeds the rental months covered/approved by the payer.",
    "status": "current"
  },
  "N371": {
    "text": "Alert: title of this equipment must be transferred to the patient.",
    "status": "current"
  },
  "N372": {
    "text": "Only reasonable and necessary maintenance/service charges are covered.",
    "status": "current"
  },
  "N373": {
    "text": "It has been determined that another payer paid the services as primary when they were not the primary payer. Therefore, we are refunding to the payer that paid as primary on your behalf.",
    "status": "current"
  },
  "N374": {
    "text": "Primary Medicare Part A insurance has been exhausted and a Part B Remittance Advice is required.",
    "status": "current"
  },
  "N375": {
    "text": "Missing/incomplete/invalid questionnaire/information required to determine dependent eligibility.",
    "status": "current"
  },
  "N376": {
    "text": "Subscriber/patient is assigned to active military duty, therefore primary coverage may be TRICARE.",
    "status": "current"
  },
  "N377": {
    "text": "Payment based on a processed replacement claim.",
    "status": "current"
  },
  "N378": {
    "text": "Missing/incomplete/invalid prescription quantity.",
    "status": "current"
  },
  "N379": {
    "text": "Claim level information does not match line level information.",
    "status": "current"
  },
  "N38": {
    "text": "Missing/incomplete/invalid place of service.",
    "status": "deactivated"
  },
  "N380": {
    "text": "The original claim has been processed, submit a corrected claim.",
    "status": "current"
  },
  "N381": {
    "text": "Alert: Consult our contractual agreement for restrictions/billing/payment information related to these charges.",
    "status": "current"
  },
  "N382": {
    "text": "Missing/incomplete/invalid patient identifier.",
    "status": "current"
  },
  "N383": {
    "text": "Not covered when deemed cosmetic.",
    "status": "current"
  },
  "N384": {
    "text": "Records indicate that the referenced body part/tooth has been removed in a previous procedure.",
    "status": "current"
  },
  "N385": {
    "text": "Notification of admission was not timely according to published plan procedures.",
    "status": "current"
  },
  "N386": {
    "text": "This decision was based on a National Coverage Determination (NCD). An NCD provides a coverage determination as to whether a particular item or service is covered. Visit CMS.gov and search for Medicare Coverage Database to find a copy of the policy.",
    "status": "current"
  },
  "N387": {
    "text": "Alert: Submit this claim to the patient's other insurer for potential payment of supplemental benefits. We did not forward the claim information.",
    "status": "current"
  },
  "N388": {
    "text": "Missing/incomplete/invalid prescription number.",
    "status": "current"
  },
  "N389": {
    "text": "Duplicate prescription number submitted.",
    "status": "current"
  },
  "N39": {
    "text": "Procedure code is not compatible with tooth number/letter.",
    "status": "current"
  },
  "N390": {
    "text": "This service/report cannot be billed separately.",
    "status": "current"
  },
  "N391": {
    "text": "Missing emergency department records.",
    "status": "current"
  },
  "N392": {
    "text": "Incomplete/invalid emergency department records.",
    "status": "current"
  },
  "N393": {
    "text": "Missing progress notes/report.",
    "status": "current"
  },
  "N394": {
    "text": "Incomplete/invalid progress notes/report.",
    "status": "current"
  },
  "N395": {
    "text": "Missing laboratory report.",
    "status": "current"
  },
  "N396": {
    "text": "Incomplete/invalid laboratory report.",
    "status": "current"
  },
  "N397": {
    "text": "Benefits are not available for incomplete service(s)/undelivered item(s).",
    "status": "current"
  },
  "N398": {
    "text": "Missing elective consent form.",
    "status": "current"
  },
  "N399": {
    "text": "Incomplete/invalid elective consent form.",
    "status": "current"
  },
  "N4": {
    "text": "Missing/Incomplete/Invalid prior Insurance Carrier(s) EOB.",
    "status": "current"
  },
  "N40": {
    "text": "Missing radiology film(s)/image(s).",
    "status": "current"
  },
  "N400": {
    "text": "Alert: Electronically enabled providers should submit claims electronically.",
    "status": "current"
  },
  "N401": {
    "text": "Missing periodontal charting.",
    "status": "current"
  },
  "N402": {
    "text": "Incomplete/invalid periodontal charting.",
    "status": "current"
  },
  "N403": {
    "text": "Missing facility certification.",
    "status": "current"
  },
  "N404": {
    "text": "Incomplete/invalid facility certification.",
    "status": "current"
  },
  "N405": {
    "text": "This service is only covered when the donor's insurer(s) do not provide coverage for the service.",
    "status": "current"
  },
  "N406": {
    "text": "This service is only covered when the recipient's insurer(s) do not provide coverage for the service.",
    "status": "current"
  },
  "N407": {
    "text": "You are not an approved submitter for this transmission format.",
    "status": "current"
  },
  "N408": {
    "text": "This payer does not cover deductibles assessed by a previous payer.",
    "status": "current"
  },
  "N409": {
    "text": "This service is related to an accidental injury and is not covered unless provided within a specific time frame from the date of the accident.",
    "status": "current"
  },
  "N41": {
    "text": "Authorization request denied.",
    "status": "deactivated"
  },
  "N410": {
    "text": "Not covered unless the prescription changes.",
    "status": "current"
  },
  "N411": {
    "text": "This service is allowed one time in a 6-month period.",
    "status": "current"
  },
  "N412": {
    "text": "This service is allowed 2 times in a 12-month period.",
    "status": "current"
  },
  "N413": {
    "text": "This service is allowed 2 times in a benefit year.",
    "status": "current"
  },
  "N414": {
    "text": "This service is allowed 4 times in a 12-month period.",
    "status": "current"
  },
  "N415": {
    "text": "This service is allowed 1 time in an 18-month period.",
    "status": "current"
  },
  "N416": {
    "text": "This service is allowed 1 time in a 3-year period.",
    "status": "current"
  },
  "N417": {
    "text": "This service is allowed 1 time in a 5-year period.",
    "status": "current"
  },
  "N418": {
    "text": "Misrouted claim. See the payer's claim submission instructions.",
    "status": "current"
  },
  "N419": {
    "text": "Claim payment was the result of a payer's retroactive adjustment due to a retroactive rate change.",
    "status": "current"
  },
  "N42": {
    "text": "Missing mental health assessment.",
    "status": "current"
  },
  "N420": {
    "text": "Claim payment was the result of a payer's retroactive adjustment due to a Coordination of Benefits or Third Party Liability Recovery.",
    "status": "current"
  },
  "N421": {
    "text": "Claim payment was the result of a payer's retroactive adjustment due to a review organization decision.",
    "status": "current"
  },
  "N422": {
    "text": "Claim payment was the result of a payer's retroactive adjustment due to a payer's contract incentive program.",
    "status": "current"
  },
  "N423": {
    "text": "Claim payment was the result of a payer's retroactive adjustment due to a non standard program.",
    "status": "current"
  },
  "N424": {
    "text": "Patient does not reside in the geographic area required for this type of payment.",
    "status": "current"
  },
  "N425": {
    "text": "Statutorily excluded service(s).",
    "status": "current"
  },
  "N426": {
    "text": "No coverage when self-administered.",
    "status": "current"
  },
  "N427": {
    "text": "Payment for eyeglasses or contact lenses can be made only after cataract surgery.",
    "status": "current"
  },
  "N428": {
    "text": "Not covered when performed in this place of service.",
    "status": "current"
  },
  "N429": {
    "text": "Not covered when considered routine.",
    "status": "current"
  },
  "N43": {
    "text": "Bed hold or leave days exceeded.",
    "status": "current"
  },
  "N430": {
    "text": "Procedure code is inconsistent with the units billed.",
    "status": "current"
  },
  "N431": {
    "text": "Not covered with this procedure.",
    "status": "current"
  },
  "N432": {
    "text": "Alert: Adjustment based on a Recovery Audit.",
    "status": "current"
  },
  "N433": {
    "text": "Resubmit this claim using only your National Provider Identifier (NPI).",
    "status": "current"
  },
  "N434": {
    "text": "Missing/Incomplete/Invalid Present on Admission indicator.",
    "status": "current"
  },
  "N435": {
    "text": "Exceeds number/frequency approved /allowed within time period without support documentation.",
    "status": "current"
  },
  "N436": {
    "text": "The injury claim has not been accepted and a mandatory medical reimbursement has been made.",
    "status": "current"
  },
  "N437": {
    "text": "Alert: If the injury claim is accepted, these charges will be reconsidered.",
    "status": "current"
  },
  "N438": {
    "text": "This jurisdiction only accepts paper claims.",
    "status": "current"
  },
  "N439": {
    "text": "Missing anesthesia physical status report/indicators.",
    "status": "current"
  },
  "N44": {
    "text": "Payer's share of regulatory surcharges, assessments, allowances or health care-related taxes paid directly to the regulatory authority.",
    "status": "deactivated"
  },
  "N440": {
    "text": "Incomplete/invalid anesthesia physical status report/indicators.",
    "status": "current"
  },
  "N441": {
    "text": "This missed/cancelled appointment is not covered.",
    "status": "current"
  },
  "N442": {
    "text": "Payment based on an alternate fee schedule.",
    "status": "current"
  },
  "N443": {
    "text": "Missing/incomplete/invalid total time or begin/end time.",
    "status": "current"
  },
  "N444": {
    "text": "Alert: This facility has not filed the Election for High Cost Outlier form with the Division of Workers' Compensation.",
    "status": "current"
  },
  "N445": {
    "text": "Missing document for actual cost or paid amount.",
    "status": "current"
  },
  "N446": {
    "text": "Incomplete/invalid document for actual cost or paid amount.",
    "status": "current"
  },
  "N447": {
    "text": "Payment is based on a generic equivalent as required documentation was not provided.",
    "status": "current"
  },
  "N448": {
    "text": "This drug/service/supply is not included in the fee schedule or contracted/legislated fee arrangement.",
    "status": "current"
  },
  "N449": {
    "text": "Payment based on a comparable drug/service/supply.",
    "status": "current"
  },
  "N45": {
    "text": "Payment based on authorized amount.",
    "status": "current"
  },
  "N450": {
    "text": "Covered only when performed by the primary treating physician or the designee.",
    "status": "current"
  },
  "N451": {
    "text": "Missing Admission Summary Report.",
    "status": "current"
  },
  "N452": {
    "text": "Incomplete/invalid Admission Summary Report.",
    "status": "current"
  },
  "N453": {
    "text": "Missing Consultation Report.",
    "status": "current"
  },
  "N454": {
    "text": "Incomplete/invalid Consultation Report.",
    "status": "current"
  },
  "N455": {
    "text": "Missing Physician Order.",
    "status": "current"
  },
  "N456": {
    "text": "Incomplete/invalid Physician Order.",
    "status": "current"
  },
  "N457": {
    "text": "Missing Diagnostic Report.",
    "status": "current"
  },
  "N458": {
    "text": "Incomplete/invalid Diagnostic Report.",
    "status": "current"
  },
  "N459": {
    "text": "Missing Discharge Summary.",
    "status": "current"
  },
  "N46": {
    "text": "Missing/incomplete/invalid admission hour.",
    "status": "current"
  },
  "N460": {
    "text": "Incomplete/invalid Discharge Summary.",
    "status": "current"
  },
  "N461": {
    "text": "Missing Nursing Notes.",
    "status": "current"
  },
  "N462": {
    "text": "Incomplete/invalid Nursing Notes.",
    "status": "current"
  },
  "N463": {
    "text": "Missing support data for claim.",
    "status": "current"
  },
  "N464": {
    "text": "Incomplete/invalid support data for claim.",
    "status": "current"
  },
  "N465": {
    "text": "Missing Physical Therapy Notes/Report.",
    "status": "current"
  },
  "N466": {
    "text": "Incomplete/invalid Physical Therapy Notes/Report.",
    "status": "current"
  },
  "N467": {
    "text": "Missing Tests and Analysis Report.",
    "status": "current"
  },
  "N468": {
    "text": "Incomplete/invalid Report of Tests and Analysis Report.",
    "status": "current"
  },
  "N469": {
    "text": "Alert: Claim/Service(s) subject to appeal process, see section 935 of Medicare Prescription Drug, Improvement, and Modernization Act of 2003 (MMA).",
    "status": "current"
  },
  "N47": {
    "text": "Claim conflicts with another inpatient stay.",
    "status": "current"
  },
  "N470": {
    "text": "This payment will complete the mandatory medical reimbursement limit.",
    "status": "current"
  },
  "N471": {
    "text": "Missing/incomplete/invalid HIPPS Rate Code.",
    "status": "current"
  },
  "N472": {
    "text": "Payment for this service has been issued to another provider.",
    "status": "current"
  },
  "N473": {
    "text": "Missing certification.",
    "status": "current"
  },
  "N474": {
    "text": "Incomplete/invalid certification.",
    "status": "current"
  },
  "N475": {
    "text": "Missing completed referral form.",
    "status": "current"
  },
  "N476": {
    "text": "Incomplete/invalid completed referral form.",
    "status": "current"
  },
  "N477": {
    "text": "Missing Dental Models.",
    "status": "current"
  },
  "N478": {
    "text": "Incomplete/invalid Dental Models.",
    "status": "current"
  },
  "N479": {
    "text": "Missing Explanation of Benefits (Coordination of Benefits or Medicare Secondary Payer).",
    "status": "current"
  },
  "N48": {
    "text": "Claim information does not agree with information received from other insurance carrier.",
    "status": "current"
  },
  "N480": {
    "text": "Incomplete/invalid Explanation of Benefits (Coordination of Benefits or Medicare Secondary Payer).",
    "status": "current"
  },
  "N481": {
    "text": "Missing Models.",
    "status": "current"
  },
  "N482": {
    "text": "Incomplete/invalid Models.",
    "status": "current"
  },
  "N483": {
    "text": "Missing Periodontal Charts.",
    "status": "deactivated"
  },
  "N484": {
    "text": "Incomplete/invalid Periodontal Charts.",
    "status": "deactivated"
  },
  "N485": {
    "text": "Missing Physical Therapy Certification.",
    "status": "current"
  },
  "N486": {
    "text": "Incomplete/invalid Physical Therapy Certification.",
    "status": "current"
  },
  "N487": {
    "text": "Missing Prosthetics or Orthotics Certification.",
    "status": "current"
  },
  "N488": {
    "text": "Incomplete/invalid Prosthetics or Orthotics Certification.",
    "status": "current"
  },
  "N489": {
    "text": "Missing referral form.",
    "status": "current"
  },
  "N49": {
    "text": "Court ordered coverage information needs validation.",
    "status": "current"
  },
  "N490": {
    "text": "Incomplete/invalid referral form.",
    "status": "current"
  },
  "N491": {
    "text": "Missing/Incomplete/Invalid Exclusionary Rider Condition.",
    "status": "current"
  },
  "N492": {
    "text": "Alert: A network provider may bill the member for this service if the member requested the service and agreed in writing, prior to receiving the service, to be financially responsible for the billed charge.",
    "status": "current"
  },
  "N493": {
    "text": "Missing Doctor First Report of Injury.",
    "status": "current"
  },
  "N494": {
    "text": "Incomplete/invalid Doctor First Report of Injury.",
    "status": "current"
  },
  "N495": {
    "text": "Missing Supplemental Medical Report.",
    "status": "current"
  },
  "N496": {
    "text": "Incomplete/invalid Supplemental Medical Report.",
    "status": "current"
  },
  "N497": {
    "text": "Missing Medical Permanent Impairment or Disability Report.",
    "status": "current"
  },
  "N498": {
    "text": "Incomplete/invalid Medical Permanent Impairment or Disability Report.",
    "status": "current"
  },
  "N499": {
    "text": "Missing Medical Legal Report.",
    "status": "current"
  },
  "N5": {
    "text": "EOB received from previous payer. Claim not on file.",
    "status": "current"
  },
  "N50": {
    "text": "Missing/incomplete/invalid discharge information.",
    "status": "current"
  },
  "N500": {
    "text": "Incomplete/invalid Medical Legal Report.",
    "status": "current"
  },
  "N501": {
    "text": "Missing Vocational Report.",
    "status": "current"
  },
  "N502": {
    "text": "Incomplete/invalid Vocational Report.",
    "status": "current"
  },
  "N503": {
    "text": "Missing Work Status Report.",
    "status": "current"
  },
  "N504": {
    "text": "Incomplete/invalid Work Status Report.",
    "status": "current"
  },
  "N505": {
    "text": "Alert: This response includes only services that could be estimated in real-time. No estimate will be provided for the services that could not be estimated in real-time.",
    "status": "current"
  },
  "N506": {
    "text": "Alert: This is an estimate of the member's liability based on the information available at the time the estimate was processed. Actual coverage and member liability amounts will be determined when the claim is processed. This is not a pre-authorization or a guarantee of payment.",
    "status": "current"
  },
  "N507": {
    "text": "Plan distance requirements have not been met.",
    "status": "current"
  },
  "N508": {
    "text": "Alert: This real-time claim adjudication response represents the member responsibility to the provider for services reported. The member will receive an Explanation of Benefits electronically or in the mail. Contact the insurer if there are any questions.",
    "status": "current"
  },
  "N509": {
    "text": "Alert: A current inquiry shows the member's Consumer Spending Account contains sufficient funds to cover the member liability for this claim/service. Actual payment from the Consumer Spending Account will depend on the availability of funds and determination of eligible services at the time of payment processing.",
    "status": "current"
  },
  "N51": {
    "text": "Electronic interchange agreement not on file for provider/submitter.",
    "status": "current"
  },
  "N510": {
    "text": "Alert: A current inquiry shows the member's Consumer Spending Account does not contain sufficient funds to cover the member's liability for this claim/service. Actual payment from the Consumer Spending Account will depend on the availability of funds and determination of eligible services at the time of payment processing.",
    "status": "current"
  },
  "N511": {
    "text": "Alert: Information on the availability of Consumer Spending Account funds to cover the member liability on this claim/service is not available at this time.",
    "status": "current"
  },
  "N512": {
    "text": "Alert: This is the initial remit of a non-NCPDP claim originally submitted real-time without change to the adjudication.",
    "status": "current"
  },
  "N513": {
    "text": "Alert: This is the initial remit of a non-NCPDP claim originally submitted real-time with a change to the adjudication.",
    "status": "current"
  },
  "N514": {
    "text": "Consult plan benefit documents/guidelines for information about restrictions for this service.",
    "status": "deactivated"
  },
  "N515": {
    "text": "Alert: Submit this claim to the patient's other insurer for potential payment of supplemental benefits. We did not forward the claim information. (use N387 instead)",
    "status": "deactivated"
  },
  "N516": {
    "text": "Records indicate a mismatch between the submitted NPI and EIN.",
    "status": "current"
  },
  "N517": {
    "text": "Resubmit a new claim with the requested information.",
    "status": "current"
  },
  "N518": {
    "text": "No separate payment for accessories when furnished for use with oxygen equipment.",
    "status": "current"
  },
  "N519": {
    "text": "Invalid combination of HCPCS modifiers.",
    "status": "current"
  },
  "N52": {
    "text": "Patient not enrolled in the billing provider's managed care plan on the date of service.",
    "status": "current"
  },
  "N520": {
    "text": "Alert: Payment made from a Consumer Spending Account.",
    "status": "current"
  },
  "N521": {
    "text": "Mismatch between the submitted provider information and the provider information stored in our system.",
    "status": "current"
  },
  "N522": {
    "text": "Duplicate of a claim processed, or to be processed, as a crossover claim.",
    "status": "current"
  },
  "N523": {
    "text": "The limitation on outlier payments defined by this payer for this service period has been met. The outlier payment otherwise applicable to this claim has not been paid.",
    "status": "current"
  },
  "N524": {
    "text": "Based on policy this payment constitutes payment in full.",
    "status": "current"
  },
  "N525": {
    "text": "These services are not covered when performed within the global period of another service.",
    "status": "current"
  },
  "N526": {
    "text": "Not qualified for recovery based on employer size.",
    "status": "current"
  },
  "N527": {
    "text": "We processed this claim as the primary payer prior to receiving the recovery demand.",
    "status": "current"
  },
  "N528": {
    "text": "Patient is entitled to benefits for Institutional Services only.",
    "status": "current"
  },
  "N529": {
    "text": "Patient is entitled to benefits for Professional Services only.",
    "status": "current"
  },
  "N53": {
    "text": "Missing/incomplete/invalid point of pick-up address.",
    "status": "current"
  },
  "N530": {
    "text": "Not Qualified for Recovery based on enrollment information.",
    "status": "current"
  },
  "N531": {
    "text": "Not qualified for recovery based on direct payment of premium.",
    "status": "current"
  },
  "N532": {
    "text": "Not qualified for recovery based on disability and working status.",
    "status": "current"
  },
  "N533": {
    "text": "Services performed in an Indian Health Services facility under a self-insured tribal Group Health Plan.",
    "status": "current"
  },
  "N534": {
    "text": "This is an individual policy, the employer does not participate in plan sponsorship.",
    "status": "current"
  },
  "N535": {
    "text": "Payment is adjusted when procedure is performed in this place of service based on the submitted procedure code and place of service.",
    "status": "current"
  },
  "N536": {
    "text": "We are not changing the prior payer's determination of patient responsibility, which you may collect, as this service is not covered by us.",
    "status": "current"
  },
  "N537": {
    "text": "We have examined claims history and no records of the services have been found.",
    "status": "current"
  },
  "N538": {
    "text": "A facility is responsible for payment to outside providers who furnish these services/supplies/drugs to its patients/residents.",
    "status": "current"
  },
  "N539": {
    "text": "Alert: We processed appeals/waiver requests on your behalf and that request has been denied.",
    "status": "current"
  },
  "N54": {
    "text": "Claim information is inconsistent with pre-certified/authorized services.",
    "status": "current"
  },
  "N540": {
    "text": "Payment adjusted based on the interrupted stay policy.",
    "status": "current"
  },
  "N541": {
    "text": "Mismatch between the submitted insurance type code and the information stored in our system.",
    "status": "current"
  },
  "N542": {
    "text": "Missing income verification.",
    "status": "current"
  },
  "N543": {
    "text": "Incomplete/invalid income verification.",
    "status": "current"
  },
  "N544": {
    "text": "Alert: Although this was paid, you have billed with a referring/ordering provider that does not match our system record. Unless corrected this will not be paid in the future.",
    "status": "current"
  },
  "N545": {
    "text": "Payment reduced based on status as an unsuccessful eprescriber per the Electronic Prescribing (eRx) Incentive Program.",
    "status": "current"
  },
  "N546": {
    "text": "Payment represents a previous reduction based on the Electronic Prescribing (eRx) Incentive Program.",
    "status": "current"
  },
  "N547": {
    "text": "A refund request (Frequency Type Code 8) was processed previously.",
    "status": "current"
  },
  "N548": {
    "text": "Alert: Patient's calendar year deductible has been met.",
    "status": "current"
  },
  "N549": {
    "text": "Alert: Patient's calendar year out-of-pocket maximum has been met.",
    "status": "current"
  },
  "N55": {
    "text": "Procedures for billing with group/referring/performing providers were not followed.",
    "status": "current"
  },
  "N550": {
    "text": "Alert: You have not responded to requests to revalidate your provider/supplier enrollment information. Your failure to revalidate your enrollment information will result in a payment hold in the near future.",
    "status": "current"
  },
  "N551": {
    "text": "Payment adjusted based on the Ambulatory Surgical Center (ASC) Quality Reporting Program.",
    "status": "current"
  },
  "N552": {
    "text": "Payment adjusted to reverse a previous withhold/bonus amount.",
    "status": "current"
  },
  "N553": {
    "text": "Payment adjusted based on a Low Income Subsidy (LIS) retroactive coverage or status change.",
    "status": "deactivated"
  },
  "N554": {
    "text": "Missing/Incomplete/Invalid Family Planning Indicator.",
    "status": "current"
  },
  "N555": {
    "text": "Missing medication list.",
    "status": "current"
  },
  "N556": {
    "text": "Incomplete/invalid medication list.",
    "status": "current"
  },
  "N557": {
    "text": "This claim/service is not payable under our service area. The claim must be filed to the Payer/Plan in whose service area the specimen was collected.",
    "status": "current"
  },
  "N558": {
    "text": "This claim/service is not payable under our service area. The claim must be filed to the Payer/Plan in whose service area the equipment was received.",
    "status": "current"
  },
  "N559": {
    "text": "This claim/service is not payable under our service area. The claim must be filed to the Payer/Plan in whose service area the Ordering Physician is located.",
    "status": "current"
  },
  "N56": {
    "text": "Procedure code billed is not correct/valid for the services billed or the date of service billed.",
    "status": "current"
  },
  "N560": {
    "text": "The pilot program requires an interim or final claim within 60 days of the Notice of Admission. A claim was not received.",
    "status": "current"
  },
  "N561": {
    "text": "The bundled claim originally submitted for this episode of care includes related readmissions. You may resubmit the original claim to receive a corrected payment based on this readmission.",
    "status": "current"
  },
  "N562": {
    "text": "The provider number of your incoming claim does not match the provider number on the processed Notice of Admission (NOA) for this bundled payment.",
    "status": "current"
  },
  "N563": {
    "text": "Alert: Missing required provider/supplier issuance of advance patient notice of non-coverage. The patient is not liable for payment for this service.",
    "status": "current"
  },
  "N564": {
    "text": "Patient did not meet the inclusion criteria for the demonstration project or pilot program.",
    "status": "current"
  },
  "N565": {
    "text": "Alert: This non-payable reporting code requires a modifier. Future claims containing this non-payable reporting code must include an appropriate modifier for the claim to be processed.",
    "status": "current"
  },
  "N566": {
    "text": "Alert: This procedure code requires functional reporting. Future claims containing this procedure code must include an applicable non-payable code and appropriate modifiers for the claim to be processed.",
    "status": "current"
  },
  "N567": {
    "text": "Not covered when considered preventative.",
    "status": "current"
  },
  "N568": {
    "text": "Alert: Initial payment based on the Notice of Admission (NOA) under the Bundled Payment Model IV initiative.",
    "status": "current"
  },
  "N569": {
    "text": "Not covered when performed for the reported diagnosis.",
    "status": "current"
  },
  "N57": {
    "text": "Missing/incomplete/invalid prescribing date.",
    "status": "current"
  },
  "N570": {
    "text": "Missing/incomplete/invalid credentialing data.",
    "status": "current"
  },
  "N571": {
    "text": "Alert: Payment will be issued quarterly by another payer/contractor.",
    "status": "current"
  },
  "N572": {
    "text": "This procedure is not payable unless appropriate non-payable reporting codes and associated modifiers are submitted.",
    "status": "current"
  },
  "N573": {
    "text": "Alert: You have been overpaid and must refund the overpayment. The refund will be requested separately by another payer/contractor.",
    "status": "current"
  },
  "N574": {
    "text": "Our records indicate the ordering/referring provider is of a type/specialty that cannot order or refer. Please verify that the claim ordering/referring provider information is accurate or contact the ordering/referring provider.",
    "status": "current"
  },
  "N575": {
    "text": "Mismatch between the submitted ordering/referring provider name and the ordering/referring provider name stored in our records.",
    "status": "current"
  },
  "N576": {
    "text": "Services not related to the specific incident/claim/accident/loss being reported.",
    "status": "current"
  },
  "N577": {
    "text": "Personal Injury Protection (PIP) Coverage.",
    "status": "current"
  },
  "N578": {
    "text": "Coverages do not apply to this loss.",
    "status": "current"
  },
  "N579": {
    "text": "Medical Payments Coverage (MPC).",
    "status": "current"
  },
  "N58": {
    "text": "Missing/incomplete/invalid patient liability amount.",
    "status": "current"
  },
  "N580": {
    "text": "Determination based on the provisions of the insurance policy.",
    "status": "current"
  },
  "N581": {
    "text": "Investigation of coverage eligibility is pending.",
    "status": "current"
  },
  "N582": {
    "text": "Benefits suspended pending the patient's cooperation.",
    "status": "current"
  },
  "N583": {
    "text": "Patient was not an occupant of our insured vehicle and therefore, is not an eligible injured person.",
    "status": "current"
  },
  "N584": {
    "text": "Not covered based on the insured's noncompliance with policy or statutory conditions.",
    "status": "current"
  },
  "N585": {
    "text": "Benefits are no longer available based on a final injury settlement.",
    "status": "current"
  },
  "N586": {
    "text": "The injured party does not qualify for benefits.",
    "status": "current"
  },
  "N587": {
    "text": "Policy benefits have been exhausted.",
    "status": "current"
  },
  "N588": {
    "text": "The patient has instructed that medical claims/bills are not to be paid.",
    "status": "current"
  },
  "N589": {
    "text": "Coverage is excluded to any person injured as a result of operating a motor vehicle while in an intoxicated condition or while the ability to operate such a vehicle is impaired by the use of a drug.",
    "status": "current"
  },
  "N59": {
    "text": "Alert: Please refer to your provider manual for additional program and provider information.",
    "status": "current"
  },
  "N590": {
    "text": "Missing independent medical exam detailing the cause of injuries sustained and medical necessity of services rendered.",
    "status": "current"
  },
  "N591": {
    "text": "Payment based on an Independent Medical Examination (IME) or Utilization Review (UR).",
    "status": "current"
  },
  "N592": {
    "text": "Adjusted because this is not the initial prescription or exceeds the amount allowed for the initial prescription.",
    "status": "current"
  },
  "N593": {
    "text": "Not covered based on failure to attend a scheduled Independent Medical Exam (IME).",
    "status": "current"
  },
  "N594": {
    "text": "Records reflect the injured party did not complete an Application for Benefits for this loss.",
    "status": "current"
  },
  "N595": {
    "text": "Records reflect the injured party did not complete an Assignment of Benefits for this loss.",
    "status": "current"
  },
  "N596": {
    "text": "Records reflect the injured party did not complete a Medical Authorization for this loss.",
    "status": "current"
  },
  "N597": {
    "text": "Adjusted based on a medical/dental provider's apportionment of care between related injuries and other unrelated medical/dental conditions/injuries.",
    "status": "current"
  },
  "N598": {
    "text": "Health care policy coverage is primary.",
    "status": "current"
  },
  "N599": {
    "text": "Our payment for this service is based upon a reasonable amount pursuant to both the terms and conditions of the policy of insurance under which the subject claim is being made as well as the Florida No-Fault Statute, which permits, when determining a reasonable charge for a service, an insurer to consider usual and customary charges and payments accepted by the provider, reimbursement levels in the community and various federal and state fee schedules applicable to automobile and other insurance coverages, and other information relevant to the reasonableness of the reimbursement for the service. The payment for this service is based upon 200% of the Participating Level of Medicare Part B fee schedule for the locale in which the services were rendered.",
    "status": "current"
  },
  "N6": {
    "text": "Under FEHB law (U.S.C. 8904(b)), we cannot pay more for covered care than the amount Medicare would have allowed if the patient were enrolled in Medicare Part A and/or Medicare Part B.",
    "status": "current"
  },
  "N60": {
    "text": "A valid NDC is required for payment of drug claims effective October 02.",
    "status": "deactivated"
  },
  "N600": {
    "text": "Adjusted based on the applicable fee schedule for the region in which the service was rendered.",
    "status": "current"
  },
  "N601": {
    "text": "In accordance with Hawaii Administrative Rules, Title 16, Chapter 23 Motor Vehicle Insurance Law payment is recommended based on Medicare Resource Based Relative Value Scale System applicable to Hawaii.",
    "status": "current"
  },
  "N602": {
    "text": "Adjusted based on the Redbook maximum allowance.",
    "status": "current"
  },
  "N603": {
    "text": "This fee is calculated according to the New Jersey medical fee schedules for Automobile Personal Injury Protection and Motor Bus Medical Expense Insurance Coverage.",
    "status": "current"
  },
  "N604": {
    "text": "In accordance with New York No-Fault Law, Regulation 68, this base fee was calculated according to the New York Workers' Compensation Board Schedule of Medical Fees, pursuant to Regulation 83 and / or Appendix 17-C of 11 NYCRR.",
    "status": "current"
  },
  "N605": {
    "text": "This fee was calculated based upon New York All Patients Refined Diagnosis Related Groups (APR-DRG), pursuant to Regulation 68.",
    "status": "current"
  },
  "N606": {
    "text": "The Oregon allowed amount for this procedure is based upon the Workers Compensation Fee Schedule (OAR 436-009). The allowed amount has been calculated in accordance with Section 4 of ORS 742.524.",
    "status": "current"
  },
  "N607": {
    "text": "Service provided for non-compensable condition(s).",
    "status": "current"
  },
  "N608": {
    "text": "The fee schedule amount allowed is calculated at 110% of the Medicare Fee Schedule for this region, specialty and type of service. This fee is calculated in compliance with Act 6.",
    "status": "current"
  },
  "N609": {
    "text": "80% of the provider's billed amount is being recommended for payment according to Act 6.",
    "status": "current"
  },
  "N61": {
    "text": "Rebill services on separate claims.",
    "status": "current"
  },
  "N610": {
    "text": "Alert: Payment based on an appropriate level of care.",
    "status": "current"
  },
  "N611": {
    "text": "Claim in litigation. Contact insurer for more information.",
    "status": "current"
  },
  "N612": {
    "text": "Medical provider not authorized/certified to provide treatment to injured workers in this jurisdiction.",
    "status": "current"
  },
  "N613": {
    "text": "Alert: Although this was paid, you have billed with an ordering provider that needs to update their enrollment record. Please verify that the ordering provider information you submitted on the claim is accurate and if it is, contact the ordering provider instructing them to update their enrollment record. Unless corrected, a claim with this ordering provider will not be paid in the future.",
    "status": "current"
  },
  "N614": {
    "text": "Alert: Additional information is included in the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information).",
    "status": "current"
  },
  "N615": {
    "text": "Alert: This enrollee receiving advance payments of the premium tax credit is in the grace period of three consecutive months for non-payment of premium. Under 45 CFR 156.270, a Qualified Health Plan issuer must pay all appropriate claims for services rendered to the enrollee during the first month of the grace period and may pend claims for services rendered to the enrollee in the second and third months of the grace period.",
    "status": "current"
  },
  "N616": {
    "text": "Alert: This enrollee is in the first month of the advance premium tax credit grace period.",
    "status": "current"
  },
  "N617": {
    "text": "This enrollee is in the second or third month of the advance premium tax credit grace period.",
    "status": "current"
  },
  "N618": {
    "text": "Alert: This claim will automatically be reprocessed if the enrollee pays their premiums.",
    "status": "current"
  },
  "N619": {
    "text": "Coverage terminated for non-payment of premium.",
    "status": "current"
  },
  "N62": {
    "text": "Dates of service span multiple rate periods. Resubmit separate claims.",
    "status": "current"
  },
  "N620": {
    "text": "Alert: This procedure code is for quality reporting/informational purposes only.",
    "status": "current"
  },
  "N621": {
    "text": "Charges for Jurisdiction required forms, reports, or chart notes are not payable.",
    "status": "current"
  },
  "N622": {
    "text": "Not covered based on the date of injury/accident.",
    "status": "current"
  },
  "N623": {
    "text": "Not covered when deemed unscientific/unproven/outmoded/experimental/excessive/inappropriate.",
    "status": "current"
  },
  "N624": {
    "text": "The associated Workers' Compensation claim has been withdrawn.",
    "status": "current"
  },
  "N625": {
    "text": "Missing/Incomplete/Invalid Workers' Compensation Claim Number.",
    "status": "current"
  },
  "N626": {
    "text": "New or established patient E/M codes are not payable with chiropractic care codes.",
    "status": "current"
  },
  "N627": {
    "text": "Service not payable per managed care contract.",
    "status": "deactivated"
  },
  "N628": {
    "text": "Out-patient follow up visits on the same date of service as a scheduled test or treatment is disallowed.",
    "status": "current"
  },
  "N629": {
    "text": "Reviews/documentation/notes/summaries/reports/charts not requested.",
    "status": "current"
  },
  "N63": {
    "text": "Rebill services on separate claim lines.",
    "status": "current"
  },
  "N630": {
    "text": "Referral not authorized by attending physician.",
    "status": "current"
  },
  "N631": {
    "text": "Medical Fee Schedule does not list this code. An allowance was made for a comparable service.",
    "status": "current"
  },
  "N632": {
    "text": "According to the Official Medical Fee Schedule this service has a relative value of zero and therefore no payment is due.",
    "status": "deactivated"
  },
  "N633": {
    "text": "Additional anesthesia time units are not allowed.",
    "status": "current"
  },
  "N634": {
    "text": "The allowance is calculated based on anesthesia time units.",
    "status": "current"
  },
  "N635": {
    "text": "The Allowance is calculated based on the anesthesia base units plus time.",
    "status": "current"
  },
  "N636": {
    "text": "Adjusted because this is reimbursable only once per injury.",
    "status": "current"
  },
  "N637": {
    "text": "Consultations are not allowed once treatment has been rendered by the same provider.",
    "status": "current"
  },
  "N638": {
    "text": "Reimbursement has been made according to the home health fee schedule.",
    "status": "current"
  },
  "N639": {
    "text": "Reimbursement has been made according to the inpatient rehabilitation facilities fee schedule.",
    "status": "current"
  },
  "N64": {
    "text": "The 'from' and 'to' dates must be different.",
    "status": "current"
  },
  "N640": {
    "text": "Exceeds number/frequency approved/allowed within time period.",
    "status": "current"
  },
  "N641": {
    "text": "Reimbursement has been based on the number of body areas rated.",
    "status": "current"
  },
  "N642": {
    "text": "Adjusted when billed as individual tests instead of as a panel.",
    "status": "current"
  },
  "N643": {
    "text": "The services billed are considered Not Covered or Non-Covered (NC) in the applicable state fee schedule.",
    "status": "current"
  },
  "N644": {
    "text": "Reimbursement has been made according to the bilateral procedure rule.",
    "status": "current"
  },
  "N645": {
    "text": "Mark-up allowance.",
    "status": "current"
  },
  "N646": {
    "text": "Reimbursement has been adjusted based on the guidelines for an assistant.",
    "status": "current"
  },
  "N647": {
    "text": "Adjusted based on diagnosis-related group (DRG).",
    "status": "current"
  },
  "N648": {
    "text": "Adjusted based on Stop Loss.",
    "status": "current"
  },
  "N649": {
    "text": "Payment based on invoice.",
    "status": "current"
  },
  "N65": {
    "text": "Procedure code or procedure rate count cannot be determined, or was not on file, for the date of service/provider.",
    "status": "current"
  },
  "N650": {
    "text": "This policy was not in effect for this date of loss. No coverage is available.",
    "status": "current"
  },
  "N651": {
    "text": "No Personal Injury Protection/Medical Payments Coverage on the policy at the time of the loss.",
    "status": "current"
  },
  "N652": {
    "text": "The date of service is before the date of loss.",
    "status": "current"
  },
  "N653": {
    "text": "The date of injury does not match the reported date of loss.",
    "status": "current"
  },
  "N654": {
    "text": "Adjusted based on achievement of maximum medical improvement (MMI).",
    "status": "current"
  },
  "N655": {
    "text": "Payment based on provider's geographic region.",
    "status": "current"
  },
  "N656": {
    "text": "An interest payment is being made because benefits are being paid outside the statutory requirement.",
    "status": "current"
  },
  "N657": {
    "text": "This should be billed with the appropriate code for these services.",
    "status": "current"
  },
  "N658": {
    "text": "The billed service(s) are not considered medical expenses.",
    "status": "current"
  },
  "N659": {
    "text": "This item is exempt from sales tax.",
    "status": "current"
  },
  "N66": {
    "text": "Missing/incomplete/invalid documentation.",
    "status": "deactivated"
  },
  "N660": {
    "text": "Sales tax has been included in the reimbursement.",
    "status": "current"
  },
  "N661": {
    "text": "Documentation does not support that the services rendered were medically necessary.",
    "status": "current"
  },
  "N662": {
    "text": "Alert: Consideration of payment will be made upon receipt of a final bill.",
    "status": "current"
  },
  "N663": {
    "text": "Adjusted based on an agreed amount.",
    "status": "current"
  },
  "N664": {
    "text": "Adjusted based on a legal settlement.",
    "status": "current"
  },
  "N665": {
    "text": "Services by an unlicensed provider are not reimbursable.",
    "status": "current"
  },
  "N666": {
    "text": "Only one evaluation and management code at this service level is covered during the course of care.",
    "status": "current"
  },
  "N667": {
    "text": "Missing prescription.",
    "status": "current"
  },
  "N668": {
    "text": "Incomplete/invalid prescription.",
    "status": "current"
  },
  "N669": {
    "text": "Adjusted based on the Medicare fee schedule.",
    "status": "current"
  },
  "N67": {
    "text": "Professional provider services not paid separately. Included in facility payment under a demonstration project. Apply to that facility for payment, or resubmit your claim if: the facility notifies you the patient was excluded from this demonstration; or if you furnished these services in another location on the date of the patient's admission or discharge from a demonstration hospital. If services were furnished in a facility not involved in the demonstration on the same date the patient was discharged from or admitted to a demonstration facility, you must report the provider ID number for the non-demonstration facility on the new claim.",
    "status": "current"
  },
  "N670": {
    "text": "This service code has been identified as the primary procedure code subject to the Medicare Multiple Procedure Payment Reduction (MPPR) rule.",
    "status": "current"
  },
  "N671": {
    "text": "Payment based on a jurisdiction cost-charge ratio.",
    "status": "current"
  },
  "N672": {
    "text": "Alert: Amount applied to Health Insurance Offset.",
    "status": "current"
  },
  "N673": {
    "text": "Reimbursement has been calculated based on an outpatient per diem or an outpatient factor and/or fee schedule amount.",
    "status": "current"
  },
  "N674": {
    "text": "Not covered unless a pre-requisite procedure/service has been provided.",
    "status": "current"
  },
  "N675": {
    "text": "Additional information is required from the injured party.",
    "status": "current"
  },
  "N676": {
    "text": "Service does not qualify for payment under the Outpatient Facility Fee Schedule.",
    "status": "current"
  },
  "N677": {
    "text": "Alert: Films/Images will not be returned.",
    "status": "current"
  },
  "N678": {
    "text": "Missing post-operative images/visual field results.",
    "status": "current"
  },
  "N679": {
    "text": "Incomplete/Invalid post-operative images/visual field results.",
    "status": "current"
  },
  "N68": {
    "text": "Prior payment being cancelled as we were subsequently notified this patient was covered by a demonstration project in this site of service. Professional services were included in the payment made to the facility. You must contact the facility for your payment. Prior payment made to you by the patient or another insurer for this claim must be refunded to the payer within 30 days.",
    "status": "current"
  },
  "N680": {
    "text": "Missing/Incomplete/Invalid date of previous dental extractions.",
    "status": "current"
  },
  "N681": {
    "text": "Missing/Incomplete/Invalid full arch series.",
    "status": "current"
  },
  "N682": {
    "text": "Missing/Incomplete/Invalid history of prior periodontal therapy/maintenance.",
    "status": "current"
  },
  "N683": {
    "text": "Missing/Incomplete/Invalid prior treatment documentation.",
    "status": "current"
  },
  "N684": {
    "text": "Payment denied as this is a specialty claim submitted as a general claim.",
    "status": "current"
  },
  "N685": {
    "text": "Missing/Incomplete/Invalid Prosthesis, Crown or Inlay Code.",
    "status": "current"
  },
  "N686": {
    "text": "Missing/incomplete/Invalid questionnaire needed to complete payment determination.",
    "status": "current"
  },
  "N687": {
    "text": "Alert: This reversal is due to a retroactive disenrollment.",
    "status": "current"
  },
  "N688": {
    "text": "Alert: This reversal is due to a medical or utilization review decision.",
    "status": "current"
  },
  "N689": {
    "text": "Alert: This reversal is due to a retroactive rate change.",
    "status": "current"
  },
  "N69": {
    "text": "Alert: PPS (Prospective Payment System) code changed by claims processing system.",
    "status": "current"
  },
  "N690": {
    "text": "Alert: This reversal is due to a provider submitted appeal.",
    "status": "current"
  },
  "N691": {
    "text": "Alert: This reversal is due to a patient submitted appeal.",
    "status": "current"
  },
  "N692": {
    "text": "Alert: This reversal is due to an incorrect rate on the initial adjudication.",
    "status": "current"
  },
  "N693": {
    "text": "Alert: This reversal is due to a cancellation of the claim by the provider.",
    "status": "current"
  },
  "N694": {
    "text": "Alert: This reversal is due to a resubmission/change to the claim by the provider.",
    "status": "current"
  },
  "N695": {
    "text": "Alert: This reversal is due to incorrect patient financial responsibility information on the initial adjudication.",
    "status": "current"
  },
  "N696": {
    "text": "Alert: This reversal is due to a Coordination of Benefits or Third Party Liability Recovery retroactive adjustment.",
    "status": "current"
  },
  "N697": {
    "text": "Alert: This reversal is due to a payer's retroactive contract incentive program adjustment.",
    "status": "current"
  },
  "N698": {
    "text": "Alert: This reversal is due to non-payment of the health insurance premiums (Health Insurance Exchange or other) by the end of the premium payment grace period, resulting in loss of coverage.",
    "status": "current"
  },
  "N699": {
    "text": "Payment adjusted based on the Physician Quality Reporting System (PQRS) Incentive Program.",
    "status": "current"
  },
  "N7": {
    "text": "Alert: Processing of this claim/service has included consideration under Major Medical provisions.",
    "status": "current"
  },
  "N70": {
    "text": "Consolidated billing and payment applies.",
    "status": "current"
  },
  "N700": {
    "text": "Payment adjusted based on the Electronic Health Records (EHR) Incentive Program.",
    "status": "current"
  },
  "N701": {
    "text": "Payment adjusted based on the Value-based Payment Modifier.",
    "status": "current"
  },
  "N702": {
    "text": "Decision based on review of previously adjudicated claims or for claims in process for the same/similar type of services.",
    "status": "current"
  },
  "N703": {
    "text": "This service is incompatible with previously adjudicated claims or claims in process.",
    "status": "current"
  },
  "N704": {
    "text": "Alert: You may not appeal this decision but can resubmit this claim/service with corrected information if warranted.",
    "status": "current"
  },
  "N705": {
    "text": "Incomplete/invalid documentation.",
    "status": "current"
  },
  "N706": {
    "text": "Missing documentation.",
    "status": "current"
  },
  "N707": {
    "text": "Incomplete/invalid orders.",
    "status": "current"
  },
  "N708": {
    "text": "Missing orders.",
    "status": "current"
  },
  "N709": {
    "text": "Incomplete/invalid notes.",
    "status": "current"
  },
  "N71": {
    "text": "Your unassigned claim for a drug or biological, clinical diagnostic laboratory services or ambulance service was processed as an assigned claim. You are required by law to accept assignment for these types of claims.",
    "status": "current"
  },
  "N710": {
    "text": "Missing notes.",
    "status": "current"
  },
  "N711": {
    "text": "Incomplete/invalid summary.",
    "status": "current"
  },
  "N712": {
    "text": "Missing summary.",
    "status": "current"
  },
  "N713": {
    "text": "Incomplete/invalid report.",
    "status": "current"
  },
  "N714": {
    "text": "Missing report.",
    "status": "current"
  },
  "N715": {
    "text": "Incomplete/invalid chart.",
    "status": "current"
  },
  "N716": {
    "text": "Missing chart.",
    "status": "current"
  },
  "N717": {
    "text": "Incomplete/Invalid documentation of face-to-face examination.",
    "status": "current"
  },
  "N718": {
    "text": "Missing documentation of face-to-face examination.",
    "status": "current"
  },
  "N719": {
    "text": "Penalty applied based on plan requirements not being met.",
    "status": "current"
  },
  "N72": {
    "text": "PPS (Prospective Payment System) code changed by medical reviewers. Not supported by clinical records.",
    "status": "current"
  },
  "N720": {
    "text": "Alert: The patient overpaid you. You may need to issue the patient a refund for the difference between the patient's payment and the amount shown as patient responsibility on this notice.",
    "status": "current"
  },
  "N721": {
    "text": "This service is only covered when performed as part of a clinical trial.",
    "status": "current"
  },
  "N722": {
    "text": "Patient must use Workers' Compensation Set-Aside (WCSA) funds to pay for the medical service or item.",
    "status": "current"
  },
  "N723": {
    "text": "Patient must use Liability set-aside (LSA) funds to pay for the medical service or item.",
    "status": "current"
  },
  "N724": {
    "text": "Patient must use No-Fault set-aside (NFSA) funds to pay for the medical service or item.",
    "status": "current"
  },
  "N725": {
    "text": "A liability insurer has reported having ongoing responsibility for medical services (ORM) for this diagnosis.",
    "status": "current"
  },
  "N726": {
    "text": "A conditional payment is not allowed.",
    "status": "current"
  },
  "N727": {
    "text": "A no-fault insurer has reported having ongoing responsibility for medical services (ORM) for this diagnosis.",
    "status": "current"
  },
  "N728": {
    "text": "A workers' compensation insurer has reported having ongoing responsibility for medical services (ORM) for this diagnosis.",
    "status": "current"
  },
  "N729": {
    "text": "Missing patient medical/dental record for this service.",
    "status": "current"
  },
  "N73": {
    "text": "A Skilled Nursing Facility is responsible for payment of outside providers who furnish these services/supplies under arrangement to its residents.",
    "status": "deactivated"
  },
  "N730": {
    "text": "Incomplete/invalid patient medical/dental record for this service.",
    "status": "current"
  },
  "N731": {
    "text": "Incomplete/Invalid mental health assessment.",
    "status": "current"
  },
  "N732": {
    "text": "Services performed at an unlicensed facility are not reimbursable.",
    "status": "current"
  },
  "N733": {
    "text": "Regulatory surcharges are paid directly to the state.",
    "status": "current"
  },
  "N734": {
    "text": "The patient is eligible for these medical services only when unable to work or perform normal activities due to an illness or injury.",
    "status": "current"
  },
  "N735": {
    "text": "Adjustment without review of medical/dental record because the requested records were not received or were not received timely.",
    "status": "deactivated"
  },
  "N736": {
    "text": "Incomplete/invalid Sleep Study Report.",
    "status": "current"
  },
  "N737": {
    "text": "Missing Sleep Study Report.",
    "status": "current"
  },
  "N738": {
    "text": "Incomplete/invalid Vein Study Report.",
    "status": "current"
  },
  "N739": {
    "text": "Missing Vein Study Report.",
    "status": "current"
  },
  "N74": {
    "text": "Resubmit with multiple claims, each claim covering services provided in only one calendar month.",
    "status": "current"
  },
  "N740": {
    "text": "The member's Consumer Spending Account does not contain sufficient funds to cover the member's liability for this claim/service.",
    "status": "current"
  },
  "N741": {
    "text": "This is a site neutral payment.",
    "status": "current"
  },
  "N742": {
    "text": "Alert: This claim was processed based on one or more ICD-9 codes. The transition to ICD-10 is required by October 1, 2015, for health care providers, health plans, and clearinghouses. More information can be found at http://www.cms.gov/Medicare/Coding/ICD10/ProviderResources.html",
    "status": "deactivated"
  },
  "N743": {
    "text": "Adjusted because the services may be related to an employment accident.",
    "status": "current"
  },
  "N744": {
    "text": "Adjusted because the services may be related to an auto/other accident.",
    "status": "current"
  },
  "N745": {
    "text": "Missing Ambulance Report.",
    "status": "current"
  },
  "N746": {
    "text": "Incomplete/invalid Ambulance Report.",
    "status": "current"
  },
  "N747": {
    "text": "This is a misdirected claim/service. Submit the claim to the payer/plan where the patient resides.",
    "status": "current"
  },
  "N748": {
    "text": "Adjusted because the related hospital charges have not been received.",
    "status": "current"
  },
  "N749": {
    "text": "Missing Blood Gas Report.",
    "status": "current"
  },
  "N75": {
    "text": "Missing/incomplete/invalid tooth surface information.",
    "status": "current"
  },
  "N750": {
    "text": "Incomplete/invalid Blood Gas Report.",
    "status": "current"
  },
  "N751": {
    "text": "Adjusted because the patient is covered under a Medicare Part D plan.",
    "status": "current"
  },
  "N752": {
    "text": "Missing/incomplete/invalid HIPPS Treatment Authorization Code (TAC).",
    "status": "current"
  },
  "N753": {
    "text": "Missing/incomplete/invalid Attachment Control Number.",
    "status": "current"
  },
  "N754": {
    "text": "Missing/incomplete/invalid Referring Provider or Other Source Qualifier on the 1500 Claim Form.",
    "status": "current"
  },
  "N755": {
    "text": "Missing/incomplete/invalid ICD Indicator.",
    "status": "current"
  },
  "N756": {
    "text": "Missing/incomplete/invalid point of drop-off address.",
    "status": "current"
  },
  "N757": {
    "text": "Adjusted based on the Federal Indian Fees schedule (MLR).",
    "status": "current"
  },
  "N758": {
    "text": "Adjusted based on the prior authorization decision.",
    "status": "current"
  },
  "N759": {
    "text": "Payment adjusted based on the National Electrical Manufacturers Association (NEMA) Standard XR-29-2013.",
    "status": "current"
  },
  "N76": {
    "text": "Missing/incomplete/invalid number of riders.",
    "status": "current"
  },
  "N760": {
    "text": "This facility is not authorized to receive payment for the service(s).",
    "status": "current"
  },
  "N761": {
    "text": "This provider is not authorized to receive payment for the service(s).",
    "status": "current"
  },
  "N762": {
    "text": "This facility is not certified for Tomosynthesis (3-D) mammography.",
    "status": "current"
  },
  "N763": {
    "text": "The demonstration code is not appropriate for this claim; resubmit without a demonstration code.",
    "status": "current"
  },
  "N764": {
    "text": "Missing/incomplete/invalid Hematocrit (HCT) value.",
    "status": "current"
  },
  "N765": {
    "text": "This payer does not cover coinsurance assessed by a previous payer.",
    "status": "current"
  },
  "N766": {
    "text": "This payer does not cover co-payment assessed by a previous payer.",
    "status": "current"
  },
  "N767": {
    "text": "The Medicaid state requires provider to be enrolled in the member's Medicaid state program prior to any claim benefits being processed.",
    "status": "current"
  },
  "N768": {
    "text": "Incomplete/invalid initial evaluation report.",
    "status": "current"
  },
  "N769": {
    "text": "A lateral diagnosis is required.",
    "status": "current"
  },
  "N77": {
    "text": "Missing/incomplete/invalid designated provider number.",
    "status": "current"
  },
  "N770": {
    "text": "The adjustment request received from the provider has been processed. Your original claim has been adjusted based on the information received.",
    "status": "current"
  },
  "N771": {
    "text": "Alert: Under Federal law you cannot charge more than the limiting charge amount.",
    "status": "current"
  },
  "N772": {
    "text": "Alert: Rebill urgent/emergent and ancillary services separately.",
    "status": "current"
  },
  "N773": {
    "text": "Drug supplied not obtained from specialty vendor.",
    "status": "current"
  },
  "N774": {
    "text": "Alert: Refer to your Third Party Processor Agreement for specific information on fees associated with this payment type.",
    "status": "current"
  },
  "N775": {
    "text": "Payment adjusted based on x-ray radiograph on film.",
    "status": "current"
  },
  "N776": {
    "text": "This service is not a covered Telehealth service.",
    "status": "current"
  },
  "N777": {
    "text": "Missing Assignment of Benefits Indicator.",
    "status": "current"
  },
  "N778": {
    "text": "Missing Primary Care Physician Information.",
    "status": "current"
  },
  "N779": {
    "text": "Replacement/Void claims cannot be submitted until the original claim has finalized. Please resubmit once payment or denial is received.",
    "status": "current"
  },
  "N78": {
    "text": "The necessary components of the child and teen checkup (EPSDT) were not completed.",
    "status": "current"
  },
  "N780": {
    "text": "Missing/incomplete/invalid end therapy date.",
    "status": "current"
  },
  "N781": {
    "text": "Alert: Patient is a Medicaid/ Qualified Medicare Beneficiary. Review your records for any wrongfully collected deductible. This amount may be billed to a subsequent payer.",
    "status": "current"
  },
  "N782": {
    "text": "Alert: Patient is a Medicaid/ Qualified Medicare Beneficiary. Review your records for any wrongfully collected coinsurance. This amount may be billed to a subsequent payer.",
    "status": "current"
  },
  "N783": {
    "text": "Alert: Patient is a Medicaid/ Qualified Medicare Beneficiary. Review your records for any wrongfully collected copayment. This amount may be billed to a subsequent payer.",
    "status": "current"
  },
  "N784": {
    "text": "Missing comprehensive procedure code.",
    "status": "current"
  },
  "N785": {
    "text": "Missing current radiology film/images.",
    "status": "current"
  },
  "N786": {
    "text": "Benefit limitation for the orthodontic active and/or retention phase of treatment.",
    "status": "current"
  },
  "N787": {
    "text": "Alert: Under 42 CFR 410.43, an eligible Partial Hospitalization Program (PHP) patient/beneficiary requires a minimum of 20 hours of PHP services per week, as evidenced in the plan of care. PHP services must be furnished in accordance with the plan of care.",
    "status": "current"
  },
  "N788": {
    "text": "Alert: The third-party administrator/review organization did not receive the required information.",
    "status": "current"
  },
  "N789": {
    "text": "Clinical Trial is not a covered benefit.",
    "status": "current"
  },
  "N79": {
    "text": "Service billed is not compatible with patient location information.",
    "status": "current"
  },
  "N790": {
    "text": "Provider/supplier not accredited for product/service.",
    "status": "current"
  },
  "N791": {
    "text": "Missing history & physical report.",
    "status": "current"
  },
  "N792": {
    "text": "Incomplete/invalid history & physical report.",
    "status": "current"
  },
  "N793": {
    "text": "Alert: Starting January 1, 2020, Medicare will ONLY accept claims submitted with the Medicare Beneficiary Identifier (MBI). Medicare will reject any claims submitted with the Health Insurance Claim Number (HICN) with a few exceptions. Please see www.cms.gov/Medicare/New-Medicare-Card/index.html for more information.",
    "status": "deactivated"
  },
  "N794": {
    "text": "Payment adjusted based on type of technology used.",
    "status": "current"
  },
  "N795": {
    "text": "Item must be resubmitted as a purchase.",
    "status": "current"
  },
  "N796": {
    "text": "Missing/incomplete/invalid Hemoglobin (Hb or Hgb) value.",
    "status": "current"
  },
  "N797": {
    "text": "Missing/incomplete/invalid date qualifier.",
    "status": "current"
  },
  "N798": {
    "text": "Submit a void request for the original claim and resubmit a new claim.",
    "status": "current"
  },
  "N799": {
    "text": "Submitted identifier must be an individual identifier, not group identifier.",
    "status": "current"
  },
  "N8": {
    "text": "Crossover claim denied by previous payer and complete claim data not forwarded. Resubmit this claim to this payer to provide adequate data for adjudication.",
    "status": "current"
  },
  "N80": {
    "text": "Missing/incomplete/invalid prenatal screening information.",
    "status": "current"
  },
  "N800": {
    "text": "Only one service date is allowed per claim.",
    "status": "current"
  },
  "N801": {
    "text": "Services performed in a Medicare participating or CAH facility under a self-insured tribal Group Health Plan, in accordance with Federal Regulation 42 CFR 136.",
    "status": "current"
  },
  "N802": {
    "text": "This claim/service is not payable under our service area. The claim must be filed to the Payer/Plan in whose service area the Rendering Physician is located.",
    "status": "current"
  },
  "N803": {
    "text": "Submission of the claim for the service rendered is the responsibility of the Contracted Medical Group or Hospital.",
    "status": "current"
  },
  "N804": {
    "text": "Alert: The claim/service was processed through the Outpatient Code Editor (OCE).",
    "status": "current"
  },
  "N805": {
    "text": "Alert: The claim/service was processed through the Correct Code Editor (CCE).",
    "status": "current"
  },
  "N806": {
    "text": "Payment is included in the Global transplant allowance.",
    "status": "current"
  },
  "N807": {
    "text": "Payment adjustment based on the Merit-based Incentive Payment System (MIPS).",
    "status": "current"
  },
  "N808": {
    "text": "Not covered for this provider type / provider specialty.",
    "status": "current"
  },
  "N809": {
    "text": "Alert: The fee schedule amount for this service was adjusted based on prior competitive bidding rates. For more information, contact your local contractor.",
    "status": "current"
  },
  "N81": {
    "text": "Procedure billed is not compatible with tooth surface code.",
    "status": "current"
  },
  "N810": {
    "text": "Alert: Due to federal, state or local disaster declaration, this claim has been processed at the in-network level of benefit. At the conclusion or expiration of the disaster declaration, network payment rules will be reinstated.",
    "status": "current"
  },
  "N811": {
    "text": "Missing Federal Sequestration Reduction from Prior Payer.",
    "status": "current"
  },
  "N812": {
    "text": "The start service date through end service date cannot span greater than 18 months.",
    "status": "current"
  },
  "N815": {
    "text": "Missing/Incomplete/Invalid NDC Unit Count",
    "status": "current"
  },
  "N816": {
    "text": "Missing/Incomplete/Invalid NDC Unit of Measure",
    "status": "current"
  },
  "N817": {
    "text": "Alert: Applicable laboratories are required to collect and report private payor data and report that data to CMS between January 1, 2020 - March 31, 2020.",
    "status": "current"
  },
  "N818": {
    "text": "Claims Dates of Service do not match Electronic Visit Verification System.",
    "status": "current"
  },
  "N819": {
    "text": "Patient not enrolled in Electronic Visit Verification System.",
    "status": "current"
  },
  "N82": {
    "text": "Provider must accept insurance payment as payment in full when a third party payer contract specifies full reimbursement.",
    "status": "current"
  },
  "N820": {
    "text": "Electronic Visit Verification System units do not meet requirements of visit.",
    "status": "current"
  },
  "N821": {
    "text": "Electronic Visit Verification System visit not found.",
    "status": "current"
  },
  "N822": {
    "text": "Missing procedure modifier(s).",
    "status": "current"
  },
  "N823": {
    "text": "Incomplete/Invalid procedure modifier(s).",
    "status": "current"
  },
  "N824": {
    "text": "Electronic Visit Verification (EVV) data must be submitted through EVV Vendor.",
    "status": "current"
  },
  "N825": {
    "text": "Early intervention guidelines were not met.",
    "status": "current"
  },
  "N826": {
    "text": "Patient did not meet the inclusion criteria for the Medicare Shared Savings Program.",
    "status": "current"
  },
  "N827": {
    "text": "Missing/Incomplete/Invalid Federal Information Processing Standard (FIPS) Code.",
    "status": "current"
  },
  "N828": {
    "text": "Alert: Payment is suppressed due to a contracted funding.",
    "status": "current"
  },
  "N829": {
    "text": "Missing/incomplete/invalid Diagnostics Exchange Z-Code Identifier.",
    "status": "current"
  },
  "N83": {
    "text": "No appeal rights. Adjudicative decision based on the provisions of a demonstration project.",
    "status": "current"
  },
  "N830": {
    "text": "Alert: The charge[s] for this service was processed in accordance with Federal/ State, Balance Billing/ No Surprise Billing regulations. As such, any amount identified with OA, CO, or PI cannot be collected from the member and may be considered provider liability or be billable to a subsequent payer. Any amount the provider collected over the identified PR amount must be refunded to the patient within applicable Federal/State timeframes. Payment amounts are eligible for dispute pursuant to any Federal/State documented appeal/grievance process(es).",
    "status": "current"
  },
  "N831": {
    "text": "You have not responded to requests to revalidate your provider/supplier enrollment information.",
    "status": "current"
  },
  "N832": {
    "text": "Duplicate occurrence code/occurrence span code.",
    "status": "current"
  },
  "N833": {
    "text": "Patient share of cost waived.",
    "status": "current"
  },
  "N834": {
    "text": "Jurisdiction exempt from sales and health tax charges.",
    "status": "current"
  },
  "N835": {
    "text": "Unrelated Service/procedure/treatment is reduced. The balance of this charge is the patient's responsibility.",
    "status": "current"
  },
  "N836": {
    "text": "Provider W9 or Payee Registration not on file.",
    "status": "current"
  },
  "N837": {
    "text": "Alert: Missing modifier was added.",
    "status": "current"
  },
  "N838": {
    "text": "Alert: Service/procedure postponed due to a federal, state, or local mandate/disaster declaration. Any amounts applied to deductible or member liability will be applied to the prior plan year from which the procedure was cancelled.",
    "status": "current"
  },
  "N839": {
    "text": "The procedure code was added/changed because the level of service exceeds the compensable condition(s).",
    "status": "current"
  },
  "N84": {
    "text": "Alert: Further installment payments are forthcoming.",
    "status": "current"
  },
  "N840": {
    "text": "Worker's compensation claim filed with a different state.",
    "status": "current"
  },
  "N841": {
    "text": "Alert: North Dakota Administrative Rule 92-01-02-50.3.",
    "status": "current"
  },
  "N842": {
    "text": "Alert: Patient cannot be billed for charges.",
    "status": "current"
  },
  "N843": {
    "text": "Missing/incomplete/invalid Core-Based Statistical Area (CBSA) code.",
    "status": "current"
  },
  "N844": {
    "text": "This claim, or a portion of this claim, was processed in accordance with the Nebraska Legislative LB997 July 24, 2020 - Out of Network Emergency Medical Care Act.",
    "status": "current"
  },
  "N845": {
    "text": "Alert: Nebraska Legislative LB997 July 24, 2020 - Out of Network Emergency Medical Care Act.",
    "status": "current"
  },
  "N846": {
    "text": "National Drug Code (NDC) supplied does not correspond to the HCPCs/CPT billed.",
    "status": "current"
  },
  "N847": {
    "text": "National Drug Code (NDC) billed is obsolete.",
    "status": "current"
  },
  "N848": {
    "text": "National Drug Code (NDC) billed cannot be associated with a product.",
    "status": "current"
  },
  "N849": {
    "text": "Missing Tooth Clause: Tooth missing prior to the member effective date.",
    "status": "current"
  },
  "N85": {
    "text": "Alert: This is the final installment payment.",
    "status": "current"
  },
  "N850": {
    "text": "Missing/incomplete/invalid narrative explaining/describing this service/treatment.",
    "status": "current"
  },
  "N851": {
    "text": "Payment reduced because services were furnished by a therapy assistant.",
    "status": "current"
  },
  "N852": {
    "text": "The pay-to and rendering provider tax identification numbers (TINs) do not match",
    "status": "current"
  },
  "N853": {
    "text": "The number of modalities performed per session exceeds our acceptable maximum.",
    "status": "current"
  },
  "N854": {
    "text": "Alert: If you have primary other health insurance (OHI) coverage that has denied services, you must exhaust all appeal levels with your primary OHI before we can consider your claim for reimbursement.",
    "status": "current"
  },
  "N855": {
    "text": "This coverage is subject to the exclusive jurisdiction of ERISA (1974), U.S.C. SEC 1001.",
    "status": "current"
  },
  "N856": {
    "text": "This coverage is not subject to the exclusive jurisdiction of ERISA (1974), U.S.C. SEC 1001.",
    "status": "current"
  },
  "N857": {
    "text": "This claim has been adjusted/reversed. Refund any collected copayment to the member.",
    "status": "current"
  },
  "N858": {
    "text": "Alert: State regulations relating to an Out of Network Medical Emergency Care Act were applied to the processing of this claim. Payment amounts are eligible for dispute following the state's documented appeal/ grievance/ arbitration process.",
    "status": "current"
  },
  "N859": {
    "text": "Alert: The Federal No Surprise Billing Act was applied to the processing of this claim. Payment amounts are eligible for dispute pursuant to any Federal documented appeal/ grievance/ dispute resolution process(es).",
    "status": "current"
  },
  "N86": {
    "text": "A failed trial of pelvic muscle exercise training is required in order for biofeedback training for the treatment of urinary incontinence to be covered.",
    "status": "current"
  },
  "N860": {
    "text": "Alert: The Federal No Surprise Billing Act Qualified Payment Amount (QPA) was used to calculate the member cost share(s).",
    "status": "current"
  },
  "N861": {
    "text": "Alert: Mismatch between the submitted Patient Liability/Share of Cost and the amount on record for this recipient.",
    "status": "current"
  },
  "N862": {
    "text": "Alert: Member cost share is in compliance with the No Surprises Act, and is calculated using the lesser of the QPA or billed charge.",
    "status": "current"
  },
  "N863": {
    "text": "Alert: This claim is subject to the No Surprises Act (NSA). The amount paid is the final out-of-network rate and was calculated based on an All Payer Model Agreement, in accordance with the NSA.",
    "status": "current"
  },
  "N864": {
    "text": "Alert: This claim is subject to the No Surprises Act provisions that apply to emergency services.",
    "status": "current"
  },
  "N865": {
    "text": "Alert: This claim is subject to the No Surprises Act provisions that apply to nonemergency services furnished by nonparticipating providers during a patient visit to a participating facility.",
    "status": "current"
  },
  "N866": {
    "text": "Alert: This claim is subject to the No Surprises Act provisions that apply to services furnished by nonparticipating providers of air ambulance services.",
    "status": "current"
  },
  "N867": {
    "text": "Alert: Cost sharing was calculated based on a specified state law, in accordance with the No Surprises Act.",
    "status": "current"
  },
  "N868": {
    "text": "Alert: Cost sharing was calculated based on an All-Payer Model Agreement, in accordance with the No Surprises Act.",
    "status": "current"
  },
  "N869": {
    "text": "Alert: Cost sharing was calculated based on the qualifying payment amount, in accordance with the No Surprises Act.",
    "status": "current"
  },
  "N87": {
    "text": "Home use of biofeedback therapy is not covered.",
    "status": "current"
  },
  "N870": {
    "text": "Alert: In accordance with the No Surprises Act, cost sharing was based on the billed amount because the billed amount was lower than the qualifying payment amount.",
    "status": "current"
  },
  "N871": {
    "text": "Alert: This initial payment was calculated based on a specified state law, in accordance with the No Surprises Act.",
    "status": "current"
  },
  "N872": {
    "text": "Alert: This final payment was calculated based on a specified state law, in accordance with the No Surprises Act.",
    "status": "current"
  },
  "N873": {
    "text": "Alert: This final payment was calculated based on an All-Payer Model Agreement, in accordance with the No Surprises Act.",
    "status": "current"
  },
  "N874": {
    "text": "Alert: This final payment was determined through open negotiation, in accordance with the No Surprises Act.",
    "status": "current"
  },
  "N875": {
    "text": "Alert: This final payment equals the amount selected as the out-of-network rate by a Federal Independent Dispute Resolution Entity, in accordance with the No Surprises Act.",
    "status": "current"
  },
  "N876": {
    "text": "Alert: This item or service is covered under the plan. This is a notice of denial of payment provided in accordance with the No Surprises Act. The provider or facility may initiate open negotiation if they desire to negotiate a higher out-of-network rate than the amount paid by the patient in cost sharing.",
    "status": "current"
  },
  "N877": {
    "text": "Alert: This initial payment is provided in accordance with the No Surprises Act. The provider or facility may initiate open negotiation if they desire to negotiate a higher out-of-network rate.",
    "status": "current"
  },
  "N878": {
    "text": "Alert: The provider or facility specified that notice was provided and consent to balance bill obtained, but notice and consent was not provided and obtained in a manner consistent with applicable Federal law. Thus, cost sharing and the total amount paid have been calculated based on the requirements under the No Surprises Act, and balance billing is prohibited.",
    "status": "current"
  },
  "N879": {
    "text": "Alert: The notice and consent to balance bill, and to be charged out-of-network cost sharing, that was obtained from the patient with regard to the billed services, is not permitted for these services. Thus, cost sharing and the total amount paid have been calculated based on the requirements under the No Surprises Act, and balance billing is prohibited.",
    "status": "current"
  },
  "N88": {
    "text": "Alert: This payment is being made conditionally. An HHA episode of care notice has been filed for this patient. When a patient is treated under a HHA episode of care, consolidated billing requires that certain therapy services and supplies, such as this, be included in the HHA's payment. This payment will need to be recouped from you if we establish that the patient is concurrently receiving treatment under a HHA episode of care.",
    "status": "current"
  },
  "N880": {
    "text": "Original claim closed due to changes in submitted data. Adjustment claim will be processed under a new claim number.",
    "status": "current"
  },
  "N881": {
    "text": "Client Obligation, patient responsibility for Home & Community Based Services (HCBS)",
    "status": "current"
  },
  "N882": {
    "text": "Alert: The out-of-network payment and cost sharing amounts were based on the plan's allowance because the provider or facility obtained the patient's consent to waive the balance billing protections under the No Surprises Act.",
    "status": "current"
  },
  "N883": {
    "text": "Alert: Processed according to state law",
    "status": "current"
  },
  "N884": {
    "text": "Alert: The No Surprises Act may apply to this claim. Please contact payer for instructions on how to submit information regarding whether or not the item or service was furnished during a patient visit to a participating facility.",
    "status": "current"
  },
  "N885": {
    "text": "Alert: This claim was not processed in accordance with the No Surprises Act cost-sharing or out-of-network payment requirements. The payer disagrees with your determination that those requirements apply. You may contact the payer to find out why it disagrees. You may appeal this adverse determination on behalf of the patient through the payer’s internal appeals and external review processes.",
    "status": "current"
  },
  "N886": {
    "text": "Alert: A Health Care Claim Request for Additional Information (277 RFAI) has been sent.",
    "status": "current"
  },
  "N887": {
    "text": "Providers not participating in the Medicare Advantage Plan have the right to appeal if the plan has partially or fully denied payment or if the provider believes the plan has not paid the services at the expected Medicare reimbursable rate or type of level/service. Providers may file their appeal in writing within 60 calendar days after the date of the remittance advice. For the plan to review the appeal, the plan will need a completed signed Waiver of Liability Statement. To obtain a Waiver of Liability form, please contact your Medicare Advantage Plan. Once we receive the completed forms, we will give you a decision on your appeal within 60 calendar days.",
    "status": "current"
  },
  "N888": {
    "text": "Alert: An electronic request for additional information has been sent for this claim.",
    "status": "current"
  },
  "N889": {
    "text": "Alert: This claim was originally processed in real-time, and we sent a real-time 835 response.",
    "status": "current"
  },
  "N89": {
    "text": "Alert: Payment information for this claim has been forwarded to more than one other payer, but format limitations permit only one of the secondary payers to be identified in this remittance advice.",
    "status": "current"
  },
  "N890": {
    "text": "Electronic Visit Verification Data Element Requirements were not met.",
    "status": "current"
  },
  "N891": {
    "text": "The maximum allowable payment for this service/procedure was paid by the primary insurance. No further payment due.",
    "status": "current"
  },
  "N892": {
    "text": "The claim does not meet the criteria for acceptable use of the Delay Reason Code.",
    "status": "current"
  },
  "N893": {
    "text": "Missing/incomplete/invalid child medical evaluation form/checklist.",
    "status": "current"
  },
  "N894": {
    "text": "Alert: These payments are made subject to a reservation of rights for the Payor to recoup or otherwise recover all or part of these payments based on any of the following: outcome of pending or future litigation/ new or updated state, federal or regulatory guidance/ any other actions that may affect the Payor's obligation to make these payments.",
    "status": "current"
  },
  "N895": {
    "text": "Processed based on a negotiated fee schedule for a specialty drug program.",
    "status": "current"
  },
  "N896": {
    "text": "Missing/incomplete/invalid trauma activation sheet.",
    "status": "current"
  },
  "N897": {
    "text": "Missing/incomplete/invalid proof of member payment.",
    "status": "current"
  },
  "N898": {
    "text": "Missing/incomplete/invalid Resource Utilization Group(s) (RUG) code(s).",
    "status": "current"
  },
  "N899": {
    "text": "Missing Initial Evaluation Report.",
    "status": "current"
  },
  "N9": {
    "text": "Adjustment represents the estimated amount a previous payer may pay.",
    "status": "current"
  },
  "N90": {
    "text": "Covered only when performed by the attending physician.",
    "status": "current"
  },
  "N900": {
    "text": "Missing Therapy Notes/Report.",
    "status": "current"
  },
  "N901": {
    "text": "Incomplete/Invalid Therapy Notes/Report.",
    "status": "current"
  },
  "N902": {
    "text": "Missing Health Risk Assessment (HRA).",
    "status": "current"
  },
  "N903": {
    "text": "Incomplete/Invalid Health Risk Assessment (HRA).",
    "status": "current"
  },
  "N904": {
    "text": "The transportation vendor is responsible for this claim.",
    "status": "current"
  },
  "N905": {
    "text": "Our records show you have opted out of Medicare, agreeing with the patient not to bill Medicare for services/tests/supplies furnished. As result, we cannot pay this claim. The patient is not responsible for payment.",
    "status": "current"
  },
  "N906": {
    "text": "Service is not covered when patient is under age 45.",
    "status": "current"
  },
  "N907": {
    "text": "No refund because this claim has been identified as 340B-eligible with a ceiling price lower than the maximum fair price.",
    "status": "current"
  },
  "N908": {
    "text": "No refund because this drug has been prospectively purchased at the maximum fair price.",
    "status": "current"
  },
  "N909": {
    "text": "Refund amount has been calculated using a methodology that differs from the Standard Default Refund Amount calculation ((Wholesale Acquisition Cost minus Maximum Fair Price) times Quantity).",
    "status": "current"
  },
  "N91": {
    "text": "Services not included in the appeal review.",
    "status": "current"
  },
  "N910": {
    "text": "A refund cannot be provided for this claim at this time. Contact the manufacturer directly regarding your eligibility.",
    "status": "current"
  },
  "N911": {
    "text": "This claim cannot be reimbursed by the manufacturer until the Part D plan submits corrected prescription drug event data to CMS for maximum fair price validation.",
    "status": "current"
  },
  "N912": {
    "text": "Our records indicate that this beneficiary did not elect hospice.",
    "status": "current"
  },
  "N913": {
    "text": "More than one Electronic Visit Verification record exists for the date and time of this service.",
    "status": "current"
  },
  "N914": {
    "text": "This claim was priced and processed in accordance with California AB-72 Health care coverage.",
    "status": "current"
  },
  "N915": {
    "text": "Predetermination of services is not allowed under the member's plan.",
    "status": "current"
  },
  "N916": {
    "text": "The third party will render payment to the provider, and they will reimburse you for covered services.",
    "status": "current"
  },
  "N917": {
    "text": "Alternative refund amount has been calculated because the maximum fair price is below the 340B ceiling price.",
    "status": "current"
  },
  "N918": {
    "text": "No refund because CMS excludes prescription drug event records when a compound code indicates it is for a compounded drug.",
    "status": "current"
  },
  "N919": {
    "text": "Family/member out-of-pocket maximum has been met.",
    "status": "current"
  },
  "N92": {
    "text": "This facility is not certified for digital mammography.",
    "status": "current"
  },
  "N920": {
    "text": "Payment to the provider has been placed on hold as a result of active contract (re)negotiation.",
    "status": "current"
  },
  "N921": {
    "text": "The time limit for filing a reconsideration or appeal has expired.",
    "status": "current"
  },
  "N922": {
    "text": "Missing primary care dentist information.",
    "status": "current"
  },
  "N923": {
    "text": "Not Denied - The Medicare Advantage Organization (MAO) made a payment responsibility determination.",
    "status": "current"
  },
  "N924": {
    "text": "Pending (Not Denied) - The Medicare Advantage Organization (MAO) has not yet made a payment responsibility determination for the service at the time the encounter record was submitted.",
    "status": "current"
  },
  "N925": {
    "text": "Denied - The Medicare Advantage Organization (MAO) determined that it had no payment responsibility for the service at the time the encounter record was submitted.",
    "status": "current"
  },
  "N926": {
    "text": "Partially Denied - The Medicare Advantage Organization (MAO) determined that it had no payment responsibility for one or more service lines, but not all, at the time the encounter record was submitted.",
    "status": "current"
  },
  "N927": {
    "text": "Missing/Incomplete/Invalid x-ray.",
    "status": "current"
  },
  "N928": {
    "text": "Missing/Incomplete/Invalid bitewing or periapical x-ray.",
    "status": "current"
  },
  "N929": {
    "text": "Missing/Incomplete/Invalid photo(s).",
    "status": "current"
  },
  "N93": {
    "text": "A separate claim must be submitted for each place of service. Services furnished at multiple sites may not be billed in the same claim.",
    "status": "current"
  },
  "N930": {
    "text": "Missing/Incomplete/Invalid quadrant identifier.",
    "status": "current"
  },
  "N931": {
    "text": "Missing/Incomplete/Invalid pre- and/or post-operative bitewing or periapical x-ray.",
    "status": "current"
  },
  "N932": {
    "text": "Missing/Incomplete/Invalid pre- and/or post-operative full mouth x-ray.",
    "status": "current"
  },
  "N933": {
    "text": "Missing/Incomplete/Invalid pre- and/or post-operative photo(s).",
    "status": "current"
  },
  "N934": {
    "text": "Missing/Incomplete/Invalid full mouth x-ray.",
    "status": "current"
  },
  "N935": {
    "text": "Alert: Patient is no longer a Medicaid/Qualified Medicare Beneficiary.",
    "status": "current"
  },
  "N936": {
    "text": "This service code has been identified as the secondary or tertiary procedure code subject to the Medicare Multiple Procedure Payment Reduction (MPPR) rule.",
    "status": "current"
  },
  "N937": {
    "text": "The service line denial threshold was exceeded.",
    "status": "current"
  },
  "N938": {
    "text": "Alert: Do not resubmit. This claim will be automatically reprocessed.",
    "status": "current"
  },
  "N939": {
    "text": "Alert: You may contact us for a peer-to-peer review.",
    "status": "current"
  },
  "N94": {
    "text": "Claim/Service denied because a more specific taxonomy code is required for adjudication.",
    "status": "current"
  },
  "N940": {
    "text": "Missing/Incomplete/Invalid pre- and/or post-operative x-ray.",
    "status": "current"
  },
  "N95": {
    "text": "This provider type/provider specialty may not bill this service.",
    "status": "current"
  },
  "N96": {
    "text": "Patient must be refractory to conventional therapy (documented behavioral, pharmacologic and/or surgical corrective therapy) and be an appropriate surgical candidate such that implantation with anesthesia can occur.",
    "status": "current"
  },
  "N97": {
    "text": "Patients with stress incontinence, urinary obstruction, and specific neurologic diseases (e.g., diabetes with peripheral nerve involvement) which are associated with secondary manifestations of the above three indications are excluded.",
    "status": "current"
  },
  "N98": {
    "text": "Patient must have had a successful test stimulation in order to support subsequent implantation. Before a patient is eligible for permanent implantation, he/she must demonstrate a 50 percent or greater improvement through test stimulation. Improvement is measured through voiding diaries.",
    "status": "current"
  },
  "N99": {
    "text": "Patient must be able to demonstrate adequate ability to record voiding diary data such that clinical results of the implant procedure can be properly evaluated.",
    "status": "current"
  }
});

module.exports = { SOURCE, CARC, RARC };
