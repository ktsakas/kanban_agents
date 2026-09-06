import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  runProjectPinnedIndex,
  sortRunProjectCardFirst,
} from './runProjectCard.js';

const DATA_DIR = process.env.KANBAN_DATA_DIR
  ? path.resolve(process.env.KANBAN_DATA_DIR)
  : path.join(os.homedir(), '.kanban-agents');

const DB_FILE = path.join(DATA_DIR, 'board.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');

fs.mkdirSync(LOG_DIR, { recursive: true });

export const COLUMNS = [
  { id: 'backlog', title: 'Not Started', accent: '#8b93a7' },
  { id: 'in_progress', title: 'In Progress', accent: '#3b82f6' },
  { id: 'needs_input', title: 'Needs Input', accent: '#f59e0b' },
  { id: 'review', title: 'Review', accent: '#a855f7' },
  { id: 'done', title: 'Done', accent: '#22c55e' },
  { id: 'cancelled', title: 'Cancelled', accent: '#64748b' },
];

export const COLUMN_IDS = COLUMNS.map((c) => c.id);
export const USER_COLUMN_IDS = COLUMN_IDS.filter((id) => id !== 'needs_input');

/** Canonical form of a working directory, so cards and settings compare equal. */
export function resolveDir(dir) {
  return path.resolve(dir || os.homedir());
}

const DEFAULT_SETTINGS = {
  workingDir: resolveDir(process.env.KANBAN_WORKDIR),
  agent: 'claude',
  model: 'claude-sonnet-5',
  permissionMode: 'acceptEdits',
  effort: 'high',
  // Where a card lands when its session finishes successfully.
  autoAdvanceTo: 'review',
  // Hold the queue while any card sits in Needs Input, so sessions never
  // overlap on a half-finished working tree.
  pauseOnNeedsInput: true,
  queuePaused: false,
  maxTurns: 0,
  appendSystemPrompt: '',
};

function emptyDb() {
  return { cards: {}, settings: { ...DEFAULT_SETTINGS }, version: 3 };
}

/**
 * Recover the durable rollback marker written by builds that logged a
 * successful undo but did not yet persist that fact on the card itself.
 * A later user prompt means the session ran again, so the old marker no
 * longer applies.
 */
function revertedAtFromLog(cardId) {
  try {
    const lines = fs.readFileSync(logPath(cardId), 'utf8').split('\n').filter(Boolean);
    let revertedAt = null;
    for (const line of lines) {
      const event = JSON.parse(line);
      if (event.type === 'user_prompt') revertedAt = null;
      if (
        event.type === 'status' &&
        event.level === 'warn' &&
        /^Moved to Cancelled .+ session (?:were reverted|made no filesystem changes)\.$/.test(
          event.text ?? '',
        )
      ) {
        revertedAt = event.ts ?? new Date(0).toISOString();
      }
    }
    return revertedAt;
  } catch {
    return null;
  }
}

