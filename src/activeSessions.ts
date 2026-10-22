import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeFileName, stateDir } from './pluginPaths';

// Tracks which session_ids are currently active on THIS machine, keyed by
// Agent id (the per-machine identity everything else in this plugin already
// uses) — the local half of "how many Codex sessions are running right
// now," e.g. two terminal tabs.
//
// SessionStart registers a session; UserPromptSubmit and PreToolUse refresh
// lastSeen for whichever session is still actually being used; SessionEnd
// (sessionEnd.ts, via markSessionInactive) removes it immediately when it
// fires. That last one isn't guaranteed to fire on an abrupt termination
// (killed process, closed terminal) — for exactly that gap, a session not
// seen in ACTIVE_TTL_MS is treated as gone and pruned outright on the next
// read or write, not just filtered out at read time, so this file can't
// grow unbounded even if SessionEnd never runs at all.
//
// Deliberately local-only: this has no visibility into other machines, so
// it can only ever answer "how many sessions on THIS machine," not a true
// cross-machine concurrent-session count. It also does not see the Claude
// Code plugin's sessions — see pluginPaths.ts for why the two plugins keep
// separate state directories.
//
// Best-effort throughout, same as turnCache/hopChain/spawnCounter: if the
// cache can't be read or written, callers just get an empty/best-guess
// result rather than failing the request.

interface SessionEntry {
  entrypoint: string;
  lastSeen: number;
}

interface ActiveSessionsState {
  sessions: Record<string, SessionEntry>;
}

const ACTIVE_TTL_MS = 10 * 60 * 1000; // no activity for 10 minutes => treated as gone

function cacheDir(dataDir?: string): string {
  return stateDir('active-sessions', dataDir);
}

function cacheFile(agentId: string, dataDir?: string): string {
  return path.join(cacheDir(dataDir), `${safeFileName(agentId)}.json`);
}

function loadState(agentId: string, dataDir?: string): ActiveSessionsState {
  try {
    const raw = fs.readFileSync(cacheFile(agentId, dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    return { sessions: parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {} };
  } catch {
    return { sessions: {} };
  }
}

function saveState(agentId: string, state: ActiveSessionsState, dataDir?: string): void {
  try {
    fs.mkdirSync(cacheDir(dataDir), { recursive: true });
    fs.writeFileSync(cacheFile(agentId, dataDir), JSON.stringify(state), 'utf8');
  } catch {
    // best effort — the next call just tries again
  }
}

// Drops any entry not seen within ACTIVE_TTL_MS — called on every write so
// the file can't accumulate sessions that closed hours/days ago.
function pruneStale(state: ActiveSessionsState): ActiveSessionsState {
  const now = Date.now();
  const sessions: Record<string, SessionEntry> = {};
  for (const [sessionId, entry] of Object.entries(state.sessions)) {
    if (now - entry.lastSeen < ACTIVE_TTL_MS) {
      sessions[sessionId] = entry;
    }
  }
  return { sessions };
}

export interface ActiveSession {
  sessionId: string;
  entrypoint: string;
  lastSeen: number;
}

// Registers (or refreshes) this session as active, and returns the entry
// just written — callers use this directly for the current session's own
// context fields (sessionId/sessionEntryPoint/sessionLastSeen), no separate
// read needed. Returns undefined for an empty/missing sessionId — nothing
// honest to record (avoids a literal "undefined" key) or report.
export function markSessionActive(
  agentId: string,
  sessionId: string,
  entrypoint: string,
  dataDir?: string,
): ActiveSession | undefined {
  if (!sessionId) return undefined;
  const state = pruneStale(loadState(agentId, dataDir));
  const entry: SessionEntry = { entrypoint, lastSeen: Date.now() };
  state.sessions[sessionId] = entry;
  saveState(agentId, state, dataDir);
  return { sessionId, ...entry };
}

// Every session currently considered active for this Agent (this machine),
// including the caller's own — so 1 means only this session is active, 2+
// means at least one other tab/window is also running right now.
export function getActiveSessions(agentId: string, dataDir?: string): ActiveSession[] {
  const state = pruneStale(loadState(agentId, dataDir));
  return Object.entries(state.sessions).map(([sessionId, entry]) => ({ sessionId, ...entry }));
}

export function getActiveSessionCount(agentId: string, dataDir?: string): number {
  return getActiveSessions(agentId, dataDir).length;
}

// Read-only lookup of one session's own entry, without refreshing it —
// used by PostToolUse, where PreToolUse already refreshed lastSeen moments
// earlier in the same tool-call cycle.
export function getSessionEntry(agentId: string, sessionId: string, dataDir?: string): ActiveSession | undefined {
  return getActiveSessions(agentId, dataDir).find((s) => s.sessionId === sessionId);
}

// Explicit removal, called from SessionEnd (sessionEnd.ts) when it fires —
// the one non-TTL way an entry leaves this file. SessionEnd isn't
// guaranteed to fire on an abrupt termination (killed process, closed
// terminal) — the TTL above stays as the fallback for exactly that gap;
// this is just the fast path for a graceful one, so a session doesn't linger
// as "active" for up to ACTIVE_TTL_MS after it's actually gone.
export function markSessionInactive(agentId: string, sessionId: string, dataDir?: string): void {
  if (!sessionId) return;
  const state = pruneStale(loadState(agentId, dataDir));
  if (sessionId in state.sessions) {
    delete state.sessions[sessionId];
    saveState(agentId, state, dataDir);
  }
}
