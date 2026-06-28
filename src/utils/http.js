const axios = require('axios');

// Polymarket's public Gamma/CLOB endpoints occasionally drop a connection
// (curl reports HTTP 000 / ECONNRESET) under no obvious load. A couple of quick
// retries with backoff turns those transient blips into successful calls.
async function getJson(url, { timeout = 15000, retries = 3, params } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await axios.get(url, {
        params,
        timeout,
        headers: { Accept: 'application/json', 'User-Agent': 'PolyEdge/1.0' },
      });
      return res.data;
    } catch (err) {
      lastErr = err;
      const retriable = !err.response || err.response.status >= 500 || err.code === 'ECONNABORTED';
      if (!retriable || attempt === retries) break;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { getJson, sleep };
