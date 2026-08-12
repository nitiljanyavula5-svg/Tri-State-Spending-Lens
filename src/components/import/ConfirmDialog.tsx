import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '../ui/Button';

interface ConfirmDialogProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * A modal confirmation for an action that changes stored data.
 *
 * Three behaviours here are deliberate rather than decorative:
 *
 *  - **Escape cancels, never confirms.** These dialogs guard destructive
 *    actions — replacing a demo workspace, rolling back an import — and a
 *    dismissal gesture must never be the one that goes through with it (§15).
 *  - **Focus is trapped and restored.** Focus moves to the dialog on open and
 *    returns to whatever opened it on close, so a keyboard user is never left
 *    tabbing through a page they cannot see.
 *  - **Cancel is focused first, not confirm.** A stray Enter on open does
 *    nothing rather than committing the action.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();

    return () => {
      // Restoring focus is what makes the dialog reversible for a keyboard or
      // screen-reader user; without it focus falls back to the document body.
      returnFocusRef.current?.focus?.();
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancel();
      return;
    }

    if (event.key !== 'Tab') return;

    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable || focusable.length === 0) return;

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-4 sm:items-center">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={onKeyDown}
        className="w-full max-w-lg rounded-card border border-line bg-canvas p-5 shadow-lg"
      >
        <h2 id={titleId} className="text-base font-semibold text-ink">
          {title}
        </h2>
        <div id={bodyId} className="mt-2 space-y-2 text-sm leading-relaxed text-ink-soft">
          {children}
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={onConfirm}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
          {/* Focused on open, so a stray Enter dismisses rather than confirms. */}
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={onCancel}
            data-autofocus="true"
          >
            {cancelLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
