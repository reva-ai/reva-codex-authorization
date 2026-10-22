import * as nodeOs from 'node:os';
import { ActiveSession } from './activeSessions';
import { AGENT_TYPE } from './ingestionClient';
import {
  CedarActionMapping,
  CedarHop,
  DirectEvalConversationMessage,
  DirectEvalTransmission,
} from './types';

// The CodingAgent Cedar schema declares a DIFFERENT context shape per
// action — Cedar treats context records as closed, so sending an attribute
// an action doesn't declare is a schema violation, not a harmless extra
// field. The direct-AI endpoint projects `conversation` and `hops` out as
// active-turn evidence before validating the remaining managed context.
//
// `prompt` is deliberately NOT sent in `context` — the RTG manages that
// field itself (derived server-side from `transmission`) and rejects any
// request that echoes it back: "invalid Cedar context: managed context
// field \"prompt\" is reserved for the Reva platform". The prompt/current
// action content still reaches the RTG, just exclusively via the top-level
// `transmission` field rather than duplicated into context. `timestamp`
// (epoch milliseconds UTC, a Long — Date.now() already is exactly this, no
// timezone handling needed) is unaffected and still sent on every action.
//
// NOTE, still open: as of the last confirmed schema, `timestamp` was only declared for
// invokeAgent/invokeTool/invokeModel — NOT for spawn/executeBash/read/
// write/edit/glob/grep. Sending it on those without a matching schema
// update is exactly the kind of closed-context violation this file exists
// to avoid. Confirm those actions' schemas declare `timestamp` before
// relying on this in production; it is the second entry under "Schema
// requests for the Reva side" in the README.
//
// Shape per action, and which of them Codex can actually reach:
//   invokeAgent:  { timestamp (required), hops: [] }             reachable
//   invokeTool:   { timestamp (required) }                       reachable (MCP)
//   spawn:        { timestamp, subagentIndex (required) }        reachable (spawn_agent)
//   executeBash:  { timestamp, command (required, real string) } reachable (Bash)
//   write / edit: { timestamp }                                  reachable (apply_patch)
//   read / glob / grep: { timestamp }                            NOT REACHABLE —
//     Codex has no Read, Glob or Grep tool; those operations run through the
//     shell and arrive as executeBash. The branches stay so the shapes are
//     already correct if Codex ever grows such tools.
//
// invokeModel and listTools are also declared in the schema but have no
// Codex hook boundary to gate them from — not implemented here.
//
// activeSessionCount/sessionId/sessionEntryPoint/sessionLastSeen are sent on
// every action (same everywhere-precedent as timestamp) — local-machine-only
// visibility into how many Codex sessions are concurrently running for this
// Agent right now (see activeSessions.ts). Kept to plain scalars
// deliberately: a Set<Record> was rejected ("managed context supports only
// homogeneous scalar sets"), and a Set<String> of every active session id
// still isn't as simple as it should be for policy authors — so this only
// reports the CURRENT session's own three fields plus the aggregate count.
//
// agentType is also sent on every action, alongside those — the same
// AGENT_TYPE constant ingestionClient.ts sends as the Agent entity's
// agentType attribute.
//
// model is sent on every action too, but ONLY when RevaConfig.modelContext
// is enabled, because unlike agentType it is an attribute the Cedar schema
// must declare first. It records which model made each individual call —
// something the Agent entity's `models` Set cannot answer, since that
// accumulates every model the machine has ever used.
//
// os is also sent on every action — "Linux" or "Windows". This is a
// command-dialect distinction, not a literal kernel identity: every
// Unix-like platform Node runs on (macOS/Darwin included) uses the same
// POSIX shell commands as Linux, so it reports as "Linux" too — only
// win32 (cmd/PowerShell, different commands entirely) is genuinely
// different. Agent.operatingSystems is still PATCH-ADDed at ingestion;
// context.os matches the Claude evaluation contract for per-request policy.
//
// machineId is also sent on every action — this machine's own id (see
// deviceId.ts's resolveMachineId), the same value PATCH-ADDed to
// User.registeredMachineIds at ingestion. Unlike os, this can't be computed
// in here: resolving it needs the plugin data directory (for the persisted-
// random-id fallback), which is an infra concern this file otherwise has
// no reason to know about — so the caller resolves it and passes the plain
// value in.
export interface ActionContextExtras {
  // Cumulative count of subagents spawned so far this turn (1 = first
  // spawn) — only meaningful for, and only sent on, the spawn action.
  subagentIndex?: number;
  // Completed lineage before the current action. Top-level
  // subject/action/resource/transmission describe the current action, so it
  // must not be duplicated here.
  hops?: CedarHop[];
  conversationMessages?: DirectEvalConversationMessage[];
  // How many sessions are currently active on this machine (this Agent),
  // including the one making this very request — so 1 means nothing else is
  // running right now. Local-only: no visibility into other machines.
  activeSessionCount?: number;
  // This request's own session — its id/entrypoint/lastSeen, the same
  // entry markSessionActive() just wrote (or getSessionEntry() read back).
  currentSession?: ActiveSession;
  // Codex's model slug for this session, taken verbatim from the hook
  // payload's required `model` field (e.g. "gpt-5.6-terra"). Never guessed:
  // a payload without it sends an empty string rather than a default.
  model?: string;
  // Gate for `model` above. See RevaConfig.modelContext — Cedar context is
  // closed, so this may only be sent once the schema declares `model` on
  // every gated action.
  modelContext?: boolean;
  // This machine's id (see deviceId.ts's resolveMachineId) — see the
  // interface-level comment above for why this is passed in, not resolved
  // here.
  machineId?: string;
}

