import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function git(cwd, args) {
  try {
    const { stdout } = await run('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function gitOrThrow(cwd, args, options = {}) {
  const { stdout } = await run('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  return stdout.trim();
}

function snapshotRef(cardId, phase) {
  // Card ids are UUIDs today. Keep this defensive in case their format ever
  // changes: Git ref components cannot contain most punctuation.
  const safeId = String(cardId).replace(/[^a-zA-Z0-9._-]/g, '-');
  return `refs/kanban-agents/sessions/${safeId}/${phase}`;
}

/**
 * Materialize the current worktree as a Git tree without touching the user's
 * real index. Unlike a commit/HEAD snapshot, this includes staged, unstaged,
 * and non-ignored untracked files, so a dirty tree can be restored precisely.
 */
async function captureWorktree(cwd, ref) {
  const root = await gitOrThrow(cwd, ['rev-parse', '--show-toplevel']);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-agents-index-'));
  const indexFile = path.join(tempDir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };

  try {
    const head = await git(root, ['rev-parse', '--verify', 'HEAD']);
    if (head) {
      await gitOrThrow(root, ['read-tree', head], { env });
    } else {
      await gitOrThrow(root, ['read-tree', '--empty'], { env });
    }
    await gitOrThrow(root, ['add', '-A'], { env });
    const tree = await gitOrThrow(root, ['write-tree'], { env });
    await gitOrThrow(root, ['update-ref', ref, tree]);
    return { root, ref, tree };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Capture the exact project contents before the first turn of a session. */
export async function captureSessionStart(cwd, cardId) {
  if (!(await isRepo(cwd))) return null;
  const before = await captureWorktree(cwd, snapshotRef(cardId, 'before'));
  return {
    version: 1,
    root: before.root,
    beforeRef: before.ref,
    beforeTree: before.tree,
    afterRef: null,
    afterTree: null,
    capturedAt: new Date().toISOString(),
  };
}

/** Refresh the session's end tree after each turn, accumulating one delta. */
export async function captureSessionEnd(snapshot) {
  if (!snapshot?.root || !snapshot?.beforeTree) return snapshot ?? null;
  const after = await captureWorktree(snapshot.root, snapshot.afterRef || snapshotRefFromBefore(snapshot.beforeRef));
  return {
    ...snapshot,
    afterRef: after.ref,
    afterTree: after.tree,
    updatedAt: new Date().toISOString(),
  };
}

function snapshotRefFromBefore(beforeRef) {
  return String(beforeRef).replace(/\/before$/, '/after');
}

/**
 * Remove only the content delta produced by this session. The check happens
 * before applying anything, so overlapping edits made later fail safely
 * instead of leaving a partially reverted worktree.
 */
export async function revertSessionChanges(snapshot) {
  if (!snapshot?.root || !snapshot?.beforeTree) {
    return { ok: false, error: 'This session has no rollback snapshot.' };
  }
  if (!snapshot.afterTree || snapshot.beforeTree === snapshot.afterTree) {
    await releaseSessionSnapshot(snapshot);
    return { ok: true, changed: false };
  }
  if (!(await isRepo(snapshot.root))) {
    return { ok: false, error: 'The session project is no longer a Git repository.' };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-agents-revert-'));
  const patchFile = path.join(tempDir, 'session.patch');
  try {
    await gitOrThrow(snapshot.root, [
      'diff',
      '--binary',
      '--full-index',
      `--output=${patchFile}`,
      snapshot.beforeTree,
      snapshot.afterTree,
    ]);
    if (!fs.statSync(patchFile).size) {
      await releaseSessionSnapshot(snapshot);
      return { ok: true, changed: false };
    }

    try {
      await gitOrThrow(snapshot.root, ['apply', '--reverse', '--check', patchFile]);
    } catch {
      return {
        ok: false,
        error:
          'These session changes overlap newer work and could not be reverted cleanly. Resolve or save the newer edits, then try again.',
      };
    }
    await gitOrThrow(snapshot.root, ['apply', '--reverse', patchFile]);
    await releaseSessionSnapshot(snapshot);
    return { ok: true, changed: true };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Drop the private Git refs once a session is reset or successfully undone. */
export async function releaseSessionSnapshot(snapshot) {
  if (!snapshot?.root) return;
  for (const ref of [snapshot.beforeRef, snapshot.afterRef]) {
    if (!ref) continue;
    try {
      await gitOrThrow(snapshot.root, ['update-ref', '-d', ref]);
    } catch {
      // Cleanup is best-effort; stale private refs do not affect the worktree.
    }
  }
}

export async function isRepo(cwd) {
  return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true';
}

export async function snapshot(cwd) {
  if (!(await isRepo(cwd))) return null;
  const [head, branch, dirty] = await Promise.all([
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['status', '--porcelain']),
  ]);
  return { head, branch, dirty: dirty ? dirty.split('\n').length : 0 };
}

/**
 * What the session changed: committed diff since `beforeHead` plus anything
 * still sitting in the working tree.
 */
export async function diffSince(cwd, beforeHead) {
  if (!(await isRepo(cwd))) return null;
  const parts = [];
  if (beforeHead) {
    const committed = await git(cwd, ['diff', '--stat', `${beforeHead}..HEAD`]);
    if (committed) parts.push(committed);
  }
  const working = await git(cwd, ['diff', '--stat', 'HEAD']);
  if (working) parts.push(working);
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
  if (untracked) {
    parts.push(untracked.split('\n').map((f) => ` ${f} (new)`).join('\n'));
  }
  return parts.length ? parts.join('\n') : null;
}

export async function createBranch(cwd, name) {
  if (!name || !(await isRepo(cwd))) return null;
  const existing = await git(cwd, ['rev-parse', '--verify', name]);
  if (existing) {
    await git(cwd, ['checkout', name]);
  } else {
    await git(cwd, ['checkout', '-b', name]);
  }
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}
