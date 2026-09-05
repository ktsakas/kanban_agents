import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as store from './store.js';
import { emitBoard, emitCardEvent } from './bus.js';
import * as git from './git.js';
import { checkAuth } from './auth.js';

/* --------------------------- streaming input ----------------------------- */

/**
 * An async iterable the SDK pulls user messages from. Keeping it open is what
 * puts the session in streaming-input mode, which is what makes mid-session
 * replies, interrupts and permission answers possible.
 */
function createInputStream() {
  const queue = [];
  let wake = null;
  let closed = false;

  return {
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length) {
            yield queue.shift();
            continue;
          }
          if (closed) return;
          await new Promise((resolve) => {
            wake = resolve;
          });
        }
      },
    },
    push(text) {
      queue.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: '',
      });
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
    get pending() {
      return queue.length;
    },
  };
}

/* -------------------------------- helpers -------------------------------- */

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('');
}

function summarizeToolResult(content) {
  const text = textOf(content);
  if (text) return text;
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

/* -------------------------------- Runner --------------------------------- */

class Runner {
  constructor() {
    this.current = null;
    this.ticking = false;
  }

  /* ------------------------------ lifecycle ------------------------------ */

  /**
   * Cards that died with a previous process go back on the queue.
   *
   * They must also move back to In Progress. A card killed while `waiting`
   * sits in Needs Input, but its prompt died with the process and is cleared
   * here — so leaving it there would hold the whole queue (pauseOnNeedsInput)
   * on a card that can never unblock itself.
   */
  recover() {
    let changed = false;
    for (const card of store.listCards()) {
      if (['running', 'waiting'].includes(card.runState)) {
        store.updateCard(card.id, {
          runState: 'queued',
          pendingPermission: null,
          error: null,
        });
        if (card.column === 'needs_input') store.moveCard(card.id, 'in_progress', 0);
        store.appendEvent(card.id, {
          type: 'status',
          level: 'warn',
          text: 'Server restarted while this session was running - requeued.',
        });
        changed = true;
      }
    }
    if (changed) this.broadcast();
  }

  broadcast() {
    emitBoard({
      type: 'board',
      cards: store.listCards(),
      settings: store.getSettings(),
      runningCardId: this.current?.cardId ?? null,
      auth: checkAuth(),
    });
  }

  record(cardId, event) {
    const saved = store.appendEvent(cardId, event);
    emitCardEvent(cardId, saved);
    return saved;
  }

  /** Live-only (not persisted): token deltas for the streaming transcript. */
  stream(cardId, event) {
    emitCardEvent(cardId, { ...event, ts: new Date().toISOString(), ephemeral: true });
  }

  /* -------------------------------- queue -------------------------------- */

  /**
   * Sequential by construction: exactly one session may hold `this.current`,
   * so cards in In Progress run strictly one after another on the same tree.
   */
  tick() {
    if (this.ticking) return;
    this.ticking = true;
    queueMicrotask(() => {
      this.ticking = false;
      this.maybeStartNext();
    });
  }

  maybeStartNext() {
    if (this.current) return;
    const settings = store.getSettings();
    if (settings.queuePaused) return;

    const cards = store.listCards();
    // Only a card that is genuinely waiting on the user holds the queue. A
    // card sitting in Needs Input with nothing pending (e.g. requeued after a
    // restart) is not blocked, and must not stall everything behind it.
    const blocked = cards.some(
      (c) =>
        c.column === 'needs_input' &&
        (c.pendingPermission || ['error', 'stopped', 'waiting'].includes(c.runState)),
    );
    if (settings.pauseOnNeedsInput && blocked) return;

    const next = cards
      .filter((c) => c.column === 'in_progress' && c.runState !== 'running')
      .sort((a, b) => a.order - b.order)[0];

    if (!next) return;
    this.runCard(next.id).catch((err) => {
      console.error('[runner] unhandled', err);
    });
  }

  /* ------------------------------- running ------------------------------- */

  async runCard(cardId) {
    const card = store.getCard(cardId);
    if (!card) return;

    const settings = store.getSettings();
    const cwd = card.workingDir || settings.workingDir;
    const model = card.model || settings.model;
    const permissionMode = card.permissionMode || settings.permissionMode;
    const effort = card.effort || settings.effort;

    const isFollowUp = Boolean(card.sessionId && card.pendingReply);
    const prompt = isFollowUp ? card.pendingReply : card.prompt || card.title;

    if (!prompt || !prompt.trim()) {
      store.updateCard(cardId, {
        column: 'needs_input',
        runState: 'error',
        error: 'This card has no prompt. Add one and move it back to In Progress.',
      });
      this.broadcast();
      return;
    }

    const input = createInputStream();
    const abort = new AbortController();
    const permissions = new Map();
    this.current = { cardId, q: null, input, abort, permissions };

    const gitBefore = await git.snapshot(cwd);

    store.updateCard(cardId, {
      runState: 'running',
      column: 'in_progress',
      startedAt: card.startedAt ?? new Date().toISOString(),
      finishedAt: null,
      error: null,
      pendingPermission: null,
      pendingReply: null,
      gitBefore: gitBefore ?? card.gitBefore,
      runCount: (card.runCount ?? 0) + 1,
      unread: false,
    });
    this.record(cardId, {
      type: 'status',
      level: 'info',
      text: isFollowUp
        ? `Resuming session in ${cwd}`
        : `Starting session in ${cwd} (${model}, ${permissionMode})`,
    });
    this.record(cardId, { type: 'user_prompt', text: prompt });
    this.broadcast();

    input.push(prompt);

    const options = {
      cwd,
      model,
      permissionMode,
      effort,
      abortController: abort,
      includePartialMessages: true,
      forwardSubagentText: true,
      canUseTool: (toolName, toolInput, opts) =>
        this.askPermission(cardId, toolName, toolInput, opts),
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'kanban-agents/1.0' },
    };
    if (permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
    if (settings.maxTurns > 0) options.maxTurns = settings.maxTurns;
    if (settings.appendSystemPrompt && settings.appendSystemPrompt.trim()) {
      options.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: settings.appendSystemPrompt,
      };
    }
    if (card.sessionId) options.resume = card.sessionId;

    let finalResult = null;
    let failure = null;

    try {
      const q = query({ prompt: input.iterable, options });
      this.current.q = q;

      for await (const message of q) {
        if (this.current?.cardId !== cardId) break;
        const res = this.handleMessage(cardId, message);
        if (res) finalResult = res;

        if (message.type === 'result') {
          // Turn complete. Close input unless a reply arrived while it ran.
          if (!input.pending) input.close();
        }
      }
    } catch (err) {
      // Recorded once by finish(), so the transcript shows a single failure.
      if (!abort.signal.aborted) failure = err?.message || String(err);
    } finally {
      input.close();
      for (const p of permissions.values()) {
        p.resolve({ behavior: 'deny', message: 'Session ended.' });
      }
      permissions.clear();
    }

    const wasAborted = abort.signal.aborted;
    if (this.current?.cardId === cardId) this.current = null;

    await this.finish(cardId, { finalResult, failure, wasAborted, cwd, gitBefore });
    this.tick();
  }

  handleMessage(cardId, message) {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          store.updateCard(cardId, { sessionId: message.session_id });
          this.record(cardId, {
            type: 'session',
            sessionId: message.session_id,
            model: message.model,
            tools: message.tools?.length ?? 0,
          });
          this.broadcast();
        }
        return null;

      case 'stream_event': {
        const ev = message.event;
        if (ev?.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta') {
            this.stream(cardId, { type: 'text_delta', index: ev.index, text: ev.delta.text });
          } else if (ev.delta?.type === 'thinking_delta') {
            this.stream(cardId, { type: 'thinking_delta', index: ev.index, text: ev.delta.thinking });
          }
        }
        return null;
      }

      case 'assistant': {
        for (const block of message.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) {
            this.record(cardId, {
              type: 'text',
              text: block.text,
              subagent: message.parent_tool_use_id ? message.subagent_type ?? 'subagent' : null,
            });
          } else if (block.type === 'thinking' && block.thinking?.trim()) {
            this.record(cardId, { type: 'thinking', text: block.thinking });
          } else if (block.type === 'tool_use') {
            this.record(cardId, {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
        return null;
      }

      case 'user': {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const text = summarizeToolResult(block.content);
              this.record(cardId, {
                type: 'tool_result',
                toolUseId: block.tool_use_id,
                isError: Boolean(block.is_error),
                text: text.length > 4000 ? `${text.slice(0, 4000)}\n... (truncated)` : text,
              });
            }
          }
        }
        return null;
      }

      case 'result': {
        this.record(cardId, {
          type: 'result',
          subtype: message.subtype,
          isError: message.is_error,
          text: message.result ?? '',
          durationMs: message.duration_ms,
          numTurns: message.num_turns,
          costUsd: message.total_cost_usd,
          usage: message.usage,
        });
        return message;
      }

      default:
        return null;
    }
  }

  /* ----------------------------- permissions ----------------------------- */

  /**
   * A permission prompt (or an AskUserQuestion) parks the card in Needs Input
   * and holds the session open until the user answers from the UI.
   */
  askPermission(cardId, toolName, toolInput, opts) {
    const requestId = randomUUID();
    const isQuestion = toolName === 'AskUserQuestion';

    const request = {
      requestId,
      toolName,
      input: toolInput,
      title: opts?.title ?? null,
      displayName: opts?.displayName ?? null,
      description: opts?.description ?? null,
      reason: opts?.decisionReason ?? null,
      blockedPath: opts?.blockedPath ?? null,
      kind: isQuestion ? 'question' : 'permission',
      questions: isQuestion ? toolInput?.questions ?? [] : null,
    };

    store.updateCard(cardId, {
      column: 'needs_input',
      runState: 'waiting',
      pendingPermission: request,
      unread: true,
    });
    this.record(cardId, { type: 'permission_request', ...request });
    this.broadcast();

    return new Promise((resolve) => {
      const settle = (result) => {
        this.current?.permissions.delete(requestId);
        const card = store.getCard(cardId);
        if (card && card.runState === 'waiting') {
          store.updateCard(cardId, {
            column: 'in_progress',
            runState: 'running',
            pendingPermission: null,
          });
          this.broadcast();
        }
        resolve(result);
      };
      this.current?.permissions.set(requestId, { resolve: settle, request });

      opts?.signal?.addEventListener(
        'abort',
        () => settle({ behavior: 'deny', message: 'Aborted.' }),
        { once: true },
      );
    });
  }

  answerPermission(cardId, requestId, decision, payload = {}) {
    if (this.current?.cardId !== cardId) return false;
    const entry = this.current.permissions.get(requestId);
    if (!entry) return false;

    if (decision === 'allow') {
      this.record(cardId, { type: 'permission_resolved', requestId, decision: 'allowed' });
      entry.resolve({
        behavior: 'allow',
        updatedInput: payload.updatedInput ?? entry.request.input,
      });
    } else if (decision === 'answer') {
      // AskUserQuestion: hand the answers straight back as the tool result.
      const answers = payload.text ?? '';
      this.record(cardId, {
        type: 'permission_resolved',
        requestId,
        decision: 'answered',
        text: answers,
      });
      entry.resolve({ behavior: 'deny', message: `The user answered: ${answers}` });
    } else {
      const reason = payload.text?.trim() || 'The user declined this action.';
      this.record(cardId, {
        type: 'permission_resolved',
        requestId,
        decision: 'denied',
        text: reason,
      });
      entry.resolve({ behavior: 'deny', message: reason });
    }
    return true;
  }

  /* ------------------------------- replies ------------------------------- */

  /**
   * Reply to a card. If it is the live session, the text is injected into the
   * running conversation. Otherwise the card is put back at the front of the
   * In Progress queue and its session is resumed when its turn comes.
   */
  reply(cardId, text) {
    const card = store.getCard(cardId);
    if (!card || !text || !text.trim()) return false;

    if (this.current?.cardId === cardId) {
      const pending = [...this.current.permissions.entries()][0];
      if (pending) {
        const [requestId, entry] = pending;
        const kind = entry.request.kind;
        this.answerPermission(cardId, requestId, kind === 'question' ? 'answer' : 'deny', { text });
        if (kind !== 'question') this.current.input.push(text);
        return true;
      }
      this.record(cardId, { type: 'user_prompt', text });
      this.current.input.push(text);
      store.updateCard(cardId, { column: 'in_progress', runState: 'running' });
      this.broadcast();
      return true;
    }

    store.updateCard(cardId, {
      pendingReply: text,
      runState: 'queued',
      error: null,
      unread: false,
    });
    store.moveCard(cardId, 'in_progress', 0);
    this.record(cardId, { type: 'status', level: 'info', text: 'Reply queued - session will resume.' });
    this.broadcast();
    this.tick();
    return true;
  }

  /* -------------------------------- control ------------------------------ */

  async stop(cardId) {
    if (this.current?.cardId !== cardId) return false;
    this.record(cardId, { type: 'status', level: 'warn', text: 'Stopped by user.' });
    for (const [requestId] of this.current.permissions) {
      this.answerPermission(cardId, requestId, 'deny', { text: 'Session stopped by the user.' });
    }
    try {
      await this.current.q?.interrupt();
    } catch {
      /* interrupt is best effort; the abort below always lands */
    }
    this.current.abort.abort();
    this.current.input.close();
    return true;
  }

  /** Called when a card is dragged out of In Progress while it is running. */
  async cancelIfRunning(cardId) {
    if (this.current?.cardId === cardId) await this.stop(cardId);
  }

  async finish(cardId, { finalResult, failure, wasAborted, cwd, gitBefore }) {
    const card = store.getCard(cardId);
    if (!card) return;

    const settings = store.getSettings();
    const gitAfter = await git.snapshot(cwd);
    const diffStat = await git.diffSince(cwd, gitBefore?.head);

    const patch = {
      finishedAt: new Date().toISOString(),
      gitAfter,
      diffStat,
      pendingPermission: null,
    };

    if (finalResult) {
      patch.stats = {
        durationMs: finalResult.duration_ms,
        numTurns: finalResult.num_turns,
        costUsd: finalResult.total_cost_usd,
        inputTokens: finalResult.usage?.input_tokens ?? 0,
        outputTokens: finalResult.usage?.output_tokens ?? 0,
      };
      patch.lastResult = (finalResult.result ?? '').slice(0, 4000);
    }

    // The card may have been dragged elsewhere mid-run - respect that.
    const movedAway = !['in_progress', 'needs_input'].includes(card.column);

    if (wasAborted) {
      patch.runState = 'stopped';
      if (!movedAway) patch.column = 'needs_input';
      patch.unread = true;
    } else if (failure || finalResult?.is_error) {
      patch.runState = 'error';
      patch.error = failure || finalResult?.result || 'The session ended with an error.';
      if (!movedAway) patch.column = 'needs_input';
      patch.unread = true;
      if (/authenticat|401|oauth/i.test(patch.error)) {
        patch.error = `${patch.error}\n\nRun "claude" in a terminal and log in (or set ANTHROPIC_API_KEY), then reply here to retry.`;
      }
      this.record(cardId, { type: 'status', level: 'error', text: patch.error });
    } else {
      patch.runState = 'finished';
      patch.error = null;
      if (!movedAway) patch.column = settings.autoAdvanceTo;
      patch.unread = true;
      this.record(cardId, {
        type: 'status',
        level: 'success',
        text: `Session complete -> ${settings.autoAdvanceTo}`,
      });
    }

    store.updateCard(cardId, patch);
    if (patch.column) store.moveCard(cardId, patch.column, 0);
    this.broadcast();
  }
}

export const runner = new Runner();
