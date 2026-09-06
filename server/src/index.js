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
import {
  RUN_PROJECT_KIND,
  RUN_PROJECT_LABEL,
  canMoveRunProjectCard,
  createRunProjectPrompt,
  isRunProjectCard,
} from './runProjectCard.js';

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
    runningCardId: runner.runningCardId(settings.workingDir),
    auth: checkAuth(settings.agent),
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
  if (body.kind === RUN_PROJECT_KIND) {
    return res.status(400).json({ error: 'Run project cards are created by the project runner.' });
  }
  if (body.column === 'needs_input') {
    return res.status(400).json({ error: 'Needs Input is reserved for agent requests' });
  }
  const card = store.createCard(body);
  runner.broadcast();
  runner.tick();
  res.status(201).json(card);

  // No explicit title from the client: derive one from the task description
  // in the background and push the update once it lands.
  const hadExplicitTitle = Boolean((body.title ?? '').trim());
  if (!hadExplicitTitle && card.prompt?.trim()) {
    const settings = store.getSettings();
    generateTitle(card.prompt, {
      agent: settings.agent,
      model: settings.model,
      cwd: card.projectDir,
    })
      .then((title) => {
        if (!title || !store.getCard(card.id)) return;
        store.updateCard(card.id, { title });
        runner.broadcast();
      })
      .catch((err) => console.error('[titler] failed to update card title:', err));
  }
});

api.patch('/cards/:id', (req, res) => {
  if (req.body?.column === 'needs_input') {
    return res.status(400).json({ error: 'Needs Input is reserved for agent requests' });
  }
  const before = store.getCard(req.params.id);
  if (!before) return res.status(404).json({ error: 'not found' });
  if (before.runState === 'reverting') {
    return res.status(409).json({ error: 'Wait for this card\'s changes to finish reverting' });
  }
  const patch = { ...(req.body ?? {}) };
  // Card identity is assigned by the server and cannot be promoted through
  // the generic task endpoint (which would bypass singleton enforcement).
  delete patch.kind;
  if (isRunProjectCard(before)) {
    if (patch.column && !canMoveRunProjectCard(patch.column)) {
      return res.status(400).json({
        error: 'Run project can only be placed in In Progress or Done.',
      });
    }
    // This is a board control, not an editable task. Its prompt is internal.
    delete patch.title;
    delete patch.prompt;
    delete patch.labels;
    delete patch.workingDir;
    delete patch.column;
  }
  const card = store.updateCard(req.params.id, patch);
  runner.broadcast();
  res.json(card);
});

api.delete('/cards/:id', async (req, res) => {
  if (store.getCard(req.params.id)?.runState === 'reverting') {
    return res.status(409).json({ error: 'Wait for this card\'s changes to finish reverting' });
  }
  await runner.cancelIfRunning(req.params.id);
  await git.releaseSessionSnapshot(store.getCard(req.params.id)?.changeSnapshot);
  const ok = store.deleteCard(req.params.id);
  runner.broadcast();
  runner.tick();
  res.json({ ok });
});

