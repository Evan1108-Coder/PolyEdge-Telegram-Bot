// Offline smoke test: exercises config, db, intent routing, polymarket client,
// the decision engine, and rendering — without starting the Telegram long-poll.
// Run: node scripts/smoke.js
const assert = require('node:assert');

async function main() {
  let pass = 0;
  const ok = (label, cond) => { assert.ok(cond, label); console.log('  ✓', label); pass += 1; };

  console.log('1. config');
  const { getConfig } = require('../src/config');
  const cfg = getConfig();
  ok('telegram token present', cfg.telegramToken.length > 20);
  ok('minimax key present', cfg.minimaxApiKey.length > 20);
  ok('edge threshold numeric', Number.isFinite(cfg.edgeThreshold));

  console.log('2. db (paper trade lifecycle)');
  const db = require('../src/db');
  db.openDb();
  const chatId = 'smoke-test';
  const aid = db.saveAnalysis({
    chatId, marketId: 'm1', question: 'Test market?', slug: 't', url: '',
    marketProb: 0.4, fairProb: 0.55, edge: 15, recommendation: 'BUY YES',
    confidence: 'medium', confidencePct: 60, reasoning: 'because', evidence: ['a', 'b'],
  });
  ok('analysis saved', aid > 0);
  const { id, shares } = db.addPaperTrade({ chatId, marketId: 'm1', question: 'Test market?', slug: 't', side: 'YES', entryPrice: 0.4, stake: 100, analysisId: aid });
  ok('paper trade saved', id > 0);
  ok('shares = stake/price', Math.abs(shares - 250) < 0.001);
  ok('open trades listed', db.getOpenTrades(chatId).length >= 1);
  const closed = db.closePaperTrade(id, 1); // resolves YES → win
  ok('pnl correct on win', Math.abs(closed.pnl - (1 - 0.4) * 250) < 0.001); // +150
  ok('latest analysis retrievable', db.getLatestAnalysis(chatId).market_id === 'm1');

  console.log('3. intent routing (fast-path)');
  const { fastIntent } = require('../src/agent');
  ok('scan', fastIntent('scan').action === 'scan');
  ok('/scan', fastIntent('/scan').action === 'scan');
  ok('analyze 2', fastIntent('analyze 2').listIndex === 2);
  ok('url -> analyze', fastIntent('check https://polymarket.com/market/foo').action === 'analyze');
  const buy = fastIntent('paper buy yes 100');
  ok('paper buy parsed', buy.action === 'paper_buy' && buy.side === 'YES' && buy.stake === 100);
  ok('buy no $50', (() => { const b = fastIntent('buy no $50'); return b.side === 'NO' && b.stake === 50; })());
  ok('close #3 yes', (() => { const c = fastIntent('close #3 yes'); return c.tradeId === 3 && c.outcome === 'YES'; })());
  ok('positions', fastIntent('positions').action === 'positions');
  ok('results', fastIntent('results').action === 'results');
  ok('free chat -> null', fastIntent('hey how are you') === null);

  console.log('4. minimax sanitizer');
  const { sanitizeAssistantText } = require('../src/llm/minimax');
  ok('strips <think>', sanitizeAssistantText('<think>secret</think>Hello') === 'Hello');
  ok('strips unterminated think', sanitizeAssistantText('<think>oops no close') === '');

  console.log('5. polymarket client (live)');
  const pm = require('../src/polymarket/client');
  const markets = await pm.getTrendingMarkets(5);
  ok('trending markets fetched', markets.length > 0);
  ok('market has yesPrice', markets[0].yesPrice != null);
  ok('market has token id', Boolean(markets[0].yesTokenId));
  const mid = await pm.getMidpoint(markets[0].yesTokenId);
  ok('clob midpoint fetched', mid == null || (mid >= 0 && mid <= 1));
  const search = await pm.searchMarkets('bitcoin', 5);
  ok('search returns markets', Array.isArray(search));
  // Regression: text relevance must beat raw volume, so a country query returns
  // that country's market, not the highest-volume World Cup market.
  const arg = await pm.searchMarkets('will argentina win the world cup', 5);
  ok('search ranks by relevance', arg.length === 0 || /argentina/i.test(arg[0].question));

  console.log('6. render');
  const render = require('../src/render');
  const list = render.renderMarketList(markets);
  ok('market list renders', list.includes('1.'));
  const card = render.renderDecision(markets[0], {
    error: null, recommendation: 'NO-TRADE', confidence: 'low', confidencePct: 30,
    marketProbPct: 5, fairProbPct: 6, edgePct: 1, threshold: 7, priceSource: 'live order book',
    reasoning: 'test', keyFactors: ['x'], knowledgeLimit: 'limited', side: null,
  });
  ok('decision card renders', card.includes('NO-TRADE'));

  console.log(`\n✅ ${pass} checks passed`);
  process.exit(0);
}

main().catch(e => { console.error('\n❌ SMOKE FAILED:', e.message, '\n', e.stack); process.exit(1); });
