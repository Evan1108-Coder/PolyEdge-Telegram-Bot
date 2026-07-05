'use strict';

// watch.js — Opt-in background watches (Feature 2, user-confirmed).
//
// When a task hits an external wait, the bot does NOT silently start watching.
// It reports the current state and OFFERS to keep an eye on it. Only if the user
// opts in does a watch start here. A watch:
//   • runs in the background — the chat stays fully responsive, the user can
//     keep talking and queue more watches in parallel,
//   • is bounded by guard.js (poll cap + wall-clock deadline + backoff), so it
//     always ends in ✅ fired / ⏳ timed out (offer to extend) / ⚠️ stopped,
//   • is persisted to SQLite so a restart resumes it instead of losing it,
//   • costs 0 extra API tokens (pure local timers/counters; no second bot).
//
// The actual "did the thing happen?" probe is injected per bot via a registry of
// named check functions, so this module stays generic across all three bots.

const { openDb } = require('./db');
const { Deadline, boundedPoll, LIMITS } = require('./utils/guard');
const { escapeHtml } = require('./utils/format');

function ensureTable() {
  openDb().exec(`
    CREATE TABLE IF NOT EXISTS watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      label TEXT NOT NULL,
      check_kind TEXT NOT NULL,
      params_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      polls_done INTEGER NOT NULL DEFAULT 0,
      max_polls INTEGER NOT NULL DEFAULT 20,
      interval_ms INTEGER NOT NULL DEFAULT 5000,
      deadline_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      result TEXT
    );
  `);
}

// A watch manager bound to a running bot. Probes are registered by kind; each is
// async (params, pollIndex, signal) => truthy-when-fired.
class WatchManager {
  constructor(bot, opts = {}) {
    this.bot = bot;
    this.probes = new Map();
    this.active = new Map(); // id -> { controller }
    this.maxConcurrent = opts.maxConcurrent || 10;
    ensureTable();
  }

  registerProbe(kind, fn) {
    this.probes.set(kind, fn);
    return this;
  }

  _db() {
    return openDb();
  }

  activeCount() {
    return this.active.size;
  }

  // Start a watch. Returns { id } immediately; the polling runs detached so the
  // chat is never blocked. `deliver` overrides how the fired/timeout message is
  // sent (defaults to bot.api.sendMessage), mainly for tests.
  startWatch({ chatId, label, kind, params = {}, maxPolls, intervalMs, totalMs }, deliver) {
    if (!this.probes.has(kind)) throw new Error(`No watch probe registered for kind "${kind}"`);
    if (this.active.size >= this.maxConcurrent) {
      throw new Error(`Too many concurrent watches (max ${this.maxConcurrent}). Stop one first.`);
    }
    const caps = {
      maxPolls: Math.min(maxPolls || LIMITS.MAX_POLLS, LIMITS.MAX_POLLS),
      intervalMs: intervalMs || LIMITS.BACKOFF_BASE_MS,
      totalMs: totalMs || LIMITS.DEFAULT_TOTAL_MS,
    };
    const deadlineAt = new Date(Date.now() + caps.totalMs).toISOString();
    const row = this._db().prepare(`
      INSERT INTO watches (chat_id, label, check_kind, params_json, status, max_polls, interval_ms, deadline_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(String(chatId), label, kind, JSON.stringify(params), caps.maxPolls, caps.intervalMs, deadlineAt);
    const id = Number(row.lastInsertRowid);
    this._run(id, { chatId, label, kind, params, caps, deadlineAt }, deliver);
    return { id, caps };
  }

  _run(id, spec, deliver) {
    const controller = new AbortController();
    this.active.set(id, { controller });
    const probe = this.probes.get(spec.kind);
    const remainingMs = Math.max(0, new Date(spec.deadlineAt).getTime() - Date.now());
    const deadline = new Deadline(remainingMs);

    boundedPoll(
      (pollIndex, signal) => probe(spec.params, pollIndex, signal),
      {
        maxPolls: spec.caps.maxPolls,
        intervalMs: spec.caps.intervalMs,
        backoff: false, // watches poll at a steady cadence, not slowing down
        deadline,
        signal: controller.signal,
        label: spec.label,
        onPoll: n => {
          try {
            this._db().prepare('UPDATE watches SET polls_done = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(n, id);
          } catch {}
        },
      }
    )
      .then(outcome => this._finish(id, spec, outcome, deliver))
      .catch(err => this._finish(id, spec, { done: false, reason: 'error', error: err?.message }, deliver))
      .finally(() => this.active.delete(id));
  }

  async _finish(id, spec, outcome, deliver) {
    const status = outcome.done ? 'fired' : outcome.reason === 'stopped' ? 'stopped' : outcome.reason === 'too_long' ? 'timed_out' : 'ended';
    try {
      this._db().prepare(`
        UPDATE watches SET status = ?, result = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(status, JSON.stringify(outcome).slice(0, 2000), id);
    } catch {}

    if (status === 'stopped') return; // user asked to stop — no ping needed
    const msg = this._message(id, spec, status, outcome);
    const send = deliver || (async (chatId, text) => {
      if (this.bot?.api?.sendMessage) await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
    });
    try {
      await send(spec.chatId, msg, { status, outcome });
    } catch (err) {
      if (typeof console !== 'undefined') console.error('[watch] deliver failed:', err?.message);
    }
  }

