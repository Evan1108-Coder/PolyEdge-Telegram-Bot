'use strict';

// guard.js — Algorithmic anti-infinite-loop primitives (0 extra API tokens).
//
// Evan's requirement: the bot must be structurally unable to loop forever, and
// it must NOT rely on a second "watcher" bot (that could itself hang and burns
// tokens). Everything here is pure local timers/counters — the escape hatch is
// the SYSTEM CLOCK (Date.now / setTimeout), not bot logic, so a task can never
// silently run forever. Every guarded operation ends in exactly one of:
//   ✅ done   ⚠️ can't (why)   ⏳ too long (keep watching or stop?)
//
// Honest limitation (documented on purpose): a purely *synchronous* `while(true)`
// with no await and no deadline.check() inside it cannot be interrupted by an
// in-process timer, because JavaScript is single-threaded. That is why:
//   • all genuinely long work in these bots is async (network polls/retries/waits),
//     where the deadline race + AbortSignal DO interrupt it, and
//   • the one tool for tight local loops, `guardedLoop`, calls deadline.check()
//     every iteration so even a sync loop is bounded.
// A separate OS process/thread is the only thing that can kill a hung sync loop,
// and Evan explicitly rejected that. Within one process, this is the strongest
// guarantee available, and it covers every real code path in these bots.

class DeadlineError extends Error {
  constructor(message = 'Deadline exceeded', meta = {}) {
    super(message);
    this.name = 'DeadlineError';
    this.code = 'DEADLINE';
    this.outcome = 'too_long';
    Object.assign(this, meta);
  }
}

class IterationCapError extends Error {
  constructor(message = 'Iteration cap reached', meta = {}) {
    super(message);
    this.name = 'IterationCapError';
    this.code = 'ITERATION_CAP';
    this.outcome = 'cant';
    Object.assign(this, meta);
  }
}

class StepBudgetError extends Error {
  constructor(message = 'Step budget exhausted', meta = {}) {
    super(message);
    this.name = 'StepBudgetError';
    this.code = 'STEP_BUDGET';
    this.outcome = 'cant';
    Object.assign(this, meta);
  }
}

// Hard ceilings. These are the "structurally can't loop forever" numbers Evan
// asked for. Individual calls may pass smaller values but never larger — the
// clamp below makes the cap a true upper bound even against a bad caller.
const LIMITS = Object.freeze({
  MAX_RETRIES: 5, // retry ≤ 5
  MAX_POLLS: 20, // poll ≤ 20
  MAX_STEPS: 15, // ≤ 15 steps per plan
  DEFAULT_STEP_MS: 30_000, // 30s per step/wait
  DEFAULT_TOTAL_MS: 10 * 60_000, // ~10 min for a long watch
  BACKOFF_BASE_MS: 5_000, // 5s, 10s, 20s, …
  BACKOFF_FACTOR: 2,
  BACKOFF_CAP_MS: 60_000,
});

function clampInt(value, min, max, fallback) {
  const n = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

// A wall-clock deadline. `now` is injectable so tests can drive time without
// real waiting; in production it defaults to Date.now (the system clock).
class Deadline {
  constructor(totalMs = LIMITS.DEFAULT_TOTAL_MS, now = Date.now) {
    this._now = now;
    this.totalMs = Math.max(0, Math.floor(totalMs));
    this.start = now();
    this.deadlineAt = this.start + this.totalMs;
  }

  remaining() {
    return Math.max(0, this.deadlineAt - this._now());
  }

  elapsed() {
    return this._now() - this.start;
  }

  expired() {
    return this._now() >= this.deadlineAt;
  }

  // Call inside any loop body. Throws the moment the clock passes the deadline,
  // so even a synchronous loop that checks this each pass is bounded.
  check(label = 'operation') {
    if (this.expired()) {
      throw new DeadlineError(`${label} exceeded its ${Math.round(this.totalMs / 1000)}s time budget`, {
        elapsedMs: this.elapsed(),
        totalMs: this.totalMs,
      });
    }
  }
}

// Sleep that can be cut short by an AbortSignal (so a deadline race or a user
// "stop" ends the wait immediately instead of after the full interval).
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    // Don't let a pending wait keep the process alive on its own — in the bot the
    // Telegram long-poll holds the event loop; a watch timer shouldn't.
    if (typeof t.unref === 'function') t.unref();
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  e.code = 'ABORT';
  return e;
}

