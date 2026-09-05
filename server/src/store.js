import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

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

const DEFAULT_SETTINGS = {
  workingDir: process.env.KANBAN_WORKDIR || os.homedir(),
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
  return { cards: {}, settings: { ...DEFAULT_SETTINGS }, version: 1 };
}

function load() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      cards: parsed.cards ?? {},
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
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
  db.settings = { ...db.settings, ...patch };
  persist();
  return getSettings();
}

/* --------------------------------- cards --------------------------------- */

export function listCards() {
  return Object.values(db.cards).sort((a, b) => a.order - b.order);
}

export function getCard(id) {
  return db.cards[id] ?? null;
}

function nextOrder(column) {
  const inColumn = listCards().filter((c) => c.column === column);
  return inColumn.length ? Math.max(...inColumn.map((c) => c.order)) + 1 : 0;
}

export function createCard(input = {}) {
  const now = new Date().toISOString();
  const column = COLUMN_IDS.includes(input.column) ? input.column : 'backlog';
  const card = {
    id: randomUUID(),
    title: (input.title ?? '').trim() || 'Untitled task',
    prompt: input.prompt ?? '',
    column,
    order: nextOrder(column),
    labels: Array.isArray(input.labels) ? input.labels : [],
    // per-card overrides; null means "inherit from settings"
    model: input.model ?? null,
    permissionMode: input.permissionMode ?? null,
    effort: input.effort ?? null,
    workingDir: input.workingDir ?? null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    // runtime
    runState: 'idle', // idle | queued | running | waiting | finished | error | stopped
    sessionId: null,
    lastResult: null,
    error: null,
    pendingPermission: null,
    stats: null,
    gitBefore: null,
    gitAfter: null,
    diffStat: null,
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
  card.column = column;
  card.updatedAt = new Date().toISOString();

  const siblings = listCards().filter((c) => c.column === column && c.id !== id);
  const at = Math.max(0, Math.min(index ?? siblings.length, siblings.length));
  siblings.splice(at, 0, card);
  siblings.forEach((c, i) => {
    c.order = i;
  });
  if (from !== column) {
    listCards()
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
