const fs = require('fs');
const path = require('path');
require('dotenv').config();

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getConfig() {
  ensureDataDir();
  return {
    rootDir: ROOT_DIR,
    dataDir: DATA_DIR,
    dbPath: process.env.DB_PATH || path.join(DATA_DIR, 'polyedge.sqlite'),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramOwnerId: process.env.TELEGRAM_OWNER_ID || '',
    minimaxApiKey: process.env.MINIMAX_API_KEY || '',
    minimaxModel: process.env.MINIMAX_MODEL || 'MiniMax-M1',
    edgeThreshold: num(process.env.EDGE_THRESHOLD, 7),
    paperBankroll: num(process.env.PAPER_BANKROLL, 1000),
    defaultTimezone: process.env.DEFAULT_TIMEZONE || 'UTC',
    llmTimeoutMs: num(process.env.LLM_TIMEOUT_MS, 60000),
  };
}

function validateStartupConfig() {
  const config = getConfig();
  if (!config.telegramToken) throw new Error('TELEGRAM_BOT_TOKEN is missing in .env');
  if (!config.minimaxApiKey) {
    console.warn('[Config] MINIMAX_API_KEY missing: chat and analysis will fail until set.');
  }
  return config;
}

module.exports = { getConfig, validateStartupConfig };