  _message(id, spec, status, outcome) {
    const label = escapeHtml(spec.label);
    if (status === 'fired') {
      return `✅ <b>Heads up — it happened.</b>\nWatch #${id}: ${label}`;
    }
    if (status === 'timed_out') {
      return `⏳ <b>Still not done after the time budget.</b>\nWatch #${id}: ${label}\nWant me to keep watching, or stop here?`;
    }
    return `⚠️ <b>Stopped watching.</b>\nWatch #${id}: ${label}${outcome.error ? `\n${escapeHtml(outcome.error)}` : ''}`;
  }

  stopWatch(id) {
    const entry = this.active.get(id);
    if (entry) entry.controller.abort();
    try {
      this._db().prepare("UPDATE watches SET status = 'stopped', finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'").run(id);
    } catch {}
    return { stopped: true, id };
  }

  listWatches(chatId, { activeOnly = false } = {}) {
    const sql = activeOnly
      ? "SELECT * FROM watches WHERE chat_id = ? AND status = 'active' ORDER BY id DESC"
      : 'SELECT * FROM watches WHERE chat_id = ? ORDER BY id DESC LIMIT 20';
    return this._db().prepare(sql).all(String(chatId));
  }

  // On boot, resume any watch left 'active'. If its deadline already passed while
  // the bot was down, it is closed out as timed_out immediately (and the user is
  // told), so nothing is silently lost.
  resumeWatches(deliver) {
    ensureTable();
    const rows = this._db().prepare("SELECT * FROM watches WHERE status = 'active'").all();
    let resumed = 0;
    for (const row of rows) {
      if (!this.probes.has(row.check_kind)) continue;
      const spec = {
        chatId: row.chat_id,
        label: row.label,
        kind: row.check_kind,
        params: safeParse(row.params_json, {}),
        caps: { maxPolls: row.max_polls, intervalMs: row.interval_ms, totalMs: LIMITS.DEFAULT_TOTAL_MS },
        deadlineAt: row.deadline_at || new Date().toISOString(),
      };
      if (new Date(spec.deadlineAt).getTime() <= Date.now()) {
        this._finish(row.id, spec, { done: false, reason: 'too_long', resumedExpired: true }, deliver);
        continue;
      }
      this._run(row.id, spec, deliver);
      resumed += 1;
    }
    return { resumed };
  }
}

function safeParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

module.exports = { WatchManager, ensureTable };
