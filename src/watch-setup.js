'use strict';

// watch-setup.js — PolyEdge-specific wiring for the generic WatchManager.
//
// Registers the "did the thing happen?" probes PolyEdge can watch for (a
// market's YES price crosses a threshold, or a market resolves/closes) and
// exposes a shared singleton. Watches are OPT-IN: the agent only calls
// startWatch after the user agrees. Each poll is one cheap Polymarket read; the
// guard caps in watch.js (poll count + wall-clock deadline) guarantee it ends.

const { WatchManager } = require('./watch');
const polymarket = require('./polymarket/client');

let manager = null;

function registerProbes(wm) {
  // A market's YES probability crosses a threshold (above or below).
  wm.registerProbe('price_cross', async params => {
    const market = await polymarket.getMarketById(params.marketId).catch(() => null);
    if (!market) return { done: false };
    let prob = market.yesPrice;
    // Prefer a live midpoint from the order book when we have a token id.
    if (market.yesTokenId) {
      const mid = await polymarket.getMidpoint(market.yesTokenId).catch(() => null);
      if (mid != null) prob = mid;
    }
    if (prob == null) return { done: false };
    const pct = prob * 100;
    const hit = params.direction === 'below' ? pct <= params.threshold : pct >= params.threshold;
    return { done: Boolean(hit), prob: pct };
  });

  // A market resolves / closes — useful to auto-settle a paper trade.
  wm.registerProbe('market_resolved', async params => {
    const market = await polymarket.getMarketById(params.marketId).catch(() => null);
    if (!market) return { done: false };
    return { done: Boolean(market.closed) || market.active === false, closed: Boolean(market.closed) };
  });

  return wm;
}

function getWatchManager(bot) {
  if (!manager) {
    manager = new WatchManager(bot, { maxConcurrent: 10 });
    registerProbes(manager);
  } else if (bot && !manager.bot) {
    manager.bot = bot;
  }
  return manager;
}

// NL → watch-spec. The agent already resolves markets from the last scan/analyze,
// so the primary path is buildWatchFromMarket(); this parser handles a bare
// "watch/alert when it hits 60%" phrasing against a supplied market.
function parseWatchIntent(text, market) {
  const t = String(text || '').toLowerCase();
  if (!/\b(watch|monitor|keep an eye|let me know when|notify me when|tell me when|ping me when|alert me when)\b/.test(t)) return null;
  if (!market) return null;

  const q = market.question || 'this market';

  // "when it resolves / settles / closes"
  if (/\b(resolve|resolves|settle|settles|close|closes|ends?)\b/.test(t)) {
    return { kind: 'market_resolved', params: { marketId: market.id }, label: `“${q}” to resolve` };
  }

  // "when it hits/crosses/reaches N%" (above by default; "drops/falls below" = below)
  const pctMatch = t.match(/(\d{1,3})\s*%/);
  if (pctMatch) {
    const threshold = Math.max(0, Math.min(100, Number(pctMatch[1])));
    const direction = /\b(below|under|drop|drops|fall|falls|dips?)\b/.test(t) ? 'below' : 'above';
    return {
      kind: 'price_cross',
      params: { marketId: market.id, threshold, direction },
      label: `“${q}” YES to go ${direction} ${threshold}%`,
    };
  }
  return null;
}

module.exports = { getWatchManager, registerProbes, parseWatchIntent };
