const { mdToHtml, escapeHtml } = require('./format');
function formatTelegramReply(text, opts={}) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  let html = mdToHtml(raw);
  if (!/^\s*[✅⚠️📊🔎💡🎯🧭📈🧠👀]/.test(raw) && opts.title) {
    html = `${opts.emoji || '💬'} <b>${escapeHtml(opts.title)}</b>\n${html}`;
  }
  html = html.replace(/\n\s*(Key points|Summary|Evidence|Next steps|Result|Why it matters|Decision|Market|Risk):/gi, (m, h) => `\n\n<b>${escapeHtml(h)}:</b>`);
  return html;
}
function formatEvidence(entry={}) {
  const parts = [];
  if (entry.version) parts.push(`version=${entry.version}`);
  if (entry.model) parts.push(`model=${entry.model}`);
  if (entry.actions) parts.push(`actions=${entry.actions}`);
  if (entry.cost != null) parts.push(`cost=${entry.cost}`);
  if (entry.terminal) parts.push(`terminal=${String(entry.terminal).slice(0,300)}`);
  return parts.join('; ');
}
module.exports={formatTelegramReply,formatEvidence};
