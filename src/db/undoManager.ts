import type { WorkspaceDatabase } from './database';
import { undoCommand, type CommandResult, type UndoCommand } from './transactionCommands';
import { MAX_UNDO_HISTORY } from '../domain/reviewLimits';

/**
 * Bounded, session-local undo history.
 *
 * **Undo does not survive a reload, and that is a deliberate limitation rather
 * than an oversight.** The edits themselves are persisted the moment they are
 * made — reloading loses the ability to *reverse* a recent change, never the
 * change itself. The interface has to say so plainly rather than offering an
 * undo control that quietly disappears.
 *
 * Keeping the stack in memory is also the privacy-preserving choice. An entry
 * holds whole previous transaction rows so it can restore them exactly; writing
 * that to IndexedDB would create a second, growing copy of personal financial
 * data whose only purpose is regret, and privacy-model.md would rather the
 * product not keep one. `UserEdit` already records *that* a field changed, in a
 * bounded, field-level form; this stack is the short-lived complement to it.
 *
 * There is no redo (§7). Undo is an escape hatch, not a version-control system,
 * and a redo stack would double the retained data for a much rarer need.
 */

export interface UndoManager {
  /** Records a successful command. Failed commands never enter history. */
  push(command: UndoCommand): void;
  /** The command that would be reversed next, without reversing it. */
  peek(): UndoCommand | null;
  canUndo(): boolean;
  /** True while an undo is in flight, so a second click cannot start another. */
  isPending(): boolean;
  size(): number;
  /**
   * Reverses the most recent command.
   *
   * A refusal — stale rows, a missing transaction — discards the entry rather
   * than leaving it to fail identically forever. The workspace has moved on,
   * and offering the same doomed undo again would be misleading.
   */
  undo(db: WorkspaceDatabase): Promise<CommandResult | null>;
  clear(): void;
}

export function createUndoManager(limit: number = MAX_UNDO_HISTORY): UndoManager {
  const bounded = Math.max(1, Math.floor(limit));
  const stack: UndoCommand[] = [];
  let pending = false;

  return {
    push(command) {
      // A command with nothing to restore would be an undo entry that does
      // nothing when chosen.
      if (command.previous.length === 0 && !command.removedLinks?.length) return;

      stack.push(command);
      // Oldest first out, so the ceiling bounds both the list and the amount of
      // transaction data held outside the database.
      while (stack.length > bounded) stack.shift();
    },

    peek() {
      return stack.length === 0 ? null : stack[stack.length - 1]!;
    },

    canUndo() {
      return stack.length > 0 && !pending;
    },

    isPending() {
      return pending;
    },

    size() {
      return stack.length;
    },

    async undo(db) {
      // Guards the window between the click and the awaited result. Two clicks
      // in the same tick would otherwise both read the same top entry and both
      // try to restore it.
      if (pending || stack.length === 0) return null;

      pending = true;
      // Popped before awaiting, so the entry cannot be chosen twice even if the
      // command takes a while.
      const command = stack.pop()!;

      try {
        const result = await undoCommand(db, command);
        // A refused undo is not returned to the stack: the rows it describes
        // have changed, and it would refuse identically every time.
        return result;
      } finally {
        pending = false;
      }
    },

    clear() {
      stack.length = 0;
    },
  };
}
