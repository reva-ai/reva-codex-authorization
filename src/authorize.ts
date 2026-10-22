import { getActiveSessionCount, markSessionActive } from './activeSessions';
import { loadConfig } from './config';
import { buildActionContext, buildTransmission } from './context';
import { debugLog } from './debug';
import { resolveMachineId } from './deviceId';
import { buildEntityDescriptor, directSpecOf, refOf } from './entity';
import { evaluateAll } from './evaluateAll';
import { additionalContextAndExit, allowAndExit, conditionalAllowNotice, denyAndExit, passThroughAndExit } from './hookOutput';
import { enqueuePendingSpawnLineage, loadAgentHops, resolveSubAgentLineage } from './hopChain';
import { resolveAgentContext, resolveSessionEntrypoint, resolveUserEmail } from './identity';
import { MAX_BASH_RESOURCES, canonicalToolName, mapToolToCedar } from './mapping';
import { triggerMcpIngestionForInvokedServer } from './mcpIngestionTrigger';
import { resolveDataDir } from './pluginPaths';
import { nextSpawnIndex } from './spawnCounter';
import { readStdin } from './stdin';
import { buildSessionContext, buildTraceId, deriveSpanId, traceparentHeader } from './trace';
import { CedarEntityDescriptor, CedarHop, CedarRequest, PreToolUseInput } from './types';
import { conversationFromTurn, directSessionFromTurn, loadOrStartTurn } from './turnCache';

