'use strict';

// staged.js — Complexity-gated, edit-in-place staged status (Feature 1).
//
// Before showing anything, classify the incoming message:
//   • trivial (hello / thanks / a short read-only question) → NO status line,
//     the bot just answers instantly.
//   • complex (a real action, write, schedule, multi-step plan, approval, or an
//     external wait) → the bot owns ONE Telegram message and edits it in place
//     through stages. Each new stage header keeps the PREVIOUS stage's
//     conclusion beneath it, so the single message becomes a live trail of
//     thinking → decision → action → result.
//
// The stage set is open/extensible — callers pick whatever stages fit. Common
// ones are exported as STAGES for consistent wording per bot.

const { escapeHtml } = require('./format');

// Reusable stage headers. A bot can add its own; these are the shared defaults.
// Wording customised for PolyEdge (markets / decisions).
const STAGES = Object.freeze({
  thinking: '🧠 <b>Thinking it through…</b>',
  scanning: '🔎 <b>Scanning the markets…</b>',
  pricing: '📈 <b>Reading the live odds…</b>',
  analyzing: '⚖️ <b>Weighing the edge…</b>',
  deciding: '🎯 <b>Forming a decision…</b>',
  doing: '⚙️ <b>Working on it…</b>',
  waiting: '⏳ <b>Waiting on something external…</b>',
  retrying: '🧩 <b>Adjusting and retrying…</b>',
  // Kept for API compatibility with the shared pattern.
  planning: '📋 <b>Planning the steps…</b>',
  looking_up: '🔍 <b>Looking that up…</b>',
  approval: '🔐 <b>Needs your confirmation…</b>',
});

// --- Complexity classification -------------------------------------------------

const GREETING_RE = /^(hi|hey|hello|yo|sup|howdy|good\s*(morning|afternoon|evening|night)|gm|gn)\b[!. ]*$/i;
const THANKS_RE = /^(thanks?|thank you|thx|ty|cheers|nice|cool|great|ok(ay)?|got it|👍|🙏|❤️|👌)[!. ]*$/i;

// Words that signal real work for a Polymarket decision bot. Prediction-style
// questions ("is X going to hit …", "will Y happen") are PolyEdge's core job —
// the agent routes them to live market analysis — so they count as complex.
const COMPLEX_RE = /\b(scan|analy[sz]e|decide|rate|check|research|find|search|buy|sell|paper|trade|position|result|scorecard|pnl|why|edge|odds|probability|chance|likely|will|would|could|market|watch|monitor|track|alert|notify|until|resolve|close|compare|hit|reach|going to|happen|win|elected|approve|launch)\b/i;

// A short, plain question with no action verb is trivial (answer directly).
function looksLikeShortQuestion(text) {
  const t = text.trim();
  if (t.length > 140) return false;
  const wordCount = t.split(/\s+/).length;
  return wordCount <= 20;
}

// Returns { complex, reason }. `hints` lets a caller force the decision when it
// already knows (e.g. an approval card is definitely complex; an intent router
// already resolved a write action).
function classifyComplexity(text, hints = {}) {
  if (hints.forceComplex) return { complex: true, reason: hints.reason || 'known action' };
  if (hints.forceTrivial) return { complex: false, reason: hints.reason || 'known trivial' };

  const t = String(text || '').trim();
  if (!t) return { complex: false, reason: 'empty' };
  if (GREETING_RE.test(t)) return { complex: false, reason: 'greeting' };
  if (THANKS_RE.test(t)) return { complex: false, reason: 'acknowledgement' };

  if (COMPLEX_RE.test(t)) return { complex: true, reason: 'action-like request' };
  // Multi-sentence / long messages usually carry a real task.
  if (t.length > 220) return { complex: true, reason: 'long request' };
  if (looksLikeShortQuestion(t)) return { complex: false, reason: 'short question' };
  // Default: medium-length, no clear action verb — treat as complex so the user
  // still sees progress rather than a frozen chat. (Errs toward showing status.)
  return { complex: true, reason: 'unclassified — showing progress to be safe' };
}

// --- Staged status message -----------------------------------------------------

