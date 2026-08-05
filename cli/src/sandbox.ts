const REFUSAL = `the codex sandbox blocks commands terminal-browser needs to run to determine the terminal pane terminal-browser is running in.
Re-run this command with escalated permissions.`;

function inCodex(): boolean {
  return Boolean(process.env.CODEX_THREAD_ID ?? process.env.CODEX_PERMISSION_PROFILE);
}

export function sandboxRefusal(): string | null {
  return process.env.CODEX_SANDBOX ? REFUSAL : null;
}

export function deniedRefusal(): string | null {
  return inCodex() ? REFUSAL : null;
}
