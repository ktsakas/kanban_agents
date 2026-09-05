import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * Turns a task description into a short card title. Runs a one-shot,
 * tool-free query against a cheap/fast model so quick-add stays snappy -
 * the card is created immediately with a placeholder title and this fills
 * in the real one a moment later (see index.js).
 */

const TITLE_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You write short titles for kanban task cards.

Given a task description, output ONLY the title - no quotes, no labels, no
explanation, nothing before or after it. 3-7 words. Plain sentence case,
no trailing period. Capture the concrete action/outcome, not generic filler
like "Task" or "Update code".`;

function cleanTitle(raw) {
  if (!raw) return null;
  let title = String(raw).trim().split('\n')[0].trim();
  title = title.replace(/^["'“”*_`]+|["'“”*_`.]+$/g, '').trim();
  if (!title) return null;
  if (title.length > 70) title = `${title.slice(0, 67).trimEnd()}...`;
  return title;
}

export async function generateTitle(description) {
  const text = (description ?? '').trim();
  if (!text) return null;

  try {
    const q = query({
      prompt: `Task description:\n"""\n${text.slice(0, 4000)}\n"""\n\nTitle:`,
      options: {
        model: TITLE_MODEL,
        maxTurns: 1,
        allowedTools: [],
        permissionMode: 'bypassPermissions',
        systemPrompt: SYSTEM_PROMPT,
      },
    });

    for await (const message of q) {
      if (message.type === 'result') {
        if (message.is_error) return null;
        return cleanTitle(message.result);
      }
    }
  } catch (err) {
    console.error('[titler] title generation failed:', err?.message || err);
  }
  return null;
}
