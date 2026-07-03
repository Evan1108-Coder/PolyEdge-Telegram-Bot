const test = require('node:test');
const assert = require('node:assert/strict');
const upd = require('../src/update');

// A fake git/npm runner so these tests never touch a real repo, network or npm.
function fakeRunner(cfg = {}) {
  const state = {
    head: cfg.head || 'aaa111',
    remote: cfg.remote || (cfg.upToDate ? (cfg.head || 'aaa111') : 'bbb222'),
    calls: [], npmRuns: 0, resets: [],
  };
  const run = (cmd) => {
    state.calls.push(cmd);
    if (cmd.includes('--is-inside-work-tree')) {
      if (cfg.notGit) throw new Error('not a git repository');
      return 'true\n';
    }
    if (cmd.includes('status --porcelain')) return cfg.dirty ? ' M src/foo.js\n' : '\n';
    if (cmd.includes('git fetch')) { if (cfg.fetchFails) throw new Error('network is unreachable'); return ''; }
    if (cmd.includes('rev-parse HEAD')) return state.head + '\n';
    if (cmd.includes('rev-parse origin/main')) return state.remote + '\n';
    if (cmd.includes('rev-list --count')) return String(cfg.behind != null ? cfg.behind : 2) + '\n';
    if (cmd.includes('git log --oneline')) return (cfg.commits || ['abc123 feat: a', 'def456 fix: b']).join('\n') + '\n';
    if (cmd.includes('git log')) return (cfg.changelog || []).join('\n') + '\n';
    if (cmd.includes('git show origin/main:package.json')) return JSON.stringify({ version: cfg.remoteVersion || '9.9.9' });
    if (cmd.includes('git pull')) { if (cfg.pullFails) throw new Error('pull conflict'); state.head = state.remote; return 'Updating\n'; }
    if (cmd.includes('git diff --name-status')) return (cfg.nameStatus || 'M\tsrc/x.js\nA\tsrc/y.js') + '\n';
    if (cmd.includes('git diff --name-only')) return (cfg.depsChanged ? 'package.json\nsrc/x.js' : 'src/x.js') + '\n';
    if (cmd.includes('npm install')) { state.npmRuns++; if (cfg.npmFails) throw new Error('npm ERR! install failed'); return ''; }
    if (cmd.includes('git reset --hard')) { state.resets.push(cmd); state.head = cfg.head || 'aaa111'; return ''; }
    if (cmd.includes('git check-ignore')) {
      const file = cmd.split(' ').pop();
      if ((cfg.unignored || []).includes(file)) throw new Error('not ignored');
      return file + '\n';
    }
    return '';
  };
  return { run, state };
}

test('checkForUpdate: detects an available update', () => {
  const { run } = fakeRunner({ head: 'aaa', remote: 'bbb', behind: 3, changelog: ['feat x', 'fix y'], remoteVersion: '1.1.0' });
  const info = upd.checkForUpdate({ run, localVersion: '1.0.0' });
  assert.equal(info.available, true);
  assert.equal(info.behind, 3);
  assert.equal(info.changelog.length, 2);
  assert.equal(info.remoteVersion, '1.1.0');
  assert.equal(info.localVersion, '1.0.0');
});

test('checkForUpdate: no false-positive when already up to date', () => {
  const { run } = fakeRunner({ head: 'same', remote: 'same' });
  const info = upd.checkForUpdate({ run, localVersion: '1.0.0' });
  assert.equal(info.available, false);
  assert.equal(info.behind, 0);
});

test('checkForUpdate: throws clearly when not a git checkout', () => {
  const { run } = fakeRunner({ notGit: true });
  assert.throws(() => upd.checkForUpdate({ run }), (e) => e.kind === 'not_git');
});

test('dataFilesProtected: the sqlite db and .env are gitignored', () => {
  const { run } = fakeRunner({});
  const dp = upd.dataFilesProtected({ run });
  assert.equal(dp.allProtected, true);
  assert.ok(dp.protected.includes('.env'));
  assert.ok(dp.protected.includes('data/polyedge.sqlite'));
});

test('dataFilesProtected: flags a data file that is NOT ignored', () => {
  const { run } = fakeRunner({ unignored: ['data/polyedge.sqlite'] });
  const dp = upd.dataFilesProtected({ run });
  assert.equal(dp.allProtected, false);
  assert.ok(dp.unprotected.includes('data/polyedge.sqlite'));
});

test('applyUpdate: happy path updates; no npm when deps unchanged', () => {
  const { run, state } = fakeRunner({ head: 'aaa', remote: 'bbb', depsChanged: false });
  const result = upd.applyUpdate({ run, healthCheck: () => ({ ok: true }) });
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(state.npmRuns, 0, 'npm must NOT run when deps unchanged');
  assert.equal(state.resets.length, 0, 'no rollback on success');
  assert.equal(result.dataProtected.allProtected, true);
});

test('applyUpdate: installs deps when package.json changed', () => {
  const { run, state } = fakeRunner({ head: 'aaa', remote: 'bbb', depsChanged: true });
  const result = upd.applyUpdate({ run, healthCheck: () => ({ ok: true }) });
  assert.equal(result.ok, true);
  assert.equal(result.depsInstalled, true);
  assert.equal(state.npmRuns, 1);
});

