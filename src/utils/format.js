const TELEGRAM_SAFE_LIMIT = 3900;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripHtml(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '');
}

function link(label, url) {
  if (!url) return escapeHtml(label);
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

function chunkText(text, limit = TELEGRAM_SAFE_LIMIT) {
  const value = String(text ?? '');
  if (value.length <= limit) return [value];
  const chunks = [];
  let rest = value;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendLong(ctxOrBot, chatIdOrText, maybeText, options = {}) {
  let send;
  let text;
  if (typeof maybeText === 'string') {
    const bot = ctxOrBot;
    const chatId = chatIdOrText;
    text = maybeText;
    send = chunk => bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML', disable_web_page_preview: true, ...options });
  } else {
    const ctx = ctxOrBot;
    text = chatIdOrText;
    send = chunk => ctx.reply(chunk, { parse_mode: 'HTML', disable_web_page_preview: true, ...maybeText });
  }
  for (const chunk of chunkText(text)) {
    await send(chunk);
  }
}

function oneLine(value, max = 180) {
  const compact = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return compact.slice(0, max - 1).trimEnd() + '…';
}

// Convert the common Markdown that language models emit into the small subset of
// HTML that Telegram supports. LLM replies come back as Markdown (**bold**,
// `code`, # headings, [text](url)), but we send with parse_mode HTML, so without
// this the user would see raw Markdown symbols. Every rule emits matched tag
// pairs so the result is always balanced and safe for Telegram's parser.
function mdToHtml(input) {
  let s = String(input ?? '');
  if (!s.trim()) return '';

  // Protect fenced and inline code before escaping so their contents are kept
  // verbatim (and escaped) rather than interpreted as Markdown.
  const blocks = [];
  s = s.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(code.replace(/\n+$/, ''));
    return ` PRE${blocks.length - 1} `;
  });
  const inlines = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    inlines.push(code);
    return ` CODE${inlines.length - 1} `;
  });

  s = escapeHtml(s);

  // Horizontal rules (---, ***, ___ on their own line) → a thin divider.
  s = s.replace(/^\s*([-*_])\1{2,}\s*$/gm, '──────────');
  // [text](url)
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) => `<a href="${url}">${text}</a>`);
  // **bold**
  s = s.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>');
  // *italic* (single asterisks, not part of a leftover ** pair)
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>');
  // # Headings → a single bold line (strip any already-converted inner bold so
  // the heading does not become a nested <b><b>…</b></b>).
  s = s.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/gm, (_, h) => `<b>${h.replace(/<\/?b>/g, '')}</b>`);
  // - / * bullets → •
  s = s.replace(/^(\s*)[-*]\s+/gm, '$1• ');

  // Restore code, escaping their contents.
  s = s.replace(/ CODE(\d+) /g, (_, i) => `<code>${escapeHtml(inlines[Number(i)])}</code>`);
  s = s.replace(/ PRE(\d+) /g, (_, i) => `<pre>${escapeHtml(blocks[Number(i)])}</pre>`);
  return balanceTags(s.trim());
}

// Guarantee the emitted tags are balanced no matter how pathological the input
// Markdown was (e.g. stray "***" runs). Telegram rejects the whole message on a
// single unbalanced tag, so drop any tag that can't be matched cleanly and close
// anything left open. Balanced input passes through unchanged.
const BALANCE_ALLOWED = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a', 'tg-spoiler', 'blockquote']);
function balanceTags(html) {
  const stack = [];
  let out = '';
  let last = 0;
  const re = /<(\/?)([a-zA-Z0-9-]+)([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    out += html.slice(last, m.index);
    last = re.lastIndex;
    const tag = m[2].toLowerCase();
    if (!BALANCE_ALLOWED.has(tag)) continue; // drop unknown tags
    if (m[1] !== '/') {
      stack.push(tag);
      out += m[0];
    } else if (stack[stack.length - 1] === tag) {
      stack.pop();
      out += m[0];
    } // else: unmatched closer — drop it
  }
  out += html.slice(last);
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

module.exports = {
  TELEGRAM_SAFE_LIMIT,
  escapeHtml,
  stripHtml,
  link,
  chunkText,
  sendLong,
  oneLine,
  mdToHtml,
};
