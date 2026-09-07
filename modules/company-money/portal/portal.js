const totals = document.querySelector('#totals');
const rows = document.querySelector('#transactions');
const status = document.querySelector('#status');
const refresh = document.querySelector('#refresh');
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
  status.textContent = 'loading ledger…';
  try {
    const response = await fetch('/api/tally', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const tally = await response.json();
    if (tally.kind !== 'company-money.tally' || tally.version !== 1) throw new Error();
    document.querySelector('#entity').textContent = tally.entity + ' · nubank';
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
      row.append(element('td', t.date), element('td', t.description), element('td', t.classification + (t.status === 'completed' ? '' : ' / ' + t.status)), element('td', (t.amount > 0 ? '+' : '') + formatters.get(t.currency)(t.amount), 'amount'));
      rows.append(row);
    }
    const dates = tally.transactions.map(t => t.date).sort();
    status.textContent = dates.length ? `${dates.length} transactions · ${dates[0]} — ${dates.at(-1)} · loaded ${new Date().toLocaleTimeString()}` : 'no nubank transactions in this ledger';
  } catch {
    totals.replaceChildren(); rows.replaceChildren();
    status.textContent = 'ledger unavailable. no totals shown. try refreshing after sync finishes.';
  } finally { refresh.disabled = false; }
}
refresh.addEventListener('click', load);
load();
