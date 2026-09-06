import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { captureSessionEnd, captureSessionStart, revertSessionChanges } from '../src/git.js';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function readNormalized(file) {
  return fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
}

test('reverts one session while preserving pre-existing and later unrelated changes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-agents-git-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(root, 'init');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'committed\n');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-m', 'initial');

  // This dirty content predates the agent session and must survive rollback.
  fs.writeFileSync(path.join(root, 'existing.txt'), 'keep me\n');
  const snapshot = await captureSessionStart(root, 'test-card');

  fs.writeFileSync(path.join(root, 'tracked.txt'), 'changed by session\n');
  fs.writeFileSync(path.join(root, 'created-by-session.txt'), 'remove me\n');
  const completed = await captureSessionEnd(snapshot);

  // Simulate unrelated work that landed after this card completed.
  fs.writeFileSync(path.join(root, 'later.txt'), 'keep this too\n');

  const result = await revertSessionChanges(completed);
  assert.deepEqual(result, { ok: true, changed: true });
  assert.equal(readNormalized(path.join(root, 'tracked.txt')), 'committed\n');
  assert.equal(readNormalized(path.join(root, 'existing.txt')), 'keep me\n');
  assert.equal(readNormalized(path.join(root, 'later.txt')), 'keep this too\n');
  assert.equal(fs.existsSync(path.join(root, 'created-by-session.txt')), false);
});
