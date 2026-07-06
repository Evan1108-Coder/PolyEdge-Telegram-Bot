const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusyState, isStatusQuestion, isAcknowledgement, isStopRequest } = require('../src/utils/busy');

test('busy classifier recognizes status, acknowledgements and stop requests', () => {
  assert.equal(isStatusQuestion('what is the current task status?'), true);
  assert.equal(isAcknowledgement('got it'), true);
  assert.equal(isAcknowledgement('can you do another thing?'), false);
  assert.equal(isStopRequest('cancel that'), true);
});

test('busy state answers status/ack/new-task without starting more work', async () => {
  let now = 1000;
  const busy = createBusyState({ now: () => now });
  const replies = [];
  const ctx = { chat: { id: 123 }, reply: async m => replies.push(m) };
  busy.start(123, { label: 'the market scan', stage: 'scanning' });
  now = 4000;
  assert.equal(await busy.handleWhileBusy(ctx, 'status'), true);
  assert.match(replies.pop(), /market scan/);
  assert.equal(await busy.handleWhileBusy(ctx, 'ok thanks'), true);
  assert.match(replies.pop(), /Still on/);
  assert.equal(await busy.handleWhileBusy(ctx, 'scan another market'), true);
  assert.match(replies.pop(), /can't start a new task yet/);
  assert.equal(busy.busy(123), true);
});

test('busy stop request marks stopRequested and reports safe checkpoint behavior', async () => {
  const busy = createBusyState();
  const replies = [];
  const ctx = { chat: { id: 9 }, reply: async m => replies.push(m) };
  busy.start(9, { label: 'the repo audit' });
  await busy.handleWhileBusy(ctx, 'stop it');
  assert.equal(busy.get(9).stopRequested, true);
  assert.match(replies[0], /next safe checkpoint/);
});
