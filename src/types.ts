export interface RevaConfig {
  rtgUrl: string;
  // Sent as the X-API-Token header on BOTH evaluation and ingestion calls —
  // one Reva auth token authenticates everything this plugin does.
  authorization: string;
  // The Cedar `Agent` entity's id — this machine's hardware id (mac
  // address / machine-id / MachineGuid), not an install-level id. The
  // CodingAgent schema's `Agent` shape has no name/description attributes,
  // only a required `user` entity reference — nothing else to configure.
  agentId: string;
  timeoutMs: number;
  // Ingestion API (registers Agent/MCPServer entities so they exist
  // before any evaluation request references them) — a separate base URL
  // and timeout from evaluation (best-effort, no user-facing value worth
  // waiting the same 25s default for), but the same `authorization` token.
  ingestionUrl: string;
  ingestionTimeoutMs: number;
  // Sent as the `policyStoreId` header on evaluation AND ingestion when set,
  // naming which Cedar policy store decides. PROVISIONAL and opt-in: nothing
  // in the confirmed contract requires this header yet, though the mock
  // server has always read `req.headers.policystoreid`, and a Reva
  // dev-platform config shows `policyStoreId` as a custom header. Omitted
  // entirely when unset, so the default request shape stays unchanged. If
  // this turns out to be required, it is a platform-contract change, not
  // something to special-case here.
  policyStoreId?: string;
  // When true, every action's Cedar context also carries `model` — Codex's
  // model slug for the session, so a decision log records WHICH model made
  // each call.
  //
  // OFF BY DEFAULT. Cedar context records are CLOSED: sending an attribute
  // the action does not declare is a schema violation that returns 4xx, which
  // this plugin treats as a real denial rather than an outage. Enabling this
  // before the schema declares `model` on every gated action denies
  // everything. See "Schema requests" in the README.
  //
  // Deliberately model-only. The OS is NOT sent here — it is already recorded
  // on the Agent entity as `operatingSystems` and cannot change between
  // sessions, so the RTG can join it server-side. `model` cannot be joined
  // that way: Agent.models is a Set of everything the machine has ever used
  // and cannot say which one made a given call.
  modelContext?: boolean;
}

// ---------------------------------------------------------------------------
// Codex CLI hook stdin payloads.
//
// Field sets confirmed against Codex's own generated JSON Schemas at
// rust-v0.151.0 (codex-rs/hooks/schema/generated/*.command.input.schema.json),
// which declare `additionalProperties: false` — so these are the complete set,
// not a guessed subset.
//
// Worth knowing cold about this shape:
//   - there is NO `prompt_id`. `turn_id` is present on EVERY turn-scoped
//     event including PreToolUse — which is why turnCache.ts does not have
//     to mint its own span id.
//   - `tool_use_id` is required on PreToolUse.
//   - `model` and `permission_mode` are always present.
//   - SessionStart carries no `turn_id` at all.
// ---------------------------------------------------------------------------

export type CodexPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions';

export interface PreToolUseInput {
  session_id: string;
  turn_id: string;
  cwd: string;
  hook_event_name: string;
  model: string;
  permission_mode: CodexPermissionMode | string;
  tool_name: string;
  tool_input: Record<string, any>;
  tool_use_id: string;
  transcript_path?: string | null;
  // Populated by Codex when this tool call originates inside a thread-spawn
  // subagent; absent for top-level session tool calls. NOT OBSERVED in the
  // 0.151.0 capture session (no spawn_agent call was made), so subagent
  // handling here remains unverified against a real payload — see hopChain.ts.
  agent_id?: string;
  agent_type?: string;
}

export interface PostToolUseInput extends PreToolUseInput {
  // Structured tool result (shape depends on the tool). This is what
  // PostToolUse puts in transmission.userQuery.
  tool_response?: unknown;
}

export interface UserPromptSubmitInput {
  session_id: string;
  turn_id: string;
  cwd: string;
  hook_event_name: string;
  model: string;
  permission_mode: CodexPermissionMode | string;
  prompt: string;
  transcript_path?: string | null;
  agent_id?: string;
  agent_type?: string;
}

export interface SessionStartInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  model: string;
  permission_mode: CodexPermissionMode | string;
  source: 'startup' | 'resume' | 'clear' | 'compact' | string;
  transcript_path?: string | null;
}

// ---------------------------------------------------------------------------
// Cedar / Reva RTG wire format — a fixed platform contract, deliberately
// not redesigned here.
// ---------------------------------------------------------------------------

// A bare reference to an entity — used for active-turn hops and as the base
// of direct-AI subject/principal/resource specs.
export interface CedarEntityRef {
  type: string;
  id: string;
}

// Canonical entity shape accepted by the direct AI evaluation endpoint.
// Request-local attributes ride in `properties`; the endpoint does not accept
// the classic evaluation API's top-level `entities` collection.
export interface DirectEvalEntitySpec extends CedarEntityRef {
  name?: string;
  properties?: Record<string, any>;
  // Request-local Cedar ancestry for ephemeral coding resources that are not
  // persisted in RTG (files, directories, tools, and subagents).
  parents?: CedarEntityRef[];
  tool?: string;
  origin?: string;
  endpoint?: string;
}

