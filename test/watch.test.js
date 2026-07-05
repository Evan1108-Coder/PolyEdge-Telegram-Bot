'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

// Isolated temp DB (same pattern as jobs.test.js) — never touch real data.
process.env.DB_PATH = path.join(os.tmpdir(), `polyedge-watch-${process.pid}.sqlite`);

const { WatchManager } = require('../src/watch');
const { openDb } = require('../src/db');

function fakeBot() {
  const sent = [];
  return { sent, api: { async sendMessage(chatId, text, opts) { sent.push({ chatId, text, opts }); } } };
}

// Wait until a condition holds or a short real-time budget elapses (the watches
// run on real timers with tiny intervals here).
async function until(pred, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return pred();
}

function clearWatches() {
  try { openDb().prepare('DELETE FROM watches').run(); } catch {}
}

test('a watch that fires delivers a heads-up and is recorded as fired', async () => {
  clearWatches();
  const bot = fakeBot();
  const wm = new WatchManager(bot);
  let polls = 0;
  wm.registerProbe('test-fire', async () => { polls += 1; return { done: polls >= 3 }; });

  const { id } = wm.startWatch({ chatId: 42, label: 'PR #7 to merge', kind: 'test-fire', maxPolls: 20, intervalMs: 5, totalMs: 60000 });
  assert.ok(id > 0, 'returns a job id immediately (non-blocking)');

  await until(() => bot.sent.length > 0);
  assert.match(bot.sent[0].text, /it happened/i);
  const row = openDb().prepare('SELECT * FROM watches WHERE id = ?').get(id);
  assert.equal(row.status, 'fired');
});

test('ADVERSARIAL: a watch whose event never happens times out (never runs forever)', async () => {
  clearWatches();
  const bot = fakeBot();
  const wm = new WatchManager(bot);
  wm.registerProbe('never', async () => ({ done: false })); // never fires

  // Tiny total budget so the deadline trips quickly; caps guarantee it ends.
  const { id } = wm.startWatch({ chatId: 42, label: 'the impossible', kind: 'never', maxPolls: 20, intervalMs: 5, totalMs: 60 });
  await until(() => bot.sent.length > 0, 3000);
  assert.match(bot.sent[0].text, /keep watching|longer|budget/i);
  const row = openDb().prepare('SELECT * FROM watches WHERE id = ?').get(id);
  assert.ok(['timed_out', 'ended'].includes(row.status), `ended cleanly, was ${row.status}`);
});

test('stopWatch aborts an active watch and sends no ping', async () => {
  clearWatches();
  const bot = fakeBot();
  const wm = new WatchManager(bot);
  wm.registerProbe('slow', async () => { await new Promise(r => setTimeout(r, 50)); return { done: false }; });

  const { id } = wm.startWatch({ chatId: 42, label: 'stop me', kind: 'slow', maxPolls: 20, intervalMs: 20, totalMs: 60000 });
  wm.stopWatch(id);
  await new Promise(r => setTimeout(r, 100));
  const row = openDb().prepare('SELECT * FROM watches WHERE id = ?').get(id);
  assert.equal(row.status, 'stopped');
  assert.equal(bot.sent.length, 0, 'a user-stopped watch does not ping');
});

test('watch is opt-in: nothing starts until startWatch is called', async () => {
  clearWatches();
  const bot = fakeBot();
  const wm = new WatchManager(bot);
  wm.registerProbe('x', async () => ({ done: true }));
  // Simply constructing the manager and registering a probe starts nothing.
  assert.equal(wm.activeCount(), 0);
  assert.equal(openDb().prepare('SELECT COUNT(*) c FROM watches').get().c, 0);
});

test('startWatch throws for an unregistered probe kind', () => {
  const wm = new WatchManager(fakeBot());
  assert.throws(() => wm.startWatch({ chatId: 1, label: 'x', kind: 'nope' }), /No watch probe/);
});

test('listWatches returns the user\'s watches', async () => {
  clearWatches();
  const bot = fakeBot();
  const wm = new WatchManager(bot);
  wm.registerProbe('quick', async () => ({ done: true }));
  wm.startWatch({ chatId: 99, label: 'a', kind: 'quick', intervalMs: 5, totalMs: 1000 });
  await until(() => wm.listWatches(99).length > 0);
  const rows = wm.listWatches(99);
  assert.ok(rows.length >= 1);
  assert.equal(String(rows[0].chat_id), '99');
});

test('resumeWatches closes out a watch whose deadline passed while offline', async () => {
  clearWatches();
  const bot = fakeBot();
  const wm = new WatchManager(bot);
  wm.registerProbe('resumable', async () => ({ done: false }));
  // Insert an already-expired active watch directly.
  openDb().prepare(`
    INSERT INTO watches (chat_id, label, check_kind, params_json, status, max_polls, interval_ms, deadline_at)
    VALUES ('42', 'left over', 'resumable', '{}', 'active', 20, 5, ?)
  `).run(new Date(Date.now() - 1000).toISOString());

  const { resumed } = wm.resumeWatches();
  assert.equal(resumed, 0, 'the expired one was not resumed as active');
  await until(() => bot.sent.length > 0);
  assert.match(bot.sent[0].text, /keep watching|longer|budget/i);
});

test('concurrency cap prevents unbounded parallel watches', () => {
  clearWatches();
  const bot = fakeBot();
  const wm = new WatchManager(bot, { maxConcurrent: 2 });
  wm.registerProbe('hold', async () => { await new Promise(r => setTimeout(r, 500)); return { done: false }; });
  wm.startWatch({ chatId: 1, label: 'a', kind: 'hold', intervalMs: 50, totalMs: 60000 });
  wm.startWatch({ chatId: 1, label: 'b', kind: 'hold', intervalMs: 50, totalMs: 60000 });
  assert.throws(() => wm.startWatch({ chatId: 1, label: 'c', kind: 'hold', intervalMs: 50, totalMs: 60000 }), /Too many/);
});
