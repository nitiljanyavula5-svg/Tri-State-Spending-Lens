import { ArrowRight, ClipboardCheck, Compass, Upload } from 'lucide-react';
import { PageContainer } from '../app/layout/PageContainer';
import { DemoEntryCard } from '../components/demo/DemoEntryCard';
import { LoadDemoButton } from '../components/demo/LoadDemoButton';
import { Badge } from '../components/ui/Badge';
import { ButtonLink } from '../components/ui/Button';
import { Callout } from '../components/ui/Callout';
import { Card, CardBody, CardTitle } from '../components/ui/Card';
import { useDocumentTitle } from '../lib/useDocumentTitle';

/** The four questions the landing page must answer on the first screen (product-spec.md §8.1). */
const FIRST_SCREEN_ANSWERS = [
  {
    question: 'What does this do?',
    answer:
      'It turns a bank CSV export into a clear picture of where your money went, then helps you set a monthly plan you can actually check against.',
  },
  {
    question: 'Is my bank data uploaded?',
    answer:
      'No. Parsing, categorizing, and every calculation happen in your browser. Your transactions are never sent to a server, because there is no server to send them to.',
  },
  {
    question: 'What will I learn?',
    answer:
      'Where your spending concentrates, which repeated charges you may have overlooked, whether you are on pace against your plan, and how tri-state price levels compare.',
  },
  {
    question: 'Can I try it without my real data?',
    answer:
      'Yes. Demo mode fills the workspace with obviously fictional transactions so you can explore every feature before importing anything of your own.',
  },
] as const;

const PRODUCT_LOOP = [
  { step: 'Import', detail: 'Bring in one or more CSV exports and confirm how to read them.' },
  { step: 'Clean', detail: 'Fix confusing descriptions, categories, transfers, and refunds.' },
  { step: 'Understand', detail: 'See net spending, categories, and repeated charges.' },
  { step: 'Plan', detail: 'Set a monthly limit, category limits, and an optional savings target.' },
  { step: 'Review', detail: 'Check your pace during the month and close it out afterwards.' },
] as const;

export function LandingPage() {
  useDocumentTitle();

  return (
    <>
      <section className="border-b border-line bg-canvas">
        <PageContainer className="py-12 lg:py-20">
          <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-14">
            <div>
              <Badge tone="ny">New Jersey · New York · Pennsylvania</Badge>
              <h1 className="mt-4 max-w-2xl text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl lg:text-5xl">
                See where your money goes&mdash;without sending it anywhere.
              </h1>
              <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-soft">
                A privacy-first financial analysis and budgeting tool for students and young adults
                in the tri-state region. Import a bank CSV, understand your spending, build a
                monthly plan, and explore regional economic context&mdash;without connecting a bank
                account.
              </p>

              <div className="mt-8 flex flex-wrap items-start gap-3">
                <LoadDemoButton>
                  Try the demo
                  <ArrowRight className="size-4" aria-hidden="true" />
                </LoadDemoButton>
                <ButtonLink to="/import" variant="secondary">
                  <Upload className="size-4" aria-hidden="true" />
                  Import a bank CSV
                </ButtonLink>
              </div>

              <dl className="mt-10 grid gap-x-8 gap-y-6 sm:grid-cols-2">
                {FIRST_SCREEN_ANSWERS.map((item) => (
                  <div key={item.question}>
                    <dt className="text-sm font-semibold text-ink">{item.question}</dt>
                    <dd className="mt-1.5 text-sm leading-relaxed text-ink-soft">{item.answer}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <DemoEntryCard />
          </div>
        </PageContainer>
      </section>

      <PageContainer>
        <section aria-labelledby="loop-title">
          <h2 id="loop-title" className="text-xl font-semibold tracking-tight text-ink">
            The loop the product is built around
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-soft">
            Every feature serves one of these five steps. Anything that does not is questioned
            before it is added.
          </p>

          <ol className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {PRODUCT_LOOP.map((item, index) => (
              <li
                key={item.step}
                className="rounded-card border border-line bg-surface p-4 shadow-card"
              >
                <span className="money text-xs font-semibold text-ink-muted">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <p className="mt-1 text-sm font-semibold text-ink">{item.step}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{item.detail}</p>
              </li>
            ))}
          </ol>
        </section>

        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          <Card accent="nj" ariaLabelledBy="promise-privacy">
            <CardBody>
              <CardTitle id="promise-privacy">Private by architecture</CardTitle>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                Personal data stays in your browser&apos;s local storage for this site. No accounts,
                no bank connections, no advertising or analytics scripts, and no third-party
                trackers.
              </p>
            </CardBody>
          </Card>

          <Card accent="ny" ariaLabelledBy="promise-trust">
            <CardBody>
              <CardTitle id="promise-trust">Trust before cleverness</CardTitle>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                Every total is explainable and reproducible. You can trace any figure back to the
                exact transactions behind it, and questionable imports are surfaced before any chart
                appears.
              </p>
            </CardBody>
          </Card>

          <Card accent="pa" ariaLabelledBy="promise-context">
            <CardBody>
              <CardTitle id="promise-context">Context, not commands</CardTitle>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                Regional statistics inform; they never prescribe. A state average is never presented
                as the correct amount for you to spend.
              </p>
            </CardBody>
          </Card>
        </div>

        <Callout tone="privacy" title="What this build can do today" className="mt-10">
          <p>
            The local workspace is real: the demo dataset is stored in this browser&apos;s own
            database, and you can back it up, restore it, or delete it from Settings. CSV import,
            the transaction grid, and every calculated figure are deliberately not implemented yet,
            so each page below explains what will eventually appear there.
          </p>
        </Callout>

        <div className="mt-8 flex flex-wrap gap-3">
          <ButtonLink to="/methodology" variant="secondary">
            <ClipboardCheck className="size-4" aria-hidden="true" />
            How every number is produced
          </ButtonLink>
          <ButtonLink to="/context" variant="secondary">
            <Compass className="size-4" aria-hidden="true" />
            Explore tri-state context
          </ButtonLink>
        </div>
      </PageContainer>
    </>
  );
}
