import { markSessionInactive } from './activeSessions';
import { debugLog } from './debug';
import { readCodexAccountId } from './identity';
import { resolveDataDir } from './pluginPaths';
import { readStdin } from './stdin';

// SessionEnd has no blocking/decision control (same as SessionStart) — it's
// pure local cleanup, immediately removing this session from the active-
// sessions registry (activeSessions.ts) rather than waiting out that file's
// 10-minute TTL. Not guaranteed to fire on an abrupt termination (killed
// process, closed terminal) — the TTL stays as the fallback for exactly
// that gap; this is just the fast path for a graceful one. No RTG call, no
// full loadConfig(): nothing here is worth a network round-trip against
// Codex's tight SessionEnd execution budget.
interface SessionEndInput {
  session_id: string;
  cwd: string;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input: SessionEndInput = JSON.parse(raw);
  const dataDir = resolveDataDir();

  // Resolved independently of loadConfig() — same reasoning as
  // sessionStart.ts's own active-session tracking: this is local
  // bookkeeping only, so it shouldn't need the auth token (or anything
  // else loadConfig() requires) to succeed first.
  const agentId = process.env.REVA_AGENT_ID?.trim() || readCodexAccountId();
  if (!agentId) {
    debugLog('sessionEnd: skipped — no Codex account id resolved and REVA_AGENT_ID not set');
  } else {
    try {
      markSessionInactive(agentId, input.session_id, dataDir);
    } catch (err: any) {
      debugLog(`sessionEnd: markSessionInactive failed — ${err?.message || String(err)}`);
    }
  }

  process.exit(0); // clean no-op pass-through — no stdout, nothing to block on
}

main().catch(() => process.exit(0));
