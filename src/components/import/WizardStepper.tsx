import { Check } from 'lucide-react';
import { WIZARD_STEPS, stepIndex, type StepId } from '../../import/wizard/wizardState';

interface WizardStepperProps {
  readonly current: StepId;
  /** Steps the user may jump back to. Forward jumps are never offered. */
  readonly onGoBack: (step: StepId) => void;
}

/**
 * Progress through the six steps.
 *
 * Status is carried by text — "Done", "Current step", "Not started" — and by a
 * check icon, never by colour alone (§15). The ordered list gives assistive
 * technology the sequence for free, and `aria-current="step"` names the one the
 * user is on without needing a live region to announce it.
 */
export function WizardStepper({ current, onGoBack }: WizardStepperProps) {
  const currentIndex = stepIndex(current);

  return (
    <nav aria-label="Import progress">
      <ol className="flex flex-wrap gap-x-2 gap-y-2 sm:gap-x-3">
        {WIZARD_STEPS.map((step, index) => {
          const done = index < currentIndex;
          const isCurrent = index === currentIndex;
          const status = done ? 'Done' : isCurrent ? 'Current step' : 'Not started';

          const label = (
            <>
              <span
                aria-hidden="true"
                className={`money flex size-6 shrink-0 items-center justify-center rounded-control border text-xs font-semibold ${
                  done
                    ? 'border-nj/40 bg-nj-wash text-nj'
                    : isCurrent
                      ? 'border-ink bg-ink text-canvas'
                      : 'border-line bg-canvas-sunk text-ink-muted'
                }`}
              >
                {done ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span className="min-w-0">
                <span className="block truncate">{step.title}</span>
                <span className="sr-only">{`: ${status}`}</span>
              </span>
            </>
          );

          return (
            <li key={step.id} className="min-w-0">
              {done ? (
                <button
                  type="button"
                  onClick={() => onGoBack(step.id)}
                  className="flex items-center gap-2 rounded-control px-2 py-1 text-xs font-medium text-ink-soft hover:bg-canvas-sunk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                >
                  {label}
                </button>
              ) : (
                <span
                  {...(isCurrent ? { 'aria-current': 'step' as const } : {})}
                  className={`flex items-center gap-2 rounded-control px-2 py-1 text-xs font-medium ${
                    isCurrent ? 'text-ink' : 'text-ink-muted'
                  }`}
                >
                  {label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