async function main(): Promise<void> {
  const raw = await readStdin();
  const input: PreToolUseInput = JSON.parse(raw);
  const cfg = loadConfig();
  const dataDir = resolveDataDir();
  const machineId = resolveMachineId(dataDir);

  // Refreshes lastSeen for this session_id — keeps the active-sessions
  // registry accurate for as long as the session keeps being used. Same for
  // a subagent's own tool calls: agentCtx.agentId is always this machine's
  // id regardless of subagent status, so this still refreshes the right entry.
  const currentSession = markSessionActive(cfg.agentId, input.session_id, resolveSessionEntrypoint(), dataDir);
  const activeSessionCount = getActiveSessionCount(cfg.agentId, dataDir);

  const agentCtx = resolveAgentContext(cfg.agentId, input);
  // Namespaced hook names ("collaborationspawn_agent") are mapped under the
  // official tool name — see canonicalToolName in mapping.ts.
  const toolMapping = mapToolToCedar(canonicalToolName(input.tool_name), input.tool_input || {}, input.cwd);

  // An MCP tool call on a server with no known url — see mapping.ts's
  // skipReason. True pass-through: no stdout at all, never an explicit
  // allow, so Codex's own permission system still decides. Also means
  // ingest-on-invoke below never fires for one of these — correct, since
  // there is nothing to ingest it as (see ingestionClient.ts).
  if (toolMapping.mappings.length > 0 && toolMapping.mappings.every((m) => m.skipReason)) {
    debugLog(`authorize: skipping — ${toolMapping.mappings[0].skipReason}`);
    passThroughAndExit();
  }

  // Ingest-on-invoke — an MCP server being used but not yet ingested gets a
  // discovery pass triggered now instead of at the next recheck. Wrapped in
  // its own try/catch on purpose: main()'s catch below fails CLOSED, so an
  // unexpected throw in this best-effort bookkeeping would DENY a legitimate
  // tool call. Nothing here is worth blocking a user's work over, so it is
  // contained and swallowed rather than allowed to reach that handler.
  try {
    const mcpServer = toolMapping.mappings
      .flatMap((m) => m.resourceParents || [])
      .find((parent) => parent.type === 'MCPServer');
    if (mcpServer) triggerMcpIngestionForInvokedServer(mcpServer.id, input.cwd, dataDir);
  } catch (err: any) {
    debugLog(`authorize: ingest-on-invoke skipped — ${err?.message || String(err)}`);
  }

  debugLog(
    `-> ${input.tool_name} (turn=${input.turn_id}) touches ${toolMapping.candidateCount} resource(s): ` +
      `${toolMapping.mappings.map((m) => `${m.actionName}:${m.resourceId}`).join(', ') || '(none)'}`,
  );

  // Over the Bash resource cap. Denied rather than partially evaluated:
  // evaluating a subset would silently let the uninspected remainder
  // through, which is the failure direction this plugin exists to prevent.
  if (toolMapping.overCap) {
    denyAndExit(
      `Reva governance: this command touches ${toolMapping.candidateCount} distinct paths, above the ` +
        `${MAX_BASH_RESOURCES}-resource limit for a single evaluated call. Split it into separate commands so each ` +
        `can be authorized against policy.`,
    );
  }

  // No identifiable resource at all. For Bash this cannot happen (it falls
  // back to the working directory); for apply_patch it means the patch
  // envelope could not be parsed, and a mutation whose target is unknown is
  // exactly the case that must not pass silently.
  if (toolMapping.mappings.length === 0) {
    denyAndExit(
      `Reva governance: could not determine which resources "${input.tool_name}" would act on, so it cannot be ` +
        `authorized. Failing closed.`,
    );
  }

  // Codex supplies turn_id on every turn-scoped hook. trace = this turn
  // (shared by every call the prompt fans out into), span = this tool call.
  // The span key is tool_name + tool_input, which PostToolUse sees
  // identically, so the pre/post pair shares one span without either process
  // having to tell the other anything. loadOrStartTurn only persists what
  // turn_id can't give us: the prompt text, the turn ordinal and startedAt.
  const turn = loadOrStartTurn(input.session_id, input.turn_id, dataDir);
  const traceId = buildTraceId(input.turn_id);
  const spanId = deriveSpanId(traceId, `tool:${input.tool_name}:${JSON.stringify(input.tool_input || {})}`);
  const traceSession = buildSessionContext(input.session_id, spanId, traceId);
  const traceparent = traceparentHeader(traceSession.traceId, traceSession.spanId);

  // Cumulative spawn count for this turn — only computed (and only
  // increments) for actual spawns, so unrelated tool calls don't advance it.
  const isSpawn = toolMapping.mappings.some((m) => m.actionName === 'spawn');
  const subagentIndex = isSpawn ? nextSpawnIndex(input.session_id, dataDir) : undefined;

  // principal: the human who ultimately initiated this chain — resolved the
  // same way regardless of who's directly acting (Agent or SubAgent).
  const userEmail = resolveUserEmail();
  const userDescriptor = buildEntityDescriptor('User', userEmail);

  // subject: no parents on SubAgent — the schema declares SubAgent's
  // memberOfTypes as [], so it isn't valid for a SubAgent to claim
  // membership in Agent (or anything else).
  const subjectDescriptor: CedarEntityDescriptor = agentCtx.isSubAgent
    ? buildEntityDescriptor('SubAgent', `${agentCtx.agentId}:${agentCtx.subAgentId}`, {
        agentType: agentCtx.subAgentType || 'subagent',
      })
    : buildEntityDescriptor('Agent', agentCtx.agentId);
  const subject = refOf(subjectDescriptor);

  const hops: CedarHop[] = agentCtx.isSubAgent
    ? resolveSubAgentLineage(input.session_id, agentCtx.subAgentId!, dataDir)
    : loadAgentHops(input.session_id, dataDir);

  // The current transmission describes this tool hop. If the host calls this
  // hook without UserPromptSubmit, use only real action data observed here,
  // because the endpoint rejects a blank current prompt.
  const serializedInput = JSON.stringify(input.tool_input || {});
  const currentHopContent =
    toolMapping.mappings[0].command?.trim() ||
    (serializedInput !== '{}' ? serializedInput : input.tool_name);
  const transmission = buildTransmission(currentHopContent, 'assistant', input.tool_name);
  const session = directSessionFromTurn(input.session_id, turn);
  const conversationMessages = conversationFromTurn(turn);

  // One CedarRequest per resource this single tool call touches. Everything
  // except `resource` and the per-action context is identical across them,
  // so the RTG sees N views of one action rather than N unrelated actions.
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
        subagentIndex,
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
    return { mapping, request };
  });

  // If this action IS a spawn, queue the lineage the resulting subagent
  // should inherit — see hopChain.ts for why this is a FIFO queue and what
  // would have to be observed to replace it with SubagentStart's agent_id.
  if (isSpawn) {
    const spawnMapping = toolMapping.mappings.find((m) => m.actionName === 'spawn')!;
    const spawnHop: CedarHop = {
      seq: hops.length + 1,
      subject,
      action: { name: 'spawn' },
      resource: { type: spawnMapping.resourceType, id: spawnMapping.resourceId },
      time: new Date().toISOString(),
    };
    enqueuePendingSpawnLineage(input.session_id, hops, spawnHop, dataDir);
  }

  const aggregate = await evaluateAll(cfg, requests, traceparent, dataDir, input.session_id);
  debugLog(`<= PreToolUse outcome=${aggregate.outcome}`);

  switch (aggregate.outcome) {
    case 'deny':
      denyAndExit(aggregate.reason || "Blocked by your organization's security policy.");
    // falls through to exit; `denyAndExit` returns never
    case 'ask':
      additionalContextAndExit('PreToolUse', conditionalAllowNotice(aggregate.reason, `this ${input.tool_name} call`));
    case 'inactive':
      passThroughAndExit();
    default:
      allowAndExit();
  }
}

main().catch((err: any) => {
  // Any unexpected failure (bad stdin JSON, missing token, mapping bug) must
  // fail CLOSED. Exit 2 is the only non-zero code Codex treats as blocking —
  // exiting 1 would be reported as a hook failure and the tool call would
  // proceed, which is precisely the silent-permission outcome to avoid.
  // The ONLY record this denial leaves. denyAndExit exits the process
  // immediately after printing the hook response, so without this line a
  // fail-closed deny is invisible everywhere except the UI toast the user
  // sees — which is exactly why an intermittent config failure looked
  // random and undiagnosable.
  debugLog(`PreToolUse: FAILING CLOSED — ${err?.stack || err?.message || String(err)}`);
  denyAndExit(`Reva governance plugin internal error — failing closed (${err?.message || String(err)})`);
});
