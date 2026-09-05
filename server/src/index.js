import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';

import * as store from './store.js';
import { bus } from './bus.js';
import { runner } from './runner.js';
import * as git from './git.js';
import { checkAuth } from './auth.js';
import { generateTitle } from './titler.js';
import * as projectRun from './projectRun.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4317);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const api = express.Router();

/* -------------------------------- board ---------------------------------- */

async function boardPayload() {
  const settings = store.getSettings();
  return {
    columns: store.COLUMNS,
    cards: store.listCards({ project: settings.workingDir }),
    projects: store.listProjects(),
    settings,
    runningCardId: runner.current?.cardId ?? null,
    auth: checkAuth(),
    projectRun: await projectRun.getRunStatus(settings.workingDir),
  };
}

api.get('/board', async (_req, res) => res.json(await boardPayload()));

/** Liveness/status probe: is the server up, and what is it serving on. */
api.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    pid: process.pid,
    port: PORT,
    url: `http://localhost:${PORT}`,
    uptime: process.uptime(),
    dataDir: store.paths.DATA_DIR,
  });
});

api.patch('/settings', (req, res) => {
  const settings = store.updateSettings(req.body ?? {});
  runner.broadcast();
  runner.tick();
  res.json(settings);
});

/* -------------------------------- cards ---------------------------------- */

api.post('/cards', (req, res) => {
  const body = req.body ?? {};
  const card = store.createCard(body);
  runner.broadcast();
  runner.tick();
  res.status(201).json(card);

  // No explicit title from the client: derive one from the task description
  // in the background and push the update once it lands.
  const hadExplicitTitle = Boolean((body.title ?? '').trim());
  if (!hadExplicitTitle && card.prompt?.trim()) {
    generateTitle(card.prompt)
      .then((title) => {
        if (!title || !store.getCard(card.id)) return;
        store.updateCard(card.id, { title });
        runner.broadcast();
      })
      .catch((err) => console.error('[titler] failed to update card title:', err));
  }
});

api.patch('/cards/:id', (req, res) => {
  const card = store.updateCard(req.params.id, req.body ?? {});
  if (!card) return res.status(404).json({ error: 'not found' });
  runner.broadcast();
  res.json(card);
});

api.delete('/cards/:id', async (req, res) => {
  await runner.cancelIfRunning(req.params.id);
  const ok = store.deleteCard(req.params.id);
  runner.broadcast();
  runner.tick();
  res.json({ ok });
});

api.post('/cards/:id/move', async (req, res) => {
  const { column, index } = req.body ?? {};
  const before = store.getCard(req.params.id);
  if (!before) return res.status(404).json({ error: 'not found' });

  // Dragging a live session out of In Progress stops it.
  if (before.column === 'in_progress' && column !== 'in_progress') {
    await runner.cancelIfRunning(req.params.id);
  }

  const card = store.moveCard(req.params.id, column, index);
  if (!card) return res.status(400).json({ error: 'bad column' });

  if (column === 'in_progress' && card.runState !== 'running') {
    store.updateCard(card.id, { runState: 'queued', error: null });
  }
  if (['done', 'cancelled', 'backlog', 'review'].includes(column)) {
    const state = column === 'cancelled' ? 'stopped' : card.runState;
    store.updateCard(card.id, { runState: state === 'running' ? 'stopped' : state });
  }

  runner.broadcast();
  runner.tick();
  res.json(store.getCard(req.params.id));
});

/* ------------------------------- sessions -------------------------------- */

api.get('/cards/:id/events', (req, res) => {
  res.json({ events: store.readEvents(req.params.id) });
});

api.post('/cards/:id/reply', (req, res) => {
  const ok = runner.reply(req.params.id, req.body?.text ?? '');
  res.json({ ok });
});

api.post('/cards/:id/permission', (req, res) => {
  const { requestId, decision, text } = req.body ?? {};
  const ok = runner.answerPermission(req.params.id, requestId, decision, { text });
  if (ok) runner.tick();
  res.json({ ok });
});

api.post('/cards/:id/stop', async (req, res) => {
  const ok = await runner.stop(req.params.id);
  res.json({ ok });
});

/** Wipe the transcript and forget the session so the next run starts clean. */
api.post('/cards/:id/reset', async (req, res) => {
  await runner.cancelIfRunning(req.params.id);
  store.clearEvents(req.params.id);
  const card = store.updateCard(req.params.id, {
    sessionId: null,
    runState: 'idle',
    error: null,
    stats: null,
    lastResult: null,
    diffStat: null,
    startedAt: null,
    finishedAt: null,
    pendingPermission: null,
    pendingReply: null,
    unread: false,
  });
  runner.broadcast();
  res.json(card);
});

/* ------------------------------ queue control ---------------------------- */

api.post('/queue/pause', (_req, res) => {
  store.updateSettings({ queuePaused: true });
  runner.broadcast();
  res.json(store.getSettings());
});

