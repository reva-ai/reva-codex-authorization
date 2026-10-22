import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeFileName, stateDir } from './pluginPaths';
import { DirectEvalConversationMessage, DirectEvalSession } from './types';

// Deliberately small, because Codex hands every turn-scoped hook the same
// `turn_id` — a turn-cache module for a host with no such id would need
// more than this one does.
//
// What this does NOT need to do:
//   - minting and persisting a trace/span id. Codex's turn_id is present on
//     UserPromptSubmit, PreToolUse and PostToolUse alike, so every hook in
//     a turn derives the identical TRACE (sha256(turn_id)) independently —
//     see trace.ts buildTraceId(). Spans are derived per tool/prompt from
//     that trace (deriveSpanId). Nothing has to be shared to agree on either.
//   - owning the turn boundary. turn_id changing IS the boundary.
//
// What still has to be persisted, because Codex does not supply it:
//   - the prompt text. Only UserPromptSubmit receives `prompt`; PreToolUse
//     and PostToolUse do not, and context.conversation needs it.
//   - the turn ORDINAL. `turn_id` is an opaque string, not a counter, and
//     DirectEvalSession.turn is a number.
//   - startedAt, the stable session start time.
//
// Best-effort throughout: if the cache can't be written or read, actions
// just proceed without turn-scoped context rather than failing.

export interface TurnCacheEntry {
  // Codex's own turn_id for the turn this entry describes. Comparing it to
  // the incoming turn_id is how a new turn is detected.
  turnId: string;
  prompt?: string;
  promptTimestamp: string;
  turn: number;
  startedAt: string;
}

// Sent as the invokeAgent userQuery and again as context.conversation on
// every tool call in the turn. An RTG 413 fails open for that request, so
// raise this only after confirming the RTG accepts the resulting request
// size.
const MAX_PROMPT_LENGTH = 10000;

function cacheDir(dataDir?: string): string {
  return stateDir('turns', dataDir);
}

function cacheFile(sessionId: string, dataDir?: string): string {
  return path.join(cacheDir(dataDir), `${safeFileName(sessionId)}.json`);
}

export function truncatePrompt(prompt: string): string {
  return prompt.length > MAX_PROMPT_LENGTH ? `${prompt.slice(0, MAX_PROMPT_LENGTH)}…` : prompt;
}

function saveTurn(sessionId: string, entry: TurnCacheEntry, dataDir?: string): void {
  try {
    fs.mkdirSync(cacheDir(dataDir), { recursive: true });
    fs.writeFileSync(cacheFile(sessionId, dataDir), JSON.stringify(entry), 'utf8');
  } catch {
    // best effort — later hooks can reconstruct metadata from what they see
  }
}

export function loadTurn(sessionId: string, dataDir?: string): TurnCacheEntry | undefined {
  try {
    const raw = fs.readFileSync(cacheFile(sessionId, dataDir), 'utf8');
    return JSON.parse(raw) as TurnCacheEntry;
  } catch {
    return undefined;
  }
}

// Call once per turn, from UserPromptSubmit. Records the prompt against
// this turn_id and advances the ordinal, preserving the session's original
// startedAt.
export function startTurn(
  sessionId: string,
  turnId: string,
  prompt: string | undefined,
  dataDir?: string,
): TurnCacheEntry {
  const previous = loadTurn(sessionId, dataDir);
  const observedAt = new Date().toISOString();
  const entry: TurnCacheEntry = {
    turnId,
    ...(prompt ? { prompt: truncatePrompt(prompt) } : {}),
    promptTimestamp: observedAt,
    // A repeated UserPromptSubmit for the SAME turn_id must not advance the
    // ordinal — only a genuinely new turn does.
    turn: previous?.turnId === turnId ? previous.turn : (previous?.turn || 0) + 1,
    startedAt: previous?.startedAt || observedAt,
  };
  saveTurn(sessionId, entry, dataDir);
  return entry;
}

// Pre/Post hooks normally follow UserPromptSubmit within the same turn_id.
// If one fires for a turn_id we have no record of, record that first
// observed event as the turn rather than fabricating session metadata.
//
// The stale prompt is deliberately DROPPED when the turn_id differs: it
// belongs to a previous turn, and attaching it as this turn's conversation
// evidence would be fabricating history for the RTG to reason about.
export function loadOrStartTurn(sessionId: string, turnId: string, dataDir?: string): TurnCacheEntry {
  const existing = loadTurn(sessionId, dataDir);
  if (existing?.turnId === turnId && existing.startedAt && existing.promptTimestamp) {
    return existing;
  }
  return startTurn(sessionId, turnId, undefined, dataDir);
}

export function directSessionFromTurn(sessionId: string, turn: TurnCacheEntry): DirectEvalSession {
  return { id: sessionId, turn: turn.turn, startedAt: turn.startedAt };
}

export function conversationFromTurn(turn: TurnCacheEntry): DirectEvalConversationMessage[] {
  if (!turn.prompt?.trim()) return [];
  return [
    {
      seq: 1,
      role: 'user',
      contentType: 'text/plain',
      content: turn.prompt,
      timestamp: turn.promptTimestamp,
    },
  ];
}