// exp backoff schedule: base, base*factor, … capped. attempt is 0-indexed.
function expBackoff(attempt, opts = {}) {
  const base = opts.base ?? LIMITS.BACKOFF_BASE_MS;
  const factor = opts.factor ?? LIMITS.BACKOFF_FACTOR;
  const cap = opts.cap ?? LIMITS.BACKOFF_CAP_MS;
  return Math.min(cap, Math.round(base * Math.pow(factor, Math.max(0, attempt))));
}

// Run an async fn but never let it exceed `ms`. The winner is whichever settles
// first: the fn, or a timer on the system clock. On timeout we abort the fn's
// AbortSignal (best-effort cooperative cancel) and reject with DeadlineError.
// This is the hard escape for a network call/await that hangs.
function runWithDeadline(fn, ms, opts = {}) {
  const label = opts.label || 'operation';
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineError(`${label} timed out after ${Math.round(ms / 1000)}s`, { totalMs: ms }));
    }, Math.max(0, ms));
    if (typeof timer.unref === 'function') timer.unref();
  });
  const work = (async () => fn(controller.signal))();
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// Retry an async fn up to maxAttempts (hard-capped at MAX_RETRIES), backing off
// between tries, and never past the shared deadline. Ends as soon as fn resolves;
// throws the last error (or a DeadlineError) if it never does.
async function boundedRetry(fn, opts = {}) {
  const maxAttempts = clampInt(opts.maxAttempts, 1, LIMITS.MAX_RETRIES, LIMITS.MAX_RETRIES);
  const deadline = opts.deadline || new Deadline(opts.totalMs ?? LIMITS.DEFAULT_TOTAL_MS, opts.now);
  const signal = opts.signal;
  const perAttemptMs = opts.perAttemptMs ?? LIMITS.DEFAULT_STEP_MS;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw abortError();
    deadline.check(opts.label || 'retry');
    try {
      const budget = Math.min(perAttemptMs, deadline.remaining());
      return await runWithDeadline(sig => fn(attempt, sig), budget, { label: opts.label || 'attempt' });
    } catch (err) {
      lastErr = err;
      if (err?.name === 'AbortError') throw err;
      const isLast = attempt === maxAttempts - 1;
      if (isLast) break;
      if (deadline.expired()) break;
      // wait === 0 means "retry immediately", not "out of time" — only the
      // deadline (checked above) ends the loop early.
      const wait = Math.max(0, Math.min(expBackoff(attempt, opts.backoff), deadline.remaining()));
      if (typeof opts.onRetry === 'function') opts.onRetry(attempt + 1, wait, err);
      if (wait > 0) await sleep(wait, signal);
    }
  }
  if (lastErr && lastErr.code === 'DEADLINE') throw lastErr;
  if (deadline.expired()) throw new DeadlineError(`${opts.label || 'retry'} gave up after its time budget`, {});
  throw new IterationCapError(`${opts.label || 'retry'} failed after ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'}`, {
    attempts: maxAttempts,
    cause: lastErr?.message,
  });
}

