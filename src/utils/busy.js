const { ack: variedAck } = require('./actionlog');
const STATUS_RE = /\b(status|progress|what(?:'|’)?s happening|what are you doing|current task|are you done|how(?:'|’)?s it going|where are we|state|update)\b/i;
const ACK_RE = /\b(ok|okay|got it|cool|thanks|thank you|sounds good|working on that|fine|great)\b/i;
const STOP_RE = /\b(stop|cancel|abort|nevermind|never mind|forget it|drop it|scratch that)\b/i;

function normalize(text) {
  return (text || '').toString().trim();
}

function isStatusQuestion(text) {
  const t = normalize(text);
  return STATUS_RE.test(t) || /\?/.test(t) && /\b(task|doing|progress|done|finished|working)\b/i.test(t);
}

function isAcknowledgement(text) {
  const t = normalize(text).toLowerCase();
  if (!t || t.length > 80) return false;
  return ACK_RE.test(t) && !/[?]/.test(t);
}

function isStopRequest(text) {
  return STOP_RE.test(normalize(text));
}

function createBusyState(opts = {}) {
  const states = new Map();
  const now = opts.now || (() => Date.now());

  function get(chatId) {
    return states.get(String(chatId)) || null;
  }

  function start(chatId, task = {}) {
    const id = String(chatId);
    const current = {
      label: task.label || 'your current task',
      detail: task.detail || '',
      stage: task.stage || 'working',
      startedAt: now(),
      updatedAt: now(),
      stopRequested: false,
    };
    states.set(id, current);
    return current;
  }

  function update(chatId, patch = {}) {
    const current = get(chatId);
    if (!current) return null;
    Object.assign(current, patch, { updatedAt: now() });
    return current;
  }

  function finish(chatId) {
    states.delete(String(chatId));
  }

  function busy(chatId) {
    return Boolean(get(chatId));
  }

  function describe(chatId) {
    const current = get(chatId);
    if (!current) return "I'm not working on a task right now.";
    const elapsed = Math.max(0, Math.round((now() - current.startedAt) / 1000));
    const detail = current.detail ? ` ${current.detail}` : '';
    const stop = current.stopRequested ? ' You asked me to stop; I will exit at the next safe checkpoint.' : '';
    return `I'm currently ${current.stage || 'working'} on ${current.label}.${detail} Elapsed: ${elapsed}s.${stop}`;
  }

  async function handleWhileBusy(ctx, text, helpers = {}) {
    const chatId = ctx.chat && ctx.chat.id;
    const current = get(chatId);
    if (!current) return false;
    const reply = helpers.reply || ((message) => ctx.reply(message));
    const label = current.label || 'the current task';
    if (isStatusQuestion(text)) {
      await reply(describe(chatId));
      return true;
    }
    if (isAcknowledgement(text)) {
      await reply(`${variedAck(text)} Still on ${label}.`);
      return true;
    }
    if (isStopRequest(text)) {
      current.stopRequested = true;
      current.updatedAt = now();
      await reply(`Understood — I won't start anything new. I'll stop ${label} at the next safe checkpoint; if it has already reached an external call, I may need that call to return or time out first.`);
      return true;
    }
    await reply(`I'm still working on ${label}, so I can't start a new task yet. Ask "status" for the current state, or say "stop/cancel" if you want me to stop this task first.`);
    return true;
  }

  return { start, update, finish, get, busy, describe, handleWhileBusy };
}

module.exports = { createBusyState, isStatusQuestion, isAcknowledgement, isStopRequest };
