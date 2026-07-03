// Self-update: check GitHub for a newer version, and (on the user's explicit
// command) pull it, reinstall deps if they changed, health-check the new code,
// and auto-roll back if the new code fails to load. The bot then restarts.
//
// Design (mirrors the TrendForge self-update, adapted for PolyEdge):
//  - AUTO-CHECK + NOTIFY only when a REAL update exists (no false alarms).
//  - MANUAL APPLY: the user must run /update; we never auto-apply.
//  - DATA IS PRESERVED: all user state (the SQLite db under data/ and .env) is
//    gitignored, so git pull/reset never touch it. dataFilesProtected() verifies
//    this so we can prove it before/after an update.
//  - SAFETY: refuse on a dirty tree; health-check the new code in a child process
//    BEFORE restarting; if it fails to load, hard-reset back to the prior commit.
//
// All git/npm/node calls go through an injectable `run` so this is fully testable
// without touching a real repo, network, or npm.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_DIR = path.join(__dirname, '..');

// User-state files that must survive any update. All are gitignored (the whole
// data/ dir plus .env), so git can never touch them.
const DATA_FILES = ['data/polyedge.sqlite', '.env'];

// Default command runner: returns trimmed stdout, throws on non-zero exit.
function defaultRun(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: REPO_DIR,
    encoding: 'utf-8',
    timeout: opts.timeout || 60000,
    maxBuffer: 1024 * 1024 * 16,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function makeRunner(deps) {
  return deps.run || defaultRun;
}

// Does a command succeed (exit 0)? Never throws.
function runOk(run, cmd, opts) {
  try {
    run(cmd, opts);
    return true;
  } catch {
    return false;
  }
}

function isGitRepo(deps = {}) {
  const run = makeRunner(deps);
  try {
    return run('git rev-parse --is-inside-work-tree').trim() === 'true';
  } catch {
    return false;
  }
}

// Only tracked changes matter for pull/reset safety; gitignored data files are
// invisible here by design.
function workingTreeClean(deps = {}) {
  const run = makeRunner(deps);
  try {
    return run('git status --porcelain --untracked-files=no').trim() === '';
  } catch {
    return false;
  }
}

// Which DATA_FILES are protected (gitignored) vs would be touched by git.
function dataFilesProtected(deps = {}) {
  const run = makeRunner(deps);
  const protectedFiles = [];
  const unprotected = [];
  for (const f of DATA_FILES) {
    // `git check-ignore <f>` exits 0 if the path is ignored, non-zero otherwise.
    if (runOk(run, `git check-ignore ${f}`)) protectedFiles.push(f);
    else unprotected.push(f);
  }
  return { protected: protectedFiles, unprotected, allProtected: unprotected.length === 0 };
}

// --- Data-integrity proof -------------------------------------------------
// Cheap per-file signature so we can PROVE user data is byte-for-byte
// untouched by an update. fs access goes through an injectable `fileMeta` so
// this is fully testable without a real filesystem.
function defaultFileMeta(file) {
  const p = path.join(REPO_DIR, file);
  try {
    const buf = fs.readFileSync(p);
    return { exists: true, size: buf.length, lines: buf.toString('utf-8').split('\n').length };
  } catch {
    return { exists: false, size: 0, lines: 0 };
  }
}

function makeFileMeta(deps) {
  return deps.fileMeta || defaultFileMeta;
}

// Snapshot a signature for every DATA_FILES entry.
function snapshotDataFiles(deps = {}) {
  const meta = makeFileMeta(deps);
  const snap = {};
  for (const f of DATA_FILES) snap[f] = meta(f);
  return snap;
}

// Compare two snapshots. `checked` = the files that existed before the update
// (the ones we are actually protecting). A change in existence, byte size, or
// line count for ANY data file is a mismatch.
function compareDataSnapshots(before, after) {
  const checked = [];
  const mismatches = [];
  for (const f of DATA_FILES) {
    const b = before[f] || { exists: false, size: 0, lines: 0 };
    const a = after[f] || { exists: false, size: 0, lines: 0 };
    if (b.exists) checked.push(f);
    if (b.exists !== a.exists || b.size !== a.size || b.lines !== a.lines) {
      mismatches.push({ file: f, before: b, after: a });
    }
  }
  return { checked, ok: mismatches.length === 0, mismatches };
}

// Human-facing summary of what an update actually changed: the list of files
// (with git status letters) and the commit subjects between two commits.
function summarizeChanges(run, from, to) {
  let filesChanged = [];
  let commits = [];
  try {
    const ns = run(`git diff --name-status ${from}..${to}`).trim();
    filesChanged = ns
      ? ns.split('\n').map((line) => {
        const parts = line.split('\t');
        return { status: parts[0], file: parts.slice(1).join('\t') };
      }).filter((x) => x.file)
      : [];
  } catch { filesChanged = []; }
  try {
    const lg = run(`git log --oneline ${from}..${to}`).trim();
    commits = lg ? lg.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  } catch { commits = []; }
  return { filesChanged, commits };
}

function readRemoteVersion(deps = {}) {
  const run = makeRunner(deps);
  try {
    const pkg = JSON.parse(run('git show origin/main:package.json'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

function readLocalVersion(deps = {}) {
  if (deps.localVersion) return deps.localVersion;
  try {
    return require('../package.json').version || null;
  } catch {
    return null;
  }
}

// Check whether a newer version exists on origin/main. Fetches first.
// Returns { available, local, remote, behind, changelog[], localVersion, remoteVersion }.
// Throws only on hard failures (not a repo, network fetch failed) so the caller
// can route those through the friendly error explainer.
function checkForUpdate(deps = {}) {
  const run = makeRunner(deps);
  if (!isGitRepo(deps)) {
    const err = new Error('PolyEdge is not running from a git checkout, so it cannot self-update.');
    err.kind = 'not_git';
    throw err;
  }

  // Network step — may throw on no connectivity; let it propagate.
  run('git fetch origin main', { timeout: 60000 });

  const local = run('git rev-parse HEAD').trim();
  const remote = run('git rev-parse origin/main').trim();

  if (local === remote) {
    return {
      available: false, local, remote, behind: 0, changelog: [],
      localVersion: readLocalVersion(deps), remoteVersion: readRemoteVersion(deps),
    };
  }

  let behind = 0;
  try { behind = parseInt(run('git rev-list --count HEAD..origin/main').trim(), 10) || 0; } catch { behind = 0; }

  let changelog = [];
  try {
    const log = run('git log --no-merges --pretty=format:%s HEAD..origin/main').trim();
    changelog = log ? log.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  } catch { changelog = []; }

  return {
    available: true, local, remote, behind, changelog,
    localVersion: readLocalVersion(deps), remoteVersion: readRemoteVersion(deps),
  };
}

// Did dependencies change between two commits? (package.json / lockfile)
function depsChangedBetween(run, from, to) {
  try {
    const changed = run(`git diff --name-only ${from} ${to}`).trim().split('\n');
    return changed.some((f) => /(^|\/)package(-lock)?\.json$/.test(f.trim()));
  } catch {
    // If we can't tell, be safe and reinstall.
    return true;
  }
}

// Health-check the freshly-pulled code WITHOUT starting a second bot: load and
// construct the core modules in a child node process. A syntax error, missing
// dependency, or require-time throw makes it exit non-zero. Injectable for tests.
function healthCheck(deps = {}) {
  if (deps.healthCheck) return deps.healthCheck();
  const run = makeRunner(deps);
  const probe =
    "require('./src/config');require('./src/db');require('./src/polymarket/client');" +
    "require('./src/decision/engine');require('./src/llm/minimax');require('./src/render');" +
    "require('./src/agent');require('./src/bot').createBot('0:healthcheck');" +
    "require('./src/update');console.log('HC_OK');";
  try {
    const out = run(`node -e "${probe}"`, { timeout: 60000 });
    return { ok: /HC_OK/.test(out), output: out };
  } catch (e) {
    return { ok: false, output: (e && (e.stderr || e.message)) || 'health check failed' };
  }
}

// Apply the update: pull → (npm install if deps changed) → health-check →
// rollback on failure. Does NOT restart (the caller restarts on ok:true).
// Never throws; returns a structured result the caller can report.
function applyUpdate(deps = {}) {
  const run = makeRunner(deps);

  if (!isGitRepo(deps)) {
    return { ok: false, stage: 'preflight', reason: 'not_git', message: 'Not a git checkout — cannot self-update.' };
  }
  if (!workingTreeClean(deps)) {
    return { ok: false, stage: 'preflight', reason: 'dirty_tree', message: 'There are uncommitted local changes. Resolve them before updating so nothing is lost.' };
  }

  let prevHead;
  try {
    prevHead = run('git rev-parse HEAD').trim();
  } catch (e) {
    return { ok: false, stage: 'preflight', reason: 'no_head', message: 'Could not read the current commit.' };
  }

  // Snapshot user-data signatures BEFORE we touch anything, so we can prove
  // afterwards that the update left every data file byte-for-byte intact.
  const dataBefore = snapshotDataFiles(deps);

  // Pull (fast-forward only — never create a merge or rewrite history).
  try {
    run('git pull --ff-only origin main', { timeout: 120000 });
  } catch (e) {
    // Working tree is unchanged on a failed ff pull; nothing to roll back.
    return { ok: false, stage: 'pull', reason: 'pull_failed', prevHead, message: (e && (e.stderr || e.message)) || 'git pull failed' };
  }

  let newHead;
  try { newHead = run('git rev-parse HEAD').trim(); } catch { newHead = null; }

  if (newHead && newHead === prevHead) {
    return {
      ok: true, stage: 'noop', updated: false, prevHead, newHead,
      dataProtected: dataFilesProtected(deps),
      dataIntegrity: compareDataSnapshots(dataBefore, snapshotDataFiles(deps)),
      filesChanged: [], commits: [],
      message: 'Already up to date.',
    };
  }

  // Reinstall deps only when they changed.
  let depsInstalled = false;
  if (depsChangedBetween(run, prevHead, newHead || 'HEAD')) {
    try {
      run('npm install --no-audit --no-fund', { timeout: 300000 });
      depsInstalled = true;
    } catch (e) {
      // Bad deps — roll the code back so the running version stays consistent.
      rollback(run, prevHead);
      return { ok: false, stage: 'npm', reason: 'npm_failed', rolledBack: true, prevHead, newHead, message: (e && (e.stderr || e.message)) || 'npm install failed' };
    }
  }

  // Verify the new code actually loads before we commit to a restart.
  const health = healthCheck(deps);
  if (!health.ok) {
    rollback(run, prevHead);
    if (depsInstalled) {
      // Restore deps to match the rolled-back package.json.
      try { run('npm install --no-audit --no-fund', { timeout: 300000 }); } catch { /* best effort */ }
    }
    return { ok: false, stage: 'healthcheck', reason: 'bad_boot', rolledBack: true, prevHead, newHead, message: 'The new version failed its health check, so I rolled back to the previous version. Your bot is still running the old, working code.', detail: health.output };
  }

  // Prove user data survived the update untouched.
  const dataIntegrity = compareDataSnapshots(dataBefore, snapshotDataFiles(deps));
  // Capture the human-facing change summary (files + commit subjects).
  const { filesChanged, commits } = summarizeChanges(run, prevHead, newHead || 'HEAD');

  if (!dataIntegrity.ok) {
    // Should be impossible — data files are gitignored — but if it ever
    // happens, treat it as a hard failure: roll the code back and refuse to
    // restart so nothing is silently lost.
    rollback(run, prevHead);
    if (depsInstalled) {
      try { run('npm install --no-audit --no-fund', { timeout: 300000 }); } catch { /* best effort */ }
    }
    return {
      ok: false, stage: 'data_integrity', reason: 'data_changed', rolledBack: true,
      prevHead, newHead, dataIntegrity, filesChanged, commits,
      message: 'A protected data file changed during the update (' + dataIntegrity.mismatches.map((m) => m.file).join(', ') + '), which should never happen. I rolled back to the previous version so none of your data is at risk — please check those files before trying again.',
    };
  }

  return {
    ok: true, stage: 'done', updated: true, prevHead, newHead, depsInstalled,
    dataProtected: dataFilesProtected(deps),
    dataIntegrity, filesChanged, commits,
    message: 'Update applied and health-checked. Restarting to run the new version.',
  };
}

function rollback(run, toHead) {
  try {
    run(`git reset --hard ${toHead}`, { timeout: 60000 });
    return true;
  } catch {
    return false;
  }
}

// Build a short, user-facing "update available" notification.
function formatUpdateNotice(info) {
  const verPart =
    info.localVersion && info.remoteVersion && info.localVersion !== info.remoteVersion
      ? `v${info.localVersion} → v${info.remoteVersion}`
      : `${info.behind} new commit${info.behind === 1 ? '' : 's'}`;
  const lines = ['🆕 A PolyEdge update is available — ' + verPart + '.'];
  if (info.changelog && info.changelog.length) {
    lines.push('');
    lines.push("What's new:");
    for (const c of info.changelog.slice(0, 8)) lines.push(`• ${c}`);
    if (info.changelog.length > 8) lines.push(`…and ${info.changelog.length - 8} more.`);
  }
  lines.push('');
  lines.push('Run /update to install it. Your paper trades, analyses and .env are kept — only the code changes, and I roll back automatically if the new version fails to start.');
  return lines.join('\n');
}

module.exports = {
  REPO_DIR,
  DATA_FILES,
  isGitRepo,
  workingTreeClean,
  dataFilesProtected,
  snapshotDataFiles,
  compareDataSnapshots,
  summarizeChanges,
  checkForUpdate,
  applyUpdate,
  healthCheck,
  rollback,
  depsChangedBetween,
  formatUpdateNotice,
  readLocalVersion,
  readRemoteVersion,
};