// Exported (with an injectable platform, defaulting to the real one) so
// tests can cover the mapping directly without mocking node:os — same
// pattern config.ts's loadConfig(env = process.env) uses.
export function osAttribute(platform: NodeJS.Platform = nodeOs.platform()): 'Linux' | 'Windows' {
  return platform === 'win32' ? 'Windows' : 'Linux';
}

function activeTurnEvidence(extras: ActionContextExtras): Record<string, any> {
  const messages = extras.conversationMessages || [];
  return {
    // Canonical direct-AI placement. An empty array is meaningful for the
    // first hop of a turn and keeps every request on one stable shape.
    hops: extras.hops || [],
    ...(messages.length > 0 ? { conversation: { messages } } : {}),
  };
}

function activeSessionFields(extras: ActionContextExtras): Record<string, any> {
  return {
    activeSessionCount: extras.activeSessionCount ?? 0,
    sessionId: extras.currentSession?.sessionId ?? '',
    sessionEntryPoint: extras.currentSession?.entrypoint ?? '',
    sessionLastSeen: extras.currentSession?.lastSeen ?? 0,
    agentType: AGENT_TYPE,
    machineId: extras.machineId ?? '',
    os: osAttribute(),
    // Same everywhere-precedent as agentType, but gated: agentType is a
    // compile-time constant the schema already accepts, whereas `model` is a
    // new attribute the schema must declare first.
    ...(extras.modelContext ? { model: extras.model ?? '' } : {}),
  };
}

export function buildActionContext(
  mapping: CedarActionMapping,
  extras: ActionContextExtras = {},
): Record<string, any> {
  const timestamp = Date.now();
  const evidence = activeTurnEvidence(extras);
  const sessions = activeSessionFields(extras);
  switch (mapping.actionName) {
    case 'invokeTool':
      return { timestamp, ...evidence, ...sessions };
    case 'spawn':
      return { timestamp, subagentIndex: extras.subagentIndex ?? 1, ...evidence, ...sessions };
    case 'executeBash':
      return { timestamp, command: mapping.command ?? '', ...evidence, ...sessions };
    case 'read':
    case 'write':
    case 'edit':
    case 'glob':
    case 'grep':
      return { timestamp, ...evidence, ...sessions };
    default:
      return { timestamp, ...evidence, ...sessions };
  }
}

export function buildInvokeAgentContext(
  activeSessionCount = 0,
  currentSession?: ActiveSession,
  extras: Pick<ActionContextExtras, 'model' | 'modelContext' | 'machineId'> = {},
): Record<string, any> {
  return {
    timestamp: Date.now(),
    hops: [],
    ...activeSessionFields({ activeSessionCount, currentSession, ...extras }),
  };
}

// `role`/`contentType`/`promptKey` are constants here — Codex doesn't
// expose a multi-role or multi-content-type concept at the hook level, only
// ever the current turn's plain-text prompt.
export function buildTransmission(
  content: string,
  role: DirectEvalTransmission['role'],
  nonblankFallback?: string,
): DirectEvalTransmission {
  const userQuery = content.trim() ? content : (nonblankFallback || '').trim();
  if (!userQuery) {
    throw new Error('direct AI evaluation requires a nonblank current prompt');
  }
  return { promptKey: 'userQuery', userQuery, role, contentType: 'text/plain' };
}

// Sent once, as transmission.response on that tool call's PostToolUse
// request. An RTG 413 fails open for that request, so raise this only
// after confirming the RTG accepts the resulting request size.
const MAX_TOOL_RESPONSE_LENGTH = 10000;

export function serializeToolResponse(toolResponse: unknown): string {
  if (toolResponse == null) return '';
  const raw = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse);
  return raw.length > MAX_TOOL_RESPONSE_LENGTH ? `${raw.slice(0, MAX_TOOL_RESPONSE_LENGTH)}…` : raw;
}

// PostToolUse: userQuery is the same current-hop prompt PreToolUse sent
// (command, pattern, serialized tool input, or tool name). The tool result
// goes in transmission.response, not userQuery — the RTG derives its
// managed prompt from userQuery. Role is "tool" because the tool has
// already returned. contentType stays text/plain, matching PreToolUse:
// response is always a string, JSON results included (see
// serializeToolResponse).
export function buildToolResponseTransmission(toolResponse: unknown, userQuery: string): DirectEvalTransmission {
  const transmission = buildTransmission(userQuery, 'tool');
  transmission.response = serializeToolResponse(toolResponse);
  return transmission;
}
