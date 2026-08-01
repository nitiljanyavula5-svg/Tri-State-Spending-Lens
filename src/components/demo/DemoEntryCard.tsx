import { FlaskConical } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { ButtonLink } from '../ui/Button';
import { Card, CardBody, CardTitle } from '../ui/Card';

/**
 * Every figure below is invented for illustration. Demo mode exists so a user
 * can evaluate the product without importing real financial data
 * (privacy-model.md §7). Nothing here is computed — these are literal strings,
 * and they are labelled as fictional in the UI, not only in this comment.
 */
const SAMPLE_ROWS = [
  { label: 'Net spending, sample month', value: '$1,284.60' },
  { label: 'Largest category', value: 'Groceries' },
  { label: 'Possible recurring monthly cost', value: '$96.45' },
] as const;

export function DemoEntryCard() {
  return (
    <Card accent="nj" ariaLabelledBy="demo-entry-title">
      <CardBody>
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="flex size-9 items-center justify-center rounded-control bg-nj-wash text-nj"
            aria-hidden="true"
          >
            <FlaskConical className="size-4.5" aria-hidden="true" />
          </span>
          <CardTitle id="demo-entry-title">Try a fictional workspace</CardTitle>
          <Badge tone="nj">Fictional sample data</Badge>
        </div>

        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Demo mode will fill the workspace with obviously fictional transactions spanning at least
          four complete months, so you can try budgets, recurring charges, and insights before
          deciding whether to import anything of your own.
        </p>

        <dl className="mt-5 divide-y divide-line border-y border-line">
          {SAMPLE_ROWS.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="text-sm text-ink-muted">{row.label}</dt>
              <dd className="money text-sm font-semibold text-ink">{row.value}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-3 text-xs leading-relaxed text-ink-muted">
          Illustration only. These figures are invented to show the shape of the interface — they
          are not calculated from any data, real or imported.
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          <ButtonLink to="/app/overview" variant="primary">
            Try the demo
          </ButtonLink>
          <ButtonLink to="/privacy" variant="secondary">
            Read the privacy model
          </ButtonLink>
        </div>

        <p className="mt-4 border-t border-line pt-4 text-xs text-ink-muted">
          The demo dataset itself arrives in Phase 2, alongside the local database. Today this
          button takes you to the workspace shell.
        </p>
      </CardBody>
    </Card>
  );
}
