import * as fs from 'node:fs';
import * as path from 'node:path';
import { debugLog } from './debug';

// A per-SESSION "stop calling the RTG, just allow" latch, opened after a 401
// and checked at the top of evaluate() before any network call. Once a
// session sees a 401 it is written off for that session: every later call in
// it short-circuits, and nothing re-checks. A NEW session always starts
// clean and makes a real RTG call, however many times an earlier session
// failed.
//
// This replaces a 4-hour window keyed by Agent id. Two things were wrong
// with that. It was keyed per MACHINE, so one session's 401 silenced every
// other session on the box, including ones started after the underlying
// problem was fixed. And nothing ever closed it on success — the only exits
// were waiting out four hours or deleting the file — so a user whose licence
// was repaired five minutes in still had almost four hours of ungoverned
// operation ahead, with no call ever reaching the RTG to notice the repair.
//
// Session scope fixes both without needing recovery logic inside a session:
// the blast radius is one session, and starting a new one is the recovery.
//
// There is deliberately NO expiry here. openedAt is recorded for logging and
// nothing reads it for a decision — the file existing IS the open state.
//
// 401 is the only status that opens this (see rtgClient.ts). Everything else
// operational — 403/404/424/429/5xx, transport failures, timeouts — already
// fails CLOSED on every call, so there is no "keep allowing" window to bound.

interface CircuitBreakerState {
  // Recorded for the audit trail and for the log line below. Never compared
  // against the clock: this latch does not expire.
  openedAt: number;
  triggeredStatus: number;
  errorType?: string;
}

// Files are only ever created when a session actually takes a 401, which is
// rare, so they accumulate slowly. Swept on write anyway rather than growing
// without bound on a long-lived machine.
//
// Deleting one is harmless by construction: a session this old is long dead,
// so its id will never be seen again and the marker cannot affect any
// decision. The window is generous precisely because nothing depends on it —
// it exists to bound growth, not to expire anything.
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

// No fallback: only ever writes inside PLUGIN_DATA (via resolveDataDir
// callers), same as every other local state file in this plugin.
function cacheDir(pluginDataDir?: string): string | undefined {
  return pluginDataDir ? path.join(pluginDataDir, 'rtg-circuit-breaker') : undefined;
}

function cacheFile(sessionId: string, pluginDataDir?: string): string | undefined {
  const dir = cacheDir(pluginDataDir);
  if (!dir || !sessionId) return undefined;
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safe}.json`);
}

export interface CircuitBreakerStatus {
  open: boolean;
  openedAt?: number;
  triggeredStatus?: number;
  errorType?: string;
}

// Open purely by the file existing and parsing. No clock involved.
export function isCircuitOpen(sessionId: string, pluginDataDir?: string): CircuitBreakerStatus {
  const file = cacheFile(sessionId, pluginDataDir);
  if (!file) return { open: false };
  try {
    const state: CircuitBreakerState = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      open: true,
      openedAt: state.openedAt,
      triggeredStatus: state.triggeredStatus,
      errorType: state.errorType,
    };
  } catch {
    // Absent is the normal case — this session has not seen a 401. Anything
    // else (unreadable, malformed) is treated the same way deliberately: a
    // latch that cannot be read is not evidence to stop calling the RTG, and
    // erring toward MAKING the call is the safer direction for a governance
    // check.
    return { open: false };
  }
}

// Latches this session open. Idempotent by nature — a second 401 in the same
// session just rewrites the same file.
export function openCircuit(
  sessionId: string,
  triggeredStatus: number,
  errorType: string | undefined,
  pluginDataDir?: string,
): void {
  const dir = cacheDir(pluginDataDir);
  const file = cacheFile(sessionId, pluginDataDir);
  if (!dir || !file) return;
  const state: CircuitBreakerState = { openedAt: Date.now(), triggeredStatus, errorType };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
    sweepStale(dir);
  } catch (err: any) {
    // Consequence is a security one rather than a wrong value: without the
    // latch every later call in this session re-hits an unauthorized RTG and
    // keeps failing open, with nothing recording that it is happening.
    debugLog(`openCircuit: could not persist the latch for this session — every later call will re-hit the RTG (${err?.message || String(err)})`);
  }
}

// Best-effort, never throws: a sweep failing must not stop a latch being set.
function sweepStale(dir: string): void {
  try {
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
      } catch {
        // another process got there first, or it vanished — either is fine
      }
    }
  } catch {
    // directory unreadable — the latch above still landed, which is what matters
  }
}
