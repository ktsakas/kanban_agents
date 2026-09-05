import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import * as store from './store.js';

/**
 * Whether, and where, the project living in a given working directory is
 * currently reachable in a browser.
 *
 * There's no generic way to know how an arbitrary project is run (a Vite app,
 * a Flask server, a Go binary...), so we don't guess from outside. Instead,
 * the "Run project" button queues a card whose prompt asks the agent to
 * figure that out itself, start the server in the background, and drop a
 * small JSON file here recording the URL it landed on. From then on this
 * module just TCP-probes that URL - so if the server later dies, crashes, or
 * the machine reboots, status flips back to "not running" on its own without
 * needing the agent to clean up after itself.
 */

const STATUS_DIR = path.join(store.paths.DATA_DIR, 'run-status');
fs.mkdirSync(STATUS_DIR, { recursive: true });

/** Deterministic, filesystem-safe path for a project's run-status file. */
export function statusFilePath(dir) {
  const resolved = store.resolveDir(dir);
  const slug = path.basename(resolved).replace(/[^a-z0-9_-]/gi, '_').slice(0, 40) || 'project';
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 12);
  return path.join(STATUS_DIR, `${slug}-${hash}.json`);
}

function readStatusFile(dir) {
  try {
    const raw = fs.readFileSync(statusFilePath(dir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.url === 'string' && parsed.url) return parsed;
  } catch {
    /* nothing reported yet, or the file is unreadable/malformed */
  }
  return null;
}

/** TCP-probes a URL's host:port. Resolves false on any error, including a bad URL. */
function probe(url, timeoutMs = 350) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve(false);
      return;
    }
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
    let settled = false;
    const socket = net.connect({ host: parsed.hostname, port, timeout: timeoutMs });
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Current run state of a project: is the URL it last reported still answering. */
export async function getRunStatus(dir) {
  const reported = readStatusFile(dir);
  if (!reported) return { running: false };
  const running = await probe(reported.url);
  return {
    running,
    url: reported.url,
    command: reported.command ?? null,
    startedAt: reported.startedAt ?? null,
  };
}

export const paths = { STATUS_DIR };
