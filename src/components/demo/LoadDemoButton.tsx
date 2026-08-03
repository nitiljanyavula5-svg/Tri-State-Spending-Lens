import { useCallback, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../ui/Button';
import type { ButtonSize, ButtonVariant } from '../ui/buttonStyles';
import { ReplaceWorkspaceConfirm } from './ReplaceWorkspaceConfirm';
import { useDemoLoader } from './useDemoLoader';

interface LoadDemoButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

/**
 * The "Try the demo" action.
 *
 * The landing hero and the demo card both offer this, and product-spec.md §8.1
 * names it a primary action in both places — so it lives in one component
 * rather than being reimplemented twice with a chance of behaving differently.
 * The confirmation logic itself lives in `useDemoLoader`, shared with Settings.
 */
export function LoadDemoButton({ variant = 'primary', size, children }: LoadDemoButtonProps) {
  const navigate = useNavigate();
  const onLoaded = useCallback(async () => {
    await navigate('/app/overview');
  }, [navigate]);

  const demo = useDemoLoader({ onLoaded });

  if (demo.confirming) {
    return (
      <ReplaceWorkspaceConfirm busy={demo.busy} onConfirm={demo.confirm} onCancel={demo.cancel} />
    );
  }

  return (
    <>
      <Button
        variant={variant}
        size={size}
        disabled={!demo.ready || demo.busy}
        onClick={demo.request}
      >
        {demo.busy ? 'Loading the demo…' : (children ?? 'Try the demo')}
      </Button>
      {demo.error ? (
        <p role="status" aria-live="polite" className="text-xs text-negative">
          {demo.error}
        </p>
      ) : null}
    </>
  );
}