api.post('/queue/resume', (_req, res) => {
  store.updateSettings({ queuePaused: false });
  runner.broadcast();
  runner.tick();
  res.json(store.getSettings());
});

/* -------------------------------- utility -------------------------------- */

/** Directory picker support: list child directories of a path. */
api.get('/fs/dirs', (req, res) => {
  const target = req.query.path ? String(req.query.path) : os.homedir();
  try {
    const resolved = path.resolve(target);
    const entries = fs
      .readdirSync(resolved, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }))
      .slice(0, 500);
    res.json({ path: resolved, parent: path.dirname(resolved), entries });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

api.get('/git/status', async (req, res) => {
  const dir = req.query.path ? String(req.query.path) : store.getSettings().workingDir;
  res.json({ path: dir, snapshot: await git.snapshot(dir) });
});

/* ------------------------------ run project ------------------------------ */

const RUN_PROJECT_LABEL = 'run-project';

function runProjectPrompt(dir) {
  const statusPath = projectRun.statusFilePath(dir);
  return `Get this project running locally so it can be opened in a browser.

Working directory: ${dir}

1. Work out how this project is built and run - check package.json scripts, or
   whatever the equivalent is for this stack (Python, Go, Rust, a Makefile,
   etc). Install dependencies first if that hasn't been done yet.
2. Start its dev/preview server *in the background*, fully detached from this
   session, so it keeps running after you finish responding (e.g. on Windows,
   \`start /B\` or spawn detached with output redirected to a log file; on
   POSIX, \`nohup ... > log 2>&1 & disown\`). Do not run it in the foreground -
   that would block this task forever.
3. Confirm it actually answers before reporting success (curl/fetch it).
4. Write exactly this JSON to exactly this file path (create parent
   directories if needed), with the real port and command substituted in:

   ${statusPath}

   {"url": "http://localhost:<port>", "command": "<command you used to start it>", "startedAt": "<current ISO timestamp>"}

If there's no sensible way to "run" this project (e.g. it's a library, not an
app), don't guess - say so in your final message instead of writing that file.`;
}

/** Kicks off a card that builds/starts whatever project lives in `dir` and reports its URL back. */
api.post('/projects/run', (req, res) => {
  const settings = store.getSettings();
  const dir = store.resolveDir(req.body?.dir || settings.workingDir);

  // Don't pile up duplicate run cards if one's already in flight for this project.
  const already = store
    .listCards({ project: dir })
    .find(
      (c) =>
        c.labels?.includes(RUN_PROJECT_LABEL) &&
        ['backlog', 'in_progress', 'needs_input'].includes(c.column),
    );
  if (already) return res.status(200).json(already);

  const card = store.createCard({
    title: 'Run project',
    prompt: runProjectPrompt(dir),
    column: 'in_progress',
    labels: [RUN_PROJECT_LABEL],
    workingDir: dir,
  });
  runner.broadcast();
  runner.tick();
  res.status(201).json(card);
});

/* ---------------------------------- SSE ---------------------------------- */

function sse(res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  return { send, stop: () => clearInterval(ping) };
}

api.get('/stream/board', (req, res) => {
  const { send, stop } = sse(res);
  boardPayload().then(send);
  const onBoard = () => {
    boardPayload().then(send);
  };
  bus.on('board', onBoard);
  req.on('close', () => {
    bus.off('board', onBoard);
    stop();
  });
});

api.get('/stream/cards/:id', (req, res) => {
  const { id } = req.params;
  const { send, stop } = sse(res);
  send({ type: 'snapshot', events: store.readEvents(id) });
  const onEvent = (event) => send(event);
  bus.on(`card:${id}`, onEvent);
  req.on('close', () => {
    bus.off(`card:${id}`, onEvent);
    stop();
  });
});

app.use('/api', api);

/* ------------------------------ static build ----------------------------- */

const webDist = path.join(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

/* --------------------------------- boot ---------------------------------- */

runner.recover();
runner.tick();

// Dropped next to the board data so `npm run status` (server/src/status.js)
// can tell whether a server is running and where, without a console to read.
const RUN_FILE = path.join(store.paths.DATA_DIR, 'run.json');

function writeRunFile() {
  const info = {
    pid: process.pid,
    port: PORT,
    url: `http://localhost:${PORT}`,
    startedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(RUN_FILE, JSON.stringify(info, null, 2));
  } catch (err) {
    console.error('[run-file] failed to write:', err);
  }
}

function clearRunFile() {
  try {
    fs.rmSync(RUN_FILE, { force: true });
  } catch {
    // best-effort
  }
}

app.listen(PORT, () => {
  console.log(`kanban-agents server  http://localhost:${PORT}`);
  console.log(`data                  ${store.paths.DATA_DIR}`);
  console.log(`default working dir   ${store.getSettings().workingDir}`);
  writeRunFile();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    store.flush();
    clearRunFile();
    process.exit(0);
  });
}
