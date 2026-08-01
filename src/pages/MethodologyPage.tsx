import { PageContainer } from '../app/layout/PageContainer';
import { Callout } from '../components/ui/Callout';
import { Card, CardBody, CardTitle } from '../components/ui/Card';
import { CodeBlock } from '../components/ui/CodeBlock';
import { useDocumentTitle } from '../lib/useDocumentTitle';

/** Reproduced verbatim from docs/calculation-contract.md §4. */
const FORMULAS = `Net spending = included purchase/fee/cash debits − included refunds

Net cash flow = included income − net spending

Savings rate = (included income − net spending) / included income

Budget remaining = budget limit − budget-period net spending`;

const PRECEDENCE = [
  'Explicit per-transaction user edit',
  'User-created merchant rule',
  'Exact built-in merchant alias',
  'Built-in keyword rule',
  'Uncategorized / Other review queue',
] as const;

const EXCLUDED_BY_DEFAULT = [
  'Income',
  'Transfers between accounts',
  'Credit-card payments',
  'Transactions you have excluded',
  'Unknown credits, until you review them',
] as const;

export function MethodologyPage() {
  useDocumentTitle('Methodology');

  return (
    <PageContainer>
      <div className="border-b border-line pb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">
          How it works
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
          Methodology
        </h1>
        <p className="mt-2 max-w-2xl text-base leading-relaxed text-ink-soft">
          Every total this product shows must be explainable and reproducible. These rules were
          written down and agreed before any chart was built, so a number can never quietly change
          meaning between screens.
        </p>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card ariaLabelledBy="formulas-title">
          <CardBody>
            <CardTitle id="formulas-title">Core formulas</CardTitle>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              All cards, charts, and tables read from one shared calculation layer, so two screens
              cannot disagree.
            </p>
            <CodeBlock label="Core calculation formulas" className="mt-4">
              {FORMULAS}
            </CodeBlock>
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">
              Money is held as whole cents throughout, and rounding happens only when a figure is
              displayed. A savings rate is undefined when income is zero or marked incomplete — in
              that case the card is hidden with an explanation rather than shown as 0%. A negative
              savings rate is a real result and is displayed honestly.
            </p>
          </CardBody>
        </Card>

        <div className="grid gap-6">
          <Card ariaLabelledBy="spending-title">
            <CardBody>
              <CardTitle id="spending-title">What counts as spending</CardTitle>
              <p className="mt-3 text-sm font-semibold text-ink">Counted</p>
              <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                Purchases, fees, and cash withdrawals, minus refunds.
              </p>
              <p className="mt-4 text-sm font-semibold text-ink">Excluded by default</p>
              <ul className="mt-1 space-y-1">
                {EXCLUDED_BY_DEFAULT.map((item) => (
                  <li key={item} className="flex gap-2 text-sm text-ink-soft">
                    <span
                      aria-hidden="true"
                      className="mt-2 size-1.5 shrink-0 rounded-full bg-line-control"
                    />
                    {item}
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-sm leading-relaxed text-ink-soft">
                Moving money between your own accounts is not spending, and paying a credit card is
                not a second purchase — so importing both a checking and a card export will not
                double count.
              </p>
            </CardBody>
          </Card>

          <Card ariaLabelledBy="precedence-title">
            <CardBody>
              <CardTitle id="precedence-title">How a category is chosen</CardTitle>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                The first rule that matches wins, and nothing later can override an earlier
                decision. Your own edits always come first.
              </p>
              <ol className="money mt-3 space-y-1.5">
                {PRECEDENCE.map((rule, index) => (
                  <li key={rule} className="flex gap-3 text-sm text-ink-soft">
                    <span className="font-semibold text-ink-muted">{index + 1}.</span>
                    <span className="font-sans">{rule}</span>
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card ariaLabelledBy="recurring-title">
          <CardBody>
            <CardTitle id="recurring-title">Recurring charges are suggestions</CardTitle>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              A recurring series is a hypothesis, shown with its evidence and a confidence label of
              high, medium, or low — never an unexplained decimal. Confidence comes from how many
              times a charge appeared, how consistent the interval is, how well the merchant
              matches, and how stable the amount is. You can always confirm, reject, merge, or split
              a series.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">
              Not every recurring charge is a subscription. Rent, insurance, and utilities repeat
              too.
            </p>
          </CardBody>
        </Card>

        <Card ariaLabelledBy="quality-title">
          <CardBody>
            <CardTitle id="quality-title">When the product will not answer</CardTitle>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              Analysis states when it is standing on incomplete data. Month-over-month percentages
              are withheld when either month is incomplete. A purchase is not called unusual without
              enough history to compare against. Monthly averages use complete calendar months only;
              a custom range is labelled a selected-period average rather than quietly treated as a
              month.
            </p>
          </CardBody>
        </Card>
      </div>

      <Callout tone="info" title="Full specifications" className="mt-8">
        <p>
          The complete rules live in the repository as reviewed documents: the calculation contract,
          category and classification rules, data methodology, privacy model, and threat model. This
          page will grow to show the exact rule that produced any given figure once calculations are
          implemented.
        </p>
      </Callout>
    </PageContainer>
  );
}
