/**
 * Pipeline board drag-and-drop resolution — pure, so the rule that decides
 * whether a drop is an API call is testable without a DOM.
 *
 * Three answers, mirroring the "Move to…" menu exactly:
 *   none        — dropped nowhere, or back on its own column
 *   transition  — run the same guarded transition the menu runs
 *   lost        — open MarkLostDialog; the backend refuses a lost move without
 *                 a reason, so a drop can never be the whole decision
 */
import { ALL_CASE_STATUSES, type CaseStatusId } from "../status";

/** Namespaced so a column id can never collide with a caseId. */
const COLUMN_ID_PREFIX = "case-column:";

export function caseColumnDroppableId(status: CaseStatusId): string {
  return `${COLUMN_ID_PREFIX}${status}`;
}

/** The drag-only "mark lost" strip at the end of the board. */
export const LOST_DROPPABLE_ID = `${COLUMN_ID_PREFIX}lost`;

/** Reverse of {@link caseColumnDroppableId}; null for anything else. */
export function caseStatusFromDroppableId(id: string): CaseStatusId | null {
  if (!id.startsWith(COLUMN_ID_PREFIX)) return null;
  const candidate = id.slice(COLUMN_ID_PREFIX.length);
  return ALL_CASE_STATUSES.find((s) => s === candidate) ?? null;
}

export type PipelineDropAction =
  | { kind: "none" }
  | { kind: "transition"; status: CaseStatusId }
  | { kind: "lost" };

/**
 * @param fromStatus the dragged card's current status
 * @param overId the droppable the pointer was over, or null/undefined when the
 *               drop landed outside every column
 */
export function resolvePipelineDrop(
  fromStatus: CaseStatusId | null | undefined,
  overId: string | number | null | undefined,
): PipelineDropAction {
  if (!fromStatus || overId === null || overId === undefined) return { kind: "none" };
  const to = caseStatusFromDroppableId(String(overId));
  if (to === null) return { kind: "none" };
  // Dropped back on its own column: a move that moves nothing is not an API
  // call — and an already-lost card must not re-open the lost dialog.
  if (to === fromStatus) return { kind: "none" };
  if (to === "lost") return { kind: "lost" };
  return { kind: "transition", status: to };
}
