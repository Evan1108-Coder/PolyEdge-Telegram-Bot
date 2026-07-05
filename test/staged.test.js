'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyComplexity, StagedStatus, maybeStaged } = require('../src/utils/staged');

// A fake grammY ctx that records every reply/edit so we can assert on the
// single-message, edit-in-place behaviour without touching Telegram.
function fakeCtx() {
  const calls = { replies: [], edits: [] };
  let nextId = 100;
  return {
    calls,
    chat: { id: 42 },
    async reply(text, opts) {
      const message_id = nextId++;
      calls.replies.push({ text, opts, message_id });
      return { message_id, chat: { id: 42 } };
    },
    api: {
      async editMessageText(chatId, messageId, text, opts) {
        calls.edits.push({ chatId, messageId, text, opts });
        return true;
      },
    },
  };
}

test('greetings and thanks are trivial (no status line)', () => {
  for (const t of ['hi', 'Hello', 'hey there', 'thanks', 'thank you!', 'ok', 'got it', '👍']) {
    assert.equal(classifyComplexity(t).complex, false, `${t} should be trivial`);
  }
});

test('action-like requests are complex (staged status)', () => {
  for (const t of [
    'scan the markets',
    'analyze the Argentina market',
    'is Bitcoin going to hit 100k?',
    'paper buy yes 100',
    'watch it and alert me when it crosses 60%',
    'what are the odds of a rate cut',
  ]) {
    assert.equal(classifyComplexity(t).complex, true, `${t} should be complex`);
  }
});

test('short plain questions are trivial', () => {
  assert.equal(classifyComplexity('what can you do?').complex, false);
  assert.equal(classifyComplexity('who are you').complex, false);
});

test('hints can force the classification', () => {
  assert.equal(classifyComplexity('hi', { forceComplex: true }).complex, true);
  assert.equal(classifyComplexity('delete everything', { forceTrivial: true }).complex, false);
});

test('maybeStaged returns null for trivial, a StagedStatus for complex', () => {
  assert.equal(maybeStaged(fakeCtx(), 'hi').staged, null);
  assert.ok(maybeStaged(fakeCtx(), 'scan the markets').staged instanceof StagedStatus);
});

test('StagedStatus owns ONE message id and edits it in place across stages', async () => {
  const ctx = fakeCtx();
  const s = new StagedStatus(ctx);
  await s.stage('🧠 thinking');
  await s.stage('📋 planning', 'decided to do X');
  await s.stage('⚙️ doing step 1/2', 'plan has 2 steps');
  await s.done('all set');

  // Exactly one reply (the first send), the rest are edits to the same id.
  assert.equal(ctx.calls.replies.length, 1);
  const id = ctx.calls.replies[0].message_id;
  assert.ok(ctx.calls.edits.length >= 3);
  for (const e of ctx.calls.edits) assert.equal(e.messageId, id, 'every edit targets the same message');
});

test('each new stage carries the previous stage conclusion beneath it', async () => {
  const ctx = fakeCtx();
  const s = new StagedStatus(ctx);
  await s.stage('🧠 thinking');
  await s.stage('📋 planning', 'concluded: need 3 steps');
  const lastEdit = ctx.calls.edits[ctx.calls.edits.length - 1];
  assert.match(lastEdit.text, /thinking/);
  assert.match(lastEdit.text, /concluded: need 3 steps/);
  assert.match(lastEdit.text, /planning/);
});

test('terminal states render and then freeze the message', async () => {
  const ctx = fakeCtx();
  const s = new StagedStatus(ctx);
  await s.stage('⚙️ doing');
  await s.cant('GitHub token lacks permission', 'set a token with repo scope');
  const before = ctx.calls.edits.length;
  await s.stage('should be ignored'); // closed → no-op
  await s.done('too late');
  assert.equal(ctx.calls.edits.length, before, 'no edits after a terminal state');
  const finalText = ctx.calls.edits[ctx.calls.edits.length - 1].text;
  assert.match(finalText, /Couldn.t finish/);
  assert.match(finalText, /permission/);
});

test('tooLong offers to keep watching or stop', async () => {
  const ctx = fakeCtx();
  const s = new StagedStatus(ctx);
  await s.stage('⏳ waiting');
  await s.tooLong('the run has not finished');
  const finalText = ctx.calls.edits[ctx.calls.edits.length - 1].text;
  assert.match(finalText, /keep watching/i);
});

test('an edit failure never throws out of the status layer', async () => {
  const ctx = fakeCtx();
  ctx.api.editMessageText = async () => { throw { description: 'Bad Request: message is not modified' }; };
  const s = new StagedStatus(ctx);
  await s.stage('a');
  await assert.doesNotReject(s.stage('b', 'x'));
  await assert.doesNotReject(s.done('ok'));
});
