/**
 * Pre-auth board drag-and-drop resolution — pure, so the rule that decides
 * whether a drop is an API call is testable without a DOM.
 *
 * Drag is only a second gesture for the existing "Move to…" flow: the answer
 * is either "do nothing" or "run the same guarded transition". Anything the
 * function cannot positively identify as a different, real status column
 * resolves to `none` — a drop that lands nowhere must never write.
 */
import { PREAUTH_BOARD_STATUSES, type PreauthStatusId } from "../status";

/** Namespaced so a column id can never collide with a preauthId. */
const COLUMN_ID_PREFIX = "preauth-column:";

export function preauthColumnDroppableId(status: PreauthStatusId): string {
  return `${COLUMN_ID_PREFIX}${status}`;
}

/** Reverse of {@link preauthColumnDroppableId}; null for anything else. */
export function preauthStatusFromDroppableId(id: string): PreauthStatusId | null {
  if (!id.startsWith(COLUMN_ID_PREFIX)) return null;
  const candidate = id.slice(COLUMN_ID_PREFIX.length);
  return PREAUTH_BOARD_STATUSES.find((s) => s === candidate) ?? null;
}

export type PreauthDropAction =
  | { kind: "none" }
  | { kind: "transition"; status: PreauthStatusId };

/**
 * @param fromStatus the dragged card's current status
 * @param overId the droppable the pointer was over, or null/undefined when the
 *               drop landed outside every column
 */
export function resolvePreauthDrop(
  fromStatus: PreauthStatusId | null | undefined,
  overId: string | number | null | undefined,
): PreauthDropAction {
  if (!fromStatus || overId === null || overId === undefined) return { kind: "none" };
  const to = preauthStatusFromDroppableId(String(overId));
  if (to === null) return { kind: "none" };
  // Dropped back on its own column: a move that moves nothing is not an API call.
  if (to === fromStatus) return { kind: "none" };
  return { kind: "transition", status: to };
}
