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
function renderDecision(market, d, candidates = []) {
  if (d.error) return `⚠️ ${escapeHtml(d.error)}`;

  const badge = REC_BADGE[d.recommendation] || escapeHtml(d.recommendation);
  const edgeSign = d.edgePct > 0 ? '+' : '';
  const marketLink = market.url ? `<a href="${escapeHtml(market.url)}">Open Polymarket ↗</a>` : '';
  const lines = [
    `📊 <b>${escapeHtml(oneLine(market.question, 140))}</b>`,
    marketLink ? `🔗 ${marketLink}` : '',
    '',
    `${badge}  ·  confidence: <b>${escapeHtml(d.confidence)}</b> (${d.confidencePct}%)`,
    '──────────',
    `• Market implied: <b>${d.marketProbPct}%</b> YES <i>(${d.priceSource})</i>`,
    `• PolyEdge fair: <b>${d.fairProbPct}%</b> YES`,
    `• Edge: <b>${edgeSign}${d.edgePct}%</b>  (threshold ±${d.threshold}%)`,
  ].filter(line => line !== '');
  if (d.side && d.evPct != null) lines.push(`• Est. value on ${d.side}: <b>${d.evPct > 0 ? '+' : ''}${d.evPct}%</b>`);
  lines.push('');

  if (d.reasoning) lines.push(`🧠 ${mdToHtml(d.reasoning)}`, '');
  if (d.keyFactors?.length) {
    lines.push('<b>Key factors</b>');
    d.keyFactors.forEach(f => lines.push(`• ${escapeHtml(oneLine(f, 160))}`));
    lines.push('');
  }
  if (d.knowledgeLimit) lines.push(`⚠️ <i>${escapeHtml(oneLine(d.knowledgeLimit, 200))}</i>`, '');

  if (candidates.length > 1) {
    lines.push('<b>Other matching markets</b>');
    candidates.slice(1, 4).forEach((m, i) => lines.push(`${i + 2}. ${escapeHtml(oneLine(m.question, 90))}`));
    lines.push('');
  }

  if (d.recommendation === 'NO-TRADE') {
    lines.push('No clear edge — sitting out is the call.');
  } else if (d.side) {
    lines.push(`💵 Paper-trade it: <code>paper buy ${d.side.toLowerCase()} 100</code>`);
  }
  lines.push('', '<i>Not financial advice. Paper trading only.</i>');
  return lines.join('\n');
}

function renderNoMarketAnswer(question, a = {}) {
  if (a.error) {
    return [
      '🔎 <b>No active Polymarket market found</b>',
      '',
      `<b>Question:</b> ${escapeHtml(oneLine(question, 160))}`,
      '',
      `⚠️ I could not generate a fallback answer: ${escapeHtml(oneLine(a.error, 180))}`,
      '',
      'Try rephrasing with the team/person/event name, or send a Polymarket link if you have one.',
    ].join('\n');
  }

  const prob = Number(a.probability);
  const hasProb = Number.isFinite(prob) && prob >= 0 && prob <= 100;
  const lines = [
    '🔎 <b>No active Polymarket market found</b>',
    '',
    `<b>Question:</b> ${escapeHtml(oneLine(question, 160))}`,
    hasProb ? `🎯 <b>My rough take:</b> ${Math.round(prob * 10) / 10}% YES · confidence: <b>${escapeHtml(a.confidence || 'low')}</b>` : `🎯 <b>My rough take:</b> confidence: <b>${escapeHtml(a.confidence || 'low')}</b>`,
    '──────────',
  ];
  if (a.answer) lines.push(`🧠 ${mdToHtml(a.answer)}`, '');
  if (Array.isArray(a.key_factors) && a.key_factors.length) {
    lines.push('<b>Key factors</b>');
    a.key_factors.slice(0, 5).forEach(f => lines.push(`• ${escapeHtml(oneLine(f, 160))}`));
    lines.push('');
  }
  if (Array.isArray(a.what_to_watch) && a.what_to_watch.length) {
    lines.push('<b>What to watch</b>');
    a.what_to_watch.slice(0, 3).forEach(f => lines.push(`• ${escapeHtml(oneLine(f, 160))}`));
    lines.push('');
  }
  lines.push('If a Polymarket market appears later, send me the link or ask again and I’ll analyze the live price/edge.');
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

function renderChat(text) {
  return mdToHtml(text);
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

module.exports = { renderMarketList, renderDecision, renderNoMarketAnswer, renderChat, renderPositions, renderResults, money, priceLine };
