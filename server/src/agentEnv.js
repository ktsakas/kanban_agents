/**
 * Environment inherited by subscription-backed agent subprocesses.
 *
 * Users often have API keys exported for unrelated development. Removing
 * them from these child processes prevents either SDK from silently choosing
 * usage-based API billing instead of its cached CLI subscription login.
 */
export function subscriptionEnv(agent) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  );
  if (agent === 'codex') {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
  } else {
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}