function load() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const settings = { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) };
    // Version 1 of multi-agent support forced Terra as Codex's default. Model
    // access varies by account/client, so migrate that generated value back
    // to "use Codex's configured/recommended default". Explicit selections
    // made after this migration are retained because the DB is now version 2.
    if ((parsed.version ?? 1) < 2 && settings.agent === 'codex' && settings.model === 'gpt-5.6-terra') {
      settings.model = '';
    }
    settings.workingDir = resolveDir(settings.workingDir);
    const cards = parsed.cards ?? {};
    // Migrate cards written before per-project boards existed: pin them to
    // whichever project they were actually running in, permanently, so they
    // don't drift the next time the board default is switched.
    for (const card of Object.values(cards)) {
      if (!card.projectDir) card.projectDir = resolveDir(card.workingDir || settings.workingDir);
      const legacyCodexModelMismatch =
        (parsed.version ?? 1) < 2 &&
        settings.agent === 'codex' &&
        /selected model \(gpt-|Claude Code returned.*selected model \(gpt-/i.test(card.error ?? '');

      if (legacyCodexModelMismatch) {
        // The new settings UI was briefly able to talk to an old Claude-only
        // server. That server created a Claude session while passing it a GPT
        // model. The session cannot be resumed by Codex, so retry it cleanly.
        card.sessionId = null;
        card.sessionAgent = null;
        card.sessionModel = null;
        card.model = null;
      } else {
        // Sessions created before multi-agent support are Claude sessions. Pin
        // their backend and model so a later board-level agent switch cannot
        // try to resume the session with an incompatible runner.
        if (card.sessionId && !card.sessionAgent) card.sessionAgent = 'claude';
        if (card.sessionId && !card.sessionModel) {
          card.sessionModel = card.model || 'claude-sonnet-5';
        }
      }
      if ((parsed.version ?? 1) < 2 && card.sessionAgent === 'codex') {
        if (card.sessionModel === 'gpt-5.6-terra') card.sessionModel = null;
        if (card.model === 'gpt-5.6-terra') card.model = null;
      }
      if (!('changesRevertedAt' in card)) {
        card.changesRevertedAt = revertedAtFromLog(card.id);
      }
    }
    // Older data may have the project control below ordinary tasks. Repair
    // every affected column on load so display order and queue order agree.
    const groups = new Map();
    for (const card of Object.values(cards)) {
      const key = `${card.projectDir}\0${card.column}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(card);
    }
    for (const group of groups.values()) {
      sortRunProjectCardFirst(group).forEach((card, index) => {
        card.order = index;
      });
    }
    return {
      version: 3,
      cards,
      settings,
    };
  } catch {
    return emptyDb();
  }
}

let db = load();

let writeTimer = null;
function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const tmp = `${DB_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 50);
}

export function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ------------------------------- settings -------------------------------- */

export function getSettings() {
  return { ...db.settings };
}

export function updateSettings(patch) {
  const clean = 'workingDir' in patch ? { ...patch, workingDir: resolveDir(patch.workingDir) } : { ...patch };
  if ('agent' in clean && !['claude', 'codex'].includes(clean.agent)) delete clean.agent;
  if (clean.agent === 'codex' && !('model' in clean)) clean.model = '';
  db.settings = { ...db.settings, ...clean };
  persist();
  return getSettings();
}

/* --------------------------------- cards --------------------------------- */

/**
 * All cards, or just the ones belonging to a project (working directory).
 * The board is scoped to one project at a time - switching the board's
 * working directory switches which cards are visible, the same way switching
 * branches switches which files you see.
 */
export function listCards({ project } = {}) {
  const all = Object.values(db.cards).sort((a, b) => a.order - b.order);
  if (!project) return all;
  const target = resolveDir(project);
  return all.filter((c) => (c.projectDir ?? resolveDir(db.settings.workingDir)) === target);
}

export function getCard(id) {
  return db.cards[id] ?? null;
}

/** Distinct projects (working directories) any card has ever run in, most recently touched first. */
export function listProjects() {
  const byDir = new Map();
  for (const card of Object.values(db.cards)) {
    const dir = card.projectDir ?? resolveDir(db.settings.workingDir);
    const prev = byDir.get(dir);
    const touched = card.updatedAt ?? card.createdAt;
    if (!prev || touched > prev.lastActivity) {
      byDir.set(dir, { dir, lastActivity: touched, count: (prev?.count ?? 0) + 1 });
    } else {
      prev.count += 1;
    }
  }
  const current = resolveDir(db.settings.workingDir);
  if (!byDir.has(current)) byDir.set(current, { dir: current, lastActivity: null, count: 0 });
  return [...byDir.values()].sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
}

function nextOrder(column, project) {
  const inColumn = listCards({ project }).filter((c) => c.column === column);
  return inColumn.length ? Math.max(...inColumn.map((c) => c.order)) + 1 : 0;
}

/** Instant placeholder shown until the AI-generated title lands (or forever, as a fallback if that fails). */
function fallbackTitle(prompt) {
  const text = (prompt ?? '').trim().split('\n')[0].trim();
  if (!text) return 'Untitled task';
  return text.length > 70 ? `${text.slice(0, 70)}...` : text;
}

export function createCard(input = {}) {
  const now = new Date().toISOString();
  const column = USER_COLUMN_IDS.includes(input.column) ? input.column : 'backlog';
  // The project this card belongs to, fixed at creation (or whenever the
  // working-dir override changes) so it doesn't drift if the board default
  // is later switched to a different project.
  const projectDir = resolveDir(input.workingDir || db.settings.workingDir);
  const card = {
    id: randomUUID(),
    kind: input.kind ?? 'task',
    title: (input.title ?? '').trim() || fallbackTitle(input.prompt),
    prompt: input.prompt ?? '',
    column,
    order: nextOrder(column, projectDir),
    labels: Array.isArray(input.labels) ? input.labels : [],
    // per-card overrides; null means "inherit from settings"
    model: input.model ?? null,
    permissionMode: input.permissionMode ?? null,
    effort: input.effort ?? null,
    workingDir: input.workingDir ?? null,
    projectDir,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    // runtime
    runState: 'idle', // idle | queued | running | waiting | reverting | finished | error | stopped
    sessionId: null,
    // The backend/model are pinned when the first turn starts. `agent` is an
    // optional future per-card override; null means use the board setting.
    agent: input.agent ?? null,
    sessionAgent: null,
    sessionModel: null,
    lastResult: null,
    error: null,
    pendingPermission: null,
    stats: null,
    gitBefore: null,
    gitAfter: null,
    diffStat: null,
    // Private Git tree refs bounding everything this agent session changed.
    // They let moving the card to Cancelled undo this session without
    // resetting changes made by other cards.
    changeSnapshot: null,
    // Kept after the private snapshot refs are released so cancelling an
    // already-undone session remains an idempotent card move.
    changesRevertedAt: null,
    runCount: 0,
    unread: false,
  };
  db.cards[card.id] = card;
  persist();
  return card;
}

export function updateCard(id, patch) {
  const card = db.cards[id];
  if (!card) return null;
  Object.assign(card, patch, { updatedAt: new Date().toISOString() });
  // Changing the override (including clearing it back to "inherit") moves
  // the card to whichever project that now resolves to.
  if ('workingDir' in patch) {
    card.projectDir = resolveDir(patch.workingDir || db.settings.workingDir);
  }
  persist();
  return card;
}

export function deleteCard(id) {
  const existed = Boolean(db.cards[id]);
  delete db.cards[id];
  persist();
  try {
    fs.rmSync(logPath(id), { force: true });
  } catch {
    /* best effort */
  }
  return existed;
}

/**
 * Move a card into `column` at position `index`, renumbering that column so the
 * order values stay dense. Order inside `in_progress` is the execution order.
 */
export function moveCard(id, column, index) {
  const card = db.cards[id];
  if (!card || !COLUMN_IDS.includes(column)) return null;
  const from = card.column;
  const project = card.projectDir;
  card.column = column;
  card.updatedAt = new Date().toISOString();

  // Scoped to this card's project: reordering only ever touches cards that
  // actually share its board, so it can't shuffle another project's queue.
  const siblings = sortRunProjectCardFirst(
    listCards({ project }).filter((c) => c.column === column && c.id !== id),
  );
  const at = runProjectPinnedIndex(card, siblings, index);
  siblings.splice(at, 0, card);
  siblings.forEach((c, i) => {
    c.order = i;
  });
  if (from !== column) {
    listCards({ project })
      .filter((c) => c.column === from)
      .forEach((c, i) => {
        c.order = i;
      });
  }
  persist();
  return card;
}

/* ------------------------------- event log -------------------------------- */

export function logPath(cardId) {
  return path.join(LOG_DIR, `${cardId}.jsonl`);
}

export function appendEvent(cardId, event) {
  const record = { ...event, ts: event.ts ?? new Date().toISOString() };
  fs.appendFileSync(logPath(cardId), `${JSON.stringify(record)}\n`);
  return record;
}

export function readEvents(cardId, { limit = 2000 } = {}) {
  try {
    const raw = fs.readFileSync(logPath(cardId), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function clearEvents(cardId) {
  try {
    fs.rmSync(logPath(cardId), { force: true });
  } catch {
    /* best effort */
  }
}

export const paths = { DATA_DIR, DB_FILE, LOG_DIR };
