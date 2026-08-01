import { PageContainer } from '../app/layout/PageContainer';
import { Callout } from '../components/ui/Callout';
import { Card, CardBody, CardTitle } from '../components/ui/Card';
import { useDocumentTitle } from '../lib/useDocumentTitle';

const NEVER_LEAVES = [
  'Transaction descriptions, amounts, and dates',
  'Categories, tags, and notes you add',
  'Budgets, income targets, and savings targets',
  'Account labels and merchant rules',
] as const;

const NOT_PRESENT = [
  'Bank connections or Plaid',
  'Accounts, sign-in, or a server database',
  'AI or language-model access to your descriptions',
  'Advertising, session replay, or behavioural analytics',
  'Third-party fonts, icons, or chart scripts loaded from another domain',
] as const;

const CONTROLS = [
  {
    name: 'Download workspace backup',
    detail:
      'Exports everything stored locally as a single versioned JSON file, written straight to your device.',
  },
  {
    name: 'Restore workspace backup',
    detail:
      'Validates a backup file before touching anything. A corrupt or newer-than-supported file fails safely and leaves your current data unchanged.',
  },
  {
    name: 'Delete all data',
    detail:
      'Clears transactions, budgets, rules, and settings after an explicit confirmation, and reports when it is done.',
  },
] as const;

export function PrivacyPage() {
  useDocumentTitle('Privacy');

  return (
    <PageContainer>
      <div className="border-b border-line pb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">
          Privacy model
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
          Your financial data stays in your browser
        </h1>
        <p className="mt-2 max-w-2xl text-base leading-relaxed text-ink-soft">
          This is a technical description, not a marketing promise. It describes exactly where data
          lives, what leaves your device, and&mdash;just as importantly&mdash;what this design does
          not protect you from.
        </p>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card accent="nj" ariaLabelledBy="stays-title">
          <CardBody>
            <CardTitle id="stays-title">What never leaves your device</CardTitle>
            <ul className="mt-3 space-y-1.5">
              {NEVER_LEAVES.map((item) => (
                <li key={item} className="flex gap-2 text-sm leading-relaxed text-ink-soft">
                  <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-nj" />
                  {item}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm leading-relaxed text-ink-soft">
              CSV parsing, categorization, and every calculation run in your browser. The original
              file is not kept after import — only the normalized rows, stored in IndexedDB for this
              site&apos;s origin. Nothing personal appears in a web address, a page title, a console
              log, or an error report.
            </p>
          </CardBody>
        </Card>

        <Card ariaLabelledBy="absent-title">
          <CardBody>
            <CardTitle id="absent-title">What this product does not have</CardTitle>
            <ul className="mt-3 space-y-1.5">
              {NOT_PRESENT.map((item) => (
                <li key={item} className="flex gap-2 text-sm leading-relaxed text-ink-soft">
                  <span
                    aria-hidden="true"
                    className="mt-2 size-1.5 shrink-0 rounded-full bg-line-control"
                  />
                  {item}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm leading-relaxed text-ink-soft">
              Regional economic data is collected during development, checked, and shipped with the
              site as static files. Your browser never calls a government API, so visiting the
              context pages reveals nothing about you.
            </p>
          </CardBody>
        </Card>
      </div>

      <Callout tone="caution" title="Local storage is not a vault" className="mt-8">
        <p>
          IndexedDB is local browser storage, not encrypted vault storage. Anyone who can use your
          unlocked browser profile may be able to inspect it. Clearing site data, browsing
          privately, or moving to a different domain can remove what is stored, and browsers may
          evict data when space runs low. Back up before large imports or a browser change. A
          password-encrypted backup is planned for a later release and is deliberately not claimed
          today.
        </p>
      </Callout>

      <section aria-labelledby="controls-title" className="mt-8">
        <h2 id="controls-title" className="text-xl font-semibold tracking-tight text-ink">
          Controls you will have
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-soft">
          These live in Settings. They are described here rather than shown as buttons, because none
          of them do anything yet in this foundation build&mdash;and a delete control that silently
          does nothing would be worse than no control at all.
        </p>

        <dl className="mt-5 grid gap-4 sm:grid-cols-3">
          {CONTROLS.map((control) => (
            <div key={control.name} className="rounded-card border border-line bg-surface p-5">
              <dt className="text-sm font-semibold text-ink">{control.name}</dt>
              <dd className="mt-1.5 text-sm leading-relaxed text-ink-soft">{control.detail}</dd>
            </div>
          ))}
        </dl>
      </section>
    </PageContainer>
  );
}
