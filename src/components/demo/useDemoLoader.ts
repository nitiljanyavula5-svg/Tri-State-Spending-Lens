import { useCallback, useState } from 'react';
import { useWorkspace } from '../../app/providers/workspaceContext';
import type { DemoSeedOutcome } from '../../data/demo/seed';

export interface UseDemoLoaderOptions {
  /** Runs after a successful load, e.g. to navigate into the workspace. */
  onLoaded?: (outcome: DemoSeedOutcome) => void | Promise<void>;
}

export interface DemoLoader {
  /** The workspace is open and its contents are known. */
  ready: boolean;
  busy: boolean;
  /** The workspace holds the user's own data, so replacing it needs a yes. */
  needsConfirmation: boolean;
  confirming: boolean;
  error: string | null;
  /** Begins the action: asks first when there is personal data to lose. */
  request: () => void;
  confirm: () => void;
  cancel: () => void;
}

/**
 * The single "load the demo" flow.
 *
 * Loading the demo REPLACES the workspace, so anywhere it is offered has to ask
 * first when the browser holds the user's own data. Keeping that decision in
 * one hook is what stops a second entry point from quietly skipping the
 * confirmation — which is exactly how the Settings button came to destroy data
 * without asking.
 */
export function useDemoLoader({ onLoaded }: UseDemoLoaderOptions = {}): DemoLoader {
  const { status, summary, actions } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = status === 'ready' && summary !== null;
  const needsConfirmation = Boolean(summary && !summary.isEmpty && summary.mode !== 'demo');

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);

    // The two failures are reported separately because only one of them leaves
    // the workspace untouched. Once `loadDemo` has resolved the replacement has
    // already committed, so a later failure must not claim otherwise.
    let outcome: DemoSeedOutcome;
    try {
      outcome = await actions.loadDemo();
    } catch {
      // The seed is written through one transaction, so a failure here
      // genuinely leaves the previous workspace intact.
      setError('The demo workspace could not be loaded. Your existing data was left unchanged.');
      setBusy(false);
      return;
    }

    setConfirming(false);

    try {
      await onLoaded?.(outcome);
    } catch {
      setError(
        'The demo workspace loaded, but the next step did not finish. Your workspace now holds the fictional demo data — open it from the Overview page.',
      );
    } finally {
      setBusy(false);
    }
  }, [actions, onLoaded]);

  const request = useCallback(() => {
    if (needsConfirmation) setConfirming(true);
    else void load();
  }, [needsConfirmation, load]);

  const confirm = useCallback(() => {
    void load();
  }, [load]);

  const cancel = useCallback(() => {
    setConfirming(false);
  }, []);

  return { ready, busy, needsConfirmation, confirming, error, request, confirm, cancel };
}
