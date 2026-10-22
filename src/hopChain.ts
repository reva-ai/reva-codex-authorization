import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeFileName, stateDir } from './pluginPaths';
import { CedarHop } from './types';

// Tracks the delegation chain ("how did the current subject get here")
// across the many separate, stateless hook processes that make up one
// session. `hops` on an outbound request is the chain BEFORE this
// request's own action — empty for the very first invokeAgent of a turn,
// [invokeAgentHop] for the main session's tool calls that turn,
// [invokeAgentHop, spawnHop] for a subagent's calls, one more spawnHop per
// level of nesting, and so on.
//
// The tricky part: Codex never reveals a newly spawned subagent's real id
// at spawn time — only that subagent's OWN first subsequent tool call
// carries it. So a
// spawn's resulting lineage can't be written keyed by the child's id yet;
// it's queued (FIFO, since spawns and their first tool calls happen in
// order) and bound to the real id the first time that subagent is seen.
//
// TODO(codex): Codex MAY make this queue unnecessary, but that is NOT yet
// established and the queue therefore stays. Codex declares a SubagentStart
// event whose generated stdin schema lists `agent_id` and `agent_type` as
// REQUIRED (codex-rs/hooks/schema/generated/subagent-start.command.input
// .schema.json, rust-v0.151.0), which would let a spawn's lineage be keyed
// by the child's real id immediately, deleting the FIFO entirely.
//
// What has to be OBSERVED before removing it — none of which the 0.151.0
// capture session produced, because no spawn_agent call was made and no
// record carried agent_id:
//   1. a SubagentStart payload actually arriving, carrying a non-empty
//      agent_id/agent_type;
//   2. a PreToolUse from inside that subagent carrying the SAME agent_id,
//      so the two can be joined;
//   3. that this holds for every subagent kind, not just thread-spawn —
//      codex-rs/core/src/hook_runtime.rs builds the subagent hook context
//      only for SessionSource::SubAgent(SubAgentSource::ThreadSpawn{..})
//      and returns early for other subagent sources, so subagents created
//      another way may carry no agent_id at all and would fall back to
//      being attributed to the main Agent.
// Until all three are captured, this queue is the behavior that is known to
// work. Do not delete it on the strength of a schema declaration.
//
// Best-effort throughout, same as turnCache/spawnCounter: if the cache
// can't be read or written, callers just get an empty chain rather than
// failing the request.

interface HopChainState {
  agentHops: CedarHop[];
  pendingSubAgentLineages: CedarHop[][];
  boundLineages: Record<string, CedarHop[]>;
}

const EMPTY_STATE: HopChainState = { agentHops: [], pendingSubAgentLineages: [], boundLineages: {} };

function cacheDir(dataDir?: string): string {
  return stateDir('hops', dataDir);
}

function cacheFile(sessionId: string, dataDir?: string): string {
  return path.join(cacheDir(dataDir), `${safeFileName(sessionId)}.json`);
}

function loadState(sessionId: string, dataDir?: string): HopChainState {
  try {
    const raw = fs.readFileSync(cacheFile(sessionId, dataDir), 'utf8');
    return JSON.parse(raw) as HopChainState;
  } catch {
    return EMPTY_STATE;
  }
}

function saveState(sessionId: string, state: HopChainState, dataDir?: string): void {
  try {
    fs.mkdirSync(cacheDir(dataDir), { recursive: true });
    fs.writeFileSync(cacheFile(sessionId, dataDir), JSON.stringify(state), 'utf8');
  } catch {
    // best effort — subsequent requests just see an empty chain
  }
}

// Called once per turn, from UserPromptSubmit, right after the invokeAgent
// decision is evaluated. Resets the chain for this session: a new user
// turn starts its own fresh lineage rather than accumulating across the
// whole session, and any subagents from a previous turn no longer apply.
export function startTurnHops(sessionId: string, invokeAgentHop: CedarHop, dataDir?: string): void {
  saveState(sessionId, { agentHops: [invokeAgentHop], pendingSubAgentLineages: [], boundLineages: {} }, dataDir);
}

// The lineage for the main session's own tool calls this turn.
export function loadAgentHops(sessionId: string, dataDir?: string): CedarHop[] {
  return loadState(sessionId, dataDir).agentHops;
}

// Called from a spawn action's authorization: queues the lineage the new
// subagent should inherit (the spawner's own current lineage, plus this
// spawn) for the next unbound subagent id seen this session.
export function enqueuePendingSpawnLineage(
  sessionId: string,
  parentLineage: CedarHop[],
  spawnHop: CedarHop,
  dataDir?: string,
): void {
  const state = loadState(sessionId, dataDir);
  state.pendingSubAgentLineages.push([...parentLineage, spawnHop]);
  saveState(sessionId, state, dataDir);
}

// Called for every subagent tool call. Returns the subagent's own bound
// lineage if already resolved; otherwise binds the oldest still-pending
// spawn lineage to this subagent id (first subagent tool call this session
// => first pending spawn, in order) and persists the binding for its later
// calls. Returns [] if there's nothing pending (shouldn't normally happen —
// a subagent's own calls always follow its spawn — but keeps this from
// crashing if it does).
export function resolveSubAgentLineage(sessionId: string, subAgentId: string, dataDir?: string): CedarHop[] {
  const state = loadState(sessionId, dataDir);
  const existing = state.boundLineages[subAgentId];
  if (existing) return existing;

  const lineage = state.pendingSubAgentLineages.shift();
  if (!lineage) return [];

  state.boundLineages[subAgentId] = lineage;
  saveState(sessionId, state, dataDir);
  return lineage;
}
