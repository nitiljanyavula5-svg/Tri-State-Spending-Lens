// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  emptyPartition,
  includedRows,
  partitionByTreatment,
  selectNetSpending,
  signedContribution,
} from '../../../src/calculations/netSpending';
import {
  cardPayment,
  cashOut,
  fee,
  income,
  purchase,
  refund,
  resetIds,
  shuffle,
  transfer,
  unknownCredit,
  unknownDebit,
} from './fixtures';

/**
 * Net spending, against calculation-contract.md §3, §4, and §14.6.
 *
 * The partition is asserted as hard as the total. An excluded row is part of the
 * explanation a user needs — "why is May lower than I expected" is usually
 * answered by the excluded-by-kind and needs-review buckets — and a selector
 * that only returned a number could not answer it.
 */

describe('the treatment partition', () => {
  it('sorts every kind into exactly one bucket', () => {
    resetIds();
    const partition = partitionByTreatment([
      purchase(1_000),
      fee(200),
      cashOut(3_000),
      refund(500),
      income(9_000),
      transfer(4_000),
      cardPayment(6_000),
      unknownCredit(700),
      unknownDebit(800),
      purchase(100, { excludedFromSpending: true }),
    ]);

    expect(partition.includedOutflow).toHaveLength(3);
    expect(partition.includedRefund).toHaveLength(1);
    expect(partition.excludedByKind).toHaveLength(3);
    expect(partition.excludedByUser).toHaveLength(1);
    expect(partition.needsReview).toHaveLength(2);
  });

  it('accounts for every row in the population', () => {
    resetIds();
    const rows = [purchase(1_000), transfer(2_000), unknownCredit(3_000), refund(400)];
    const partition = partitionByTreatment(rows);
    const total =
      partition.includedOutflow.length +
      partition.includedRefund.length +
      partition.excludedByKind.length +
      partition.excludedByUser.length +
      partition.needsReview.length;
    expect(total).toBe(rows.length);
    expect(partition.populationCount).toBe(rows.length);
  });

  it('reports a transfer the user also excluded as excluded by kind', () => {
    resetIds();
    // The kind gate is checked first, so the honest reason is the one that was
    // always going to apply.
    const partition = partitionByTreatment([transfer(1_000, { excludedFromSpending: true })]);
    expect(partition.excludedByKind).toHaveLength(1);
    expect(partition.excludedByUser).toHaveLength(0);
  });

  it('produces an empty partition for an empty population', () => {
    const partition = partitionByTreatment([]);
    expect(partition.populationCount).toBe(0);
    expect(selectNetSpending(partition).netSpendingCents).toBe(0);
    expect(emptyPartition().populationCount).toBe(0);
  });
});

describe('net spending', () => {
  it('adds purchases, fees, and cash withdrawals', () => {
    resetIds();
    const result = selectNetSpending(
      partitionByTreatment([purchase(1_000), fee(250), cashOut(4_000)]),
    );
    expect(result.grossOutflowCents).toBe(5_250);
    expect(result.refundsCents).toBe(0);
    expect(result.netSpendingCents).toBe(5_250);
  });

  it('subtracts refunds', () => {
    resetIds();
    const result = selectNetSpending(partitionByTreatment([purchase(10_000), refund(2_500)]));
    expect(result.netSpendingCents).toBe(7_500);
    expect(result.refundsCents).toBe(2_500);
  });

  it('goes negative when refunds exceed outflows', () => {
    resetIds();
    const result = selectNetSpending(partitionByTreatment([purchase(5_000), refund(18_000)]));
    expect(result.netSpendingCents).toBe(-13_000);
  });

  it('excludes income, transfers, and card payments entirely', () => {
    resetIds();
    const result = selectNetSpending(
      partitionByTreatment([
        purchase(1_000),
        income(500_000),
        transfer(250_000),
        cardPayment(75_000),
      ]),
    );
    expect(result.netSpendingCents).toBe(1_000);
  });

  it('excludes both sides of a card payment pair, so nothing is double counted', () => {
    resetIds();
    const result = selectNetSpending(
      partitionByTreatment([
        purchase(4_000, { accountId: 'acct-card' }),
        cardPayment(4_000, { accountId: 'acct-checking', direction: 'debit' }),
        cardPayment(4_000, { accountId: 'acct-card', direction: 'credit' }),
      ]),
    );
    // The purchase is counted once, where it was spent. The payment is money
    // moved, not money spent.
    expect(result.netSpendingCents).toBe(4_000);
  });

  it('excludes user-flagged rows', () => {
    resetIds();
    const result = selectNetSpending(
      partitionByTreatment([purchase(1_000), purchase(9_999, { excludedFromSpending: true })]),
    );
    expect(result.netSpendingCents).toBe(1_000);
  });

  it('excludes unknown credits and unknown debits alike', () => {
    resetIds();
    const result = selectNetSpending(
      partitionByTreatment([purchase(1_000), unknownCredit(50_000), unknownDebit(9_000)]),
    );
    expect(result.netSpendingCents).toBe(1_000);
  });

  it('counts zero-amount rows as included without changing the total', () => {
    resetIds();
    const result = selectNetSpending(partitionByTreatment([purchase(0), purchase(1_500)]));
    expect(result.netSpendingCents).toBe(1_500);
    expect(result.includedTransactionCount).toBe(2);
  });

  it('counts both outflows and refunds as included transactions', () => {
    resetIds();
    const result = selectNetSpending(
      partitionByTreatment([purchase(100), refund(50), transfer(9)]),
    );
    expect(result.includedTransactionCount).toBe(2);
    expect(
      includedRows(partitionByTreatment([purchase(100), refund(50), transfer(9)])),
    ).toHaveLength(2);
  });

  it('is exact at cent granularity', () => {
    resetIds();
    const result = selectNetSpending(
      partitionByTreatment([purchase(1), purchase(2), purchase(3), refund(1)]),
    );
    expect(result.netSpendingCents).toBe(5);
  });

  it('does not depend on input order', () => {
    resetIds();
    const rows = [purchase(1_000), refund(250), fee(75), transfer(5_000), unknownDebit(10)];
    const forward = selectNetSpending(partitionByTreatment(rows));
    const shuffled = selectNetSpending(partitionByTreatment(shuffle(rows)));
    expect(shuffled).toEqual(forward);
  });
});

describe('signed contribution', () => {
  it('adds for an outflow and subtracts for a refund', () => {
    resetIds();
    const outflow = purchase(1_000);
    const back = refund(400);
    expect(signedContribution(outflow, 'included-outflow')).toBe(1_000);
    expect(signedContribution(back, 'included-refund')).toBe(-400);
  });

  it('contributes nothing for every excluded treatment', () => {
    resetIds();
    const row = purchase(1_000);
    expect(signedContribution(row, 'excluded-by-kind')).toBe(0);
    expect(signedContribution(row, 'excluded-by-user')).toBe(0);
    expect(signedContribution(row, 'needs-review')).toBe(0);
  });
});
