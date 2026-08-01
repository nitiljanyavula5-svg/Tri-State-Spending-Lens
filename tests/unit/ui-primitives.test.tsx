import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { Beaker } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { Badge } from '../../src/components/ui/Badge';
import { Button, ButtonLink } from '../../src/components/ui/Button';
import { Callout } from '../../src/components/ui/Callout';
import { Card, CardBody, CardTitle } from '../../src/components/ui/Card';
import { CodeBlock } from '../../src/components/ui/CodeBlock';
import { EmptyState } from '../../src/components/ui/EmptyState';
import { PageHeader } from '../../src/components/ui/PageHeader';
import { PlaceholderMetric, PlaceholderPanel } from '../../src/components/ui/Placeholder';

describe('Button', () => {
  it('defaults to type="button" so it never submits a form by accident', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'button');
  });

  it('calls its handler on click and on Enter', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Run</Button>);

    const button = screen.getByRole('button', { name: 'Run' });
    await user.click(button);
    button.focus();
    await user.keyboard('{Enter}');

    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('does not fire when disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Run
      </Button>,
    );

    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('ButtonLink', () => {
  it('stays an anchor so link semantics survive the styling', () => {
    render(
      <MemoryRouter>
        <ButtonLink to="/import">Import</ButtonLink>
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Import' })).toHaveAttribute('href', '/import');
  });
});

describe('EmptyState', () => {
  it('explains what will appear and what is not built yet', () => {
    render(
      <EmptyState
        icon={Beaker}
        title="Nothing here yet"
        description="This is where the thing goes."
        items={['First future feature', 'Second future feature']}
        status="Arrives in Phase 3."
      />,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Nothing here yet' })).toBeInTheDocument();
    expect(screen.getByText('This is where the thing goes.')).toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getByText('First future feature')).toBeInTheDocument();
    expect(screen.getByText('Arrives in Phase 3.')).toBeInTheDocument();
  });

  it('omits the list entirely when there is nothing to promise', () => {
    render(<EmptyState icon={Beaker} title="Empty" description="Nothing planned." />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});

describe('PlaceholderMetric', () => {
  it('shows no number at all, not a zero', () => {
    render(<PlaceholderMetric label="Net spending" note="Needs transactions." />);

    expect(screen.getByText('Net spending')).toBeInTheDocument();
    expect(screen.getByText('Needs transactions.')).toBeInTheDocument();
    // A zero in a financial summary is indistinguishable from a real result.
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });
});

describe('PlaceholderPanel', () => {
  it('describes the reserved chart region instead of drawing a fake chart', () => {
    render(<PlaceholderPanel title="Category breakdown" description="Grouped by category." />);
    expect(screen.getByText('Category breakdown')).toBeInTheDocument();
    expect(document.querySelector('svg')).toBeNull();
  });
});

describe('CodeBlock', () => {
  it('is a focusable, named region so it can be scrolled without a mouse', () => {
    render(
      <CodeBlock label="Core calculation formulas">Net spending = debits - refunds</CodeBlock>,
    );

    const region = screen.getByRole('region', { name: 'Core calculation formulas' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveTextContent('Net spending = debits - refunds');
  });
});

describe('Card, Badge, Callout, PageHeader', () => {
  it('gives a card an accessible name from its own title', () => {
    render(
      <Card ariaLabelledBy="card-title">
        <CardBody>
          <CardTitle id="card-title">Planned sources</CardTitle>
        </CardBody>
      </Card>,
    );
    expect(screen.getByRole('region', { name: 'Planned sources' })).toBeInTheDocument();
  });

  it('renders a badge as plain readable text', () => {
    render(<Badge tone="nj">Fictional sample data</Badge>);
    expect(screen.getByText('Fictional sample data')).toBeInTheDocument();
  });

  it('renders a callout title and body', () => {
    render(
      <Callout tone="caution" title="Local storage is not a vault">
        <p>Back up regularly.</p>
      </Callout>,
    );
    expect(screen.getByText('Local storage is not a vault')).toBeInTheDocument();
    expect(screen.getByText('Back up regularly.')).toBeInTheDocument();
  });

  it('renders the page heading as the level-1 heading', () => {
    render(<PageHeader eyebrow="Workspace" title="Budget" lede="A simple monthly plan." />);
    expect(screen.getByRole('heading', { level: 1, name: 'Budget' })).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
  });
});
