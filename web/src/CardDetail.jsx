import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, subscribe } from './api.js';
import MicButton, { appendDictation } from './MicButton.jsx';

const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'];
const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function duration(ms) {
  if (ms == null) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function turns(n) {
  return `${n} turn${n === 1 ? '' : 's'}`;
}

/** Sub-cent runs read as noise at three decimals; show them as a floor. */
function cost(usd) {
  if (usd == null) return null;
  return usd < 0.001 ? '<$0.001' : `$${usd.toFixed(3)}`;
}

function previewToolInput(name, input) {
  if (!input) return '';
  if (name === 'Bash') return input.command ?? '';
  if (name === 'Read' || name === 'Write' || name === 'Edit') return input.file_path ?? '';
  if (name === 'Grep' || name === 'Glob') return input.pattern ?? '';
  if (name === 'Task' || name === 'Agent') return input.description ?? '';
  const json = JSON.stringify(input);
  return json.length > 120 ? `${json.slice(0, 120)}...` : json;
}

/* ------------------------------- transcript ------------------------------- */

function ToolEvent({ event, result }) {
  const [open, setOpen] = useState(false);
  const failed = result?.isError;
  return (
    <div className={`ev ev-tool ${failed ? 'is-error' : ''}`}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-caret">{open ? '▾' : '▸'}</span>
        <span className="tool-name">{event.name}</span>
        <span className="tool-preview">{previewToolInput(event.name, event.input)}</span>
        {!result && <span className="live-dot" />}
        {failed && <span className="tool-flag">error</span>}
      </button>
      {open && (
        <div className="tool-body">
          <pre className="code">{JSON.stringify(event.input, null, 2)}</pre>
          {result && <pre className="code code-result">{result.text || '(no output)'}</pre>}
        </div>
      )}
    </div>
  );
}

function Thinking({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ev ev-thinking">
      <button className="thinking-head" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Thinking
      </button>
      {open && <pre className="thinking-body">{text}</pre>}
    </div>
  );
}

function Transcript({ cardId, isRunning }) {
  const [events, setEvents] = useState([]);
  const [live, setLive] = useState({ text: '', thinking: '' });
  const scrollRef = useRef(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    setEvents([]);
    setLive({ text: '', thinking: '' });
    return subscribe(`/stream/cards/${cardId}`, (event) => {
      if (event.type === 'snapshot') {
        setEvents(event.events);
        return;
      }
      if (event.type === 'text_delta') {
        setLive((l) => ({ ...l, text: l.text + event.text }));
        return;
      }
      if (event.type === 'thinking_delta') {
        setLive((l) => ({ ...l, thinking: l.thinking + event.text }));
        return;
      }
      // A persisted block supersedes whatever was streaming into it.
      if (event.type === 'text') setLive((l) => ({ ...l, text: '' }));
      if (event.type === 'thinking') setLive((l) => ({ ...l, thinking: '' }));
      if (event.type === 'tool_use') setLive({ text: '', thinking: '' });
      setEvents((prev) => [...prev, event]);
    });
  }, [cardId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [events, live]);

  const resultsByToolId = useMemo(() => {
    const map = new Map();
    for (const e of events) if (e.type === 'tool_result') map.set(e.toolUseId, e);
    return map;
  }, [events]);

  return (
    <div
      className="transcript"
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      {!events.length && (
        <p className="transcript-empty">
          No activity yet. Move this card to <b>In Progress</b> to start the session.
        </p>
      )}

      {events.map((event, i) => {
        switch (event.type) {
          case 'user_prompt':
            return (
              <div key={i} className="ev ev-user">
                <span className="ev-who">You</span>
                <div className="bubble">{event.text}</div>
              </div>
            );
          case 'text':
            return (
              <div key={i} className="ev ev-assistant">
                {event.subagent && <span className="ev-who">{event.subagent}</span>}
                <div className="prose">{event.text}</div>
              </div>
            );
          case 'thinking':
            return <Thinking key={i} text={event.text} />;
          case 'tool_use':
            return <ToolEvent key={i} event={event} result={resultsByToolId.get(event.id)} />;
          case 'tool_result':
            return null;
          case 'permission_request':
            return (
              <div key={i} className="ev ev-permission">
                {event.kind === 'question' ? 'Claude asked you a question' : `Permission requested: ${event.title || event.toolName}`}
              </div>
            );
          case 'permission_resolved':
            return (
              <div key={i} className="ev ev-note">
                You {event.decision}
                {event.text ? `: ${event.text}` : ''}
              </div>
            );
          case 'session':
            return (
              <div key={i} className="ev ev-note">
                Session {String(event.sessionId).slice(0, 8)} &middot; {event.model} &middot; {event.tools} tools
              </div>
            );
          case 'result':
            return (
              <div key={i} className={`ev ev-result ${event.isError ? 'is-error' : ''}`}>
                <b>{event.isError ? 'Ended with error' : 'Turn complete'}</b>
                <span>
                  {duration(event.durationMs)} &middot; {turns(event.numTurns)}
                  {event.costUsd ? ` · ${cost(event.costUsd)}` : ''}
                </span>
              </div>
            );
          case 'status':
            return (
              <div key={i} className={`ev ev-note lvl-${event.level ?? 'info'}`}>
                {event.text}
              </div>
            );
          default:
            return null;
        }
      })}

      {live.thinking && (
        <div className="ev ev-thinking">
          <div className="thinking-body streaming">{live.thinking}</div>
        </div>
      )}
      {live.text && (
        <div className="ev ev-assistant">
          <div className="prose streaming">
            {live.text}
            <span className="caret" />
          </div>
        </div>
      )}
      {isRunning && !live.text && !live.thinking && (
        <div className="ev ev-note working">
          <span className="live-dot" /> working&hellip;
        </div>
      )}
    </div>
  );
}

/* ------------------------------ permission ------------------------------- */

function PermissionPanel({ card, onAnswered }) {
  const request = card.pendingPermission;
  const [note, setNote] = useState('');
  if (!request) return null;

  const answer = async (decision, text) => {
    await api.permission(card.id, request.requestId, decision, text);
    setNote('');
    onAnswered?.();
  };

  if (request.kind === 'question') {
    return (
      <div className="permission">
        <h4>Claude needs an answer</h4>
        {(request.questions ?? []).map((q, qi) => (
          <div key={qi} className="question">
            <p className="question-text">{q.question}</p>
            <div className="question-options">
              {(q.options ?? []).map((opt, oi) => (
                <button key={oi} className="btn" onClick={() => answer('answer', `${q.question} -> ${opt.label}`)}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="permission-actions">
          <input
            placeholder="Or type your own answer"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && note.trim() && answer('answer', note)}
          />
          <MicButton title="Dictate answer" onText={(chunk) => setNote((n) => appendDictation(n, chunk))} />
          <button className="btn btn-primary" disabled={!note.trim()} onClick={() => answer('answer', note)}>
            Send
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="permission">
      <h4>{request.title || `Claude wants to use ${request.toolName}`}</h4>
      {request.description && <p className="permission-desc">{request.description}</p>}
      <pre className="code">{JSON.stringify(request.input, null, 2)}</pre>
      <div className="permission-actions">
        <button className="btn btn-primary" onClick={() => answer('allow')}>
          Allow
        </button>
        <input
          placeholder="Reason for denying (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <MicButton title="Dictate reason" onText={(chunk) => setNote((n) => appendDictation(n, chunk))} />
        <button className="btn btn-danger" onClick={() => answer('deny', note)}>
          Deny
        </button>
      </div>
    </div>
  );
}

/* -------------------------------- detail --------------------------------- */

export default function CardDetail({ card, settings, isRunning, columns, onClose, onChanged }) {
  const [tab, setTab] = useState('session');
  const [reply, setReply] = useState('');
  const [draft, setDraft] = useState({ title: card.title, prompt: card.prompt });

  useEffect(() => {
    setDraft({ title: card.title, prompt: card.prompt });
  }, [card.id]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = async () => {
    const text = reply.trim();
    if (!text) return;
    setReply('');
    await api.reply(card.id, text);
    onChanged?.();
  };

  const patch = (p) => api.updateCard(card.id, p).then(onChanged);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        <header className="drawer-head">
          <input
            className="drawer-title"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            onBlur={() => draft.title !== card.title && patch({ title: draft.title })}
          />
          <div className="drawer-head-actions">
            {isRunning && (
              <button className="btn btn-danger" onClick={() => api.stop(card.id)}>
                Stop
              </button>
            )}
            <select
              className="select"
              value={card.column}
              onChange={(e) => api.moveCard(card.id, e.target.value, 0).then(onChanged)}
            >
              {columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
            <button className="icon-btn" onClick={onClose} title="Close">
              &times;
            </button>
          </div>
        </header>

        <nav className="tabs">
          {['session', 'task', 'changes'].map((t) => (
            <button key={t} className={tab === t ? 'tab is-active' : 'tab'} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
          <span className="tabs-spacer" />
          {card.stats && (
            <span className="tabs-stats">
              {duration(card.stats.durationMs)} &middot; {turns(card.stats.numTurns)}
              {card.stats.costUsd ? ` · ${cost(card.stats.costUsd)}` : ''}
            </span>
          )}
        </nav>

        {card.error && tab !== 'session' && (
          <div className="banner banner-error">{card.error}</div>
        )}

        {tab === 'session' && (
          <>
            <PermissionPanel card={card} onAnswered={onChanged} />
            <Transcript cardId={card.id} isRunning={isRunning} />
            <footer className="composer">
              <div className="textarea-wrap">
                <textarea
                  placeholder={
                    isRunning
                      ? 'Send a message into the running session...'
                      : 'Reply to resume this session (it goes to the front of the queue)'
                  }
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
                  }}
                />
                <MicButton title="Dictate reply" onText={(chunk) => setReply((r) => appendDictation(r, chunk))} />
              </div>
              <div className="composer-actions">
                <span className="hint">Ctrl+Enter to send</span>
                <button className="btn" onClick={() => api.reset(card.id).then(onChanged)}>
                  Reset session
                </button>
                <button className="btn btn-primary" disabled={!reply.trim()} onClick={send}>
                  Send
                </button>
              </div>
            </footer>
          </>
        )}

        {tab === 'task' && (
          <div className="panel">
            <label className="field">
              <span>Prompt</span>
              <textarea
                rows={10}
                value={draft.prompt}
                onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
                onBlur={() => draft.prompt !== card.prompt && patch({ prompt: draft.prompt })}
              />
            </label>

            <div className="field-row">
              <label className="field">
                <span>Model</span>
                <select
                  className="select"
                  value={card.model ?? ''}
                  onChange={(e) => patch({ model: e.target.value || null })}
                >
                  <option value="">Board default ({settings.model})</option>
                  {MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Permissions</span>
                <select
                  className="select"
                  value={card.permissionMode ?? ''}
                  onChange={(e) => patch({ permissionMode: e.target.value || null })}
                >
                  <option value="">Board default ({settings.permissionMode})</option>
                  {PERMISSION_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Effort</span>
                <select
                  className="select"
                  value={card.effort ?? ''}
                  onChange={(e) => patch({ effort: e.target.value || null })}
                >
                  <option value="">Board default ({settings.effort})</option>
                  {EFFORTS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="field">
              <span>Working directory override</span>
              <input
                value={card.workingDir ?? ''}
                placeholder={settings.workingDir}
                onChange={(e) => patch({ workingDir: e.target.value || null })}
              />
            </label>

            <label className="field">
              <span>Labels (comma separated)</span>
              <input
                defaultValue={(card.labels ?? []).join(', ')}
                onBlur={(e) =>
                  patch({
                    labels: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>

            <div className="panel-foot">
              <span className="hint">
                {card.sessionId ? `Session ${card.sessionId.slice(0, 8)}` : 'No session yet'} &middot; run{' '}
                {card.runCount ?? 0}x
              </span>
              <button
                className="btn btn-danger"
                onClick={async () => {
                  if (confirm('Delete this card and its transcript?')) {
                    await api.deleteCard(card.id);
                    onClose();
                  }
                }}
              >
                Delete card
              </button>
            </div>
          </div>
        )}

        {tab === 'changes' && (
          <div className="panel">
            {card.lastResult && (
              <>
                <h4>Final summary</h4>
                <div className="prose">{card.lastResult}</div>
              </>
            )}
            <h4>Git</h4>
            {card.gitBefore ? (
              <p className="hint">
                branch <b>{card.gitAfter?.branch ?? card.gitBefore.branch}</b> &middot; before{' '}
                <code>{card.gitBefore.head?.slice(0, 8)}</code>
                {card.gitAfter?.head && card.gitAfter.head !== card.gitBefore.head && (
                  <>
                    {' '}
                    &rarr; after <code>{card.gitAfter.head.slice(0, 8)}</code>
                  </>
                )}
              </p>
            ) : (
              <p className="hint">The working directory is not a git repository.</p>
            )}
            {card.diffStat ? (
              <pre className="code">{card.diffStat}</pre>
            ) : (
              <p className="hint">No file changes recorded for this run.</p>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
