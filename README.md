# PolyEdge — Polymarket Decision Bot 📊

A private Telegram bot that helps you decide Polymarket trades. PolyEdge scans
live markets, estimates a **fair probability** from the market price plus an
independent LLM evidence assessment, and returns a clear call —
**BUY YES / BUY NO / NO-TRADE** — with a confidence score and written reasoning.
Every recommendation can be logged as a **paper trade** so the bot's track record
can be measured over time.

> ⚠️ Not financial advice. All trades are paper trades for self-evaluation only.

## What it does

- **Chat** — natural language, backed by an LLM. Ask anything; it nudges you
  toward a decision.
- **Scan** — `/scan` lists the top live markets by 24h volume with YES/NO prices.
- **Analyze** — point it at a market (by number from the last scan, a Polymarket
  link, or just a market name) and it returns a decision card.
- **Paper-trade log** — record paper buys, list open positions, and track P&L /
  win-rate in a local SQLite ledger.

## The decision engine

The decision is the product. For a binary market:

1. **Market prior** — the live YES price (from the CLOB order book, falling back
   to the Gamma snapshot) is read as the market's implied probability. Prediction
   markets are usually well-calibrated, so this is a strong starting point.
2. **LLM evidence assessment** — MiniMax estimates an *independent* fair
   probability for YES, with key factors, reasoning, and an explicit note on what
   it cannot see (e.g. news after its training cutoff).
3. **Blend** — `fair = market + 0.6 × (llm − market)`. We only move part of the
   way toward the model, so the edge is a conservative, shrunk version of the
   disagreement.
4. **Edge & recommendation** — `edge = fair − market`. If `|edge|` clears the
   configurable threshold (default ±7%), recommend the underpriced side;
   otherwise **NO-TRADE**.
5. **Confidence** — blends the model's self-confidence with how decisive the edge
   is, bucketed into low / medium / high.

## Usage

Talk to the bot in plain language or use the slash menu:

| Command / phrase | What it does |
| --- | --- |
| `/scan` · "what's moving?" | Top live markets by volume |
| `analyze 2` | Decide on #2 from the last scan |
| *(paste a Polymarket link)* | Analyze that market |
| "will argentina win the world cup?" | Find & analyze by name |
| `paper buy yes 100` | Log a $100 YES paper trade |
| `close #1 yes` | Settle paper trade #1 (outcome optional) |
| `/positions` | Open paper positions |
| `/results` | Paper-trading scorecard (P&L, win rate) |
| `/why` | Full reasoning behind the last call |

## Setup

Requires **Node.js ≥ 22.5** (uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN and MINIMAX_API_KEY
npm start
```

### Environment

| Variable | Description |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (required) |
| `TELEGRAM_OWNER_ID` | Optional — restrict the bot to a single user id |
| `MINIMAX_API_KEY` | MiniMax API key — the reasoning brain (required) |
| `MINIMAX_MODEL` | Model id (default `MiniMax-M1`) |
| `EDGE_THRESHOLD` | Min edge in % before a trade is recommended (default 7) |
| `PAPER_BANKROLL` | Starting paper bankroll in USD (default 1000) |
| `LLM_TIMEOUT_MS` | LLM request timeout (default 60000) |

### Run 24/7 with pm2

```bash
pm2 start src/index.js --name polyedge-bot
pm2 save
```

## Testing

```bash
npm run smoke   # offline + live-API checks: db lifecycle, intent routing,
                # sanitizer, Polymarket client, search relevance, rendering
```

## Data sources

- **Polymarket Gamma API** — market list, metadata, search (keyless)
- **Polymarket CLOB API** — live order-book midpoints (keyless)
- **MiniMax** — LLM reasoning

## Project layout

```
src/
  index.js              entrypoint (long-poll + command menu)
  bot.js                grammy wiring, owner lock, typing indicator
  agent.js              intent routing (regex fast-path + LLM) + handlers
  config.js             env config
  db.js                 SQLite: analyses, paper trades, conversations
  render.js             Telegram HTML rendering
  decision/engine.js    the decision engine (prior + LLM → edge → call)
  polymarket/client.js  Gamma + CLOB clients with retry & normalization
  llm/minimax.js        MiniMax client (+ <think> sanitizer, JSON mode)
  utils/                format (HTML), ux (typing/errors), http (retry)
scripts/smoke.js        test suite
```

## Status

MVP — chat, scan, analyze-to-decision, and paper-trade logging all work
end-to-end. Roadmap: live evidence retrieval (web/news), category-specific data
(sports odds, crypto prices), and an ensemble of competing models with a
calibration/learning loop.
