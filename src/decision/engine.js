const { getConfig } = require('../config');
const { chatJson } = require('../llm/minimax');
const { languagePolicy } = require('../utils/language');
const { getMidpoint } = require('../polymarket/client');

// How much we trust the LLM's disagreement with the market. The market price is
// a strong prior (prediction markets are usually well-calibrated), so we only
// move part of the way toward the model's independent estimate. fair_prob =
// market_prob + LLM_WEIGHT * (llm_prob - market_prob). With LLM_WEIGHT = 0.6
// this matches the planned "40% market / 60% model" blend while keeping the
// edge a shrunk, conservative version of the raw disagreement.
const LLM_WEIGHT = 0.6;

function clampProb(p) {
  if (!Number.isFinite(p)) return null;
  return Math.min(0.999, Math.max(0.001, p));
}

function pct(p) {
  return Math.round(p * 1000) / 10; // one decimal place, in %
}

// Build the analysis prompt. The model is asked to reason from what it knows
// about the question, list the key factors for and against, and commit to an
// independent probability — deliberately NOT just echoing the market price.
function buildMessages(market, marketProb) {
  const daysLeft = market.endDate
    ? Math.max(0, Math.round((new Date(market.endDate) - Date.now()) / 86400000))
    : null;

  const system = [
    'You are PolyEdge, a sharp, disciplined prediction-market analyst.',
    languagePolicy(),
    'Your job: estimate the TRUE probability that a Polymarket question resolves YES,',
    'reasoning independently from evidence and base rates — do NOT simply repeat the market price.',
    'Be calibrated and honest about uncertainty. If you have no real edge, say so.',
    'Return ONLY a JSON object, no prose outside it, with these exact keys:',
    '{',
    '  "fair_probability": <number 0-100, your independent probability that it resolves YES>,',
    '  "confidence": <number 0-100, how confident you are in your own estimate>,',
    '  "key_factors": [<3-6 short bullet strings: the main drivers, for and against>],',
    '  "reasoning": "<2-4 sentence explanation of your estimate and where you differ from the market, if at all>",',
    '  "knowledge_limit": "<one short sentence on what would change your view / what you cannot see (e.g. live news after your training)>"',
    '}',
  ].join('\n');

  const user = [
    `MARKET QUESTION: ${market.question}`,
    market.description ? `\nRESOLUTION DETAILS:\n${String(market.description).slice(0, 1500)}` : '',
    `\nCURRENT MARKET PRICE (implied probability of YES): ${pct(marketProb)}%`,
    daysLeft != null ? `TIME TO RESOLUTION: ~${daysLeft} day(s) (ends ${market.endDate})` : '',
    market.volume24hr ? `24H VOLUME: $${Math.round(market.volume24hr).toLocaleString()}` : '',
    '\nGive your independent fair probability for YES and the reasoning, as JSON.',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function qualifyConfidence(pctValue) {
  if (pctValue >= 70) return 'high';
  if (pctValue >= 45) return 'medium';
  return 'low';
}

// Core decision. Returns a structured recommendation object that the bot renders
// and the DB persists.
async function analyzeMarket(market) {
  const config = getConfig();

  if (market.closed || !market.active) {
    return { error: 'This market is closed or inactive — no decision to make.' };
  }

  // Prefer the freshest CLOB midpoint as the market prior; fall back to the
  // Gamma snapshot price if the order book call is unavailable.
  const liveMid = await getMidpoint(market.yesTokenId);
  const marketProb = clampProb(liveMid ?? market.yesPrice);
  if (marketProb == null) {
    return { error: 'No usable price for this market, so I cannot estimate an edge.' };
  }

  let assessment;
  try {
    assessment = await chatJson(buildMessages(market, marketProb), { maxTokens: 1200, temperature: 0.2 });
  } catch (err) {
    return { error: `The analysis model failed: ${err.message}` };
  }

  const llmProb = clampProb(Number(assessment.fair_probability) / 100);
  if (llmProb == null) {
    return { error: 'The model did not return a usable probability.' };
  }

  // Blend toward the model estimate, then derive the edge.
  const fairProb = clampProb(marketProb + LLM_WEIGHT * (llmProb - marketProb));
  const edge = fairProb - marketProb; // signed, in probability units
  const edgePct = pct(edge);
  const absEdgePct = Math.abs(edgePct);
  const threshold = config.edgeThreshold;

  // Recommendation: positive edge => YES underpriced; negative => NO underpriced.
  let recommendation = 'NO-TRADE';
  let side = null;
  if (absEdgePct >= threshold) {
    if (edge > 0) {
      recommendation = 'BUY YES';
      side = 'YES';
    } else {
      recommendation = 'BUY NO';
      side = 'NO';
    }
  }

  // Expected value on stake for the recommended side (sanity figure for the UI).
  let evPct = null;
  if (side === 'YES') evPct = pct((fairProb - marketProb) / marketProb);
  if (side === 'NO') evPct = pct((marketProb - fairProb) / (1 - marketProb));

  // Final confidence blends the model's self-confidence with how decisive the
  // edge is. A big edge the model is unsure about, or a tiny edge it's sure
  // about, both land in the middle.
  const modelConfidence = Math.min(100, Math.max(0, Number(assessment.confidence) || 0));
  const edgeConfidence = Math.min(100, (absEdgePct / Math.max(threshold, 1)) * 50);
  const confidencePct = Math.round(0.6 * modelConfidence + 0.4 * edgeConfidence);
  const confidence = qualifyConfidence(confidencePct);

  return {
    marketProb,
    marketProbPct: pct(marketProb),
    llmProb,
    llmProbPct: pct(llmProb),
    fairProb,
    fairProbPct: pct(fairProb),
    edge,
    edgePct,
    evPct,
    recommendation,
    side,
    confidence,
    confidencePct,
    threshold,
    keyFactors: Array.isArray(assessment.key_factors) ? assessment.key_factors.slice(0, 6) : [],
    reasoning: assessment.reasoning || '',
    knowledgeLimit: assessment.knowledge_limit || '',
    priceSource: liveMid != null ? 'live order book' : 'gamma snapshot',
  };
}

module.exports = { analyzeMarket, LLM_WEIGHT };
