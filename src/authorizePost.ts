import { getActiveSessionCount, getSessionEntry } from './activeSessions';
import { loadConfig } from './config';
import { buildActionContext, buildToolResponseTransmission } from './context';
import { debugLog } from './debug';
import { resolveMachineId } from './deviceId';
import { buildEntityDescriptor, directSpecOf } from './entity';
import { evaluateAll } from './evaluateAll';
import { additionalContextAndExit, allowAndExit, conditionalAllowNotice, denyAndExit, passThroughAndExit } from './hookOutput';
import { loadAgentHops, resolveSubAgentLineage } from './hopChain';
import { resolveAgentContext, resolveUserEmail } from './identity';
import { canonicalToolName, mapToolToCedar } from './mapping';
import { resolveDataDir } from './pluginPaths';
import { readStdin } from './stdin';
import { buildTraceId, deriveSpanId, toolSpanKey, traceparentHeader } from './trace';
import { CedarEntityDescriptor, CedarRequest, PostToolUseInput } from './types';
import { conversationFromTurn, directSessionFromTurn, loadOrStartTurn } from './turnCache';

// PostToolUse fires after the tool has already run. An RTG deny cannot undo
// it — Codex replaces the tool result with the block reason so the model
// sees why, but the side effect has happened. Same fail-closed posture as
// PreToolUse for internal errors.
//
// IMPORTANT, and measured rather than assumed: PostToolUse is NOT
// guaranteed to fire for every PreToolUse. The 0.151.0 capture recorded 3
// apply_patch PreToolUse events against only 2 PostToolUse events. This
// entrypoint is therefore opportunistic evaluation, NOT a reliable audit
// backstop, and nothing else in this plugin is designed as if it were.
async function main(): Promise<void> {
  const raw = await readStdin();
  const input: PostToolUseInput = JSON.parse(raw);
  const cfg = loadConfig();
  const dataDir = resolveDataDir();
  const machineId = resolveMachineId(dataDir);

  // Read-only here, not a refresh — PreToolUse already marked this same
  // tool call's session active moments earlier in the same cycle.
  const activeSessionCount = getActiveSessionCount(cfg.agentId, dataDir);
  const currentSession = getSessionEntry(cfg.agentId, input.session_id, dataDir);

  const agentCtx = resolveAgentContext(cfg.agentId, input);
  // Same canonicalization as PreToolUse, so pre and post map identically.
  const toolMapping = mapToolToCedar(canonicalToolName(input.tool_name), input.tool_input || {}, input.cwd);

  // See the matching check in authorize.ts: an MCP tool call on a server
  // with no known url is out of governance scope entirely, true
  // pass-through, no RTG call.
  if (toolMapping.mappings.length > 0 && toolMapping.mappings.every((m) => m.skipReason)) {
    debugLog(`authorizePost: skipping — ${toolMapping.mappings[0].skipReason}`);
    passThroughAndExit();
  }

  // Over-cap or unmappable: the tool has ALREADY RUN, so there is nothing to
  // prevent and denying would only replace a real result with an error the
  // model then has to reason about. Recorded and passed through instead —
  // the PreToolUse gate is where that call was, or was not, stopped.
  if (toolMapping.overCap || toolMapping.mappings.length === 0) {
    debugLog(
      `PostToolUse: no evaluable resource for ${input.tool_name} ` +
        `(overCap=${Boolean(toolMapping.overCap)}, candidates=${toolMapping.candidateCount}) — passing through`,
    );
    passThroughAndExit();
  }

  const turn = loadOrStartTurn(input.session_id, input.turn_id, dataDir);
  // trace = this turn, span = one resource of this tool call. Same key
  // (tool_name + tool_input + action + resource) PreToolUse used, so each
  // resource's pair shares one span without shared state.
  const traceId = buildTraceId(input.turn_id);
  const traceparentFor = (mapping: { actionName: string; resourceId: string }): string =>
    traceparentHeader(traceId, deriveSpanId(traceId, toolSpanKey(input.tool_name, input.tool_input, mapping)));

  const userEmail = resolveUserEmail();
  const userDescriptor = buildEntityDescriptor('User', userEmail);

  const subjectDescriptor: CedarEntityDescriptor = agentCtx.isSubAgent
    ? buildEntityDescriptor('SubAgent', `${agentCtx.agentId}:${agentCtx.subAgentId}`, {
        agentType: agentCtx.subAgentType || 'subagent',
      })
    : buildEntityDescriptor('Agent', agentCtx.agentId);

  const hops = agentCtx.isSubAgent
    ? resolveSubAgentLineage(input.session_id, agentCtx.subAgentId!, dataDir)
    : loadAgentHops(input.session_id, dataDir);

  // Same current-hop prompt PreToolUse puts in transmission.userQuery.
  const serializedInput = JSON.stringify(input.tool_input || {});
  const currentHopContent =
    toolMapping.mappings[0].command?.trim() ||
    (serializedInput !== '{}' ? serializedInput : input.tool_name);

  // userQuery matches PreToolUse; the tool result is transmission.response,
  // not closed Cedar context, so the evaluate payload carries it without a
  // schema change.
  const transmission = buildToolResponseTransmission(input.tool_response, currentHopContent);
  const session = directSessionFromTurn(input.session_id, turn);
  const conversationMessages = conversationFromTurn(turn);

  const requests = toolMapping.mappings.map((mapping) => {
    const resourceDescriptor = buildEntityDescriptor(
      mapping.resourceType,
      mapping.resourceId,
      mapping.resourceProperties,
      mapping.resourceParents,
    );
    const request: CedarRequest = {
      subject: directSpecOf(subjectDescriptor),
      principal: directSpecOf(userDescriptor),
      action: { name: mapping.actionName },
      resource: directSpecOf(resourceDescriptor),
      context: buildActionContext(mapping, {
        hops,
        conversationMessages,
        activeSessionCount,
        currentSession,
        model: input.model,
        modelContext: cfg.modelContext,
        machineId,
      }),
      transmission,
      session,
    };
    return { mapping, request, traceparent: traceparentFor(mapping) };
  });

  debugLog(`-> post ${input.tool_name} (turn=${input.turn_id}, resources=${requests.length}, hops=${hops.length})`);
  const aggregate = await evaluateAll(cfg, requests, dataDir, input.session_id);
  debugLog(`<= PostToolUse outcome=${aggregate.outcome}`);

  switch (aggregate.outcome) {
    case 'deny':
      denyAndExit(aggregate.reason || "Blocked by your organization's security policy.");
    case 'ask':
      additionalContextAndExit(
        'PostToolUse',
        conditionalAllowNotice(aggregate.reason, `the result of this ${input.tool_name} call`),
      );
    case 'inactive':
      passThroughAndExit();
    default:
      allowAndExit();
  }
}

main().catch((err: any) => {
  debugLog(`PostToolUse: FAILING CLOSED — ${err?.stack || err?.message || String(err)}`);
  denyAndExit(`Reva governance plugin internal error — failing closed (${err?.message || String(err)})`);
});
