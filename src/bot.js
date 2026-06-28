const { Bot } = require('grammy');
const { getConfig } = require('./config');
const { handleMessage, HELP } = require('./agent');
const { sendLong } = require('./utils/format');
const { withTyping, friendlyError } = require('./utils/ux');

function createBot(token) {
  const bot = new Bot(token);
  const ownerId = getConfig().telegramOwnerId;

  // Optional single-user lock: if TELEGRAM_OWNER_ID is set, ignore everyone else.
  bot.use(async (ctx, next) => {
    if (ownerId && ctx.from && String(ctx.from.id) !== String(ownerId)) {
      return; // silently ignore non-owner
    }
    return next();
  });

  bot.command('start', ctx => sendLong(ctx, HELP));
  bot.command('help', ctx => sendLong(ctx, HELP));

  // Thin command wrappers — they all funnel through the same NL handler so the
  // behaviour is identical whether the user types /scan or "scan the markets".
  const route = phrase => async ctx => runHandler(ctx, phrase);
  bot.command('scan', route('scan'));
  bot.command('positions', route('positions'));
  bot.command('results', route('results'));
  bot.command('why', route('why'));
  bot.command('analyze', async ctx => {
    const arg = (ctx.match || '').trim();
    return runHandler(ctx, arg ? `analyze ${arg}` : 'analyze');
  });

  bot.on('message:text', async ctx => {
    const text = buildMessageContext(ctx);
    if (!text) return;
    return runHandler(ctx, text);
  });

  bot.catch(err => {
    console.error('[Bot] Error:', err.error?.message || err.message);
  });

  return bot;
}

async function runHandler(ctx, text) {
  try {
    const reply = await withTyping(ctx, () => handleMessage(ctx.chat.id, text));
    return sendLong(ctx, reply);
  } catch (err) {
    console.error('[handler]', err.message);
    return sendLong(ctx, friendlyError(err));
  }
}

// Fold a reply-to quote into the message so "analyze this" works on a quoted link.
function buildMessageContext(ctx) {
  const msg = ctx.message;
  let text = msg.text || msg.caption || '';
  if (msg.reply_to_message) {
    const replyText = msg.reply_to_message.text || msg.reply_to_message.caption || '';
    if (replyText && !/polymarket\.com/i.test(text) && /polymarket\.com/i.test(replyText)) {
      text = `${text} ${replyText}`.trim();
    }
  }
  return text;
}

module.exports = { createBot };
