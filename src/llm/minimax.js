const axios = require('axios');
const { getConfig } = require('../config');

const MINIMAX_URL = 'https://api.minimaxi.chat/v1/chat/completions';

// MiniMax-M1 is a reasoning model: it wraps its thinking in <think>…</think> and
// can emit tool-call markup even when no tools are offered. None of that should
// reach the user, so strip it centrally before returning any text.
function sanitizeAssistantText(text) {
  let s = String(text ?? '');
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<think>[\s\S]*$/i, ''); // unterminated think block
  s = s.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/gi, '');
  s = s.replace(/<minimax:tool_call>[\s\S]*$/i, '');
  s = s.replace(/<invoke\b[\s\S]*?<\/invoke>/gi, '');
  s = s.replace(/<invoke\b[\s\S]*$/i, '');
  s = s.replace(/<\/?(?:think|minimax:tool_call|tool_call|invoke|parameter)\b[^>]*>/gi, '');
  return s.trim();
}

async function chat(messages, options = {}) {
  const config = getConfig();
  if (!config.minimaxApiKey) throw new Error('MINIMAX_API_KEY is not set.');
  const res = await axios.post(
    MINIMAX_URL,
    {
      model: config.minimaxModel,
      messages,
      max_tokens: options.maxTokens || 2000,
      temperature: options.temperature ?? 0.4,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.minimaxApiKey}`,
      },
      timeout: options.timeout || config.llmTimeoutMs,
    },
  );
  const choice = res.data?.choices?.[0]?.message?.content;
  return sanitizeAssistantText(choice);
}

// Ask for strict JSON and parse it, tolerating ```json fences and any stray
// prose the model wraps around the object.
async function chatJson(messages, options = {}) {
  const text = await chat(messages, { ...options, temperature: options.temperature ?? 0.2 });
  return extractJson(text);
}

function extractJson(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    // Fall back to the first balanced {...} block.
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(s.slice(start, end + 1));
    }
    throw new Error('Model did not return valid JSON.');
  }
}

module.exports = { chat, chatJson, sanitizeAssistantText, extractJson };
