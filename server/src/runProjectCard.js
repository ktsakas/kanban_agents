export const RUN_PROJECT_KIND = 'run_project';
export const RUN_PROJECT_LABEL = 'run-project';

export const RUN_PROJECT_COLUMNS = Object.freeze(['in_progress', 'done']);

/** Recognize both new control cards and cards created by older releases. */
export function isRunProjectCard(card) {
  return Boolean(
    card &&
      (card.kind === RUN_PROJECT_KIND ||
        (card.kind == null &&
          card.title === 'Run project' &&
          card.labels?.includes(RUN_PROJECT_LABEL))),
  );
}

export function canMoveRunProjectCard(column) {
  return RUN_PROJECT_COLUMNS.includes(column);
}

/** Run-project controls always finish in Done, regardless of the task default. */
export function runProjectCompletionColumn(card, taskCompletionColumn) {
  return isRunProjectCard(card) ? 'done' : taskCompletionColumn;
}

/**
 * A detached dev server can keep the Codex transport open after the agent has
 * finished talking. In that case the run-status record is the authoritative
 * completion signal, but it must have been refreshed by this run (rather than
 * merely describing the server that the control was asked to restart).
 */
export function isFreshSuccessfulRun(card, status, runStartedAt) {
  if (!isRunProjectCard(card) || !status?.running) return false;
  const reportedAt = Date.parse(status.startedAt);
  const startedAt =
    typeof runStartedAt === 'number' ? runStartedAt : Date.parse(runStartedAt);
  return Number.isFinite(reportedAt) && Number.isFinite(startedAt) && reportedAt >= startedAt;
}

export function createRunProjectPrompt(dir, statusPath) {
  return `Build (when needed) and start or restart this project locally so it can be opened in a browser.

Working directory: ${dir}
Run-status file: ${statusPath}

1. Work out how this project is built and run. Check package.json scripts or
   the equivalent for its stack (Python, Go, Rust, a Makefile, etc.). Read the
   run-status file if it exists; a valid file means this project has completed
   its first successful build-and-run before.
2. If there is no valid run-status file, this is the first run: install missing
   dependencies, run the project's build command first when it has one, and
   only then start the project. If the stack has no separate build step, do
   the equivalent required preparation and continue.
3. If the run-status file exists and its URL is not answering, start the
   project again. Do not repeat the one-time build merely because the old
   server stopped, unless the project's tooling requires a build to run.
4. If its URL is currently answering, restart it: identify and stop the
   previously launched project process (prefer the recorded PID; otherwise
   carefully identify the process that owns the recorded port), confirm that
   it stopped, and then start a fresh process. Do not kill an unrelated
   process.
5. Start the dev/preview server *in the background*, fully detached from this
   session, so it keeps running after you finish responding (e.g. on Windows,
   \`start /B\` or spawn detached with output redirected to a log file; on
   POSIX, \`nohup ... > log 2>&1 & disown\`). Do not run it in the foreground -
   that would block this task forever.
6. Confirm the new process actually answers before reporting success
   (curl/fetch it). Then write JSON to the run-status path above, using the
   real values. Preserve the existing builtAt value on later runs; set it to
   the current ISO timestamp after the successful first build. Record the PID
   of the actual long-lived server process, not a short-lived shell wrapper:

   {"url":"http://localhost:<port>","command":"<start command>","pid":<server pid>,"builtAt":"<first successful build ISO timestamp>","startedAt":"<current ISO timestamp>"}

If there's no sensible way to "run" this project (e.g. it's a library, not an
app), don't guess - say so in your final message instead of writing that file.`;
}

/** Keep the project control ahead of ordinary tasks while preserving task order. */
export function sortRunProjectCardFirst(cards) {
  return [...cards].sort((a, b) => {
    const pinned = Number(isRunProjectCard(b)) - Number(isRunProjectCard(a));
    return pinned || a.order - b.order;
  });
}

/** Resolve a requested drop position without allowing a task above the pinned control. */
export function runProjectPinnedIndex(card, siblings, requestedIndex) {
  if (isRunProjectCard(card)) return 0;
  const at = Math.max(0, Math.min(requestedIndex ?? siblings.length, siblings.length));
  return siblings.some(isRunProjectCard) ? Math.max(1, at) : at;
}
