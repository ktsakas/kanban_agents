import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const playwrightUrl = pathToFileURL(
  path.join(os.tmpdir(), 'kanban-video-tool', 'node_modules', 'playwright-core', 'index.mjs'),
).href;
const { chromium } = await import(playwrightUrl);

const outDir = path.resolve('demo', 'frames');
await fs.mkdir(outDir, { recursive: true });

const columns = [
  { id: 'not_started', title: 'Not Started' },
  { id: 'in_progress', title: 'In Progress' },
  { id: 'needs_input', title: 'Needs Input' },
  { id: 'review', title: 'Review' },
  { id: 'done', title: 'Done' },
  { id: 'cancelled', title: 'Cancelled' },
];

const now = new Date().toISOString();
const card = (id, title, prompt, column, extra = {}) => ({
  id,
  kind: 'task',
  title,
  prompt,
  column,
  order: 0,
  labels: [],
  model: null,
  permissionMode: null,
  effort: null,
  workingDir: null,
  projectDir: 'C:\\Projects\\acme-dashboard',
  createdAt: now,
  updatedAt: now,
  startedAt: null,
  finishedAt: null,
  runState: 'idle',
  sessionId: null,
  sessionAgent: null,
  sessionModel: null,
  lastResult: null,
  error: null,
  pendingPermission: null,
  stats: null,
  runCount: 0,
  unread: false,
  ...extra,
});

let board = {
  columns,
  settings: {
    workingDir: 'C:\\Projects\\acme-dashboard',
    agent: 'codex',
    model: 'gpt-5.6-sol',
    permissionMode: 'acceptEdits',
    effort: 'medium',
    autoAdvanceTo: 'review',
    pauseOnNeedsInput: true,
    queuePaused: false,
    maxTurns: 0,
    appendSystemPrompt: 'Run tests before finishing.',
  },
  projects: [{ dir: 'C:\\Projects\\acme-dashboard', count: 8 }],
  auth: { ok: true },
  projectRun: { running: true, url: 'http://localhost:5173', command: 'npm run dev' },
  runningCardId: 'filters',
  cards: [
    card('export', 'Add CSV export', 'Add CSV export to the reports page.', 'not_started', { labels: ['feature'] }),
    card('empty', 'Polish empty states', 'Improve the empty states across the dashboard.', 'not_started', { labels: ['design'] }),
    card('filters', 'Improve dashboard filters', 'Add saved filters and date presets.', 'in_progress', {
      runState: 'running', startedAt: now, sessionId: 'session-running', sessionAgent: 'codex', sessionModel: 'gpt-5.6-sol', labels: ['feature'],
    }),
    card('shortcuts', 'Add keyboard shortcuts', 'Add shortcuts for common navigation actions.', 'in_progress', { runState: 'queued', labels: ['ux'] }),
    card('database', 'Connect staging database', 'Wire the preview environment to staging.', 'needs_input', {
      runState: 'waiting', sessionId: 'session-waiting', sessionAgent: 'codex', sessionModel: 'gpt-5.6-sol',
      pendingPermission: { requestId: 'permission-1', toolName: 'Bash', title: 'Run the database migration', description: 'The agent is ready, but needs your approval before changing the staging schema.', input: { command: 'npm run migrate:staging' } },
    }),
    card('invites', 'Add team invitations', 'Build the invite flow with role selection.', 'review', {
      runState: 'finished', finishedAt: now, sessionId: 'session-review', sessionAgent: 'codex', sessionModel: 'gpt-5.6-sol', stats: { durationMs: 78000, numTurns: 7, costUsd: 0.18 },
    }),
    card('analytics', 'Launch analytics dashboard', 'Create the analytics overview with responsive charts.', 'done', {
      runState: 'finished', finishedAt: now, sessionId: 'session-analytics', sessionAgent: 'codex', sessionModel: 'gpt-5.6-sol', stats: { durationMs: 94000, numTurns: 9, costUsd: 0.24 },
      lastResult: 'Implemented the analytics dashboard with responsive charts, date filtering, and accessible loading states. All tests pass.',
      gitBefore: { head: '2a4f81c9', branch: 'main' }, gitAfter: { head: '78c193af', branch: 'main' },
      diffStat: 'src/pages/Analytics.tsx  | 148 +++++++++++++++++++++\nsrc/components/Chart.tsx |  64 +++++++++\nsrc/styles/dashboard.css |  31 +++++\n3 files changed, 243 insertions(+)',
    }),
    card('palette', 'Try alternate color palette', 'Explore a brighter visual theme.', 'cancelled', { runState: 'stopped' }),
  ],
};

