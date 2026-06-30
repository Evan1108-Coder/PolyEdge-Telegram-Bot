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
  const replyOptions = ctx.message?.message_id
    ? { reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true } }
    : {};
  try {
    const reply = await withTyping(ctx, () => handleMessage(ctx.chat.id, text));
    return sendLong(ctx, reply, replyOptions);
  } catch (err) {
    console.error('[handler]', err.message);
    return sendLong(ctx, friendlyError(err), replyOptions);
  }
}

// Fold Telegram-native context into the text the agent sees. This makes reply UX
// work naturally in groups: users can reply “analyze this”, “why?”, or “buy yes”
// to a market/link/previous bot answer and PolyEdge will understand the quote.
function buildMessageContext(ctx) {
  const msg = ctx.message || {};
  let text = stripBotMention(msg.text || msg.caption || '', ctx.me?.username).trim();
  const replyText = msg.reply_to_message
    ? stripBotMention(msg.reply_to_message.text || msg.reply_to_message.caption || '', ctx.me?.username).trim()
    : '';

  if (!replyText) return text;

  const shouldUseReply =
    /polymarket\.com/i.test(replyText) ||
    /^(analy[sz]e|check|rate|decide|why|this|that|it|yes|no|buy|paper buy)\b/i.test(text) ||
    text.length < 18 ||
    /\b(this|that|it|above|quoted|reply)\b/i.test(text);

  if (!shouldUseReply) return text;
  if (!text) return replyText;

  return [
    text,
    '',
    '--- Telegram reply context ---',
    replyText,
  ].join('\n').trim();
}

function stripBotMention(text, username) {
  let out = String(text || '');
  if (username) out = out.replace(new RegExp(`@${username}\\b`, 'ig'), '');
  return out.replace(/^\/[a-z_]+@\w+/i, m => m.split('@')[0]);
}

module.exports = { createBot, buildMessageContext, stripBotMention };
