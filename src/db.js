const { DatabaseSync } = require('node:sqlite');
const { getConfig } = require('./config');

let db;

function openDb(dbPath = getConfig().dbPath) {
  if (db) return db;
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversations (
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- One row per market analysis (the core decision output), so /why and the
    -- self-eval loop can look up the latest reasoning for any market.
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      question TEXT NOT NULL,
      slug TEXT,
      url TEXT,
      market_prob REAL,
      fair_prob REAL,
      edge REAL,
      recommendation TEXT NOT NULL,
      confidence TEXT,
      confidence_pct INTEGER,
      reasoning TEXT,
      evidence_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Paper trades = the bot's self-evaluation ledger (not a real portfolio).
    CREATE TABLE IF NOT EXISTS paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      question TEXT NOT NULL,
      slug TEXT,
      side TEXT NOT NULL,            -- YES | NO
      entry_price REAL NOT NULL,    -- 0..1 implied prob at entry
      stake REAL NOT NULL,          -- USD
      shares REAL NOT NULL,         -- stake / entry_price
      status TEXT NOT NULL DEFAULT 'open',  -- open | closed
      exit_price REAL,
      pnl REAL,
      resolved_outcome TEXT,
      analysis_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT,
      FOREIGN KEY(analysis_id) REFERENCES analyses(id) ON DELETE SET NULL
    );
  `);
}

function getSetting(key, fallback = null) {
  const row = openDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

function setSetting(key, value) {
  openDb()
    .prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `)
    .run(key, JSON.stringify(value));
}

function addConversation(chatId, role, content) {
  openDb()
    .prepare('INSERT INTO conversations (chat_id, role, content) VALUES (?, ?, ?)')
    .run(String(chatId), role, String(content).slice(0, 6000));
  // Keep only the last 30 turns per chat.
  openDb()
    .prepare(`
      DELETE FROM conversations
      WHERE rowid IN (
        SELECT rowid FROM conversations
        WHERE chat_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT -1 OFFSET 30
      )
    `)
    .run(String(chatId));
}

function getConversation(chatId, limit = 10) {
  return openDb()
    .prepare(`
      SELECT role, content FROM conversations
      WHERE chat_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `)
    .all(String(chatId), limit)
    .reverse();
}

function saveAnalysis(record) {
  const result = openDb()
    .prepare(`
      INSERT INTO analyses
        (chat_id, market_id, question, slug, url, market_prob, fair_prob, edge,
         recommendation, confidence, confidence_pct, reasoning, evidence_json)
      VALUES
        (@chat_id, @market_id, @question, @slug, @url, @market_prob, @fair_prob, @edge,
         @recommendation, @confidence, @confidence_pct, @reasoning, @evidence_json)
    `)
    .run({
      chat_id: String(record.chatId),
      market_id: String(record.marketId),
      question: record.question,
      slug: record.slug || '',
      url: record.url || '',
      market_prob: record.marketProb,
      fair_prob: record.fairProb,
      edge: record.edge,
      recommendation: record.recommendation,
      confidence: record.confidence || '',
      confidence_pct: record.confidencePct ?? null,
      reasoning: record.reasoning || '',
      evidence_json: JSON.stringify(record.evidence || []),
    });
  return Number(result.lastInsertRowid);
}

function getLatestAnalysisForMarket(chatId, marketId) {
  return openDb()
    .prepare(`
      SELECT * FROM analyses
      WHERE chat_id = ? AND market_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `)
    .get(String(chatId), String(marketId));
}

function getLatestAnalysis(chatId) {
  return openDb()
    .prepare('SELECT * FROM analyses WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(String(chatId));
}

function addPaperTrade(record) {
  const shares = record.stake / record.entryPrice;
  const result = openDb()
    .prepare(`
      INSERT INTO paper_trades
        (chat_id, market_id, question, slug, side, entry_price, stake, shares, analysis_id)
      VALUES
        (@chat_id, @market_id, @question, @slug, @side, @entry_price, @stake, @shares, @analysis_id)
    `)
    .run({
      chat_id: String(record.chatId),
      market_id: String(record.marketId),
      question: record.question,
      slug: record.slug || '',
      side: record.side,
      entry_price: record.entryPrice,
      stake: record.stake,
      shares,
      analysis_id: record.analysisId ?? null,
    });
  return { id: Number(result.lastInsertRowid), shares };
}

function getOpenTrades(chatId) {
  return openDb()
    .prepare(`SELECT * FROM paper_trades WHERE chat_id = ? AND status = 'open' ORDER BY created_at DESC`)
    .all(String(chatId));
}

function getAllTrades(chatId) {
  return openDb()
    .prepare('SELECT * FROM paper_trades WHERE chat_id = ? ORDER BY created_at DESC')
    .all(String(chatId));
}

function getTradeById(chatId, id) {
  return openDb()
    .prepare('SELECT * FROM paper_trades WHERE chat_id = ? AND id = ?')
    .get(String(chatId), Number(id));
}

// Close a paper trade at a given exit price (0..1). PnL for a prediction-market
// share = (exit - entry) * shares for YES exposure; the share already encodes
// the side because entry_price is stored as the price actually paid for `side`.
function closePaperTrade(id, exitPrice) {
  const trade = openDb().prepare('SELECT * FROM paper_trades WHERE id = ?').get(Number(id));
  if (!trade) return null;
  const pnl = (exitPrice - trade.entry_price) * trade.shares;
  openDb()
    .prepare(`
      UPDATE paper_trades
      SET status = 'closed', exit_price = ?, pnl = ?, closed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    .run(exitPrice, pnl, Number(id));
  return { ...trade, status: 'closed', exit_price: exitPrice, pnl };
}

module.exports = {
  openDb,
  getSetting,
  setSetting,
  addConversation,
  getConversation,
  saveAnalysis,
  getLatestAnalysisForMarket,
  getLatestAnalysis,
  addPaperTrade,
  getOpenTrades,
  getAllTrades,
  getTradeById,
  closePaperTrade,
};
