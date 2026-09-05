import { execFile } from 'node:child_process';
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
