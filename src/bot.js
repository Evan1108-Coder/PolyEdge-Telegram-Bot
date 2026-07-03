const { Bot } = require('grammy');
const { getConfig } = require('./config');
const { handleMessage, HELP } = require('./agent');
const { sendLong, escapeHtml } = require('./utils/format');
const { withTyping, friendlyError } = require('./utils/ux');
const { checkForUpdate, applyUpdate } = require('./update');
const { execSync } = require('child_process');

// pm2 process name to restart after a successful self-update.
const PM2_NAME = process.env.PM2_PROCESS_NAME || 'polyedge-bot';

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

  let updateInProgress = false;
  bot.command('update', async ctx => {
    if (updateInProgress) {
      return sendLong(ctx, '⏳ An update is already in progress — hang tight.');
    }
    updateInProgress = true;
    try {
      await ctx.reply('🔎 Checking GitHub for a newer version…');

      let info;
      try {
        info = checkForUpdate();
      } catch (err) {
        return sendLong(ctx, `⚠️ <b>Couldn’t check for updates.</b>\n${escapeHtml(friendlyError(err))}`);
      }

      if (!info.available) {
        const v = info.localVersion ? ` (v${escapeHtml(info.localVersion)})` : '';
        return sendLong(ctx, `✅ <b>Already on the latest version${v}.</b>\nNothing to update.`);
      }

      const verPart = info.localVersion && info.remoteVersion && info.localVersion !== info.remoteVersion
        ? `v${escapeHtml(info.localVersion)} → v${escapeHtml(info.remoteVersion)}`
        : `${info.behind} new commit${info.behind === 1 ? '' : 's'}`;
      const changeLines = (info.changelog || []).slice(0, 8).map(c => `• ${escapeHtml(c)}`);
      await sendLong(ctx, [
        `⬇️ <b>Update found</b> — ${verPart}.`,
        changeLines.length ? '\n<b>What’s new:</b>' : '',
        ...changeLines,
        '\nApplying now — I’ll health-check the new code and roll back automatically if it fails to start.',
      ].filter(Boolean).join('\n'));

      const result = applyUpdate();
      if (!result.ok) {
        const rolled = result.rolledBack
          ? '\n\n↩️ <b>Rolled back</b> to the previous working version — the bot is still running the old code.'
          : '';
        return sendLong(ctx, `⚠️ <b>Update failed</b> at the <code>${escapeHtml(result.stage || 'update')}</code> step.\n${escapeHtml(result.message || 'Unknown error.')}${rolled}`);
      }

      const filesPart = (result.filesChanged || []).length
        ? '\n<b>Files changed:</b>\n' + result.filesChanged.slice(0, 20).map(f => `• <code>${escapeHtml(f.status)}</code> ${escapeHtml(f.file)}`).join('\n')
        : '';
      const commitsPart = (result.commits || []).length
        ? '\n<b>Commits:</b>\n' + result.commits.slice(0, 10).map(c => `• ${escapeHtml(c)}`).join('\n')
        : '';
      const integrityPart = result.dataIntegrity
        ? `\n<b>Data integrity:</b> ${result.dataIntegrity.ok ? '✅ all user data untouched' : '⚠️ mismatch'} (checked ${result.dataIntegrity.checked.length} file${result.dataIntegrity.checked.length === 1 ? '' : 's'}).`
        : '';
      await sendLong(ctx, [
        `✅ <b>Updated successfully!</b> ${escapeHtml((result.prevHead || '').slice(0, 7))} → ${escapeHtml((result.newHead || '').slice(0, 7))}`,
        result.depsInstalled ? '📦 Dependencies were reinstalled.' : '',
        filesPart,
        commitsPart,
        integrityPart,
        '\n♻️ Restarting now to run the new version…',
      ].filter(Boolean).join('\n'));

      // Restart out-of-band so this handler can finish replying first.
      setTimeout(() => {
        try { execSync(`pm2 restart ${PM2_NAME}`); }
        catch (e) { console.error('[update] restart failed:', e.message); }
      }, 1000);
    } finally {
      updateInProgress = false;
    }
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
