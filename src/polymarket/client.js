const { getJson } = require('../utils/http');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

// Several Gamma fields (outcomes, outcomePrices, clobTokenIds) come back as
// JSON-encoded strings rather than arrays. Parse them defensively.
function parseMaybeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Reduce a raw Gamma market to the fields the decision engine and UI need.
// For binary markets we expose the YES price as the implied probability.
function normalizeMarket(raw) {
  if (!raw) return null;
  const outcomes = parseMaybeJsonArray(raw.outcomes);
  const prices = parseMaybeJsonArray(raw.outcomePrices).map(Number);
  const tokenIds = parseMaybeJsonArray(raw.clobTokenIds);

  let yesIndex = outcomes.findIndex(o => String(o).toLowerCase() === 'yes');
  if (yesIndex === -1) yesIndex = 0;
  const noIndex = yesIndex === 0 ? 1 : 0;

  const yesPrice = Number.isFinite(prices[yesIndex]) ? prices[yesIndex] : null;
  const noPrice = Number.isFinite(prices[noIndex]) ? prices[noIndex] : (yesPrice != null ? 1 - yesPrice : null);

  return {
    id: String(raw.id),
    question: raw.question || raw.title || 'Untitled market',
    slug: raw.slug || '',
    description: raw.description || '',
    endDate: raw.endDate || raw.endDateIso || null,
    closed: Boolean(raw.closed),
    active: Boolean(raw.active),
    enableOrderBook: Boolean(raw.enableOrderBook),
    volume24hr: Number(raw.volume24hr || 0),
    volume: Number(raw.volume || raw.volumeNum || 0),
    liquidity: Number(raw.liquidity || raw.liquidityNum || 0),
    outcomes: outcomes.length ? outcomes : ['Yes', 'No'],
    yesPrice,
    noPrice,
    yesTokenId: tokenIds[yesIndex] || null,
    noTokenId: tokenIds[noIndex] || null,
    category: raw.category || raw.groupItemTitle || '',
    url: raw.slug ? `https://polymarket.com/market/${raw.slug}` : '',
  };
}

// Top live markets by 24h volume — the /scan feed.
async function getTrendingMarkets(limit = 10) {
  const data = await getJson(`${GAMMA}/markets`, {
    params: {
      active: true,
      closed: false,
      archived: false,
      order: 'volume24hr',
      ascending: false,
      limit,
    },
    retries: 3,
  });
  return (Array.isArray(data) ? data : []).map(normalizeMarket).filter(Boolean);
}

async function getMarketBySlug(slug) {
  const data = await getJson(`${GAMMA}/markets`, { params: { slug }, retries: 3 });
  const market = Array.isArray(data) ? data[0] : data;
  return market ? normalizeMarket(market) : null;
}

async function getMarketById(id) {
  try {
    const data = await getJson(`${GAMMA}/markets/${encodeURIComponent(id)}`, { retries: 3 });
    return data ? normalizeMarket(data) : null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

// Score how well a market question matches the query by word overlap. The
// public-search endpoint returns every market in a matching event (e.g. all 48
// "Will <country> win the World Cup?" markets for one "argentina" query), so
// ranking by volume alone surfaces the wrong country. Relevance must come first.
function relevanceScore(question, queryWords) {
  const q = String(question).toLowerCase();
  let score = 0;
  for (const word of queryWords) {
    if (q.includes(word)) score += word.length >= 4 ? 2 : 1; // weight meaningful words
  }
  return score;
}

// Free-text market search via the public-search endpoint. Returns flattened
// markets across the matching events, ranked by query relevance then 24h volume.
async function searchMarkets(query, limit = 8) {
  const data = await getJson(`${GAMMA}/public-search`, {
    params: { q: query, limit_per_type: 10, events_status: 'active' },
    retries: 3,
  });
  const events = data?.events || [];
  const markets = [];
  for (const event of events) {
    for (const m of event.markets || []) {
      const normalized = normalizeMarket(m);
      if (normalized && !normalized.closed) {
        if (!normalized.url && event.slug) normalized.url = `https://polymarket.com/event/${event.slug}`;
        markets.push(normalized);
      }
    }
  }

  // Skip common stop/structure words so "will X win" doesn't reward every market.
  const STOP = new Set(['will', 'the', 'win', 'a', 'an', 'to', 'in', 'of', 'on', 'is', 'be', 'by', 'for', 'and', 'or', 'do', 'does', 'happen', 'this', 'year', 'should', 'i', 'buy', 'bet']);
  const queryWords = String(query)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP.has(w));

  markets.sort((a, b) => {
    const ra = relevanceScore(a.question, queryWords);
    const rb = relevanceScore(b.question, queryWords);
    if (rb !== ra) return rb - ra;
    return b.volume24hr - a.volume24hr;
  });
  return markets.slice(0, limit);
}

// Live midpoint price for a CLOB token (0..1). Used to refresh the YES price at
// analysis time so the decision uses the freshest market prior available.
async function getMidpoint(tokenId) {
  if (!tokenId) return null;
  try {
    const data = await getJson(`${CLOB}/midpoint`, { params: { token_id: tokenId }, retries: 2, timeout: 12000 });
    const mid = Number(data?.mid);
    return Number.isFinite(mid) ? mid : null;
  } catch {
    return null;
  }
}

// Resolve a user-supplied reference (full URL, slug, numeric id, or free text)
// to a single normalized market. Returns { market, candidates } so the caller
// can disambiguate when a text search is ambiguous.
async function resolveMarket(reference) {
  const ref = String(reference || '').trim();
  if (!ref) return { market: null, candidates: [] };

  // Polymarket URL → extract the trailing slug.
  const urlMatch = ref.match(/polymarket\.com\/(?:event|market)\/([^/?#]+)/i);
  if (urlMatch) {
    const slug = urlMatch[1];
    const market = await getMarketBySlug(slug);
    if (market) return { market, candidates: [market] };
    // Event slugs differ from market slugs; fall through to search on the slug.
    const found = await searchMarkets(slug.replace(/-/g, ' '), 8);
    return { market: found[0] || null, candidates: found };
  }

  // Pure numeric id.
  if (/^\d+$/.test(ref)) {
    const market = await getMarketById(ref);
    if (market) return { market, candidates: [market] };
  }

  // Bare slug (looks-like-a-slug with hyphens, no spaces).
  if (/^[a-z0-9-]+$/i.test(ref) && ref.includes('-')) {
    const market = await getMarketBySlug(ref);
    if (market) return { market, candidates: [market] };
  }

  // Free-text search.
  const candidates = await searchMarkets(ref, 8);
  return { market: candidates[0] || null, candidates };
}

module.exports = {
  normalizeMarket,
  getTrendingMarkets,
  getMarketBySlug,
  getMarketById,
  searchMarkets,
  getMidpoint,
  resolveMarket,
};
