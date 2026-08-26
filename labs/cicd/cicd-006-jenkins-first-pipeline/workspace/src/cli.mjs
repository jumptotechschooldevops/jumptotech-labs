/*
 * JumpToTech Bank — statement command line.
 *
 *   node src/cli.mjs             print a sample statement
 *   node src/cli.mjs --selftest  run the built-in self-check (exit 0 on success)
 *
 * The self-check is what a deployment smoke test would call: it exercises the
 * library end to end and reports through the exit code, the way a pipeline
 * step expects.
 */
import assert from 'node:assert/strict';
import { formatAmount, renderStatement, summarise } from './statements.mjs';

const ACCOUNT = { number: 'JTT-4417-0092', holder: 'A. Okonkwo', currency: 'USD' };

const TRANSACTIONS = [
  { description: 'Salary — Meridian Systems', amount: 412_500 },
  { description: 'Rent', amount: -155_000 },
  { description: 'Groceries', amount: -8_745 },
  { description: 'Refund — Halden Books', amount: 2_199 },
];

function selftest() {
  try {
    assert.equal(formatAmount(125_050), '$1,250.50');
    assert.equal(formatAmount(-4_200), '-$42.00');
    assert.equal(summarise(TRANSACTIONS).balance, 250_954);

    const statement = renderStatement(ACCOUNT, TRANSACTIONS);
    assert.match(statement, /JumpToTech Bank/);
    assert.match(statement, /Closing balance/);

    console.log('selftest: ok');
    return 0;
  } catch (error) {
    console.error(`selftest: FAILED — ${error.message}`);
    return 1;
  }
}

const args = process.argv.slice(2);
if (args.includes('--selftest')) {
  process.exit(selftest());
} else {
  console.log(renderStatement(ACCOUNT, TRANSACTIONS));
}
