import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, subscribe } from './api.js';
import CardDetail from './CardDetail.jsx';
import SettingsDialog from './SettingsDialog.jsx';
import MicButton, { appendDictation } from './MicButton.jsx';

const RUN_STATE_LABEL = {
  idle: 'Idle',
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting on you',
  finished: 'Finished',
  error: 'Error',
  stopped: 'Stopped',
};

function relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatCost(usd) {
  if (usd == null) return null;
  return usd < 0.01 ? `<$0.01` : `$${usd.toFixed(2)}`;
}

/* --------------------------------- card ---------------------------------- */

function Card({ card, isRunning, queuePosition, onOpen, onDragStart, onDragEnd, dragging }) {
  const stats = card.stats;
  return (
    <article
      className={`card ${dragging ? 'is-dragging' : ''} ${isRunning ? 'is-running' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.id);
        onDragStart(card.id);
      }}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(card.id)}
    >
      <header className="card-head">
        <span className="card-title">{card.title}</span>
        {card.unread && <span className="dot-unread" title="New activity" />}
      </header>

      {card.prompt && <p className="card-prompt">{card.prompt}</p>}

      <div className="card-meta">
        {isRunning ? (
          <span className="state state-running">Running</span>
        ) : card.pendingPermission ? (
          <span className="state state-waiting">Needs answer</span>
        ) : queuePosition != null ? (
          <span className="state state-queued">Next {queuePosition + 1}</span>
        ) : card.runState !== 'idle' ? (
          <span className={`state state-${card.runState}`}>{RUN_STATE_LABEL[card.runState]}</span>
        ) : null}
        {card.model && <span className="tag tag-model">{card.model.replace('claude-', '')}</span>}
        {card.labels?.map((label) => (
          <span key={label} className="tag">
            {label}
          </span>
        ))}
      </div>

      {(stats || card.finishedAt) && (
        <footer className="card-foot">
          {stats?.numTurns != null && (
            <span>
              {stats.numTurns} turn{stats.numTurns === 1 ? '' : 's'}
            </span>
          )}
          {stats?.costUsd != null && <span>{formatCost(stats.costUsd)}</span>}
          {card.finishedAt && <span>{relativeTime(card.finishedAt)}</span>}
        </footer>
      )}
    </article>
  );
}

/* -------------------------------- column --------------------------------- */

function Column({ column, cards, runningCardId, onOpen, onDrop, drag, setDrag, onQuickAdd }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const listRef = useRef(null);

  const dropIndex = drag.overColumn === column.id ? drag.overIndex : null;

  function computeIndex(event) {
    const nodes = [...(listRef.current?.querySelectorAll('[data-card]') ?? [])];
    for (let i = 0; i < nodes.length; i += 1) {
      const rect = nodes[i].getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) return i;
    }
    return nodes.length;
  }

  return (
    <section
      className="column"
      data-col={column.id}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const index = computeIndex(e);
        if (drag.overColumn !== column.id || drag.overIndex !== index) {
          setDrag((d) => ({ ...d, overColumn: column.id, overIndex: index }));
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData('text/plain') || drag.cardId;
        if (id) onDrop(id, column.id, computeIndex(e));
      }}
    >
      <header className="column-head">
        <h2>{column.title}</h2>
        <span className="column-count">{cards.length}</span>
        <button className="icon-btn" title="Add a task" onClick={() => setAdding((v) => !v)}>
          +
        </button>
      </header>

      {adding && (
        <form
          className="quick-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) onQuickAdd(column.id, draft.trim());
            setDraft('');
            setAdding(false);
          }}
        >
          <div className="textarea-wrap">
            <textarea
              autoFocus
              placeholder="What should Claude do?"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form.requestSubmit();
                if (e.key === 'Escape') setAdding(false);
              }}
            />
            <MicButton title="Dictate task" onText={(chunk) => setDraft((d) => appendDictation(d, chunk))} />
          </div>
          <div className="quick-add-actions">
            <button type="submit" className="btn btn-primary">
              Add
            </button>
            <button type="button" className="btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="column-list" ref={listRef}>
        {cards.map((card, index) => (
          <React.Fragment key={card.id}>
            {dropIndex === index && <div className="drop-line" />}
            <div data-card>
              <Card
                card={card}
                isRunning={card.id === runningCardId}
                queuePosition={
                  column.id === 'in_progress' && card.id !== runningCardId ? index : null
                }
                dragging={drag.cardId === card.id}
                onOpen={onOpen}
                onDragStart={(id) => setDrag({ cardId: id, overColumn: null, overIndex: null })}
                onDragEnd={() => setDrag({ cardId: null, overColumn: null, overIndex: null })}
              />
            </div>
          </React.Fragment>
        ))}
        {dropIndex === cards.length && <div className="drop-line" />}
        {!cards.length && !adding && <p className="column-empty">Nothing here</p>}
      </div>
    </section>
  );
}

/* ---------------------------------- app ---------------------------------- */

export default function App() {
  const [board, setBoard] = useState(null);
  const [openCardId, setOpenCardId] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [search, setSearch] = useState('');
  const [drag, setDrag] = useState({ cardId: null, overColumn: null, overIndex: null });
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') ?? 'light');
  const [connected, setConnected] = useState(true);

  useEffect(
    () => subscribe('/stream/board', setBoard, (status) => setConnected(status === 'open')),
    [],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  const refresh = useCallback(async () => setBoard(await api.board()), []);

  const filtered = useMemo(() => {
    if (!board) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return board.cards;
    return board.cards.filter((c) =>
      `${c.title} ${c.prompt} ${(c.labels ?? []).join(' ')}`.toLowerCase().includes(needle),
    );
  }, [board, search]);

  const byColumn = useMemo(() => {
    const map = Object.fromEntries((board?.columns ?? []).map((c) => [c.id, []]));
    for (const card of filtered) map[card.column]?.push(card);
    for (const list of Object.values(map)) list.sort((a, b) => a.order - b.order);
    return map;
  }, [board, filtered]);

  const handleDrop = useCallback(
    async (id, column, index) => {
      setDrag({ cardId: null, overColumn: null, overIndex: null });
      // Optimistic: the SSE board push will reconcile.
      setBoard((prev) =>
        prev
          ? { ...prev, cards: prev.cards.map((c) => (c.id === id ? { ...c, column } : c)) }
          : prev,
      );
      await api.moveCard(id, column, index);
    },
    [],
  );

  const quickAdd = useCallback(async (column, prompt) => {
    // No title: the server generates one from the task description and
    // pushes the update over SSE once it's ready.
    await api.createCard({ prompt, column });
  }, []);

  const switchProject = useCallback(async (dir) => {
    if (!dir || dir === board?.settings?.workingDir) return;
    await api.updateSettings({ workingDir: dir });
  }, [board]);

  const [starting, setStarting] = useState(false);
  const runProject = useCallback(async () => {
    setStarting(true);
    try {
      const card = await api.runProject(board.settings.workingDir);
      setOpenCardId(card.id);
    } finally {
      setStarting(false);
    }
  }, [board]);

  if (!board) {
    return (
      <div className="boot">
        Connecting to the agent server&hellip;
      </div>
    );
  }

  const running = board.cards.find((c) => c.id === board.runningCardId);
  const openCard = board.cards.find((c) => c.id === openCardId) ?? null;
  const queueDepth = board.cards.filter((c) => c.column === 'in_progress').length;
  const needsInput = board.cards.filter((c) => c.column === 'needs_input').length;
  const paused = board.settings.queuePaused;
  const blocked = !paused && !running && needsInput > 0 && board.settings.pauseOnNeedsInput;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Kanban <em>Agents</em>
        </div>

        <div
          className={`conn-status ${connected ? 'is-connected' : 'is-reconnecting'}`}
          title={connected ? `Connected to ${window.location.origin}` : 'Lost connection to the server — retrying…'}
        >
          <span className="conn-dot" />
          {connected ? window.location.host : 'Reconnecting…'}
        </div>

        <div className={`queue-status ${paused ? 'is-paused' : ''}`}>
          {paused ? (
            <>Queue paused &middot; {queueDepth} waiting</>
          ) : running ? (
            <>
              <span className="live-dot" /> Running <b>{running.title}</b>
              {queueDepth > 1 && <> &middot; {queueDepth - 1} queued</>}
            </>
          ) : blocked ? (
            <>Held &mdash; {needsInput} card{needsInput > 1 ? 's' : ''} need your input</>
          ) : queueDepth ? (
            <>Starting next...</>
          ) : (
            <>Idle</>
          )}
        </div>

        <div className="topbar-actions">
          <input
            className="search"
            placeholder="Search tasks"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {paused ? (
            <button className="btn btn-primary" onClick={() => api.resumeQueue()}>
              Resume queue
            </button>
          ) : (
            <button className="btn" onClick={() => api.pauseQueue()}>
              Pause queue
            </button>
          )}
          {running && (
            <button className="btn btn-danger" onClick={() => api.stop(running.id)}>
              Stop current
            </button>
          )}
          <button className="btn" onClick={() => setShowSettings(true)}>
            Settings
          </button>
          <button
            className="icon-btn"
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? '☾' : '☀'}
          </button>
        </div>
      </header>

      {board.auth && !board.auth.ok && (
        <div className="auth-bar">
          <strong>Claude isn&rsquo;t logged in.</strong> {board.auth.reason} {board.auth.hint}
          <span className="auth-cmd">claude</span>
        </div>
      )}

      <div className="workdir-bar">
        <span className="project-label">Project</span>
        <select
          className="select project-select"
          value={board.settings.workingDir}
          onChange={(e) => switchProject(e.target.value)}
          title="Switch which project's board you're looking at"
        >
          {(board.projects ?? []).map((p) => (
            <option key={p.dir} value={p.dir}>
              {p.dir}
              {p.count ? ` (${p.count})` : ''}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => setShowSettings(true)}>
          Change&hellip;
        </button>
        <span className="sep">&mdash;</span>

        {board.projectRun?.running ? (
          <a
            className="project-run is-running"
            href={board.projectRun.url}
            target="_blank"
            rel="noreferrer"
            title={board.projectRun.command ? `Started with: ${board.projectRun.command}` : 'Open in a new tab'}
          >
            <span className="live-dot" /> Running at {board.projectRun.url}
          </a>
        ) : (
          <button className="btn btn-run" onClick={runProject} disabled={starting}>
            {starting ? 'Starting…' : '▶ Run project'}
          </button>
        )}

        <span className="sep">&mdash;</span>
        <span className="note">
          every session runs here, one at a time, building on the last one&rsquo;s changes. Cards
          belong to the project they were created in &mdash; switch projects to see theirs.
        </span>
      </div>

      <main className="board">
        {board.columns.map((column) => (
          <Column
            key={column.id}
            column={column}
            cards={byColumn[column.id] ?? []}
            runningCardId={board.runningCardId}
            onOpen={setOpenCardId}
            onDrop={handleDrop}
            drag={drag}
            setDrag={setDrag}
            onQuickAdd={quickAdd}
          />
        ))}
      </main>

      {openCard && (
        <CardDetail
          card={openCard}
          settings={board.settings}
          isRunning={openCard.id === board.runningCardId}
          columns={board.columns}
          onClose={() => setOpenCardId(null)}
          onChanged={refresh}
        />
      )}

      {showSettings && (
        <SettingsDialog
          settings={board.settings}
          onClose={() => setShowSettings(false)}
          onSave={async (patch) => {
            await api.updateSettings(patch);
            setShowSettings(false);
          }}
        />
      )}
    </div>
  );
}
