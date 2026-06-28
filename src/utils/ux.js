// Telegram UX helpers: a typing indicator that keeps refreshing while a slow
// task runs, and a friendly-error mapper so raw stack traces never reach the user.

function startTyping(ctx, intervalMs = 4500) {
  let active = true;
  const send = () => {
    if (!active) return;
    if (!ctx.api?.sendChatAction) return;
    ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
  };
  send();
  const interval = setInterval(send, intervalMs);
  return () => {
    active = false;
    clearInterval(interval);
  };
}

async function withTyping(ctx, fn) {
  const stop = startTyping(ctx);
  try {
    return await fn();
  } finally {
    stop();
  }
}

function escapeMinimal(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function friendlyError(err) {
  const message = err?.message || String(err);
  if (/timeout|timed out|ECONNABORTED/i.test(message)) {
    return '⏱️ <b>That took too long.</b>\nI stopped waiting so the chat does not freeze. Try again in a moment.';
  }
  if (/rate limit|429/i.test(message)) {
    return '🚦 <b>Rate limit hit.</b>\nThe model or Polymarket is limiting requests. I can try again shortly.';
  }
  if (/no model|api key|MINIMAX/i.test(message)) {
    return '🔑 <b>Brain offline.</b>\nThe MiniMax API key is missing or invalid, so I cannot reason right now.';
  }
  if (/not found|no market|404/i.test(message)) {
    return '🔎 <b>I could not find that market.</b>\nTry /scan to see live markets, or paste a full Polymarket link.';
  }
  return `⚠️ <b>Something went wrong.</b>\n${escapeMinimal(message)}`;
}

module.exports = { startTyping, withTyping, friendlyError };