// Poll `probe()` until it returns a truthy/`{done:true}`-ish value, or until the
// poll cap / deadline stops us. Never blocks the event loop between polls (sleep
// is timer-based and abortable). Returns { done, value, polls, reason }.
async function boundedPoll(probe, opts = {}) {
  const maxPolls = clampInt(opts.maxPolls, 1, LIMITS.MAX_POLLS, LIMITS.MAX_POLLS);
  const deadline = opts.deadline || new Deadline(opts.totalMs ?? LIMITS.DEFAULT_TOTAL_MS, opts.now);
  const signal = opts.signal;
  const baseInterval = opts.intervalMs ?? LIMITS.BACKOFF_BASE_MS;
  for (let poll = 0; poll < maxPolls; poll++) {
    if (signal?.aborted) return { done: false, polls: poll, reason: 'stopped' };
    if (deadline.expired()) return { done: false, polls: poll, reason: 'too_long' };
    let result;
    try {
      const budget = Math.min(opts.probeMs ?? LIMITS.DEFAULT_STEP_MS, deadline.remaining());
      result = await runWithDeadline(sig => probe(poll, sig), budget, { label: opts.label || 'poll' });
    } catch (err) {
      if (err?.name === 'AbortError') return { done: false, polls: poll, reason: 'stopped' };
      result = { done: false, error: err?.message };
    }
    const done = result === true || (result && result.done === true) || (result && result.ready === true);
    if (done) return { done: true, value: result, polls: poll + 1, reason: 'done' };
    if (typeof opts.onPoll === 'function') opts.onPoll(poll + 1, result);
    if (poll === maxPolls - 1) break;
    if (deadline.expired()) return { done: false, polls: poll + 1, reason: 'too_long' };
    const wait = Math.max(0, opts.backoff === false
      ? baseInterval
      : Math.min(expBackoff(poll, opts.backoff), deadline.remaining()));
    // wait === 0 means "poll again immediately"; only an expired deadline (checked
    // above) or an abort ends the loop early.
    if (wait > 0) {
      try {
        await sleep(wait, signal);
      } catch {
        return { done: false, polls: poll + 1, reason: 'stopped' };
      }
    }
  }
  return { done: false, polls: maxPolls, reason: deadline.expired() ? 'too_long' : 'exhausted' };
}

// A per-plan step counter. Consume one unit per real step; throws once the plan
// tries to exceed MAX_STEPS so a runaway plan can't spin out new steps forever.
class StepBudget {
  constructor(maxSteps = LIMITS.MAX_STEPS) {
    this.max = clampInt(maxSteps, 1, LIMITS.MAX_STEPS, LIMITS.MAX_STEPS);
    this.used = 0;
  }

  remaining() {
    return Math.max(0, this.max - this.used);
  }

  consume(label = 'step') {
    if (this.used >= this.max) {
      throw new StepBudgetError(`Plan hit its ${this.max}-step limit`, { used: this.used, max: this.max });
    }
    this.used += 1;
    return { index: this.used, label, remaining: this.remaining() };
  }
}

// Guarded local loop: like a for-loop but bounded by BOTH an iteration cap and a
// deadline that is checked every pass (so a sync-ish body still can't hang). The
// body is called with (i, deadline); return a truthy `{done:true}` to stop early.
async function guardedLoop(body, opts = {}) {
  const maxIterations = clampInt(opts.maxIterations, 1, LIMITS.MAX_POLLS, LIMITS.MAX_POLLS);
  const deadline = opts.deadline || new Deadline(opts.totalMs ?? LIMITS.DEFAULT_TOTAL_MS, opts.now);
  const signal = opts.signal;
  for (let i = 0; i < maxIterations; i++) {
    if (signal?.aborted) return { done: false, iterations: i, reason: 'stopped' };
    deadline.check(opts.label || 'loop'); // system-clock escape, every pass
    const r = await body(i, deadline);
    if (r === true || (r && r.done === true)) return { done: true, value: r, iterations: i + 1, reason: 'done' };
  }
  return { done: false, iterations: maxIterations, reason: 'exhausted' };
}

module.exports = {
  LIMITS,
  Deadline,
  DeadlineError,
  IterationCapError,
  StepBudgetError,
  StepBudget,
  sleep,
  expBackoff,
  runWithDeadline,
  boundedRetry,
  boundedPoll,
  guardedLoop,
  clampInt,
};
