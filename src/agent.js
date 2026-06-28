const { getConfig } = require('./config');
const { chat, chatJson } = require('./llm/minimax');
const polymarket = require('./polymarket/client');
const { analyzeMarket } = require('./decision/engine');
const render = require('./render');
const db = require('./db');
const { oneLine, escapeHtml } = require('./utils/format');

// Per-chat conversational state (in-memory; fine for a single-process bot).
// Lets "analyze 2" refer to the last /scan list and "paper buy yes 100" refer
// to the last analyzed market without the user pasting ids.
const sessions = new Map();
function session(chatId) {
  const key = String(chatId);
  if (!sessions.has(key)) sessions.set(key, { lastScan: [], lastMarket: null, lastDecision: null });
  return sessions.get(key);
}

// ---- Intent routing -------------------------------------------------------

// Fast-path regexes for the unambiguous cases; everything else falls to the LLM
// classifier so the bot feels conversational rather than command-driven.
function fastIntent(text) {
  const t = text.trim();
  const low = t.toLowerCase();

  if (/^\/?(scan|trending|markets?)\b/.test(low) && low.length < 40) return { action: 'scan' };
  if (/^\/?(positions?|portfolio|holdings)\b/.test(low)) return { action: 'positions' };
  if (/^\/?(results?|scorecard|pnl|performance)\b/.test(low)) return { action: 'results' };
  if (/^\/?(help|start)\b/.test(low)) return { action: 'help' };
  if (/^\/?why\b/.test(low)) return { action: 'why' };

  // "analyze 3", "analyse #2", "look at 1"
  const idx = low.match(/^\/?(?:analyze|analyse|look at|check|decide|rate)\s+#?(\d{1,2})$/);
  if (idx) return { action: 'analyze', listIndex: Number(idx[1]) };

  // A pasted Polymarket URL anywhere in the message.
  if (/polymarket\.com\//i.test(t)) return { action: 'analyze', reference: t };

  // "paper buy yes 100" / "buy no $50" / "paper-buy yes"
  const buy = low.match(/(?:paper[\s-]*)?buy\s+(yes|no)(?:\s*\$?(\d+(?:\.\d+)?))?/);
  if (buy) return { action: 'paper_buy', side: buy[1].toUpperCase(), stake: buy[2] ? Number(buy[2]) : null };

  // "close #3" / "close 3 yes" (resolved outcome optional)
  const close = low.match(/^\/?close\s+#?(\d+)(?:\s+(yes|no))?$/);
  if (close) return { action: 'close', tradeId: Number(close[1]), outcome: close[2] ? close[2].toUpperCase() : null };

  // "analyze <free text market name>"
  const an = t.match(/^\/?(?:analyze|analyse|decide|should i buy|rate)\s+(.{3,})$/i);
  if (an) return { action: 'analyze', reference: an[1].trim() };

  return null;
}

// LLM intent classifier for natural language that the fast-path missed.
async function classifyIntent(text) {
  const messages = [
    {
      role: 'system',
      content: [
        'You route messages for a Polymarket decision bot. Return ONLY JSON:',
        '{"action": one of ["scan","analyze","paper_buy","positions","results","why","chat"],',
        ' "reference": "<market name or url if analyze, else empty>",',
        ' "side": "<YES or NO if paper_buy, else empty>",',
        ' "stake": <number if paper_buy mentions an amount, else null>}',
        'Guidance: "what should I buy / find me a trade / scan" -> scan.',
        '"analyze X / is X likely / odds of X / should I bet on X" -> analyze with reference=X.',
        '"buy yes/no [amount]" -> paper_buy. "my positions" -> positions. "how am I doing" -> results.',
        'Anything conversational or general -> chat.',
      ].join('\n'),
    },
    { role: 'user', content: text.slice(0, 500) },
  ];
  try {
    const out = await chatJson(messages, { maxTokens: 300 });
    return out;
  } catch {
    return { action: 'chat' };
  }
}

// ---- Action handlers ------------------------------------------------------

async function doScan(chatId) {
  const markets = await polymarket.getTrendingMarkets(10);
  session(chatId).lastScan = markets;
  return render.renderMarketList(markets);
}

async function resolveTarget(chatId, intent) {
  const s = session(chatId);
  // By list index from the last scan.
  if (intent.listIndex) {
    const m = s.lastScan[intent.listIndex - 1];
    if (!m) return { error: `I don't have a #${intent.listIndex} from the last scan. Try /scan first.` };
    return { market: m };
  }
  if (intent.reference) {
    const { market, candidates } = await polymarket.resolveMarket(intent.reference);
    if (!market) return { error: `Couldn't find a market for “${oneLine(intent.reference, 60)}”. Try /scan or paste a Polymarket link.` };
    // If the text search was ambiguous, remember the candidate list too.
    if (candidates.length > 1) s.lastScan = candidates;
    return { market, candidates };
  }
  // Default: re-analyze the last market.
  if (s.lastMarket) return { market: s.lastMarket };
  return { error: 'Which market? Try /scan, then “analyze 2”, or paste a Polymarket link.' };
}

async function doAnalyze(chatId, intent) {
  const target = await resolveTarget(chatId, intent);
  if (target.error) return target.error;
  const market = target.market;
  const s = session(chatId);
  s.lastMarket = market;

  const decision = await analyzeMarket(market);
  s.lastDecision = decision;

  if (!decision.error) {
    db.saveAnalysis({
      chatId,
      marketId: market.id,
      question: market.question,
      slug: market.slug,
      url: market.url,
      marketProb: decision.marketProb,
      fairProb: decision.fairProb,
      edge: decision.edgePct,
      recommendation: decision.recommendation,
      confidence: decision.confidence,
      confidencePct: decision.confidencePct,
      reasoning: decision.reasoning,
      evidence: decision.keyFactors,
    });
  }
  return render.renderDecision(market, decision);
}

async function doPaperBuy(chatId, intent) {
  const s = session(chatId);
  const market = s.lastMarket;
  const decision = s.lastDecision;
  if (!market) return '🤔 Analyze a market first, then I can paper-trade it. Try /scan → “analyze 1”.';

  const side = intent.side || (decision?.side) || 'YES';
  const stake = intent.stake && intent.stake > 0 ? intent.stake : 100;

  // Entry price = the implied prob you pay for that side.
  const entryPrice = side === 'YES' ? (decision?.marketProb ?? market.yesPrice) : (1 - (decision?.marketProb ?? market.yesPrice));
  if (!entryPrice || entryPrice <= 0 || entryPrice >= 1) {
    return '⚠️ No usable price to enter at. Re-run the analysis and try again.';
  }

  const analysis = db.getLatestAnalysisForMarket(chatId, market.id);
  const { id, shares } = db.addPaperTrade({
    chatId,
    marketId: market.id,
    question: market.question,
    slug: market.slug,
    side,
    entryPrice,
    stake,
    analysisId: analysis?.id ?? null,
  });

  return [
    `✅ <b>Paper trade logged</b> (#${id})`,
    '',
    `${escapeHtml(oneLine(market.question, 100))}`,
    `${side} @ ${Math.round(entryPrice * 1000) / 10}% · stake $${stake} · ${shares.toFixed(1)} shares`,
    '',
    'See all with /positions · score with /results · <code>close #' + id + '</code> when it resolves.',
  ].join('\n');
}

async function doClose(chatId, intent) {
  const trade = db.getTradeById(chatId, intent.tradeId);
  if (!trade) return `🤔 No paper trade #${intent.tradeId} found. Check /positions.`;
  if (trade.status === 'closed') return `Trade #${intent.tradeId} is already closed (P&L ${trade.pnl >= 0 ? '+' : ''}$${(trade.pnl || 0).toFixed(2)}).`;

  // If the user states the resolved outcome, settle at 1/0. Otherwise close at
  // the current market price (mark-to-market).
  let exitPrice;
  if (intent.outcome) {
    const won = intent.outcome === trade.side;
    exitPrice = won ? 1 : 0;
  } else {
    const market = await polymarket.getMarketById(trade.market_id);
    const live = market ? await polymarket.getMidpoint(trade.side === 'YES' ? market.yesTokenId : market.noTokenId) : null;
    exitPrice = live != null ? live : trade.entry_price;
  }
  const closed = db.closePaperTrade(trade.id, exitPrice);
  const pnl = closed.pnl || 0;
  return [
    `${pnl >= 0 ? '🟢' : '🔴'} <b>Closed #${trade.id}</b>`,
    `${escapeHtml(oneLine(trade.question, 90))}`,
    `${trade.side} @ ${Math.round(trade.entry_price * 1000) / 10}% → ${Math.round(exitPrice * 1000) / 10}%`,
    `P&L: <b>${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</b>`,
  ].join('\n');
}

function doPositions(chatId) {
  return render.renderPositions(db.getAllTrades(chatId));
}

function doResults(chatId) {
  return render.renderResults(db.getAllTrades(chatId), getConfig().paperBankroll);
}

function doWhy(chatId) {
  const a = db.getLatestAnalysis(chatId);
  if (!a) return 'No analysis yet. Try /scan then “analyze 1”.';
  const factors = (() => { try { return JSON.parse(a.evidence_json); } catch { return []; } })();
  const lines = [
    `🧠 <b>Why: ${escapeHtml(oneLine(a.question, 120))}</b>`,
    '',
    `Recommendation: <b>${escapeHtml(a.recommendation)}</b> (${a.confidence}, ${a.confidence_pct}%)`,
    `Market ${Math.round(a.market_prob * 1000) / 10}% → fair ${Math.round(a.fair_prob * 1000) / 10}% · edge ${a.edge > 0 ? '+' : ''}${a.edge}%`,
    '',
    a.reasoning ? escapeHtml(a.reasoning) : '',
  ];
  if (factors.length) {
    lines.push('', '<b>Key factors</b>');
    factors.forEach(f => lines.push(`• ${escapeHtml(oneLine(f, 160))}`));
  }
  return lines.join('\n');
}

async function doChat(chatId, text) {
  const history = db.getConversation(chatId, 8).map(m => ({ role: m.role, content: m.content }));
  const messages = [
    {
      role: 'system',
      content: [
        'You are PolyEdge, a friendly, sharp assistant for Polymarket trading decisions.',
        'You can: scan trending markets, analyze a market into a BUY YES / BUY NO / NO-TRADE decision',
        'with confidence + reasoning, and log paper trades for self-evaluation.',
        'Keep replies short (3-6 lines), concrete, and conversational. Use plain text.',
        'If the user seems to want a decision or to find markets, nudge them: "Try /scan" or',
        '"send me a market name or Polymarket link and I\'ll analyze it." Never invent live prices —',
        'tell them to analyze a specific market for real numbers.',
      ].join('\n'),
    },
    ...history,
    { role: 'user', content: text },
  ];
  const reply = await chat(messages, { maxTokens: 700, temperature: 0.6 });
  return reply || 'I’m here. Try /scan to see live markets, or send me a market to analyze.';
}

const HELP = [
  '👋 <b>PolyEdge</b> — your Polymarket decision desk.',
  '',
  'I find markets, judge them, and tell you <b>BUY YES / BUY NO / NO-TRADE</b> with a confidence score and reasoning — then track paper trades so we can see if I’m any good.',
  '',
  '<b>Try natural language or these:</b>',
  '🔎 /scan — top live markets by volume',
  '📊 <code>analyze 2</code> — decide on #2 from the last scan',
  '🔗 paste a <i>Polymarket link</i> — I’ll analyze it',
  '🧠 “is X going to happen?” — I’ll find & analyze it',
  '💵 <code>paper buy yes 100</code> — log a $100 paper trade',
  '📈 /positions · 📊 /results · ❓ /why',
  '',
  '<i>Not financial advice. All trades are paper trades.</i>',
].join('\n');

// ---- Top-level dispatcher -------------------------------------------------

async function handleMessage(chatId, text) {
  db.addConversation(chatId, 'user', text);
  let intent = fastIntent(text);
  if (!intent) intent = await classifyIntent(text);

  let reply;
  switch (intent.action) {
    case 'help': reply = HELP; break;
    case 'scan': reply = await doScan(chatId); break;
    case 'analyze': reply = await doAnalyze(chatId, intent); break;
    case 'paper_buy': reply = await doPaperBuy(chatId, intent); break;
    case 'close': reply = await doClose(chatId, intent); break;
    case 'positions': reply = doPositions(chatId); break;
    case 'results': reply = doResults(chatId); break;
    case 'why': reply = doWhy(chatId); break;
    default: reply = await doChat(chatId, text); break;
  }

  db.addConversation(chatId, 'assistant', String(reply).replace(/<[^>]+>/g, ''));
  return reply;
}

module.exports = { handleMessage, HELP, fastIntent };