// Owns exactly one Telegram message and edits it in place. Every stage() call
// appends the header, and — once the next stage or a terminal state arrives —
// tucks the finished stage's one-line conclusion beneath it. Resilient by design:
// Telegram edit errors (message-not-modified, rate limits, deleted message) are
// swallowed so status rendering can never break the actual task.
class StagedStatus {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.parseMode = opts.parseMode || 'HTML';
    this.header = opts.header || null; // optional fixed title line at the very top
    this.messageId = null;
    this.chatId = ctx?.chat?.id;
    this.trail = []; // [{ header, conclusion }]
    this.current = null; // active stage awaiting a conclusion
    this.closed = false;
    this._maxTrail = opts.maxTrail || 8; // keep the message from growing unbounded
  }

  _render() {
    const lines = [];
    if (this.header) lines.push(this.header);
    for (const s of this.trail) {
      lines.push(s.header);
      if (s.conclusion) lines.push(`   ↳ ${s.conclusion}`);
    }
    if (this.current) lines.push(this.current.header);
    return lines.join('\n');
  }

  async _flush() {
    if (this.closed) return;
    const text = this._render();
    if (!text) return;
    try {
      if (this.messageId == null) {
        const sent = await this.ctx.reply(text, { parse_mode: this.parseMode, disable_web_page_preview: true });
        this.messageId = sent?.message_id ?? null;
        this.chatId = sent?.chat?.id ?? this.chatId;
      } else {
        await this.ctx.api.editMessageText(this.chatId, this.messageId, text, {
          parse_mode: this.parseMode,
          disable_web_page_preview: true,
        });
      }
    } catch (err) {
      // Never let a status-render failure surface as a task failure.
      if (!/not modified|message to edit not found|message is not modified/i.test(err?.description || err?.message || '')) {
        // Genuinely unexpected — log once, keep going.
        if (typeof console !== 'undefined') console.error('[staged] flush:', err?.description || err?.message);
      }
    }
  }

  // Begin a new stage. `header` is a STAGES value or any string. Any previously
  // open stage is closed with `prevConclusion` (or left blank) first.
  async stage(header, prevConclusion) {
    if (this.closed) return this;
    if (this.current) {
      this.trail.push({ header: this.current.header, conclusion: prevConclusion || this.current.pendingConclusion || '' });
    } else if (prevConclusion && this.trail.length) {
      this.trail[this.trail.length - 1].conclusion = prevConclusion;
    }
    if (this.trail.length > this._maxTrail) this.trail.splice(0, this.trail.length - this._maxTrail);
    this.current = { header, pendingConclusion: '' };
    await this._flush();
    return this;
  }

  // Attach/replace the conclusion for the CURRENT stage without advancing.
  note(conclusion) {
    if (this.current) this.current.pendingConclusion = conclusion;
    return this;
  }

  async _terminal(headerLine, body) {
    if (this.closed) return this;
    if (this.current) {
      this.trail.push({ header: this.current.header, conclusion: this.current.pendingConclusion || '' });
      this.current = null;
    }
    this.trail.push({ header: headerLine, conclusion: body || '' });
    await this._flush();
    this.closed = true;
    return this;
  }

  // Terminal states — every task ends in exactly one of these.
  done(result) {
    return this._terminal('✅ <b>Done.</b>', result ? escapeHtml(stripTags(result)).slice(0, 900) : '');
  }

  cant(why, suggestions) {
    const s = suggestions ? `\n   💡 ${escapeHtml(stripTags(suggestions)).slice(0, 300)}` : '';
    return this._terminal('⚠️ <b>Couldn’t finish.</b>', (why ? escapeHtml(stripTags(why)).slice(0, 500) : '') + s);
  }

  tooLong(what) {
    return this._terminal(
      '⏳ <b>This is taking longer than expected.</b>',
      (what ? escapeHtml(stripTags(what)) + '\n   ' : '') + 'Want me to keep watching for it, or stop here?'
    );
  }

  // If nothing was ever shown (trivial path bailed after construction), there is
  // no message to clean up. Safe no-op.
  get shown() {
    return this.messageId != null;
  }
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, '');
}

// Convenience: decide-and-create. Returns a StagedStatus only when the message
// is complex; otherwise returns null (caller answers directly, no status line).
function maybeStaged(ctx, text, hints = {}) {
  const { complex, reason } = classifyComplexity(text, hints);
  if (!complex) return { staged: null, complex: false, reason };
  return { staged: new StagedStatus(ctx, hints), complex: true, reason };
}

module.exports = {
  STAGES,
  classifyComplexity,
  StagedStatus,
  maybeStaged,
};
