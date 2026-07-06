const { version: VERSION } = require('../package.json');
const { getConfig } = require('./config');
const { evidenceSummary } = require('./utils/actionlog');
const { escapeHtml } = require('./utils/format');
const { checkForUpdate } = require('./update');

const SELF_RE = /\b(latest version|what version|version are you|your version|who are you|what can you do|what are you|your config|your model|your status|update status|can you update|commands|capabilities)\b/i;

function isSelfContextQuery(text) { return SELF_RE.test(String(text || '')); }

function getSelfContext(chatId, opts = {}) {
  const cfg = getConfig();
  let update = 'not checked in this response';
  if (opts.checkUpdate) {
    try {
      const info = checkForUpdate();
      update = info.available ? `update available (${info.behind} commit${info.behind === 1 ? '' : 's'} behind)` : 'already on latest origin/main';
    } catch (e) { update = `could not check update: ${e.message}`; }
  }
  return {
    name: 'PolyEdge',
    version: VERSION,
    repo: 'Evan1108-Coder/PolyEdge-Telegram-Bot',
    pm2: process.env.PM2_PROCESS_NAME || 'polyedge-bot',
    model: cfg.minimaxModel || 'configured MiniMax model',
    update,
    capabilities: 'Polymarket market scan, market analysis, BUY YES/BUY NO/NO-TRADE decisions, confidence/reasoning, paper trades, positions/results, opt-in watches.',
    recentEvidence: evidenceSummary(chatId),
  };
}

function selfContextText(chatId, opts = {}) {
  const c = getSelfContext(chatId, opts);
  return [
    `Bot: ${c.name} v${c.version}`,
    `Repo/process: ${c.repo} / ${c.pm2}`,
    `Model: ${c.model}`,
    `Update: ${c.update}`,
    `Capabilities: ${c.capabilities}`,
    `Recent evidence:\n${c.recentEvidence}`,
  ].join('\n');
}

function renderSelfContext(chatId, opts = {}) {
  const c = getSelfContext(chatId, { ...opts, checkUpdate: true });
  return [
    `🎯 <b>${escapeHtml(c.name)} v${escapeHtml(c.version)}</b>`,
    `<b>Repo/process:</b> <code>${escapeHtml(c.repo)}</code> / <code>${escapeHtml(c.pm2)}</code>`,
    `<b>Model:</b> <code>${escapeHtml(c.model)}</code>`,
    `<b>Update:</b> ${escapeHtml(c.update)}`,
    '',
    '<b>What I can do:</b>',
    '• Scan live Polymarket markets',
    '• Analyze a market into <b>BUY YES / BUY NO / NO-TRADE</b>',
    '• Explain confidence, edge, and risk factors',
    '• Track paper trades, positions, results, and opt-in watches',
    '',
    '<b>Recent recorded evidence:</b>',
    `<pre>${escapeHtml(c.recentEvidence).slice(0, 1200)}</pre>`,
  ].join('\n');
}
module.exports = { isSelfContextQuery, getSelfContext, selfContextText, renderSelfContext };
