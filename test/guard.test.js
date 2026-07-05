'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Deadline,
  DeadlineError,
  StepBudget,
  StepBudgetError,
  IterationCapError,
  boundedRetry,
  boundedPoll,
  guardedLoop,
  runWithDeadline,
  expBackoff,
  sleep,
  LIMITS,
} = require('../src/utils/guard');

// A controllable clock so "wall-clock" tests run instantly and deterministically.
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; }, set: ms => { t = ms; } };
}

test('Deadline.check throws once the system clock passes the budget', () => {
  const clk = fakeClock(1000);
  const d = new Deadline(5000, clk.now);
  assert.equal(d.expired(), false);
  d.check('op'); // fine
  clk.advance(4999);
  d.check('op'); // still fine (not yet past)
  clk.advance(2);
  assert.equal(d.expired(), true);
  assert.throws(() => d.check('op'), DeadlineError);
});

test('ADVERSARIAL: a deliberate infinite async loop is broken by the deadline', async () => {
  // This body never returns done:true — a classic infinite loop. The ONLY thing
  // that stops it is the wall-clock deadline checked each pass.
  const clk = fakeClock(0);
  const d = new Deadline(100, clk.now);
  let iterations = 0;
  await assert.rejects(
    guardedLoop(
      async () => {
        iterations += 1;
        clk.advance(30); // simulate ~30ms of work per pass
        return { done: false }; // never done → would loop forever without the guard
      },
      { deadline: d, maxIterations: LIMITS.MAX_POLLS, label: 'infinite' }
    ),
    DeadlineError
  );
  // 100ms budget / 30ms per pass → breaks out after a handful of iterations,
  // well under the iteration cap, proving the CLOCK is the escape.
  assert.ok(iterations <= 5, `broke out quickly (was ${iterations})`);
});

test('ADVERSARIAL: guardedLoop also stops at the iteration cap when time is plentiful', async () => {
  const clk = fakeClock(0);
  const d = new Deadline(10 ** 9, clk.now); // effectively unlimited time
  let iterations = 0;
  const r = await guardedLoop(
    async () => { iterations += 1; return { done: false }; },
    { deadline: d, maxIterations: 8 }
  );
  assert.equal(r.done, false);
  assert.equal(r.reason, 'exhausted');
  assert.equal(iterations, 8, 'hard iteration cap, never more');
});

test('StepBudget throws once a plan exceeds its step limit', () => {
  const b = new StepBudget(3);
  b.consume('a');
  b.consume('b');
  b.consume('c');
  assert.throws(() => b.consume('d'), StepBudgetError);
  assert.equal(b.remaining(), 0);
});

test('StepBudget is hard-capped at LIMITS.MAX_STEPS even if a caller asks for more', () => {
  const b = new StepBudget(9999);
  assert.equal(b.max, LIMITS.MAX_STEPS);
});

test('boundedPoll stops at the poll cap and reports exhausted (never infinite)', async () => {
  const clk = fakeClock(0);
  let polls = 0;
  const r = await boundedPoll(
    async () => { polls += 1; return { done: false }; },
    { maxPolls: 6, deadline: new Deadline(10 ** 9, clk.now), backoff: false, intervalMs: 0 }
  );
  assert.equal(r.done, false);
  assert.equal(r.reason, 'exhausted');
  assert.equal(polls, 6);
});

test('boundedPoll returns done as soon as the probe fires', async () => {
  let polls = 0;
  const r = await boundedPoll(
    async i => { polls += 1; return { done: i === 2 }; },
    { maxPolls: 20, intervalMs: 0, backoff: false }
  );
  assert.equal(r.done, true);
  assert.equal(r.polls, 3);
});

test('boundedPoll is hard-capped at MAX_POLLS even if asked for more', async () => {
  let polls = 0;
  const r = await boundedPoll(
    async () => { polls += 1; return false; },
    { maxPolls: 1000, intervalMs: 0, backoff: false }
  );
  assert.equal(polls, LIMITS.MAX_POLLS);
  assert.equal(r.polls, LIMITS.MAX_POLLS);
});

test('boundedRetry gives up after maxAttempts with an IterationCapError', async () => {
  let attempts = 0;
  await assert.rejects(
    boundedRetry(
      async () => { attempts += 1; throw new Error('nope'); },
      { maxAttempts: 3, backoff: { base: 0 }, perAttemptMs: 1000 }
    ),
    IterationCapError
  );
  assert.equal(attempts, 3);
});

test('boundedRetry succeeds on a later attempt and stops retrying', async () => {
  let attempts = 0;
  const val = await boundedRetry(
    async () => { attempts += 1; if (attempts < 2) throw new Error('transient'); return 'ok'; },
    { maxAttempts: 5, backoff: { base: 0 } }
  );
  assert.equal(val, 'ok');
  assert.equal(attempts, 2);
});

test('boundedRetry is hard-capped at MAX_RETRIES', async () => {
  let attempts = 0;
  await assert.rejects(
    boundedRetry(async () => { attempts += 1; throw new Error('x'); }, { maxAttempts: 999, backoff: { base: 0 }, perAttemptMs: 500 }),
    err => err.code === 'ITERATION_CAP'
  );
  assert.equal(attempts, LIMITS.MAX_RETRIES);
});

test('runWithDeadline rejects a hung async op and aborts its signal', async () => {
  let aborted = false;
  await assert.rejects(
    runWithDeadline(
      signal => new Promise((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        // never resolves on its own → would hang forever without the deadline
      }),
      20,
      { label: 'hang' }
    ),
    DeadlineError
  );
  assert.equal(aborted, true, 'the fn was signalled to abort');
});

test('runWithDeadline returns the value when the op finishes in time', async () => {
  const v = await runWithDeadline(async () => 42, 1000);
  assert.equal(v, 42);
});

test('expBackoff grows geometrically and respects the cap', () => {
  assert.equal(expBackoff(0, { base: 5000, factor: 2, cap: 60000 }), 5000);
  assert.equal(expBackoff(1, { base: 5000, factor: 2, cap: 60000 }), 10000);
  assert.equal(expBackoff(2, { base: 5000, factor: 2, cap: 60000 }), 20000);
  assert.equal(expBackoff(10, { base: 5000, factor: 2, cap: 60000 }), 60000); // capped
});

test('sleep can be aborted immediately via signal', async () => {
  const ac = new AbortController();
  const p = sleep(10_000, ac.signal);
  ac.abort();
  await assert.rejects(p, err => err.name === 'AbortError');
});

test('boundedPoll can be stopped mid-flight by an abort signal', async () => {
  const ac = new AbortController();
  let polls = 0;
  const p = boundedPoll(
    async () => { polls += 1; return false; },
    { maxPolls: 20, intervalMs: 50, signal: ac.signal }
  );
  // Abort after the first poll's interval starts.
  setTimeout(() => ac.abort(), 10);
  const r = await p;
  assert.equal(r.done, false);
  assert.equal(r.reason, 'stopped');
  assert.ok(polls <= 2, 'stopped almost immediately');
});