test('applyUpdate: rolls back when the new code fails its health check', () => {
  const { run, state } = fakeRunner({ head: 'aaa', remote: 'bbb', depsChanged: false });
  const result = upd.applyUpdate({ run, healthCheck: () => ({ ok: false, output: 'SyntaxError: bad' }) });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.reason, 'bad_boot');
  assert.equal(state.resets.length, 1);
  assert.ok(state.resets[0].includes('aaa'));
});

test('applyUpdate: refuses on a dirty working tree (never pulls)', () => {
  const { run, state } = fakeRunner({ dirty: true });
  const result = upd.applyUpdate({ run, healthCheck: () => ({ ok: true }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'dirty_tree');
  assert.ok(!state.calls.some((c) => c.includes('git pull')));
});

test('applyUpdate: rolls back when npm install fails', () => {
  const { run, state } = fakeRunner({ head: 'aaa', remote: 'bbb', depsChanged: true, npmFails: true });
  const result = upd.applyUpdate({ run, healthCheck: () => ({ ok: true }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'npm_failed');
  assert.equal(result.rolledBack, true);
  assert.ok(state.resets.length >= 1);
});

test('applyUpdate: success result includes filesChanged, commits and dataIntegrity', () => {
  const fileMeta = () => ({ exists: true, size: 10, lines: 2 }); // stable → integrity ok
  const { run } = fakeRunner({ head: 'aaa', remote: 'bbb', depsChanged: false, nameStatus: 'M\tsrc/a.js', commits: ['c1 feat: x'] });
  const result = upd.applyUpdate({ run, healthCheck: () => ({ ok: true }), fileMeta });
  assert.equal(result.ok, true);
  assert.equal(result.filesChanged[0].file, 'src/a.js');
  assert.equal(result.commits[0], 'c1 feat: x');
  assert.equal(result.dataIntegrity.ok, true);
});

test('applyUpdate: a data-file change during update → failure + rollback', () => {
  const seen = {};
  const fileMeta = (f) => {
    seen[f] = (seen[f] || 0) + 1;
    const changed = f === '.env' && seen[f] >= 2;
    return { exists: true, size: changed ? 200 : 100, lines: changed ? 20 : 10 };
  };
  const { run, state } = fakeRunner({ head: 'aaa', remote: 'bbb', depsChanged: false });
  const result = upd.applyUpdate({ run, healthCheck: () => ({ ok: true }), fileMeta });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'data_integrity');
  assert.equal(result.rolledBack, true);
  assert.equal(state.resets.length, 1);
  assert.ok(result.dataIntegrity.mismatches.some((m) => m.file === '.env'));
});

test('depsChangedBetween: true when package.json is in the diff', () => {
  const { run } = fakeRunner({ depsChanged: true });
  assert.equal(upd.depsChangedBetween(run, 'aaa', 'bbb'), true);
});

test('depsChangedBetween: false when only source changed', () => {
  const { run } = fakeRunner({ depsChanged: false });
  assert.equal(upd.depsChangedBetween(run, 'aaa', 'bbb'), false);
});

test('summarizeChanges: parses name-status files + oneline commits', () => {
  const { run } = fakeRunner({ nameStatus: 'M\tsrc/a.js\nA\tsrc/b.js', commits: ['c1 feat: x', 'c2 fix: y'] });
  const s = upd.summarizeChanges(run, 'aaa', 'bbb');
  assert.equal(s.filesChanged.length, 2);
  assert.equal(s.filesChanged[0].status, 'M');
  assert.equal(s.filesChanged[0].file, 'src/a.js');
  assert.equal(s.commits[0], 'c1 feat: x');
});

test('compareDataSnapshots: identical signatures → ok, no mismatches', () => {
  const before = { '.env': { exists: true, size: 100, lines: 10 }, 'data/polyedge.sqlite': { exists: true, size: 50, lines: 5 } };
  const after = { '.env': { exists: true, size: 100, lines: 10 }, 'data/polyedge.sqlite': { exists: true, size: 50, lines: 5 } };
  const di = upd.compareDataSnapshots(before, after);
  assert.equal(di.ok, true);
  assert.ok(di.checked.includes('.env'));
  assert.equal(di.mismatches.length, 0);
});

test('compareDataSnapshots: a changed byte size is flagged as a mismatch', () => {
  const before = { 'data/polyedge.sqlite': { exists: true, size: 100, lines: 10 } };
  const after = { 'data/polyedge.sqlite': { exists: true, size: 220, lines: 14 } };
  const di = upd.compareDataSnapshots(before, after);
  assert.equal(di.ok, false);
  assert.equal(di.mismatches[0].file, 'data/polyedge.sqlite');
});

test('snapshotDataFiles: uses injected fileMeta for every DATA_FILES entry', () => {
  const seen = [];
  const fileMeta = (f) => { seen.push(f); return { exists: true, size: 1, lines: 1 }; };
  const snap = upd.snapshotDataFiles({ fileMeta });
  assert.equal(seen.length, upd.DATA_FILES.length);
  assert.equal(snap['.env'].size, 1);
});

test('formatUpdateNotice: shows version, changelog and how to apply', () => {
  const msg = upd.formatUpdateNotice({ available: true, behind: 2, changelog: ['feat: a', 'fix: b'], localVersion: '1.0.0', remoteVersion: '1.1.0' });
  assert.ok(msg.includes('v1.0.0'));
  assert.ok(msg.includes('v1.1.0'));
  assert.ok(msg.includes('feat: a'));
  assert.ok(msg.includes('/update'));
  assert.ok(/kept|preserv/i.test(msg));
});
