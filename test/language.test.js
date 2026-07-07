const test = require('node:test');
const assert = require('node:assert/strict');
const { languagePolicy, ENGLISH_DEFAULT_INSTRUCTION } = require('../src/utils/language');

test('language policy defaults replies to English and permits only necessary non-English', () => {
  assert.match(ENGLISH_DEFAULT_INSTRUCTION, /Default reply language is English/);
  assert.match(ENGLISH_DEFAULT_INSTRUCTION, /proper nouns, names, titles, code identifiers/);
  assert.match(ENGLISH_DEFAULT_INSTRUCTION, /Do not drift into Chinese/);
  assert.match(languagePolicy('extra'), /extra/);
});
