const totals = document.querySelector('#totals');
const rows = document.querySelector('#transactions');
const status = document.querySelector('#status');
const refresh = document.querySelector('#refresh');
const mailRows = document.querySelector('#mail-records');
const mailStatus = document.querySelector('#mail-status');
const outcomes = {
  'unresolved': 'needs review',
  'statement-ingested': 'imported into ledger',
  'notification-ingested': 'imported into ledger',
  'statement-quarantined': 'statement needs review',
  'unresolved-account-ownership': 'account ownership needs review',
  'card-statement-excluded': 'card statement excluded',
  'unresolved-provider-template': 'needs review · provider template',
  'supplementary-notification-not-counted': 'supporting notification · not counted again',
  'no-supported-transaction-extracted': 'no transaction extracted',
};
function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function load() {
  refresh.disabled = true;
  totals.replaceChildren();
  rows.replaceChildren();
  mailRows.replaceChildren();
  mailStatus.textContent = 'loading saved work mail…';
  status.textContent = 'loading ledger…';
  try {
    const response = await fetch('/api/tally', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const tally = await response.json();
    if (tally.kind !== 'company-money.tally' || tally.version !== 2) throw new Error();
    document.querySelector('#entity').textContent = tally.entity + ' · company accounts';
    const formatters = new Map(tally.currencies.map(c => [c.currency, n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: c.currency }).format(n / 10 ** c.decimals)]));
    for (const c of tally.currencies) {
      const group = element('div', '', 'totals');
      for (const [label, value, style] of [['in', c.incoming, 'incoming'], ['out', c.outgoing, 'outgoing'], ['net movement', c.net, '']]) {
        const box = element('div', '', 'total');
        box.append(element('span', label), element('strong', formatters.get(c.currency)(value), style));
        group.append(box);
      }
      totals.append(group);
    }
    for (const t of tally.transactions) {
      const row = element('tr', '');
      const description = element('td', t.description);
      description.prepend(element('small', t.provider, 'provider'));
      row.append(element('td', t.date), description, element('td', t.classification + (t.status === 'completed' ? '' : ' / ' + t.status)), element('td', (t.amount > 0 ? '+' : '') + formatters.get(t.currency)(t.amount), 'amount'));
      rows.append(row);
    }
    const dates = tally.transactions.map(t => t.date).sort();
    status.textContent = dates.length ? `${dates.length} transactions · ${dates[0]} — ${dates.at(-1)} · loaded ${new Date().toLocaleTimeString()}` : 'no transactions in configured company accounts';
    if (tally.mail.status === 'available') {
      mailStatus.textContent = `${tally.mail.records.length} saved work-mail records · no additional amounts counted here`;
      for (const record of tally.mail.records) {
        const row = element('tr', '');
        const amounts = record.amounts.map(a => `${a.currency} ${a.lexeme}${a.signedMinorUnits === null ? ' (unparsed)' : ''}`).join('; ');
        row.append(element('td', record.receivedAt.slice(0, 10)), element('td', record.provider + (record.hints.length ? ' · ' + record.hints.join(', ') : '')), element('td', outcomes[record.disposition]), element('td', amounts || '—'));
        mailRows.append(row);
      }
    } else {
      mailStatus.textContent = tally.mail.status === 'missing' ? 'saved work mail has not synced here yet.' : 'saved work mail unavailable. ledger totals above are still available.';
    }
  } catch {
    totals.replaceChildren(); rows.replaceChildren(); mailRows.replaceChildren();
    mailStatus.textContent = 'saved work mail unavailable.';
    status.textContent = 'ledger unavailable. no totals shown. try refreshing after sync finishes.';
  } finally { refresh.disabled = false; }
}
refresh.addEventListener('click', load);
load();