const events = {
  database: [
    { type: 'user_prompt', text: 'Wire the preview environment to staging.' },
    { type: 'thinking', text: 'I will inspect the migration configuration and verify the target environment.' },
    { type: 'tool_use', id: 'tool-db', name: 'Read', input: { file_path: 'config/database.ts' } },
    { type: 'tool_result', toolUseId: 'tool-db', text: 'Configuration loaded.', isError: false },
    { type: 'permission_request', kind: 'permission', title: 'Run the database migration' },
  ],
  analytics: [
    { type: 'user_prompt', text: 'Create the analytics overview with responsive charts.' },
    { type: 'thinking', text: 'I will inspect the existing design system, build the page, then run the test suite.' },
    { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/components' } },
    { type: 'tool_result', toolUseId: 'tool-1', text: 'Found the shared card and chart primitives.', isError: false },
    { type: 'tool_use', id: 'tool-2', name: 'Edit', input: { file_path: 'src/pages/Analytics.tsx' } },
    { type: 'tool_result', toolUseId: 'tool-2', text: 'Updated analytics page.', isError: false },
    { type: 'text', text: 'The analytics dashboard is complete. It includes responsive charts, date filtering, and accessible loading states. All tests pass.' },
    { type: 'result', isError: false, durationMs: 94000, numTurns: 9, costUsd: 0.24 },
  ],
};

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: ['--hide-scrollbars', '--force-device-scale-factor=1'],
});
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: 'light' });
const page = await context.newPage();

await page.addInitScript(({ initialBoard, eventMap }) => {
  window.__demoBoard = initialBoard;
  window.__demoEventMap = eventMap;
  window.__demoSources = [];
  class DemoEventSource {
    constructor(url) {
      this.url = String(url);
      this.readyState = 1;
      window.__demoSources.push(this);
      setTimeout(() => {
        this.onopen?.({});
        if (this.url.includes('/stream/board')) {
          this.onmessage?.({ data: JSON.stringify(window.__demoBoard) });
        } else {
          const id = this.url.split('/').pop();
          this.onmessage?.({ data: JSON.stringify({ type: 'snapshot', events: window.__demoEventMap[id] || [] }) });
        }
      }, 40);
    }
    close() { this.readyState = 2; }
  }
  window.EventSource = DemoEventSource;
  window.__demoPushBoard = (next) => {
    window.__demoBoard = next;
    for (const source of window.__demoSources) {
      if (source.readyState === 1 && source.url.includes('/stream/board')) {
        source.onmessage?.({ data: JSON.stringify(next) });
      }
    }
  };
}, { initialBoard: board, eventMap: events });

await page.route('**/api/**', async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const pathname = url.pathname;
  if (pathname === '/api/board') return route.fulfill({ json: board });
  if (pathname === '/api/cards' && req.method() === 'POST') {
    const body = req.postDataJSON();
    const created = card('new-task', 'Add CSV export to reports', body.prompt, body.column, { labels: ['new'] });
    board = { ...board, cards: [...board.cards, created] };
    return route.fulfill({ json: created });
  }
  if (pathname.includes('/events')) return route.fulfill({ json: [] });
  return route.fulfill({ json: {} });
});