api.post('/cards/:id/move', async (req, res) => {
  const { column, index } = req.body ?? {};
  const before = store.getCard(req.params.id);
  if (!before) return res.status(404).json({ error: 'not found' });
  if (isRunProjectCard(before) && runner.currentForProject(before.projectDir)) {
    return res.status(409).json({ error: 'Stop the running task before moving Run project' });
  }
  if (before.runState === 'running' || runner.currentForCard(before.id)) {
    return res.status(409).json({ error: 'Stop the running card before moving it' });
  }
  if (before.runState === 'reverting') {
    return res.status(409).json({ error: 'Wait for this card\'s changes to finish reverting' });
  }
  if (column === 'needs_input') {
    return res.status(400).json({ error: 'Needs Input is reserved for agent requests' });
  }
  if (!store.COLUMN_IDS.includes(column)) {
    return res.status(400).json({ error: 'bad column' });
  }
  if (isRunProjectCard(before) && !canMoveRunProjectCard(column)) {
    return res.status(400).json({
      error: 'Run project can only be placed in In Progress or Done.',
    });
  }

  // A waiting card may still own the live session. Moving it out of the queue
  // must finish aborting before its filesystem snapshot can be safely reverted.
  if (column !== 'in_progress') {
    await runner.cancelIfRunning(req.params.id);
  }

  // Re-entering the queue means rerun the project from the beginning, never
  // resume the old agent conversation. Reordering within the queue is not a rerun.
  if (isRunProjectCard(before) && column === 'in_progress' && before.column !== column) {
    await git.releaseSessionSnapshot(before.changeSnapshot);
    store.clearEvents(before.id);
    store.updateCard(before.id, {
      prompt: runProjectPrompt(before.projectDir),
      sessionId: null,
      sessionAgent: null,
      sessionModel: null,
      runState: 'idle',
      error: null,
      stats: null,
      lastResult: null,
      diffStat: null,
      changeSnapshot: null,
      changesRevertedAt: null,
      gitBefore: null,
      gitAfter: null,
      startedAt: null,
      finishedAt: null,
      pendingPermission: null,
      pendingReply: null,
      unread: false,
    });
  }

  let card = null;
  if (column === 'cancelled' && before.column !== 'cancelled') {
    const current = store.getCard(req.params.id);
    if (current.changeSnapshot) {
      const previous = {
        column: current.column,
        order: current.order,
        runState: current.runState,
        error: current.error,
      };
      const restorePreviousState = () => {
        store.moveCard(current.id, previous.column, previous.order);
        store.updateCard(current.id, { runState: previous.runState, error: previous.error });
        runner.broadcast();
      };
      card = store.moveCard(current.id, column, index);
      store.updateCard(current.id, { runState: 'reverting', error: null });
      runner.broadcast();

      let reverted;
      try {
        reverted = await git.revertSessionChanges(current.changeSnapshot);
      } catch (err) {
        restorePreviousState();
        return res.status(500).json({
          error: `Could not revert this session's changes: ${err?.message || String(err)}`,
        });
      }
      if (!reverted.ok) {
        restorePreviousState();
        return res.status(409).json({ error: reverted.error });
      }
      store.updateCard(current.id, {
        runState: 'stopped',
        changeSnapshot: null,
        changesRevertedAt: new Date().toISOString(),
        gitAfter: await git.snapshot(current.projectDir),
        diffStat: null,
      });
      runner.record(current.id, {
        type: 'status',
        level: 'warn',
        text: reverted.changed
          ? 'Moved to Cancelled — all changes from this session were reverted.'
          : 'Moved to Cancelled — this session made no filesystem changes.',
      });
    } else if ((current.runCount ?? 0) > 0 && !current.changesRevertedAt) {
      runner.broadcast();
      return res.status(409).json({
        error:
          'This older session has no rollback snapshot, so it cannot be cancelled without risking unrelated work.',
      });
    }
  }

  card ??= store.moveCard(req.params.id, column, index);
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
  if (store.getCard(req.params.id)?.runState === 'reverting') {
    return res.status(409).json({ error: 'Wait for this card\'s changes to finish reverting' });
  }
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
  if (store.getCard(req.params.id)?.runState === 'reverting') {
    return res.status(409).json({ error: 'Wait for this card\'s changes to finish reverting' });
  }
  await runner.cancelIfRunning(req.params.id);
  await git.releaseSessionSnapshot(store.getCard(req.params.id)?.changeSnapshot);
  store.clearEvents(req.params.id);
  const card = store.updateCard(req.params.id, {
    sessionId: null,
    sessionAgent: null,
    sessionModel: null,
    agent: null,
    model: null,
    runState: 'idle',
    error: null,
    stats: null,
    lastResult: null,
    diffStat: null,
    changeSnapshot: null,
    changesRevertedAt: null,
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

function runProjectPrompt(dir) {
  return createRunProjectPrompt(dir, projectRun.statusFilePath(dir));
}

/** Kicks off a card that builds/starts whatever project lives in `dir` and reports its URL back. */
api.post('/projects/run', async (req, res) => {
  const settings = store.getSettings();
  const dir = store.resolveDir(req.body?.dir || settings.workingDir);

  // This is a singleton project control, including after it has completed.
  const already = store
    .listCards({ project: dir })
    .find(isRunProjectCard);
  if (already) {
    // Repeated clicks while this control is already queued/running are
    // idempotent. A completed control, however, starts a fresh agent session
    // so it can restart a live server or bring a stopped one back up.
    if (runner.currentForCard(already.id) || already.column === 'in_progress') {
      return res.status(200).json(already);
    }

    await git.releaseSessionSnapshot(already.changeSnapshot);
    store.clearEvents(already.id);
    store.updateCard(already.id, {
      prompt: runProjectPrompt(dir),
      sessionId: null,
      sessionAgent: null,
      sessionModel: null,
      runState: 'idle',
      error: null,
      stats: null,
      lastResult: null,
      diffStat: null,
      changeSnapshot: null,
      changesRevertedAt: null,
      gitBefore: null,
      gitAfter: null,
      startedAt: null,
      finishedAt: null,
      pendingPermission: null,
      pendingReply: null,
      unread: false,
    });
    const card = store.moveCard(already.id, 'in_progress', 0);
    runner.broadcast();
    runner.tick();
    return res.status(200).json(card);
  }

  const card = store.createCard({
    kind: RUN_PROJECT_KIND,
    title: 'Run project',
    prompt: runProjectPrompt(dir),
    column: 'in_progress',
    labels: [RUN_PROJECT_LABEL],
    workingDir: dir,
  });
  store.moveCard(card.id, card.column, 0);
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

await runner.recover();
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
