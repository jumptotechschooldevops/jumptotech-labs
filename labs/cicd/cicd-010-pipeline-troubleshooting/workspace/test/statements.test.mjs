/*
 * JumpToTech Bank — statement tests.
 *
 * Run them the way a CI job would:
 *
 *   node --test
 *
 * The Node.js built-in test runner is used so the project has no dependencies
 * to install; a pipeline step that "installs dependencies" for this project is
 * really a step that provisions the right Node.js version.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAmount, renderStatement, summarise } from '../src/statements.mjs';

test('formatAmount groups thousands and always shows two minor digits', () => {
  assert.equal(formatAmount(0), '$0.00');
  assert.equal(formatAmount(5), '$0.05');
  assert.equal(formatAmount(125_050), '$1,250.50');
  assert.equal(formatAmount(1_000_000_00), '$1,000,000.00');
});

test('formatAmount renders a debit with a leading minus', () => {
  assert.equal(formatAmount(-4_200), '-$42.00');
});

test('formatAmount honours the currency symbol', () => {
  assert.equal(formatAmount(199, 'EUR'), '€1.99');
  assert.equal(formatAmount(199, 'GBP'), '£1.99');
});

test('formatAmount refuses fractional minor units', () => {
  assert.throws(() => formatAmount(12.5), TypeError);
});

test('summarise separates credits from debits', () => {
  const totals = summarise([
    { description: 'Salary', amount: 300_000 },
    { description: 'Rent', amount: -120_000 },
    { description: 'Refund', amount: 2_500 },
  ]);

  assert.equal(totals.credits, 302_500);
  assert.equal(totals.debits, -120_000);
  assert.equal(totals.balance, 182_500);
  assert.equal(totals.count, 3);
});

test('summarise handles an empty statement period', () => {
  assert.deepEqual(summarise([]), { credits: 0, debits: 0, balance: 0, count: 0 });
});

test('formatAmount renders a whole amount', () => {
  assert.equal(formatAmount(500_00), '$500');
});

test('renderStatement includes the holder, every line, and the closing balance', () => {
  const statement = renderStatement(
    { number: 'JTT-0001-0001', holder: 'R. Vance', currency: 'USD' },
    [{ description: 'Opening deposit', amount: 50_000 }],
  );

  assert.match(statement, /JumpToTech Bank/);
  assert.match(statement, /JTT-0001-0001/);
  assert.match(statement, /R\. Vance/);
  assert.match(statement, /Opening deposit/);
  assert.match(statement, /Closing balance\s+\$500\.00/);
});