await page.goto('http://localhost:4317', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.board');
await page.addStyleTag({ content: `
  * { cursor: none !important; }
  .demo-caption { position: fixed; left: 50%; bottom: 42px; transform: translateX(-50%); z-index: 9999;
    width: min(820px, calc(100vw - 80px)); padding: 18px 24px; border-radius: 18px;
    color: white; background: rgba(18, 24, 39, .93); box-shadow: 0 18px 50px rgba(0,0,0,.28);
    font-family: Inter, ui-sans-serif, system-ui, sans-serif; text-align: left; backdrop-filter: blur(14px); }
  .demo-caption .eyebrow { color: #7dd3fc; text-transform: uppercase; letter-spacing: .16em; font-size: 12px; font-weight: 800; }
  .demo-caption .headline { font-size: 25px; line-height: 1.2; font-weight: 760; margin-top: 5px; }
  .demo-caption .sub { color: #d7deea; font-size: 15px; margin-top: 6px; }
  .demo-title { bottom: auto; top: 50%; transform: translate(-50%, -50%); text-align: center; width: 760px; padding: 34px; }
  .demo-title .headline { font-size: 42px; }
  .demo-title .sub { font-size: 19px; }
  .demo-cursor { position: fixed; z-index: 10000; width: 24px; height: 24px; border: 4px solid white; border-radius: 50%;
    background: #2563eb; box-shadow: 0 4px 18px rgba(0,0,0,.4); transform: translate(-50%,-50%); pointer-events:none; }
` });

async function caption(eyebrow, headline, sub, title = false) {
  await page.locator('.demo-caption').evaluateAll((nodes) => nodes.forEach((n) => n.remove())).catch(() => {});
  await page.evaluate(({ eyebrow, headline, sub, title }) => {
    const el = document.createElement('div');
    el.className = `demo-caption${title ? ' demo-title' : ''}`;
    el.innerHTML = `<div class="eyebrow"></div><div class="headline"></div><div class="sub"></div>`;
    el.querySelector('.eyebrow').textContent = eyebrow;
    el.querySelector('.headline').textContent = headline;
    el.querySelector('.sub').textContent = sub;
    document.body.appendChild(el);
  }, { eyebrow, headline, sub, title });
}

async function cursorOn(selector) {
  await page.locator('.demo-cursor').evaluateAll((nodes) => nodes.forEach((n) => n.remove())).catch(() => {});
  const box = await page.locator(selector).first().boundingBox();
  if (!box) return;
  await page.evaluate(({ x, y }) => {
    const el = document.createElement('div');
    el.className = 'demo-cursor';
    el.style.left = `${x}px`; el.style.top = `${y}px`;
    document.body.appendChild(el);
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
}

async function snap(name) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
}

await caption('Kanban Agents', 'A visual command center for coding agents', 'Plan work, run sessions, handle approvals, and review every change — from one board.', true);
await snap('01-intro');

await page.locator('.demo-caption').evaluate((n) => n.remove());
await page.locator('[data-col="not_started"] .icon-btn').click();
await page.locator('[data-col="not_started"] textarea').fill('Add CSV export to the reports page');
await cursorOn('[data-col="not_started"] .mic-btn');
await caption('Capture', 'Add a task in seconds', 'Type a prompt or dictate it by voice. The card title can be generated automatically.');
await snap('02-capture');

await page.locator('[data-col="not_started"] .btn-primary').click();
await page.evaluate((next) => window.__demoPushBoard(next), board);
await page.waitForTimeout(100);
await cursorOn('[data-col="in_progress"] .card.is-running');
await caption('Queue', 'Move cards into In Progress to run them', 'Tasks execute sequentially per project, while the board shows what is running and what is next.');
await snap('03-queue');

await page.locator('.demo-caption').evaluate((n) => n.remove());
await page.locator('.demo-cursor').evaluateAll((nodes) => nodes.forEach((n) => n.remove()));
await page.getByText('Connect staging database', { exact: true }).click();
await page.waitForTimeout(120);
await cursorOn('.permission-actions .btn-primary');
await caption('Stay in control', 'Approvals pause exactly where your input is needed', 'Allow, deny, or dictate a response — then the same agent session continues.');
await snap('04-approval');

await page.locator('.drawer .icon-btn[title="Close"]').click();
await page.getByText('Launch analytics dashboard', { exact: true }).click();
await page.waitForTimeout(120);
await cursorOn('.tabs .tab:nth-child(1)');
await caption('Observe', 'Follow the live session, not just the final answer', 'Prompts, reasoning summaries, tool calls, and results stay together in the card transcript.');
await snap('05-session');

await page.locator('.tabs .tab').filter({ hasText: 'changes' }).click();
await cursorOn('.tabs .tab.is-active');
await caption('Review', 'See the outcome and the exact code footprint', 'Each completed card records its summary, git state, and diff statistics.');
await snap('06-changes');

await page.locator('.drawer .icon-btn[title="Close"]').click();
await page.getByRole('button', { name: 'Settings' }).click();
await cursorOn('.modal .btn-primary');
await caption('Configure once', 'Choose the agent, model, permissions, and effort', 'Board-wide defaults keep every queued session consistent.');
await snap('07-settings');

await page.locator('.modal-head .icon-btn').click();
await page.locator('.topbar .icon-btn').click();
await cursorOn('.btn-run');
await caption('Ship', 'Run the project, review the queue, and keep moving', 'Long waits are out of the story — only the decisions and results remain.');
await snap('08-outro');

await browser.close();
console.log(`Created demo frames in ${outDir}`);
