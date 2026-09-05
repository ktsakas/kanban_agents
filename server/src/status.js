import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

// Same data-dir resolution as store.js, kept independent so `npm run status`
// works without booting the rest of the server.
const DATA_DIR = process.env.KANBAN_DATA_DIR
  ? path.resolve(process.env.KANBAN_DATA_DIR)
  : path.join(os.homedir(), '.kanban-agents');

const RUN_FILE = path.join(DATA_DIR, 'run.json');

function isPidAlive(pid) {
  try {
    // Signal 0 does no killing — it just probes whether the pid exists and
    // is ours to signal. Works on Windows and POSIX alike in Node.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ping(url) {
  return new Promise((resolve) => {
    const req = http.get(`${url}/api/health`, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function main() {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
  } catch {
    console.log('kanban-agents: not running (no run file found)');
    process.exit(1);
  }

  const { pid, port, url, startedAt } = info;
  const pidAlive = isPidAlive(pid);

  if (!pidAlive) {
    console.log(`kanban-agents: not running (stale run file, pid ${pid} is gone)`);
    try {
      fs.rmSync(RUN_FILE, { force: true });
    } catch {
      // best-effort cleanup
    }
    process.exit(1);
  }

  const responding = await ping(url);

  if (responding) {
    console.log(`kanban-agents: running at ${url}`);
    console.log(`  port       ${port}`);
    console.log(`  pid        ${pid}`);
    console.log(`  started    ${startedAt}`);
    process.exit(0);
  } else {
    console.log(`kanban-agents: process ${pid} is alive but not responding on ${url}`);
    process.exit(2);
  }
}

main();
