const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { classifyFile, getSupportedExtensions, extractText, getMimeType } = require('../src/files');

const fixtures = path.join(__dirname, 'fixtures', 'uploads');
const REQUIRED = ['.txt', '.md', '.csv', '.json', '.html', '.pdf', '.rtf', '.png', '.jpg', '.jpeg', '.avif'];

test('supports Evan requested upload extensions', () => {
  const exts = getSupportedExtensions();
  for (const ext of REQUIRED) assert.ok(exts.includes(ext), `${ext} missing`);
  for (const ext of REQUIRED) assert.ok(classifyFile(`sample${ext}`), `${ext} not classified`);
  assert.equal(classifyFile('sample.png').kind, 'image');
  assert.equal(classifyFile('sample.pdf').kind, 'document');
});

test('extracts text and rtf sample files', async () => {
  assert.match(await extractText(path.join(fixtures, 'sample.txt'), 'sample.txt'), /hello txt/);
  assert.match(await extractText(path.join(fixtures, 'sample.md'), 'sample.md'), /Hello md/);
  assert.match(await extractText(path.join(fixtures, 'sample.csv'), 'sample.csv'), /a,b/);
  assert.match(await extractText(path.join(fixtures, 'sample.json'), 'sample.json'), /json/);
  assert.match(await extractText(path.join(fixtures, 'sample.html'), 'sample.html'), /Hello html/);
  assert.match(await extractText(path.join(fixtures, 'sample.rtf'), 'sample.rtf'), /Hello rtf/);
});

test('image mime types are explicit', () => {
  assert.equal(getMimeType('a.png'), 'image/png');
  assert.equal(getMimeType('a.jpg'), 'image/jpeg');
  assert.equal(getMimeType('a.jpeg'), 'image/jpeg');
  assert.equal(getMimeType('a.avif'), 'image/avif');
});
