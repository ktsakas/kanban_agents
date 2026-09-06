import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import * as store from './store.js';
import { emitBoard, emitCardEvent } from './bus.js';
import * as git from './git.js';
import { checkAuth } from './auth.js';
import { subscriptionEnv } from './agentEnv.js';
import * as projectRun from './projectRun.js';
import {
  isFreshSuccessfulRun,
  isRunProjectCard,
  runProjectCompletionColumn,
} from './runProjectCard.js';

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
    take() {
      const item = queue.shift();
      if (!item) return null;
      if (typeof item === 'string') return item;
      return item.message?.content ?? null;
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

function codexPermissions(permissionMode) {
  if (permissionMode === 'plan') {
    return { sandboxMode: 'read-only', approvalPolicy: 'never' };
  }
  if (permissionMode === 'bypassPermissions') {
    return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' };
  }
  // Non-interactive SDK turns cannot pause on a native approval dialog. Keep
  // normal runs safely inside the project; an action outside that sandbox is
  // denied and Codex can explain what it needs in its final response.
  return { sandboxMode: 'workspace-write', approvalPolicy: 'never' };
}

function truncate(text, max = 4000) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}\n... (truncated)` : value;
}

function withExtraInstructions(prompt, extra) {
  if (!extra?.trim()) return prompt;
  return `${prompt}\n\nAdditional instructions for this session:\n${extra.trim()}`;
}

function modelMatchesAgent(model, agent) {
  if (!model) return false;
  if (agent === 'claude') return !String(model).startsWith('gpt-');
  return !String(model).startsWith('claude-');
}

/* -------------------------------- Runner --------------------------------- */

class Runner {
  constructor() {
    // One live session per project. Projects may run concurrently, while cards
    // that share a working tree remain strictly sequential.
    this.currents = new Map();
    this.startingProjects = new Set();
    this.ticking = false;
  }

  currentForProject(project) {
    return this.currents.get(store.resolveDir(project)) ?? null;
  }

  currentForCard(cardId) {
    for (const current of this.currents.values()) {
      if (current.cardId === cardId) return current;
    }
    return null;
  }

  runningCardId(project) {
    return this.currentForProject(project)?.cardId ?? null;
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
  async recover() {
    let changed = false;
    for (const card of store.listCards()) {
      if (['running', 'waiting'].includes(card.runState)) {
        if (isRunProjectCard(card)) {
          const status = await projectRun.getRunStatus(card.projectDir);
          if (isFreshSuccessfulRun(card, status, card.startedAt)) {
            store.updateCard(card.id, {
              column: 'done',
              runState: 'finished',
              finishedAt: new Date().toISOString(),
              pendingPermission: null,
              error: null,
              unread: true,
            });
            store.appendEvent(card.id, {
              type: 'status',
              level: 'success',
              text: 'Recovered completed project run from its verified run-status record.',
            });
            changed = true;
            continue;
          }
        }
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
    const settings = store.getSettings();
    emitBoard({
      type: 'board',
      cards: store.listCards({ project: settings.workingDir }),
      projects: store.listProjects(),
      settings,
      runningCardId: this.runningCardId(settings.workingDir),
      auth: checkAuth(settings.agent),
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
   * Sequential per project: each working tree gets one execution slot, while
   * cards belonging to different projects may run concurrently.
   */
  tick() {
    if (this.ticking) return;
    this.ticking = true;
    queueMicrotask(() => {
      this.ticking = false;
      for (const { dir } of store.listProjects()) this.maybeStartNext(dir);
    });
  }

  maybeStartNext(project) {
    const projectKey = store.resolveDir(project);
    if (this.currentForProject(projectKey) || this.startingProjects.has(projectKey)) return;
    const settings = store.getSettings();
    if (settings.queuePaused) return;

    const cards = store.listCards({ project });
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
    this.startingProjects.add(projectKey);
    this.runCard(next.id)
      .catch((err) => {
        console.error('[runner] unhandled', err);
      })
      .finally(() => {
        this.startingProjects.delete(projectKey);
        this.tick();
      });
  }

  /* ------------------------------- running ------------------------------- */

  async runCard(cardId) {
    const card = store.getCard(cardId);
    if (!card) return;

    const settings = store.getSettings();
    const cwd = card.workingDir || settings.workingDir;
    const project = store.resolveDir(card.projectDir || cwd);
    if (this.currentForProject(project)) return;
    const agent = card.sessionAgent || card.agent || settings.agent || 'claude';
    const model =
      (modelMatchesAgent(card.model, agent) ? card.model : null) ||
      card.sessionModel ||
      (agent === settings.agent ? settings.model : agent === 'codex' ? '' : 'claude-sonnet-5');
    const permissionMode = card.permissionMode || settings.permissionMode;
    const effort = card.effort || settings.effort;

    let changeSnapshot = card.changeSnapshot;
    if (!changeSnapshot) {
      try {
        changeSnapshot = await git.captureSessionStart(cwd, cardId);
      } catch (err) {
        store.updateCard(cardId, {
          column: isRunProjectCard(card) ? 'done' : 'needs_input',
          runState: 'error',
          error: `Could not create the rollback snapshot: ${err?.message || String(err)}`,
        });
        this.broadcast();
        return;
      }
    }

    const isFollowUp = Boolean(card.sessionId && card.pendingReply);
    const basePrompt = card.prompt || card.title;
    const prompt = card.pendingReply
      ? card.sessionId
        ? card.pendingReply
        : `${basePrompt}\n\nAdditional user message:\n${card.pendingReply}`
      : basePrompt;

    if (!prompt || !prompt.trim()) {
      store.updateCard(cardId, {
        column: isRunProjectCard(card) ? 'done' : 'needs_input',
        runState: 'error',
        error: 'This card has no prompt. Add one and move it back to In Progress.',
      });
      this.broadcast();
      return;
    }

    const input = createInputStream();
    const abort = new AbortController();
    const permissions = new Map();
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const current = { cardId, project, agent, q: null, input, abort, permissions, done };
    this.currents.set(project, current);

    const gitBefore = await git.snapshot(cwd);

    store.updateCard(cardId, {
      runState: 'running',
      column: 'in_progress',
      startedAt: card.startedAt ?? new Date().toISOString(),
      finishedAt: null,
      error: null,
      pendingPermission: null,
      pendingReply: null,
      sessionAgent: agent,
      sessionModel: model || null,
      gitBefore: gitBefore ?? card.gitBefore,
      changeSnapshot,
      changesRevertedAt: null,
      runCount: (card.runCount ?? 0) + 1,
      unread: false,
    });
    this.record(cardId, {
      type: 'status',
      level: 'info',
      text: isFollowUp
        ? `Resuming ${agent === 'codex' ? 'Codex' : 'Claude Code'} session in ${cwd}`
        : `Starting ${agent === 'codex' ? 'Codex' : 'Claude Code'} session in ${cwd} (${model || 'configured default'}, ${permissionMode})`,
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
      env: {
        ...subscriptionEnv('claude'),
        CLAUDE_AGENT_SDK_CLIENT_APP: 'kanban-agents/1.0',
      },
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
      if (agent === 'codex') {
        finalResult = await this.runCodex(cardId, {
          card,
          cwd,
          model,
          permissionMode,
          effort,
          settings,
          input,
          abort,
        });
      } else {
        const q = query({ prompt: input.iterable, options });
        current.q = q;

        for await (const message of q) {
          if (this.currentForProject(project) !== current) break;
          const res = this.handleMessage(cardId, message);
          if (res) finalResult = res;

          if (message.type === 'result') {
            // Turn complete. Close input unless a reply arrived while it ran.
            if (!input.pending) input.close();
          }
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
    if (this.currentForProject(project) === current) this.currents.delete(project);

    try {
      await this.finish(cardId, { finalResult, failure, wasAborted, cwd, gitBefore });
      this.tick();
    } finally {
      resolveDone();
    }
  }

  async runCodex(cardId, { card, cwd, model, permissionMode, effort, settings, input, abort }) {
    // Intentionally omit `apiKey`: the SDK launches its bundled Codex CLI,
    // which reuses the user's cached `codex login` (ChatGPT subscription).
    const codex = new Codex({ env: subscriptionEnv('codex') });
    const threadOptions = {
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      modelReasoningEffort: effort,
      ...codexPermissions(permissionMode),
    };
    if (model) threadOptions.model = model;
    const thread = card.sessionId
      ? codex.resumeThread(card.sessionId, threadOptions)
      : codex.startThread(threadOptions);
    const current = this.currentForCard(cardId);
    if (current) current.thread = thread;

    const started = Date.now();
    const usage = {
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
    };
    let numTurns = 0;
    let finalText = '';

    // A reply submitted during a Codex turn is queued here and starts as the
    // next turn on the same thread as soon as the current turn completes.
    for (let prompt = input.take(); prompt; prompt = input.take()) {
      const { events } = await thread.runStreamed(
        withExtraInstructions(prompt, settings.appendSystemPrompt),
        { signal: abort.signal },
      );
      const toolIds = new Set();
      let turnText = '';
      let turnUsage = null;
      let turnFailure = null;
      let verifiedRunProjectCompletion = false;

      for await (const event of events) {
        if (this.currentForCard(cardId) !== current) break;

        if (event.type === 'thread.started') {
          store.updateCard(cardId, {
            sessionId: event.thread_id,
            sessionAgent: 'codex',
            sessionModel: model || null,
          });
          this.record(cardId, {
            type: 'session',
            sessionId: event.thread_id,
            agent: 'codex',
            model: model || 'Codex default',
            tools: null,
          });
          this.broadcast();
        } else if (event.type === 'item.started') {
          const tool = this.codexToolEvent(event.item);
          if (tool) {
            toolIds.add(event.item.id);
            this.record(cardId, tool);
          }
        } else if (event.type === 'item.completed') {
          const item = event.item;
          if (item.type === 'agent_message' && item.text?.trim()) {
            turnText = item.text;
            this.record(cardId, { type: 'text', text: item.text });
            if (isRunProjectCard(card)) {
              const status = await projectRun.getRunStatus(cwd);
              verifiedRunProjectCompletion = isFreshSuccessfulRun(card, status, started);
              if (verifiedRunProjectCompletion) {
                this.record(cardId, {
                  type: 'status',
                  level: 'success',
                  text: 'Project is running - closing the completed control session.',
                });
                break;
              }
            }
          } else if (item.type === 'reasoning' && item.text?.trim()) {
            this.record(cardId, { type: 'thinking', text: item.text });
          } else if (item.type === 'error') {
            this.record(cardId, { type: 'status', level: 'warn', text: item.message });
          } else {
            const tool = toolIds.has(item.id) ? null : this.codexToolEvent(item);
            if (tool) this.record(cardId, tool);
            const result = this.codexToolResult(item);
            if (result) this.record(cardId, result);
          }
        } else if (event.type === 'turn.completed') {
          turnUsage = event.usage;
        } else if (event.type === 'turn.failed') {
          turnFailure = event.error?.message || 'Codex turn failed.';
        } else if (event.type === 'error') {
          turnFailure = event.message || 'Codex session failed.';
        }
      }

      if (turnFailure) throw new Error(turnFailure);
      numTurns += 1;
      finalText = turnText || finalText;
      for (const key of Object.keys(usage)) usage[key] += turnUsage?.[key] ?? 0;
      this.record(cardId, {
        type: 'result',
        subtype: 'success',
        isError: false,
        text: turnText,
        durationMs: Date.now() - started,
        numTurns,
        costUsd: null,
        usage: turnUsage,
      });
    }

    return {
      subtype: 'success',
      is_error: false,
      result: finalText,
      duration_ms: Date.now() - started,
      num_turns: numTurns,
      total_cost_usd: null,
      usage,
    };
  }

  codexToolEvent(item) {
    switch (item?.type) {
      case 'command_execution':
        return { type: 'tool_use', id: item.id, name: 'Shell', input: { command: item.command } };
      case 'file_change':
        return { type: 'tool_use', id: item.id, name: 'File changes', input: { changes: item.changes } };
      case 'mcp_tool_call':
        return {
          type: 'tool_use',
          id: item.id,
          name: `${item.server}.${item.tool}`,
          input: item.arguments,
        };
      case 'web_search':
        return { type: 'tool_use', id: item.id, name: 'Web search', input: { query: item.query } };
      default:
        return null;
    }
  }

  codexToolResult(item) {
    switch (item?.type) {
      case 'command_execution':
        return {
          type: 'tool_result',
          toolUseId: item.id,
          isError: item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0),
          text: truncate(item.aggregated_output),
        };
      case 'file_change':
        return {
          type: 'tool_result',
          toolUseId: item.id,
          isError: item.status === 'failed',
          text: item.changes?.map((change) => `${change.kind}: ${change.path}`).join('\n') || '',
        };
      case 'mcp_tool_call':
        return {
          type: 'tool_result',
          toolUseId: item.id,
          isError: item.status === 'failed',
          text: truncate(item.error?.message || summarizeToolResult(item.result?.content)),
        };
      case 'web_search':
        return { type: 'tool_result', toolUseId: item.id, isError: false, text: item.query || '' };
      default:
        return null;
    }
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
      column: isRunProjectCard(store.getCard(cardId)) ? 'in_progress' : 'needs_input',
      runState: 'waiting',
      pendingPermission: request,
      unread: true,
    });
    this.record(cardId, { type: 'permission_request', ...request });
    this.broadcast();

    return new Promise((resolve) => {
      const settle = (result) => {
        this.currentForCard(cardId)?.permissions.delete(requestId);
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
      this.currentForCard(cardId)?.permissions.set(requestId, { resolve: settle, request });

      opts?.signal?.addEventListener(
        'abort',
        () => settle({ behavior: 'deny', message: 'Aborted.' }),
        { once: true },
      );
    });
  }

  answerPermission(cardId, requestId, decision, payload = {}) {
    const current = this.currentForCard(cardId);
    if (!current) return false;
    const entry = current.permissions.get(requestId);
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

    const current = this.currentForCard(cardId);
    if (current) {
      const pending = [...current.permissions.entries()][0];
      if (pending) {
        const [requestId, entry] = pending;
        const kind = entry.request.kind;
        this.answerPermission(cardId, requestId, kind === 'question' ? 'answer' : 'deny', { text });
        if (kind !== 'question') current.input.push(text);
        return true;
      }
      this.record(cardId, { type: 'user_prompt', text });
      current.input.push(text);
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
    const current = this.currentForCard(cardId);
    if (!current) return false;
    this.record(cardId, { type: 'status', level: 'warn', text: 'Stopped by user.' });
    for (const [requestId] of current.permissions) {
      this.answerPermission(cardId, requestId, 'deny', { text: 'Session stopped by the user.' });
    }
    try {
      await current.q?.interrupt();
    } catch {
      /* interrupt is best effort; the abort below always lands */
    }
    current.abort.abort();
    current.input.close();
    return true;
  }

  /** Called when a card is dragged out of In Progress while it is running. */
  async cancelIfRunning(cardId) {
    const running = this.currentForCard(cardId);
    if (!running) return;
    await this.stop(cardId);
    await running.done;
  }

  async finish(cardId, { finalResult, failure, wasAborted, cwd, gitBefore }) {
    const card = store.getCard(cardId);
    if (!card) return;

    const settings = store.getSettings();
    const isProjectRunner = isRunProjectCard(card);
    const gitAfter = await git.snapshot(cwd);
    const diffStat = await git.diffSince(cwd, gitBefore?.head);

    let changeSnapshot = card.changeSnapshot;
    if (changeSnapshot) {
      try {
        changeSnapshot = await git.captureSessionEnd(changeSnapshot);
      } catch (err) {
        failure ||= `Could not finish the rollback snapshot: ${err?.message || String(err)}`;
      }
    }

    const patch = {
      finishedAt: new Date().toISOString(),
      gitAfter,
      diffStat,
      changeSnapshot,
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
      if (!movedAway) patch.column = isProjectRunner ? 'done' : 'needs_input';
      patch.unread = true;
    } else if (failure || finalResult?.is_error) {
      patch.runState = 'error';
      patch.error = failure || finalResult?.result || 'The session ended with an error.';
      if (!movedAway) patch.column = isProjectRunner ? 'done' : 'needs_input';
      patch.unread = true;
      if (/authenticat|401|oauth|log(?:ged)? in/i.test(patch.error)) {
        const agent = card.sessionAgent || 'claude';
        const command = agent === 'codex' ? 'npm run login:codex' : 'claude';
        const name = agent === 'codex' ? 'ChatGPT' : 'your Claude subscription';
        patch.error = `${patch.error}\n\nRun "${command}" in a terminal and log in with ${name}, then reply here to retry.`;
      }
      if (
        card.sessionAgent === 'codex' &&
        /selected model|may not exist|access to it/i.test(patch.error)
      ) {
        patch.model = null;
        patch.sessionModel = null;
        patch.error = `${patch.error}\n\nThe explicit model override was cleared. Reply here to retry with your Codex configured default.`;
      }
      this.record(cardId, { type: 'status', level: 'error', text: patch.error });
    } else {
      patch.runState = 'finished';
      patch.error = null;
      const completedColumn = runProjectCompletionColumn(card, settings.autoAdvanceTo);
      if (!movedAway) patch.column = completedColumn;
      patch.unread = true;
      this.record(cardId, {
        type: 'status',
        level: 'success',
        text: `Session complete -> ${completedColumn}`,
      });
    }

    store.updateCard(cardId, patch);
    if (patch.column) store.moveCard(cardId, patch.column, 0);
    this.broadcast();
  }
}

export const runner = new Runner();
