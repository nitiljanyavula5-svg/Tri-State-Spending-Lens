import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Button } from '../ui/Button';
import { Card, CardBody } from '../ui/Card';
import { ConfirmDialog } from './ConfirmDialog';
import { StepChooseFiles } from './StepChooseFiles';
import { StepConfirmConventions } from './StepConfirmConventions';
import { StepHealthReport } from './StepHealthReport';
import { StepIdentifyFormat } from './StepIdentifyFormat';
import { StepMapColumns } from './StepMapColumns';
import { StepReview } from './StepReview';
import { WizardStepper } from './WizardStepper';
import { useWorkspace } from '../../app/providers/workspaceContext';
import { listAccounts } from '../../db/repositories/accounts';
import { useImportWizard, type ImportWizardApi } from '../../import/wizard/useImportWizard';
import { useMappingPresets } from '../../import/wizard/useMappingPresets';
import type { ImportWorkerClient } from '../../import/importWorkerClient';
import {
  WIZARD_STEPS,
  blockedReason,
  nextStep,
  previousStep,
  stepIndex,
} from '../../import/wizard/wizardState';

interface ImportWizardProps {
  /** Injectable for tests; production builds the real module worker. */
  readonly createClient?: () => ImportWorkerClient;
  readonly generateId?: () => string;
  /** Called after a successful commit so the page can refresh history. */
  readonly onWorkspaceChanged?: () => void;
}

/**
 * The six-step import wizard.
 *
 * The shell owns navigation and focus; each step owns its own fields. All
 * state, invalidation, and worker lifecycle live in `useImportWizard`, so this
 * component never touches Dexie or a worker directly (§4).
 */
export function ImportWizard({ createClient, generateId, onWorkspaceChanged }: ImportWizardProps) {
  const { db, summary } = useWorkspace();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [showRestart, setShowRestart] = useState(false);

  const accounts = useLiveQuery(() => (db?.isOpen() ? listAccounts(db) : undefined), [db]) ?? [];

  const wizard = useImportWizard({
    db,
    workspaceMode: summary?.mode ?? 'empty',
    ...(createClient ? { createClient } : {}),
    ...(generateId ? { generateId } : {}),
    ...(onWorkspaceChanged ? { onWorkspaceChanged } : {}),
  });

  const { state } = wizard;
  const current = WIZARD_STEPS[stepIndex(state.step)]!;
  const forward = nextStep(state.step);
  const back = previousStep(state.step);
  const blocked = forward ? blockedReason(state, forward) : null;

  // Focus moves to the step heading on every transition, so a keyboard or
  // screen-reader user lands at the top of the new step rather than wherever
  // the old step's Continue button happened to be (§15).
  useEffect(() => {
    headingRef.current?.focus();
  }, [state.step]);

  const committed = state.commit.kind === 'committed';

  return (
    <Card ariaLabelledBy="wizard-step-title">
      <CardBody>
        <WizardStepper
          current={state.step}
          onGoBack={(step) => {
            if (!committed) wizard.goToStep(step);
          }}
        />

        <h2
          id="wizard-step-title"
          ref={headingRef}
          tabIndex={-1}
          className="mt-5 text-lg font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink"
        >
          {`Step ${stepIndex(state.step) + 1} of ${WIZARD_STEPS.length}: ${current.title}`}
        </h2>

        <div className="mt-5">
          {state.step === 'choose' ? <StepChooseFiles wizard={wizard} /> : null}
          {state.step === 'format' ? <StepIdentifyFormat wizard={wizard} /> : null}
          {state.step === 'map' ? <MapStep wizard={wizard} /> : null}
          {state.step === 'confirm' ? (
            <StepConfirmConventions wizard={wizard} accounts={accounts} />
          ) : null}
          {state.step === 'review' ? <StepReview wizard={wizard} /> : null}
          {state.step === 'report' ? (
            <StepHealthReport
              wizard={wizard}
              accounts={accounts}
              onDone={() => {
                wizard.reset();
                setShowRestart(false);
              }}
            />
          ) : null}
        </div>

        {committed ? null : (
          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-5">
            {back ? (
              <Button variant="secondary" onClick={() => wizard.goToStep(back)}>
                Back
              </Button>
            ) : null}

            {forward ? (
              <Button
                variant="primary"
                disabled={blocked !== null}
                onClick={() => wizard.goToStep(forward)}
              >
                Continue
              </Button>
            ) : null}

            {state.files.length > 0 ? (
              <Button variant="quiet" onClick={() => setShowRestart(true)}>
                Start over
              </Button>
            ) : null}

            {/* The reason a disabled Continue is disabled, announced politely. */}
            <p role="status" className="text-sm text-ink-muted">
              {blocked ?? ''}
            </p>
          </div>
        )}
      </CardBody>

      {showRestart ? (
        <RestartDialog
          onCancel={() => setShowRestart(false)}
          onConfirm={() => {
            wizard.reset();
            setShowRestart(false);
          }}
        />
      ) : null}
    </Card>
  );
}

/** Presets are loaded only for the step that uses them. */
function MapStep({ wizard }: { wizard: ImportWizardApi }) {
  const { db } = useWorkspace();
  const presets = useMappingPresets(db);
  return <StepMapColumns wizard={wizard} presets={presets} />;
}

function RestartDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <ConfirmDialog
      title="Start over?"
      confirmLabel="Start over"
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <p>
        Your staged files and every choice made about them will be discarded. Nothing has been saved
        yet, so your workspace is unaffected.
      </p>
    </ConfirmDialog>
  );
}
