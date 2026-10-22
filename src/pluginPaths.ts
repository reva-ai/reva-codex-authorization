import * as os from 'node:os';
import * as path from 'node:path';

// Where the file-backed per-session caches (turns, hops, spawns,
// active-sessions, entity-types) live.
//
// Codex sets PLUGIN_DATA — a per-plugin writable directory — for hooks that
// come from a plugin bundle, and also sets CLAUDE_PLUGIN_DATA to the same
// value purely for out-of-the-box compatibility with plugins built for
// other hosts (confirmed in codex-rs/hooks/src/engine/discovery.rs, which
// comments the alias as exactly that). We read PLUGIN_DATA first because
// it is the real Codex name, and accept the alias so a mixed install still
// works.
//
// IMPORTANT: those variables are injected ONLY for plugin-bundled hooks.
// A hook registered by hand in ~/.codex/hooks.json gets neither — discovery
// passes `env: HashMap::new()` for every non-plugin source — so the
// home-directory fallback below is a real code path, not defensive padding.
//
// The fallback directory is deliberately NOT shared with a Reva governance
// plugin for a different host, which may well be installed on the same
// machine. activeSessions.ts is keyed by the machine's hardware id: sharing
// a directory would make each agent count the other's sessions, changing
// the `activeSessionCount` a Cedar policy sees. Each plugin reports only
// its own agent's sessions.
const FALLBACK_DIR_NAME = '.codex-governance';

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromPlugin = env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
  if (fromPlugin && fromPlugin.trim()) return fromPlugin;
  return path.join(os.homedir(), FALLBACK_DIR_NAME);
}

// One named subdirectory of the data dir. Callers pass an explicit
// `dataDir` in tests (a temp directory) so nothing ever touches the real one.
export function stateDir(name: string, dataDir?: string): string {
  return path.join(dataDir || resolveDataDir(), name);
}

// Session ids and agent ids become file names, so anything that isn't
// clearly filesystem-safe is replaced. Shared by every cache module.
export function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}
