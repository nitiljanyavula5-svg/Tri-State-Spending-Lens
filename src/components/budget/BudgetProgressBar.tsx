import type { Measured, Ratio } from '../../calculations';
import { cn } from '../../lib/cn';

/**
 * One budget bar.
 *
 * The bar is decoration. Every figure it depicts is printed as text beside it,
 * and the accessible value comes from `aria-valuetext` rather than from the
 * clamped percentage — a bar pinned at 100% while the plan is 140% used would
 * otherwise announce the wrong number to anyone who cannot see the label.
 *
 * Clamping happens here and nowhere else: `usedRatio` in the selection is the
 * exact ratio, and calculation-contract.md §9 forbids feeding a presentation
 * value back into a calculation.
 */

interface BudgetProgressBarProps {
  /** The exact ratio from the selector. Unavailable for a zero-dollar limit. */
  readonly usedRatio: Measured<Ratio>;
  /** Text naming what the bar is for, e.g. "Groceries". */
  readonly label: string;
  /** The exact figures, announced instead of the clamped percentage. */
  readonly valueText: string;
  readonly over: boolean;
}

export function BudgetProgressBar({ usedRatio, label, valueText, over }: BudgetProgressBarProps) {
  // A negative ratio is real — refunds can exceed outflows — and a bar cannot
  // draw it, so the track is simply empty rather than mirrored.
  const raw = usedRatio.available ? usedRatio.value : 0;
  const clamped = Math.max(0, Math.min(1, raw));

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(usedRatio.available
        ? { 'aria-valuenow': Math.round(clamped * 100) }
        : // No numeric value exists for a zero-dollar limit, so none is claimed.
          {})}
      aria-valuetext={valueText}
      className="mt-2 h-2 w-full overflow-hidden rounded-full bg-canvas-sunk"
    >
      <div
        className={cn('h-full rounded-full', over ? 'bg-pa' : 'bg-ny')}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}
