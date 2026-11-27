// The hooks' output: Claude Code's hook JSON on stdout, `systemMessage` for
// the user and `additionalContext` for the agent. Each part is left out when
// it is empty.

/** Writes the hook output for `event`. */
export function say(event, { user, agent }) {
  const out = {};
  if (user) out.systemMessage = user;
  if (agent) out.hookSpecificOutput = { hookEventName: event, additionalContext: agent };
  process.stdout.write(JSON.stringify(out) + "\n");
}
