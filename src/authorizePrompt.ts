import { getActiveSessionCount, markSessionActive } from './activeSessions';
import { loadConfig } from './config';
import { debugLog } from './debug';
import { resolveMachineId } from './deviceId';
import { additionalContextAndExit, allowAndExit, conditionalAllowNotice, denyAndExit, passThroughAndExit } from './hookOutput';
import { startTurnHops } from './hopChain';
import { resolveSessionEntrypoint, resolveUserEmail } from './identity';
import { buildInvokeAgentRequest } from './invokeAgent';
import { triggerMcpDiscoveryIfDue } from './mcpIngestionTrigger';
import { evaluate } from './rtgClient';
import { resolveDataDir } from './pluginPaths';
import { resetSpawnCounter } from './spawnCounter';
import { readStdin } from './stdin';
import { buildSessionContext, buildTraceId, deriveSpanId, traceparentHeader } from './trace';
import { CedarHop, UserPromptSubmitInput } from './types';
import { directSessionFromTurn, startTurn, truncatePrompt } from './turnCache';

// UserPromptSubmit gates the whole turn: one invokeAgent evaluation of
// User -> Agent, before Codex does anything with the prompt.
//
// Single-resource by nature — the resource is the Agent itself — so this is
// the one entrypoint that does not go through evaluateAll().
async function main(): Promise<void> {
  const raw = await readStdin();
  const input: UserPromptSubmitInput = JSON.parse(raw);
  const cfg = loadConfig();
  const dataDir = resolveDataDir();

  // Closes the gap between SessionStart's once-per-session discovery pass
  // and an MCP server added mid-session: UserPromptSubmit fires every turn,
  // so re-checking here (throttled to ~15 minutes, see
  // mcpIngestionTrigger.ts) picks up a new server well before the next
  // SessionStart would. A no-op, non-blocking cache read when not yet due.
  triggerMcpDiscoveryIfDue(input.cwd, dataDir);

  const userEmail = resolveUserEmail();
  const prompt = input.prompt ? truncatePrompt(input.prompt) : '';

  // UserPromptSubmit fires every turn, unlike SessionStart (once per
  // session) — a good second place to keep this session's lastSeen fresh.
  const currentSession = markSessionActive(cfg.agentId, input.session_id, resolveSessionEntrypoint(), dataDir);
  const activeSessionCount = getActiveSessionCount(cfg.agentId, dataDir);

  // Codex's own turn_id is the turn boundary — this plugin no longer has to
  // mint one. startTurn records the prompt against it and advances the
  // ordinal that DirectEvalSession.turn needs.
  const turn = startTurn(input.session_id, input.turn_id, input.prompt, dataDir);
  // Same turn boundary resets the subagent spawn counter — each turn's
  // first spawn is #1 again, not a continuation of every prior turn's count
  // (see spawnCounter.ts's own comment on why).
  resetSpawnCounter(input.session_id, dataDir);
  // This hook opens the turn, so its trace id is the one every tool call in
  // the turn will derive. Its own span is the prompt evaluation itself.
  const traceId = buildTraceId(input.turn_id);
  const spanId = deriveSpanId(traceId, 'user-prompt');
  const traceSession = buildSessionContext(input.session_id, spanId, traceId);
  const traceparent = traceparentHeader(traceSession.traceId, traceSession.spanId);

  const request = buildInvokeAgentRequest(
    userEmail,
    cfg.agentId,
    prompt,
    directSessionFromTurn(input.session_id, turn),
    activeSessionCount,
    currentSession,
    // `model` comes straight off the hook payload, where Codex declares it
    // required. Only reaches context when REVA_MODEL_CONTEXT is set.
    {
      model: input.model,
      modelContext: cfg.modelContext,
      machineId: resolveMachineId(dataDir),
    },
  );

  debugLog(`-> invokeAgent as ${userEmail} on Agent:${cfg.agentId} (turn=${input.turn_id})`);
  const result = await evaluate(cfg, request, traceparent, dataDir, input.session_id);
  debugLog(`<- decision=${result.decision}${result.inactive ? ' (inactive)' : ''}${result.reason ? ` reason="${result.reason}"` : ''}`);

  // Record this invokeAgent as the base of this turn's hop chain regardless
  // of the decision, so a subsequent tool call (if the turn proceeds) has it
  // to build on — mirrors how the spawn counter also advances on every
  // attempt, not just approved ones.
  const invokeAgentHop: CedarHop = {
    seq: 1,
    subject: request.subject,
    action: { name: 'invokeAgent' },
    resource: request.resource,
    time: new Date().toISOString(),
  };
  startTurnHops(input.session_id, invokeAgentHop, dataDir);

  if (result.inactive) passThroughAndExit();
  if (result.decision === 'deny') denyAndExit(result.reason || "Blocked by your organization's security policy.");
  if (result.decision === 'ask') {
    additionalContextAndExit('UserPromptSubmit', conditionalAllowNotice(result.reason, 'this session'));
  }
  allowAndExit();
}

main().catch((err: any) => {
  debugLog(`UserPromptSubmit: FAILING CLOSED — ${err?.stack || err?.message || String(err)}`);
  denyAndExit(`Reva governance plugin internal error — failing closed (${err?.message || String(err)})`);
});
