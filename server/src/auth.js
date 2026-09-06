import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { subscriptionEnv } from './agentEnv.js';

const CODEX_CLI = fileURLToPath(new URL('../node_modules/@openai/codex/bin/codex.js', import.meta.url));
const CODEX_LOGIN_COMMAND = 'npm run login:codex';

/**
 * Cheap preflight so a stale token surfaces on the board instead of failing
 * one card at a time.
 *
 * The Claude desktop app keeps its own refreshed token in memory and does not
 * rewrite this file, so a session started from the app can work while every
 * other process on the machine — this server included — sees an expired token.
 * We report what a spawned CLI would actually see.
 */
function checkClaudeAuth() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const file = path.join(dir, '.credentials.json');

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {
      ok: false,
      via: 'oauth',
      reason: 'No stored Claude credentials were found.',
      hint: 'Run "claude" in a terminal and log in with your subscription, then reload this page.',
    };
  }

  const oauth = parsed.claudeAiOauth ?? {};
  const expiresAt = oauth.expiresAt ?? null;

  if (expiresAt && expiresAt < Date.now() && !oauth.refreshToken) {
    return {
      ok: false,
      via: 'oauth',
      expiresAt,
      reason: `Your stored Claude login expired on ${new Date(expiresAt).toLocaleDateString()}.`,
      hint: 'Run "claude" in a terminal and log in with your subscription, then reload this page.',
    };
  }

  return { ok: true, via: 'oauth', expiresAt };
}

let codexCache = null;
let codexCheckedAt = 0;

function checkCodexAuth() {
  // `codex login status` understands both the file and OS credential-store
  // backends. Cache it because board broadcasts can happen several times per
  // second while a session is active.
  if (codexCache && Date.now() - codexCheckedAt < 5000) return codexCache;

  const result = spawnSync(process.execPath, [CODEX_CLI, 'login', 'status'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    env: subscriptionEnv('codex'),
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();

  if (!result.error && result.status === 0 && /logged in/i.test(output)) {
    codexCache = { ok: true, via: /chatgpt/i.test(output) ? 'chatgpt' : 'codex' };
  } else if (result.error?.code === 'ENOENT') {
    codexCache = {
      ok: false,
      via: 'missing',
      reason: 'The Codex CLI is not installed or is not on PATH.',
      hint: `Run "${CODEX_LOGIN_COMMAND}" and sign in with ChatGPT.`,
    };
  } else if (result.error) {
    // Some sandboxed launchers prevent a synchronous preflight even though
    // the SDK child process can run normally. Let the actual card surface a
    // definitive error instead of showing a false logged-out banner.
    codexCache = { ok: true, via: 'unchecked' };
  } else {
    codexCache = {
      ok: false,
      via: 'chatgpt',
      reason: output || 'Codex is not logged in.',
      hint: `Run "${CODEX_LOGIN_COMMAND}" and sign in with ChatGPT, then reload this page.`,
    };
  }
  codexCheckedAt = Date.now();
  return codexCache;
}

export function checkAuth(agent = 'claude') {
  return agent === 'codex' ? checkCodexAuth() : checkClaudeAuth();
}