// Internal normalized entity description used by the mapping layer. Direct
// AI requests map attrs and optional ancestry onto the direct entity spec;
// RTG's stored bare User/Agent entities remain authoritative.
export interface CedarEntityDescriptor {
  uid: CedarEntityRef;
  attrs: Record<string, any>;
  parents: CedarEntityRef[];
}

// One step in the delegation chain leading up to (but not including) the
// current request's own action — see hopChain.ts for how this is tracked
// across the stateless per-hook-call processes.
export interface CedarHop {
  seq: number;
  subject: CedarEntityRef;
  action: { name: string };
  resource: CedarEntityRef;
  time: string;
}

export interface DirectEvalConversationMessage {
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  contentType: string;
  content: string;
  timestamp: string;
}

export interface DirectEvalTransmission {
  promptKey: 'userQuery';
  userQuery: string;
  role: 'user' | 'assistant' | 'tool';
  contentType: string;
  // PostToolUse only: serialized tool result. Absent on prompt and
  // PreToolUse, where there is no tool result yet. userQuery on that same
  // transmission is the current-hop prompt PreToolUse already sent.
  response?: string;
}

// Metadata-only sessions are explicitly supported by RTG Edge. The plugin
// deliberately omits `messages`: its current hooks do not observe a reliable
// final assistant response for every completed turn, so adding history would
// fabricate evidence or create invalid request/response pairs.
export interface DirectEvalSession {
  id: string;
  turn: number;
  startedAt: string;
}

export interface CedarRequest {
  // subject: the entity directly performing this action (Agent/SubAgent
  // for tool calls, User for invokeAgent itself).
  subject: DirectEvalEntitySpec;
  // principal: the human who ultimately initiated this chain — always the
  // resolved user, even many hops/subagents deep. Equal to `subject` only
  // for invokeAgent, where the human IS the one directly acting.
  principal: DirectEvalEntitySpec;
  action: { name: string };
  resource: DirectEvalEntitySpec;
  context: Record<string, any>;
  transmission: DirectEvalTransmission;
  session: DirectEvalSession;
}

export type RtgDecision = 'allow' | 'deny' | 'ask';

export interface RtgResult {
  decision: RtgDecision;
  // A 401 or operational 5xx disables Reva enforcement for this one request.
  // Hook writers must emit no Codex decision in this state: exiting 2 would
  // block on an RTG outage, and emitting JSON would be a no-op anyway.
  inactive?: boolean;
  reason?: string;
  raw?: any;
  // Opaque machine-readable error supplied by RTG Edge, or a synthetic
  // RTG_UNAVAILABLE/RTG_TIMEOUT for transport failures.
  errorType?: string;
  // The actual RTG HTTP status, or synthetic 503/504 for transport/timeout
  // inactivity. Kept separate from the Codex hook decision.
  status?: number;
}

export type CedarActionName =
  | 'executeBash'
  | 'read'
  | 'write'
  | 'edit'
  | 'glob'
  | 'grep'
  | 'invokeTool'
  | 'spawn'
  | 'invokeAgent';

export interface CedarActionMapping {
  actionName: CedarActionName;
  resourceType: string;
  resourceId: string;
  resourceProperties?: Record<string, any>;
  resourceParents?: CedarEntityRef[];
  // Only set for executeBash: the literal, real shell command string.
  command?: string;
  // Only set for glob/grep: the search pattern. Unreachable on Codex — there
  // is no Glob or Grep tool here, but the field is still declared so this
  // type's shape stays usable anywhere rtgClient/context's logic is reused.
  pattern?: string;
  // Original Codex tool name (e.g. "apply_patch") for actions that group
  // multiple tools/hunks together — keeps audit fidelity without needing a
  // separate action per tool variant.
  tool?: string;
  // Set only for an mcp__<server>__<tool> call whose server has no known
  // URL (never ingested — see ingestionClient.ts: only a server with a URL
  // ever becomes a MCPServer entity or a registeredMcpServers name). When
  // set, authorize.ts/authorizePost.ts treat the call as out of governance
  // scope entirely — true pass-through, no RTG call — rather than send a
  // Cedar request RTG has no entity to evaluate it against.
  skipReason?: string;
}

// ONE Codex hook call can touch MANY resources: a chained PowerShell command
// (`a; b; c`) or a single apply_patch that adds one file and updates two more.
// Cedar takes one resource per request and the hook fires once, so mapping
// returns the full deduped candidate set and the caller evaluates each one,
// denying if any denies. See mapping.ts and evaluateAll.ts.
export interface ToolMapping {
  mappings: CedarActionMapping[];
  // Number of distinct resources the tool call was found to touch, BEFORE
  // the cap is applied — so a debug log can show what was dropped.
  candidateCount: number;
  // True when a Bash candidate set exceeded MAX_BASH_RESOURCES. The caller
  // denies outright rather than degrading to a coarser resource: silently
  // evaluating a subset would let the uninspected remainder through.
  overCap?: boolean;
}

export interface SessionContext {
  id: string;
  traceId: string;
  spanId: string;
}
