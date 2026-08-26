/*
 * JumpToTech Bank — account statement formatting.
 *
 * A small, dependency-free library so the lab is about the pipeline, not about
 * the application. It has no imports on purpose: build.mjs bundles this file by
 * dropping the `export` keywords and concatenating, which only works while the
 * module stands alone.
 */

export const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };

/** Render minor units (cents) as a display amount: 125050 -> "$1,250.50". */
export function formatAmount(minorUnits, currency = 'USD') {
  if (!Number.isInteger(minorUnits)) {
    throw new TypeError('amounts are held in integer minor units');
  }
  const symbol = CURRENCY_SYMBOLS[currency] ?? '';
  const negative = minorUnits < 0;
  const absolute = Math.abs(minorUnits);
  const major = Math.floor(absolute / 100);
  const minor = String(absolute % 100).padStart(2, '0');
  const grouped = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${symbol}${grouped}.${minor}`;
}

/** Total the credits, debits and closing balance of a transaction list. */
export function summarise(transactions) {
  if (!Array.isArray(transactions)) {
    throw new TypeError('transactions must be an array');
  }
  let credits = 0;
  let debits = 0;
  for (const transaction of transactions) {
    const amount = transaction.amount;
    if (!Number.isInteger(amount)) {
      throw new TypeError(`transaction '${transaction.description}' has a non-integer amount`);
    }
    if (amount >= 0) credits += amount;
    else debits += amount;
  }
  return { credits, debits, balance: credits + debits, count: transactions.length };
}

/** Render a plain-text statement for one account. */
export function renderStatement(account, transactions) {
  const totals = summarise(transactions);
  const currency = account.currency ?? 'USD';
  const width = 44;

  const lines = [
    'JumpToTech Bank'.padEnd(width),
    '='.repeat(width),
    `Account: ${account.number}`,
    `Holder:  ${account.holder}`,
    '-'.repeat(width),
  ];

  for (const transaction of transactions) {
    const amount = formatAmount(transaction.amount, currency);
    lines.push(`${String(transaction.description).slice(0, 28).padEnd(30)}${amount.padStart(14)}`);
  }

  lines.push('-'.repeat(width));
  lines.push(`${'Credits'.padEnd(30)}${formatAmount(totals.credits, currency).padStart(14)}`);
  lines.push(`${'Debits'.padEnd(30)}${formatAmount(totals.debits, currency).padStart(14)}`);
  lines.push(`${'Closing balance'.padEnd(30)}${formatAmount(totals.balance, currency).padStart(14)}`);

  return lines.join('\n');
}
