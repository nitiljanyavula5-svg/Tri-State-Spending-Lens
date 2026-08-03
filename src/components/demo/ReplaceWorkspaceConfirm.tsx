import { Button } from '../ui/Button';

interface ReplaceWorkspaceConfirmProps {
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The confirmation shown before the demo replaces a user's own data.
 *
 * Shared by every entry point that can trigger the replacement, so the wording
 * and the required second click cannot drift apart between them.
 */
export function ReplaceWorkspaceConfirm({
  busy,
  onConfirm,
  onCancel,
}: ReplaceWorkspaceConfirmProps) {
  return (
    <div className="rounded-card border border-pa/40 bg-pa-wash p-4">
      <p className="text-sm font-semibold text-ink">This will replace what is already stored</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-soft">
        Loading the demo removes the data currently in this browser, so invented transactions are
        never mixed into your own. Download a backup from Settings first if you want to keep it.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={onConfirm}>
          Replace with the demo
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
