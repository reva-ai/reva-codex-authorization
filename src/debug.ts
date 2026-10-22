import * as fs from 'node:fs';
import * as path from 'node:path';
import { readCodexRevaConfig } from './codexRevaConfig';
import { resolveDataDir } from './pluginPaths';

const LOG_FILENAME = 'debug.log';

// Opt-in via REVA_DEBUG (env or ~/.codex/config.toml [reva] / [reva.env]).
// Always writes to stderr (unmodified — a live terminal watching a hook run
// directly still sees exactly this). Also appends a timestamped copy to
// PLUGIN_DATA/debug.log (via resolveDataDir): stderr alone isn't enough
// when Codex's TUI hides hook stderr. Timestamped on the file specifically
// because it accumulates across every hook invocation.
let cachedEnabled: boolean | undefined;

function debugEnabled(): boolean {
  if (cachedEnabled !== undefined) return cachedEnabled;
  const fromEnv = process.env.REVA_DEBUG?.trim();
  if (fromEnv && fromEnv !== '0' && fromEnv.toLowerCase() !== 'false') {
    cachedEnabled = true;
    return true;
  }
  cachedEnabled = Boolean(readCodexRevaConfig().debug);
  return cachedEnabled;
}

export function debugLog(message: string): void {
  if (!debugEnabled()) return;
  process.stderr.write(`[reva-security] ${message}\n`);

  try {
    const dataDir = resolveDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, LOG_FILENAME), `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    // best effort — this plugin's own logging must never itself crash a hook
  }
}

export function _resetDebugCacheForTests(): void {
  cachedEnabled = undefined;
}
