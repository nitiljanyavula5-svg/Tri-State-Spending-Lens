import type { WorkspaceDatabase } from '../database';
import type { MerchantRule, UserEdit, UserEditEntityType } from '../../types/domain';

/**
 * Rules in deterministic precedence order (category-rules.md §5.2): user rules
 * first, then higher priority, then the most specific match type, then the
 * longest pattern, then id. Sorting here — rather than at each call site —
 * keeps the order in one place, where the specification can be checked
 * against it.
 */
const MATCH_TYPE_SPECIFICITY: Record<MerchantRule['matchType'], number> = {
  exact: 3,
  starts_with: 2,
  contains: 1,
};

export function sortRulesByPrecedence(rules: MerchantRule[]): MerchantRule[] {
  return [...rules].sort((a, b) => {
    if (a.createdByUser !== b.createdByUser) return a.createdByUser ? -1 : 1;
    if (a.priority !== b.priority) return b.priority - a.priority;

    const specificity = MATCH_TYPE_SPECIFICITY[b.matchType] - MATCH_TYPE_SPECIFICITY[a.matchType];
    if (specificity !== 0) return specificity;

    if (a.pattern.length !== b.pattern.length) return b.pattern.length - a.pattern.length;
    return a.id.localeCompare(b.id);
  });
}

export async function listMerchantRules(db: WorkspaceDatabase): Promise<MerchantRule[]> {
  return sortRulesByPrecedence(await db.merchantRules.toArray());
}

export async function putMerchantRule(db: WorkspaceDatabase, rule: MerchantRule): Promise<void> {
  await db.merchantRules.put(rule);
}

export async function deleteMerchantRule(db: WorkspaceDatabase, id: string): Promise<void> {
  await db.merchantRules.delete(id);
}

export async function countMerchantRules(db: WorkspaceDatabase): Promise<number> {
  return db.merchantRules.count();
}

/**
 * User edits are appended, never overwritten. They are the record of manual
 * decisions that must survive re-running normalization (category-rules.md
 * §5.4), and the basis for undo.
 */
export async function appendUserEdit(db: WorkspaceDatabase, edit: UserEdit): Promise<void> {
  await db.userEdits.add(edit);
}

export async function listUserEditsForEntity(
  db: WorkspaceDatabase,
  entityType: UserEditEntityType,
  entityId: string,
): Promise<UserEdit[]> {
  const edits = await db.userEdits.where('entityId').equals(entityId).toArray();
  return edits
    .filter((edit) => edit.entityType === entityType)
    .sort((a, b) => a.editedAt.localeCompare(b.editedAt));
}

export async function countUserEdits(db: WorkspaceDatabase): Promise<number> {
  return db.userEdits.count();
}
