import type { DataQualityFlags } from '../../calculations';
import { Callout } from '../ui/Callout';
import { buildWarnings } from './dataQualityWarnings';
import { formatCount } from './format';

/**
 * The data-quality region, rendered above the figures it qualifies.
 *
 * The decision of *which* warnings apply lives in `dataQualityWarnings.ts` —
 * pure, separately testable, and not an export of a component module. This file
 * is only presentation.
 */

interface DataQualityBannerProps {
  readonly flags: DataQualityFlags;
  readonly accountLabels: ReadonlyMap<string, string>;
}

export function DataQualityBanner({ flags, accountLabels }: DataQualityBannerProps) {
  const warnings = buildWarnings(flags, accountLabels);
  if (warnings.length === 0) return null;

  return (
    <section aria-labelledby="data-quality-title" className="mt-8">
      <h2 id="data-quality-title" className="text-lg font-semibold tracking-tight text-ink">
        Before you read these figures
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
        {warnings.length === 1
          ? 'One condition qualifies the figures below.'
          : `${formatCount(warnings.length)} conditions qualify the figures below.`}
      </p>
      <div className="mt-4 space-y-3">
        {warnings.map((warning) => (
          <Callout key={warning.id} tone={warning.tone} title={warning.title}>
            <p>{warning.body}</p>
          </Callout>
        ))}
      </div>
    </section>
  );
}
