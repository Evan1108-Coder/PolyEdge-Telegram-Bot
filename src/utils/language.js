const ENGLISH_DEFAULT_INSTRUCTION = [
  'LANGUAGE POLICY:',
  '- Default reply language is English, regardless of the language of recent chat history, quoted messages, source text, or retrieved content.',
  '- Use non-English only when the user explicitly asks for translation/non-English output, or for proper nouns, names, titles, code identifiers, quoted text, URLs, commands, and terms that must remain as-is.',
  '- If the user writes in another language but does not explicitly ask you to answer in that language, answer in English and preserve only necessary original-language terms/names.',
  '- Do not drift into Chinese or any other language just because context, group names, source snippets, or previous messages contain that language.',
].join('\n');

function languagePolicy(extra = '') {
  return extra ? `${ENGLISH_DEFAULT_INSTRUCTION}\n${extra}` : ENGLISH_DEFAULT_INSTRUCTION;
}

module.exports = { ENGLISH_DEFAULT_INSTRUCTION, languagePolicy };
