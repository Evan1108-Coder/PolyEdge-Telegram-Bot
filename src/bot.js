const { Bot, InlineKeyboard } = require('grammy');
const { getConfig } = require('./config');
const { handleMessage, HELP, detectWatchRequest } = require('./agent');
const { sendLong, escapeHtml } = require('./utils/format');
const { formatTelegramReply } = require('./utils/tgformat');
const { withTyping, friendlyError } = require('./utils/ux');
const { checkForUpdate, applyUpdate } = require('./update');
const { classifyComplexity, StagedStatus, STAGES, openingStage } = require('./utils/staged');
const { runWithDeadline, DeadlineError } = require('./utils/guard');
const { createBusyState } = require('./utils/busy');
const { remember, evidenceSummary } = require('./utils/actionlog');
const { getWatchManager } = require('./watch-setup');
const { execSync } = require('child_process');

// pm2 process name to restart after a successful self-update.
const PM2_NAME = process.env.PM2_PROCESS_NAME || 'polyedge-bot';

function createBot(token) {
  const bot = new Bot(token);
  const ownerId = getConfig().telegramOwnerId;
  const busyState = createBusyState();

  // Optional single-user lock: if TELEGRAM_OWNER_ID is set, ignore everyone else.
  bot.use(async (ctx, next) => {
    if (ownerId && ctx.from && String(ctx.from.id) !== String(ownerId)) {
      return; // silently ignore non-owner
    }
    const originalReply = ctx.reply.bind(ctx);
    ctx.reply = async (text, options) => {
      const plain = String(text || '').replace(/<[^>]+>/g, '').slice(0, 1200);
      if (plain && ctx.chat?.id) {
        remember(ctx.chat.id, { action: 'sent bot reply', evidence: plain, result: 'Recorded outgoing structured/command response for follow-up context.', version: require('../package.json').version, cost: 'none' });
      }
      return originalReply(text, options);
    };
    return next();
  });

  bot.command('start', ctx => sendLong(ctx, HELP));
  bot.command('help', ctx => sendLong(ctx, HELP));

  // Thin command wrappers — they all funnel through the same NL handler so the
  // behaviour is identical whether the user types /scan or "scan the markets".
  const route = phrase => async ctx => {
    if (busyState.busy(ctx.chat.id)) return busyState.handleWhileBusy(ctx, phrase, { reply: message => sendLong(ctx, escapeHtml(message)) });
    return runHandler(ctx, phrase, { busyState });
  };
  bot.command('scan', route('scan'));
  bot.command('positions', route('positions'));
  bot.command('results', route('results'));
  bot.command('why', route('why'));
  bot.command('analyze', async ctx => {
    const arg = (ctx.match || '').trim();
    return runHandler(ctx, arg ? `analyze ${arg}` : 'analyze');
  });
  bot.command('watches', ctx => showWatches(ctx));

  bot.on('callback_query:data', async ctx => {
    const data = ctx.callbackQuery.data || '';
    if (data.startsWith('watch:')) return handleWatchCallback(ctx);
    return ctx.answerCallbackQuery();
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
        remember(ctx.chat.id, { action: 'checked /update command', evidence: `local=${info.localVersion || info.local || 'unknown'} remote=${info.remoteVersion || info.remote || 'unknown'}`, result: 'Already on latest version; no update applied.', version: require('../package.json').version, cost: 'none' });
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

      remember(ctx.chat.id, { action: 'found available /update', evidence: `${verPart}; changelog=${(info.changelog || []).slice(0, 8).join(' | ')}`, result: 'Applying update with health check.', version: require('../package.json').version, cost: 'none' });
      const result = applyUpdate();
      if (!result.ok) {
        remember(ctx.chat.id, { action: 'failed /update command', evidence: `stage=${result.stage || 'unknown'} message=${result.message || 'unknown'}`, result: result.rolledBack ? 'Update failed and rolled back.' : 'Update failed before completion.', version: require('../package.json').version, cost: 'none' });
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
      remember(ctx.chat.id, { action: 'completed /update command', evidence: `prev=${result.prevHead || 'unknown'} new=${result.newHead || 'unknown'} files=${(result.filesChanged || []).map(f => `${f.status} ${f.file}`).join(', ')}`, result: `Updated successfully${result.remoteVersion ? ` to ${result.remoteVersion}` : ''}; restarting.`, version: require('../package.json').version, cost: 'none' });
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

    // Quick watch-management phrases handled inline (no model, no work).
    if (/^(watches|show watches|list watches|what am i watching)\??$/i.test(text.trim())) {
      return showWatches(ctx);
    }
    const stopMatch = text.match(/\b(?:stop|cancel)\s+watch(?:ing)?\s*#?(\d+)/i);
    if (stopMatch) {
      getWatchManager({ api: ctx.api }).stopWatch(Number(stopMatch[1]));
      return sendLong(ctx, `⏹️ <b>Stopped watch #${stopMatch[1]}.</b>`);
    }

    if (busyState.busy(ctx.chat.id)) {
      const handled = await busyState.handleWhileBusy(ctx, text, { reply: message => sendLong(ctx, escapeHtml(message)) });
      if (handled) return;
    }

    return runHandler(ctx, text, { busyState });
  });

  bot.catch(err => {
    console.error('[Bot] Error:', err.error?.message || err.message);
  });

  // Bring opt-in background watches back after a restart. Any watch whose
  // deadline passed while the bot was down is closed out (and the user told),
  // so nothing is silently lost — and none of this blocks startup.
  try {
    const wm = getWatchManager(bot);
    const { resumed } = wm.resumeWatches();
    if (resumed) console.log(`[Watch] Resumed ${resumed} active watch${resumed === 1 ? '' : 'es'}.`);
  } catch (err) {
    console.error('[Watch] resume failed:', err.message);
  }

  return bot;
}

async function runHandler(ctx, text, options = {}) {
  const replyOptions = ctx.message?.message_id
    ? { reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true } }
    : {};

  const busyState = options.busyState || null;
  const taskLabel = makeTaskLabel(text);
  if (busyState) busyState.start(ctx.chat.id, { label: taskLabel, stage: 'working', detail: 'I can still answer questions about this task state.' });

  // Feature 2 (opt-in watch): "watch this market / alert me when it hits 60%".
  // We OFFER to watch in the background and only start if the user taps yes.
  try {
    const watchIntent = await detectWatchRequest(ctx.chat.id, text);
    if (watchIntent) {
      if (busyState) busyState.finish(ctx.chat.id);
      return offerWatch(ctx, watchIntent);
    }
  } catch (err) {
    console.error('[watch-intent]', err.message);
  }

  // Feature 1 — complexity-gated status. A hello / thanks / short question gets
  // an instant reply with NO status line; a real request (scan / analyze /
  // trade) shows a single edit-in-place trail while the work runs.
  const { complex } = classifyComplexity(text);
  const staged = complex ? new StagedStatus(ctx) : null;
  if (staged) await staged.stage(openingStage(text));

  try {
    // Feature 2 — hard wall-clock deadline around the whole handler. Polymarket
    // or the model hanging can never freeze the chat; it ends as "took too long".
    const budgetMs = Number(process.env.HANDLER_TIMEOUT_MS || 90000);
    if (busyState) busyState.update(ctx.chat.id, { stage: staged ? 'running staged progress' : 'working' });
    const reply = await runWithDeadline(
      () => withTyping(ctx, () => handleMessage(ctx.chat.id, text + `\n\n[Recent recorded actions for follow-up/status questions]\n${evidenceSummary(ctx.chat.id)}\nUse only actual checked evidence; do not invent market/tool results.`)),
      budgetMs,
      { label: 'request' }
    );
    remember(ctx.chat.id, { action: 'handled PolyEdge request', evidence: text.slice(0, 260), result: String(reply).slice(0, 320), version: require('../package.json').version, actions: taskLabel, cost: 'not reported by provider/tool', terminal: '' });
    if (staged) await staged.done();
    return sendLong(ctx, formatTelegramReply(reply, { title: 'PolyEdge result', emoji: '🎯' }), replyOptions);
  } catch (err) {
    console.error('[handler]', err.message);
    if (err instanceof DeadlineError) {
      if (staged) { await staged.tooLong('Polymarket/model took longer than the time budget.'); return; }
      return sendLong(ctx, '⏱️ <b>That took too long.</b>\nI stopped waiting so the chat doesn’t freeze. Try again, or narrow the request.', replyOptions);
    }
    if (staged) { await staged.cant(friendlyError(err).replace(/<[^>]+>/g, '')); return; }
    return sendLong(ctx, friendlyError(err), replyOptions);
  } finally {
    if (busyState) busyState.finish(ctx.chat.id);
  }
}

function makeTaskLabel(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (/\b(scan|market|markets)\b/i.test(t)) return 'the market scan';
  if (/\b(position|positions|portfolio)\b/i.test(t)) return 'the positions check';
  if (/\b(analy[sz]e|why|decision|trade)\b/i.test(t)) return 'the market analysis';
  return t ? `“${t.slice(0, 60)}${t.length > 60 ? '…' : ''}”` : 'your request';
}

// OFFER to watch (opt-in). Shows the current state and asks; the background
// watch only starts if the user taps "Yes, keep watching".
async function offerWatch(ctx, intent) {
  const token = `${intent.kind}:${Buffer.from(JSON.stringify({ p: intent.params, l: intent.label })).toString('base64url').slice(0, 3500)}`;
  const keyboard = new InlineKeyboard()
    .text('👀 Yes, keep watching', `watch:start:${token}`)
    .text('❌ No thanks', 'watch:decline');
  return ctx.reply(
    `⏳ <b>Not there yet.</b>\nI can keep an eye on ${escapeHtml(intent.label)} in the background and ping you the moment it happens — you can keep chatting meanwhile. Want me to?`,
    { parse_mode: 'HTML', reply_markup: keyboard }
  );
}

async function showWatches(ctx) {
  const wm = getWatchManager();
  const rows = wm.listWatches(ctx.chat.id);
  if (!rows.length) return sendLong(ctx, '👀 <b>No watches.</b>\nAnalyze a market, then say “watch it and tell me when it crosses 60%”.');
  const lines = ['👀 <b>Watches</b>'];
  for (const r of rows) {
    const icon = r.status === 'active' ? '🟢' : r.status === 'fired' ? '✅' : r.status === 'timed_out' ? '⏳' : r.status === 'stopped' ? '⏹️' : '⚪';
    lines.push(`${icon} #${r.id} — ${escapeHtml(r.label)} <i>(${escapeHtml(r.status)}, ${r.polls_done} check${r.polls_done === 1 ? '' : 's'})</i>`);
  }
  lines.push('\nStop one with “stop watch #<id>”.');
  return sendLong(ctx, lines.join('\n'));
}

async function handleWatchCallback(ctx) {
  const data = ctx.callbackQuery?.data || '';
  const [, action, ...rest] = data.split(':');
  if (action === 'decline') {
    await ctx.answerCallbackQuery('No problem.');
    try { await ctx.editMessageText('👍 Okay, I won’t watch it. Ask any time.', { parse_mode: 'HTML' }); } catch {}
    return;
  }
  if (action === 'start') {
    const tok = rest.join(':');
    const kind = tok.split(':')[0];
    const encoded = tok.slice(kind.length + 1);
    let spec;
    try { spec = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
    catch { await ctx.answerCallbackQuery('That watch offer expired.'); return; }
    const wm = getWatchManager({ api: ctx.api });
    try {
      const { id } = wm.startWatch({ chatId: ctx.chat.id, label: spec.l, kind, params: spec.p });
      await ctx.answerCallbackQuery('Watching in the background.');
      try { await ctx.editMessageText(`👀 <b>Watching (#${id}).</b>\nI’ll ping you the moment ${escapeHtml(spec.l)} — keep chatting, I’m on it. Stop with “stop watch #${id}”.`, { parse_mode: 'HTML' }); } catch {}
    } catch (err) {
      await ctx.answerCallbackQuery('Could not start.');
      try { await ctx.editMessageText(`⚠️ ${escapeHtml(err.message)}`, { parse_mode: 'HTML' }); } catch {}
    }
    return;
  }
  return ctx.answerCallbackQuery();
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
