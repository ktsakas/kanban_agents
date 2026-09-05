import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Cheap preflight so a stale token surfaces on the board instead of failing
 * one card at a time.
 *
 * The Claude desktop app keeps its own refreshed token in memory and does not
 * rewrite this file, so a session started from the app can work while every
 * other process on the machine — this server included — sees an expired token.
 * We report what a spawned CLI would actually see.
 */
export function checkAuth() {
  if (process.env.ANTHROPIC_API_KEY) {
    return { ok: true, via: 'ANTHROPIC_API_KEY' };
  }

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
      hint: 'Run "claude" in a terminal and log in, then reload this page.',
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
      hint: 'Run "claude" in a terminal and log in, then reload this page.',
    };
  }

  return { ok: true, via: 'oauth', expiresAt };
}
