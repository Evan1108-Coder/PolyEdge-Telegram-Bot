const test = require('node:test');
const assert = require('node:assert/strict');
const { isSelfContextQuery, getSelfContext, renderSelfContext, selfContextText } = require('../src/self-context');
const { version } = require('../package.json');

test('self-context detects ambiguous bot/version questions', () => {
  assert.equal(isSelfContextQuery('latest version'), true);
  assert.equal(isSelfContextQuery('who are you and what can you do?'), true);
});

test('self-context includes actual PolyEdge runtime identity', () => {
  const ctx = getSelfContext(123);
  assert.equal(ctx.name, 'PolyEdge');
  assert.equal(ctx.version, version);
  assert.match(selfContextText(123), /PolyEdge/);
  assert.match(renderSelfContext(123), new RegExp(version.replace(/\./g, '\\.')));
});
