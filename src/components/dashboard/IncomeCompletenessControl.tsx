import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { WorkspaceDatabase } from '../../db/database';
import { getSetting, setSetting, unsetSetting, SETTING_KEYS } from '../../db/repositories/settings';
import { RadioGroup } from '../import/FormControls';

/**
 * The tri-state income-completeness confirmation.
 *
 * calculation-contract.md §14.1 makes this three states, not a checkbox: a
 * missing setting means the question was never answered, and that is *not* the
 * same as answering "complete". Money in, net cash flow, and savings rate stay
 * hidden until someone confirms, because publishing a savings rate nobody
 * vouched for is the misleading precision §6 forbids.
 *
 * "Not confirmed" therefore deletes the row rather than storing a sentinel.
 * Writing a third value would make silence indistinguishable from an answer.
 */

export type IncomeCompletenessChoice = 'unconfirmed' | 'complete' | 'incomplete';

const OPTIONS: readonly { value: IncomeCompletenessChoice; label: string; description: string }[] =
  [
    {
      value: 'unconfirmed',
      label: 'Not confirmed',
      description:
        'The default. Money in, net cash flow, and savings rate stay hidden until you answer.',
    },
    {
      value: 'complete',
      label: 'Complete',
      description: 'Every income deposit you expect is present in the imported data.',
    },
    {
      value: 'incomplete',
      label: 'Incomplete',
      description: 'Some income is missing from the import. Income figures stay hidden.',
    },
  ];

/** Stored boolean to UI choice. `undefined` stays unconfirmed — never promoted. */
function choiceFromSetting(value: boolean | undefined): IncomeCompletenessChoice {
  if (value === true) return 'complete';
  if (value === false) return 'incomplete';
  return 'unconfirmed';
}

interface IncomeCompletenessControlProps {
  readonly db: WorkspaceDatabase | null;
}

export function IncomeCompletenessControl({ db }: IncomeCompletenessControlProps) {
  const [busy, setBusy] = useState(false);

  const stored = useLiveQuery(
    async () =>
      db?.isOpen()
        ? ((await getSetting<boolean>(db, SETTING_KEYS.incomeDataComplete)) ?? null)
        : undefined,
    [db],
  );

  // `undefined` means the query has not resolved; `null` means it resolved and
  // the key is absent. Only the second is "unconfirmed".
  const choice = stored === undefined ? 'unconfirmed' : choiceFromSetting(stored ?? undefined);

  const handleChange = async (next: IncomeCompletenessChoice) => {
    if (!db?.isOpen()) return;
    setBusy(true);
    try {
      if (next === 'unconfirmed') {
        // Removes only this key; every other setting is untouched.
        await unsetSetting(db, SETTING_KEYS.incomeDataComplete);
      } else {
        await setSetting(db, SETTING_KEYS.incomeDataComplete, next === 'complete');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div aria-busy={busy || undefined}>
      <RadioGroup
        legend="Is the imported income data complete?"
        name="income-completeness"
        value={choice}
        options={OPTIONS}
        onChange={(value) => {
          void handleChange(value);
        }}
        hint="This confirmation decides whether money in, net cash flow, and savings rate can be reported. It records your answer about coverage; it does not check or validate the imported records themselves."
      />
    </div>
  );
}
