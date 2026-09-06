import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canMoveRunProjectCard,
  createRunProjectPrompt,
  isFreshSuccessfulRun,
  isRunProjectCard,
  runProjectCompletionColumn,
  runProjectPinnedIndex,
  sortRunProjectCardFirst,
} from '../src/runProjectCard.js';

test('recognizes new and legacy Run project cards', () => {
  assert.equal(isRunProjectCard({ kind: 'run_project' }), true);
  assert.equal(
    isRunProjectCard({ title: 'Run project', labels: ['run-project'] }),
    true,
  );
  assert.equal(isRunProjectCard({ title: 'Run project', labels: [] }), false);
  assert.equal(
    isRunProjectCard({ kind: 'task', title: 'Run project', labels: ['run-project'] }),
    false,
  );
});

test('Run project cards only move between In Progress and Done', () => {
  assert.equal(canMoveRunProjectCard('backlog'), false);
  assert.equal(canMoveRunProjectCard('in_progress'), true);
  assert.equal(canMoveRunProjectCard('review'), false);
  assert.equal(canMoveRunProjectCard('needs_input'), false);
  assert.equal(canMoveRunProjectCard('done'), true);
  assert.equal(canMoveRunProjectCard('cancelled'), false);
});

test('Run project completion ignores the ordinary task review destination', () => {
  assert.equal(runProjectCompletionColumn({ kind: 'run_project' }, 'review'), 'done');
  assert.equal(runProjectCompletionColumn({ kind: 'task' }, 'review'), 'review');
});

test('a fresh healthy run record can complete a stuck Run project stream', () => {
  const card = { kind: 'run_project' };
  const startedAt = Date.parse('2026-09-06T01:00:00.000Z');

  assert.equal(
    isFreshSuccessfulRun(
      card,
      { running: true, startedAt: '2026-09-06T01:00:01.000Z' },
      startedAt,
    ),
    true,
  );
  assert.equal(
    isFreshSuccessfulRun(
      card,
      { running: true, startedAt: '2026-09-06T00:59:59.000Z' },
      startedAt,
    ),
    false,
  );
  assert.equal(
    isFreshSuccessfulRun(card, { running: false, startedAt: '2026-09-06T01:00:01.000Z' }, startedAt),
    false,
  );
  assert.equal(
    isFreshSuccessfulRun(
      { kind: 'task' },
      { running: true, startedAt: '2026-09-06T01:00:01.000Z' },
      startedAt,
    ),
    false,
  );
});

test('Run project prompt covers first build, stopped start, and live restart', () => {
  const prompt = createRunProjectPrompt('C:\\work\\app', 'C:\\data\\app.json');

  assert.match(prompt, /no valid run-status file[\s\S]*build command first/i);
  assert.match(prompt, /URL is not answering[\s\S]*start the\s+project again/i);
  assert.match(prompt, /URL is currently answering[\s\S]*stop[\s\S]*fresh process/i);
  assert.match(prompt, /"pid":<server pid>/);
  assert.match(prompt, /"builtAt":/);
});

test('Run project stays first without changing the order of ordinary tasks', () => {
  const taskA = { id: 'a', kind: 'task', order: 0 };
  const taskB = { id: 'b', kind: 'task', order: 1 };
  const runProject = { id: 'run', kind: 'run_project', order: 2 };

  assert.deepEqual(
    sortRunProjectCardFirst([taskA, taskB, runProject]).map((card) => card.id),
    ['run', 'a', 'b'],
  );
});

test('drop positions cannot place an ordinary task above Run project', () => {
  const runProject = { id: 'run', kind: 'run_project', order: 0 };
  const task = { id: 'task', kind: 'task', order: 1 };

  assert.equal(runProjectPinnedIndex(task, [runProject], 0), 1);
  assert.equal(runProjectPinnedIndex(task, [runProject], 1), 1);
  assert.equal(runProjectPinnedIndex(runProject, [task], 1), 0);
});
