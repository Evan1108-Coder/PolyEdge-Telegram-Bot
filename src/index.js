require('dotenv').config();
const { createBot } = require('./bot');
const { validateStartupConfig, getConfig } = require('./config');
const { openDb } = require('./db');

async function main() {
  const config = validateStartupConfig();
  openDb();
  const bot = createBot(config.telegramToken);

  // Register the slash-command menu so "/" shows the list in Telegram.
  await bot.api.setMyCommands([
    { command: 'scan', description: 'Top live Polymarket markets' },
    { command: 'analyze', description: 'Analyze a market → BUY YES / NO / NO-TRADE' },
    { command: 'positions', description: 'Open paper positions' },
    { command: 'results', description: 'Paper-trading scorecard' },
    { command: 'why', description: 'Reasoning behind the last call' },
    { command: 'update', description: 'Update to the latest GitHub version' },
    { command: 'help', description: 'How to use PolyEdge' },
  ]).catch(() => {});

  await bot.start({
    onStart: info => {
      console.log(`PolyEdge running as @${info.username}`);
      console.log(`Model: ${config.minimaxModel} · edge threshold: ${config.edgeThreshold}% · bankroll: $${config.paperBankroll}`);
    },
  });
}

main().catch(err => {
  console.error('[Fatal]', err);
  process.exit(1);
});
