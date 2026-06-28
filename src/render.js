const { escapeHtml, oneLine, mdToHtml } = require('./utils/format');

function money(n) {
  const v = Number(n || 0);
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function priceLine(market) {
  const yes = market.yesPrice != null ? `${Math.round(market.yesPrice * 1000) / 10}%` : '—';
  const no = market.noPrice != null ? `${Math.round(market.noPrice * 1000) / 10}%` : '—';
  return `YES ${yes} · NO ${no}`;
}

// /scan list — numbered, compact, with prices and volume.
function renderMarketList(markets, title = '🔥 Trending Polymarket markets') {
  if (!markets.length) return '😕 No live markets came back. Try again in a moment.';
  const lines = [`<b>${escapeHtml(title)}</b>`, ''];
  markets.forEach((m, i) => {
    lines.push(
      `<b>${i + 1}.</b> ${escapeHtml(oneLine(m.question, 90))}`,
      `   ${priceLine(m)} · 24h ${money(m.volume24hr)}`,
    );
  });
  lines.push('', '💡 Reply <code>analyze 2</code> (or paste a market link) to get a decision.');
  return lines.join('\n');
}

const REC_BADGE = {
  'BUY YES': '🟢 <b>BUY YES</b>',
  'BUY NO': '🔴 <b>BUY NO</b>',
  'NO-TRADE': '⚪ <b>NO-TRADE</b>',
};

// The decision card — the product's core output.
function renderDecision(market, d) {
  if (d.error) return `⚠️ ${escapeHtml(d.error)}`;

  const badge = REC_BADGE[d.recommendation] || escapeHtml(d.recommendation);
  const edgeSign = d.edgePct > 0 ? '+' : '';
  const lines = [
    `📊 <b>${escapeHtml(oneLine(market.question, 140))}</b>`,
    '',
    `${badge}  ·  confidence: <b>${escapeHtml(d.confidence)}</b> (${d.confidencePct}%)`,
    '',
    `• Market implied: <b>${d.marketProbPct}%</b> YES <i>(${d.priceSource})</i>`,
    `• PolyEdge fair: <b>${d.fairProbPct}%</b> YES`,
    `• Edge: <b>${edgeSign}${d.edgePct}%</b>  (threshold ±${d.threshold}%)`,
  ];
  if (d.side && d.evPct != null) lines.push(`• Est. value on ${d.side}: <b>${d.evPct > 0 ? '+' : ''}${d.evPct}%</b>`);
  lines.push('');

  if (d.reasoning) lines.push(`🧠 ${mdToHtml(d.reasoning)}`, '');
  if (d.keyFactors?.length) {
    lines.push('<b>Key factors</b>');
    d.keyFactors.forEach(f => lines.push(`• ${escapeHtml(oneLine(f, 160))}`));
    lines.push('');
  }
  if (d.knowledgeLimit) lines.push(`⚠️ <i>${escapeHtml(oneLine(d.knowledgeLimit, 200))}</i>`, '');

  if (d.recommendation === 'NO-TRADE') {
    lines.push('No clear edge — sitting out is the call.');
  } else if (d.side) {
    lines.push(`💵 Paper-trade it: <code>paper buy ${d.side.toLowerCase()} 100</code>`);
  }
  lines.push('', '<i>Not financial advice. Paper trading only.</i>');
  return lines.join('\n');
}

function renderPositions(trades) {
  const open = trades.filter(t => t.status === 'open');
  if (!open.length) return '📭 No open paper positions. Analyze a market, then <code>paper buy yes 100</code>.';
  const lines = ['<b>📈 Open paper positions</b>', ''];
  open.forEach(t => {
    lines.push(
      `<b>#${t.id}</b> ${escapeHtml(oneLine(t.question, 80))}`,
      `   ${t.side} @ ${Math.round(t.entry_price * 1000) / 10}% · stake ${money(t.stake)} · ${t.shares.toFixed(1)} shares`,
    );
  });
  lines.push('', 'Close one with <code>close #ID</code> once it resolves.');
  return lines.join('\n');
}

function renderResults(trades, bankroll) {
  if (!trades.length) return '📊 No paper trades yet. Your self-eval ledger is empty.';
  const closed = trades.filter(t => t.status === 'closed');
  const open = trades.filter(t => t.status === 'open');
  const realized = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const wins = closed.filter(t => (t.pnl || 0) > 0).length;
  const winRate = closed.length ? Math.round((wins / closed.length) * 100) : 0;

  const lines = [
    '<b>📊 Paper trading scorecard</b>',
    '',
    `Bankroll: <b>${money(bankroll)}</b>`,
    `Closed trades: <b>${closed.length}</b> · Win rate: <b>${winRate}%</b>`,
    `Realized P&L: <b>${realized >= 0 ? '+' : ''}${money(realized)}</b>`,
    `Open positions: <b>${open.length}</b>`,
  ];
  if (closed.length) {
    lines.push('', '<b>Recent closed</b>');
    closed.slice(0, 6).forEach(t => {
      const sign = (t.pnl || 0) >= 0 ? '🟢' : '🔴';
      lines.push(`${sign} #${t.id} ${escapeHtml(oneLine(t.question, 60))} → ${(t.pnl || 0) >= 0 ? '+' : ''}${money(t.pnl)}`);
    });
  }
  return lines.join('\n');
}

module.exports = { renderMarketList, renderDecision, renderPositions, renderResults, money, priceLine };
